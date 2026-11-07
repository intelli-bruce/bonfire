// bf/weapon-vfx.js — 플레이어 무기 이펙트(셰이더 기반): GPU 파티클(가산 불꽃·스파크 줄기·불씨 + 연기), 총구 화염 원뿔, 탄 궤적, 검기·「死」 디졸브, 칼날 잔상 리본, 폭발 불덩이·충격파.
// 파티클은 생성할 때만 버퍼에 쓰고 움직임(감쇠·중력·수명)은 정점 셰이더가 시간으로 계산한다 → 프레임당 CPU 비용 0, 그리기 호출 2번(가산 1 · 연기 1).
// 순수 수학(particleAt · ringSlot · rampAt)은 THREE 없이 테스트한다(tools/weapon-vfx.test.mjs).
//   const V = createWeaponVfx(THREE, scene); V.update(dt); V.muzzle(o, dir, slot); V.hit(p, kind); V.boom(p, R, party) …

// ---- 순수 함수 --------------------------------------------------------------------------------
// 감쇠(drag, 1/s)와 중력(g, m/s² 아래)을 받는 입자의 t 초 뒤 위치·속도(정점 셰이더와 같은 식)
export function particleAt(p0, v0, drag, g, t) {
  const e = drag > 1e-6 ? (1 - Math.exp(-drag * t)) / drag : t, k = drag > 1e-6 ? Math.exp(-drag * t) : 1;
  return {
    p: [p0[0] + v0[0] * e, p0[1] + v0[1] * e - 0.5 * g * t * t, p0[2] + v0[2] * e],
    v: [v0[0] * k, v0[1] * k - g * t, v0[2] * k],
  };
}
// 고리 버퍼: 다음 칸(가장 오래된 것부터 덮어쓴다)
export const ringSlot = (cursor, n) => (cursor + 1) % n;
// 불 색 경사: u 0 = 흰 심 → 노랑 → 주황 → 붉은 숯 → 1 = 검붉음(선형 RGB)
export const FIRE_RAMP = [[0, [1.0, 0.97, 0.88]], [0.18, [1.0, 0.8, 0.36]], [0.42, [1.0, 0.42, 0.08]], [0.7, [0.62, 0.1, 0.03]], [1, [0.12, 0.03, 0.02]]];
export function rampAt(ramp, u) {
  u = Math.min(1, Math.max(0, u));
  for (let i = 1; i < ramp.length; i++) if (u <= ramp[i][0]) {
    const [a0, c0] = ramp[i - 1], [a1, c1] = ramp[i], k = (u - a0) / (a1 - a0 || 1);
    return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
  }
  return ramp[ramp.length - 1][1].slice();
}
// 무기별 총구 화염 크기(m): 길이 · 굵기 · 섬광 지름
export const MUZZLE = { 3: [0.55, 0.16, 0.7], 4: [0.75, 0.3, 1.1], 5: [0.32, 0.12, 0.5], 7: [1.0, 0.22, 1.2], 8: [1.3, 0.5, 2.0] };

// ---- GLSL ---------------------------------------------------------------------------------
export const NOISE_GLSL = /* glsl */`
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float h31(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm3(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.02 + 11.7; a *= 0.5; } return s; }
`;
const OUT = /* glsl */`#include <tonemapping_fragment>
#include <colorspace_fragment>`;

const PART_VS = /* glsl */`
uniform float uTime;
attribute vec3 aP0; attribute vec3 aV0; attribute vec4 aCol; attribute vec4 aT; attribute vec4 aK;
varying vec2 vUv; varying vec4 vCol; varying float vU; varying float vKind; varying float vSeed;
void main(){
  float age = uTime - aT.x, life = aT.y, u = age / life;
  vKind = aK.x; vSeed = aK.w; vCol = aCol; vU = u; vUv = position.xy * 2.0;
  if (age < 0.0 || u >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float d = aK.y, g = aK.z, e = d > 1e-4 ? (1.0 - exp(-d * age)) / d : age;
  vec3 p = aP0 + aV0 * e - vec3(0.0, 0.5 * g * age * age, 0.0);
  vec3 vel = aV0 * (d > 1e-4 ? exp(-d * age) : 1.0) - vec3(0.0, g * age, 0.0);
  float size = mix(aT.z, aT.w, u);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec2 q = position.xy;
  if (aK.x > 0.5 && aK.x < 1.5) {          // 1 스파크 줄기: 화면에서 속도 방향으로 늘인다
    vec2 vv = (viewMatrix * vec4(vel, 0.0)).xy; float l = length(vv);
    vec2 dir = l > 1e-4 ? vv / l : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
    float len = size + l * 0.02;
    q = dir * q.x * len + nrm * q.y * size * 0.35;
  } else {                                  // 0 빛 · 2 연기 · 3 불씨: 화면을 보는 판, 연기는 천천히 돈다
    float a = aK.w * 6.2831 + (aK.x > 1.5 && aK.x < 2.5 ? age * (aK.w - 0.5) * 1.6 : 0.0), c = cos(a), s = sin(a);
    q = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
  }
  mv.xy += q;
  gl_Position = projectionMatrix * mv;
}`;
const PART_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv; varying vec4 vCol; varying float vU; varying float vKind; varying float vSeed;
${NOISE_GLSL}
void main(){
  float r2 = dot(vUv, vUv); if (r2 > 1.0) discard;
  vec3 col = vCol.rgb; float a;
  if (vKind < 0.5) {                        // 빛 번짐(가짜 블룸): 가우스 + 밝은 심
    a = exp(-r2 * 4.0) + exp(-r2 * 28.0) * 0.8; a *= pow(1.0 - vU, 1.6);
    col = mix(col, vec3(1.0), exp(-r2 * 30.0) * 0.7);
  } else if (vKind < 1.5) {                 // 스파크 줄기: 앞(+x)이 뜨겁고 꼬리로 가늘어진다
    float along = vUv.x * 0.5 + 0.5, across = abs(vUv.y);
    a = smoothstep(1.0, 0.15, across) * smoothstep(0.0, 0.55, along) * (1.0 - smoothstep(0.92, 1.0, along));
    a *= 1.0 - vU * vU;
    col = mix(col, vec3(1.0, 0.98, 0.9), smoothstep(0.5, 1.0, along) * (1.0 - across) * 0.8);
  } else if (vKind < 2.5) {                 // 연기: 노이즈 덩어리가 바깥부터 디졸브
    float n = fbm(vUv * 1.7 + vSeed * 9.0 + vec2(0.0, -uTime * 0.25));
    float mask = (1.0 - r2) * (0.55 + n);
    a = smoothstep(vU * 0.85, vU * 0.85 + 0.35, mask) * (1.0 - smoothstep(0.75, 1.0, vU)) * smoothstep(0.0, 0.08, vU);
    col *= 0.75 + n * 0.5;
    gl_FragColor = vec4(col, a * vCol.a);
    ${OUT}
    return;
  } else {                                  // 불씨: 작게 깜빡인다
    a = exp(-r2 * 6.0) * (0.55 + 0.45 * sin(uTime * 38.0 + vSeed * 40.0)) * (1.0 - vU);
    col = mix(col, vec3(1.0), exp(-r2 * 20.0) * 0.5);
  }
  gl_FragColor = vec4(col * a * vCol.a, 1.0);
  ${OUT}
}`;

// 검기(초승달) · 「死」: 흐르는 노이즈 + 나이에 따라 디졸브, 디졸브 경계가 하얗게 탄다
const SLASH_VS = /* glsl */`
varying vec4 vC; varying vec2 vUv;
void main(){
#if defined(USE_COLOR_ALPHA)
  vC = color;
#elif defined(USE_COLOR)
  vC = vec4(color, 1.0);
#else
  vC = vec4(1.0);
#endif
  vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SLASH_FS = /* glsl */`
uniform float uTime; uniform float uAge; uniform float uGlow; uniform vec3 uEdge; uniform float uSeed;
varying vec4 vC; varying vec2 vUv;
${NOISE_GLSL}
void main(){
  float n = fbm(vec2(vUv.x * 6.0 - uTime * 5.0 + uSeed, vUv.y * 2.4 + uSeed));
  float streak = fbm(vec2(vUv.x * 2.0 + uSeed, vUv.y * 14.0 - uTime * 2.0));
  float tip = pow(sin(3.14159 * clamp(vUv.x, 0.0, 1.0)), 0.7);
  float thr = uAge * 1.05 + (1.0 - vUv.y) * 0.0 - 0.1;
  float body = n * 0.7 + streak * 0.5 + (1.0 - vUv.y) * 0.35 - (1.0 - tip) * 0.6;
  float a = smoothstep(thr, thr + 0.18, body) * vC.a;
  float edge = smoothstep(0.22, 0.0, abs(body - thr - 0.09)) * step(0.02, a);
  vec3 col = vC.rgb * (1.2 + streak * 0.8) + uEdge * edge * 1.6;
  if (uGlow > 0.5) { a *= 0.32 * tip; col = uEdge; }
  gl_FragColor = vec4(col * a, 1.0);
  ${OUT}
}`;
const DEATH_FS = /* glsl */`
uniform float uTime; uniform float uAge; uniform float uGlow; uniform sampler2D map;
varying vec4 vC; varying vec2 vUv;
${NOISE_GLSL}
void main(){
  vec2 w = vec2(fbm(vUv * 5.0 + vec2(0.0, -uTime * 2.2)), fbm(vUv * 5.0 + 7.3 + vec2(uTime * 1.3, 0.0))) - 0.5;
  vec2 uv = vUv + w * (uGlow > 0.5 ? 0.06 : 0.018);
  vec4 tx = texture2D(map, uv);
  float n = fbm(vUv * 7.0 + vec2(0.0, -uTime * 1.6));
  float thr = smoothstep(0.55, 1.0, uAge) * 1.1;
  float a = tx.a * smoothstep(thr, thr + 0.12, n + 0.15);
  float edge = smoothstep(0.14, 0.0, abs(n + 0.15 - thr - 0.06)) * tx.a * step(0.01, thr);
  float fl = 0.85 + 0.15 * sin(uTime * 31.0) * sin(uTime * 17.0 + 1.0);
  vec3 col = tx.rgb * vec3(1.4, 0.9, 0.85) * fl + vec3(1.0, 0.45, 0.12) * edge * 3.0;
  if (uGlow > 0.5) { a *= 0.45; col = vec3(1.0, 0.12, 0.06) * (0.8 + n); }
  gl_FragColor = vec4(col * a, 1.0);
  ${OUT}
}`;
// 탄 궤적: uv.x 가로(0~1) · uv.y 꼬리 0 → 머리 1. 흰 심 + 주황 테두리, 꼬리로 갈수록 사라진다
const TRACER_FS = /* glsl */`
varying vec4 vC; varying vec2 vUv; uniform vec3 uTint;
void main(){
  float x = abs(vUv.x - 0.5) * 2.0, core = exp(-x * x * 18.0), halo = exp(-x * x * 3.0);
  float along = pow(clamp(vUv.y, 0.0, 1.0), 1.6);
  vec3 col = vec3(1.0, 0.97, 0.88) * core * 1.6 + uTint * halo * 0.9;
  gl_FragColor = vec4(col * along, 1.0);
  ${OUT}
}`;
// 총구 화염 원뿔(십자 두 판): uv.y 0 총구 → 1 끝. 노이즈로 찢긴 꽃잎 불꽃
const FLAME_FS = /* glsl */`
uniform float uTime; uniform float uSeed; uniform float uK; uniform vec3 uTint;
varying vec4 vC; varying vec2 vUv;
${NOISE_GLSL}
void main(){
  float y = vUv.y, x = (vUv.x - 0.5) * 2.0;
  float wdt = mix(0.55, 0.05, pow(y, 0.8)) * (0.8 + 0.4 * vnoise(vec2(y * 9.0 + uSeed, uSeed)));
  float n = fbm(vec2(x * 3.0 + uSeed, y * 6.0 - uTime * 30.0));
  float m = smoothstep(wdt, wdt * 0.25, abs(x)) * (0.55 + n * 0.9) * smoothstep(1.0, 0.55, y + n * 0.25);
  vec3 col = mix(vec3(1.0, 0.98, 0.9), uTint, smoothstep(0.0, 0.7, y + abs(x) * 0.6));
  gl_FragColor = vec4(col * m * 2.0 * uK, 1.0);
  ${OUT}
}`;
// 폭발 불덩이: 구 표면을 노이즈로 부풀리고 색 경사 + 디졸브
const BALL_VS = /* glsl */`
uniform float uTime; uniform float uSeed; uniform float uAge;
varying float vN; varying vec3 vNrm; varying vec3 vView;
${NOISE_GLSL}
void main(){
  float n = fbm3(normal * 2.2 + vec3(uSeed, uSeed * 0.7, -uTime * 1.4));
  vN = n;
  vec3 p = position * (1.0 + (n - 0.45) * (0.55 + uAge * 0.4));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNrm = normalize(normalMatrix * normal); vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const BALL_FS = /* glsl */`
uniform float uAge; uniform float uParty; uniform float uTime;
varying float vN; varying vec3 vNrm; varying vec3 vView;
vec3 fireRamp(float u){
  vec3 c = mix(vec3(1.0, 0.97, 0.88), vec3(1.0, 0.8, 0.36), smoothstep(0.0, 0.18, u));
  c = mix(c, vec3(1.0, 0.42, 0.08), smoothstep(0.18, 0.42, u));
  c = mix(c, vec3(0.62, 0.1, 0.03), smoothstep(0.42, 0.7, u));
  return mix(c, vec3(0.12, 0.03, 0.02), smoothstep(0.7, 1.0, u));
}
void main(){
  float fres = pow(1.0 - abs(dot(vNrm, vView)), 1.5);
  float heat = clamp(uAge * 1.1 + (1.0 - vN) * 0.7 + fres * 0.45 - 0.12, 0.0, 1.0);
  vec3 col = fireRamp(heat);
  if (uParty > 0.5) col = mix(vec3(1.0), 0.5 + 0.5 * cos(6.2831 * (vN * 1.5 + uTime * 0.6 + vec3(0.0, 0.33, 0.67))), smoothstep(0.1, 0.6, heat));
  float a = smoothstep(uAge * 1.05, uAge * 1.05 + 0.2, vN + 0.25) * (1.0 - fres * 0.6);
  gl_FragColor = vec4(col * a * (0.8 - heat * 0.35) * (0.55 + vN * 0.6), 1.0);
  ${OUT}
}`;
// 충격파 고리(바닥 판): 반지름 u 에 걸린 얇은 띠, 노이즈로 끊긴다
const RING_FS = /* glsl */`
uniform float uAge; uniform vec3 uTint; uniform float uSeed; uniform float uParty;
varying vec4 vC; varying vec2 vUv;
${NOISE_GLSL}
void main(){
  vec2 c = vUv * 2.0 - 1.0; float r = length(c), ang = atan(c.y, c.x);
  float R = 1.0 - pow(1.0 - uAge, 3.0), w = 0.04 + 0.1 * uAge;
  float band = exp(-pow((r - R) / w, 2.0)) + exp(-pow((r - R * 0.85) / (w * 2.5), 2.0)) * 0.35;
  float n = fbm(vec2(ang * 3.0 + uSeed, r * 4.0 - uAge * 3.0));
  vec3 col = uTint;
  if (uParty > 0.5) col = 0.55 + 0.45 * cos(6.2831 * (ang / 6.2831 + vec3(0.0, 0.33, 0.67)));
  float a = band * (0.5 + n) * (1.0 - uAge) * step(r, 1.0);
  gl_FragColor = vec4(col * a * 1.8, 1.0);
  ${OUT}
}`;
// 칼날 잔상 리본: uv.x 나이(0 지금 → 1 오래됨), uv.y 손잡이 0 → 끝 1
const RIBBON_FS = /* glsl */`
uniform float uTime; uniform vec3 uTint;
varying vec4 vC; varying vec2 vUv;
${NOISE_GLSL}
void main(){
  float age = vUv.x, s = vUv.y;
  float n = fbm(vec2(age * 6.0 - uTime * 3.0, s * 3.0));
  float a = pow(1.0 - age, 2.2) * smoothstep(0.0, 0.35, s) * (0.55 + n * 0.8) * vC.a;
  vec3 col = mix(uTint, vec3(1.0), smoothstep(0.75, 1.0, s) * (1.0 - age));
  gl_FragColor = vec4(col * a * 1.6, 1.0);
  ${OUT}
}`;

export function createWeaponVfx(T, scene, opts = {}) {
  const coarse = !!opts.coarse;
  let time = 0;
  const uTime = { value: 0 };
  const rnd = Math.random;
  const ADD = { transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false, toneMapped: true };

  // ---- 파티클 계(가산 · 연기) -----------------------------------------------------------------
  function makeSystem(n, blending) {
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const A = (k, sz) => { const a = new T.InstancedBufferAttribute(new Float32Array(n * sz), sz); a.setUsage(T.DynamicDrawUsage); g.setAttribute(k, a); return a; };
    const s = { n, cur: 0, dirty: false, P: A('aP0', 3), V: A('aV0', 3), C: A('aCol', 4), Tm: A('aT', 4), K: A('aK', 4) };
    for (let i = 0; i < n; i++) s.Tm.array[i * 4 + 1] = 1e-3, s.Tm.array[i * 4] = -10;   // 비어 있는 칸: 이미 죽은 입자
    g.instanceCount = n;
    s.mesh = new T.Mesh(g, new T.ShaderMaterial({ uniforms: { uTime }, vertexShader: PART_VS, fragmentShader: PART_FS, transparent: true, depthWrite: false, blending, fog: false }));
    s.mesh.frustumCulled = false; s.mesh.renderOrder = blending === T.AdditiveBlending ? 7 : 6; scene.add(s.mesh);
    return s;
  }
  const add = makeSystem(coarse ? 1400 : 3000, T.AdditiveBlending), smoke = makeSystem(coarse ? 260 : 600, T.NormalBlending);
  // kind 0 빛 · 1 스파크 · 2 연기 · 3 불씨. col 은 선형 RGB(1 이상이면 더 밝게 번진다)
  function emit(kind, x, y, z, vx, vy, vz, r, g, b, a, life, s0, s1, drag = 0, grav = 0, delay = 0) {
    const S = kind === 2 ? smoke : add, i = S.cur = ringSlot(S.cur, S.n);
    S.P.array.set([x, y, z], i * 3); S.V.array.set([vx, vy, vz], i * 3); S.C.array.set([r, g, b, a], i * 4);
    S.Tm.array.set([time + delay, life, s0, s1], i * 4); S.K.array.set([kind, drag, grav, rnd()], i * 4);
    S.dirty = true;
  }
  const sph = (sp) => { const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, q = Math.sqrt(1 - u * u); return [Math.cos(a) * q * sp, u * sp, Math.sin(a) * q * sp]; };
  // 방향 d 둘레로 퍼지는 원뿔 속도
  function coneVel(d, spread, sp) {
    let ux = -d[2], uy = 0, uz = d[0]; let l = Math.hypot(ux, uz); if (l < 1e-4) { ux = 1; uz = 0; l = 1; } ux /= l; uz /= l;
    const wx = d[1] * uz - d[2] * uy, wy = d[2] * ux - d[0] * uz, wz = d[0] * uy - d[1] * ux;
    const a = rnd() * Math.PI * 2, r = Math.tan(spread) * Math.sqrt(rnd()), cx = Math.cos(a) * r, cy = Math.sin(a) * r;
    const vx = d[0] + ux * cx + wx * cy, vy = d[1] + uy * cx + wy * cy, vz = d[2] + uz * cx + wz * cy, n = Math.hypot(vx, vy, vz) || 1;
    return [vx / n * sp, vy / n * sp, vz / n * sp];
  }

  // ---- 총구 화염 원뿔 풀 -------------------------------------------------------------------------
  const flameGeo = (() => {   // 십자 두 판, 길이 +Z 1 m, uv.y 0 총구 → 1 끝
    const pos = [], uv = [], idx = [];
    for (const [ax, ay] of [[1, 0], [0, 1]]) {
      const b = pos.length / 3;
      pos.push(-0.5 * ax, -0.5 * ay, 0, 0.5 * ax, 0.5 * ay, 0, 0.5 * ax, 0.5 * ay, 1, -0.5 * ax, -0.5 * ay, 1);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1); idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return g;
  })();
  const flames = [];
  for (let i = 0; i < 4; i++) {
    const m = new T.Mesh(flameGeo, new T.ShaderMaterial({ uniforms: { uTime, uSeed: { value: 0 }, uK: { value: 0 }, uTint: { value: new T.Color(1, 0.55, 0.15) } }, vertexShader: SLASH_VS, fragmentShader: FLAME_FS, ...ADD }));
    m.visible = false; m.frustumCulled = false; m.renderOrder = 7; scene.add(m); flames.push({ m, t: 0, t0: 0.06 });
  }
  let flN = 0;
  const _z = new T.Vector3(0, 0, 1), _d = new T.Vector3();
  function muzzle(o, dir, slot) {
    const [len, wid, fl] = MUZZLE[slot] || MUZZLE[3], f = flames[flN = (flN + 1) % flames.length];
    _d.set(dir[0], dir[1], dir[2]).normalize();
    f.m.position.copy(o); f.m.quaternion.setFromUnitVectors(_z, _d); f.m.scale.set(wid * (0.85 + rnd() * 0.3), wid * (0.85 + rnd() * 0.3), len * (0.8 + rnd() * 0.4));
    f.m.rotateZ(rnd() * Math.PI); f.m.material.uniforms.uSeed.value = rnd() * 50; f.m.material.uniforms.uK.value = 1; f.m.visible = true; f.t = f.t0 = slot === 8 ? 0.12 : 0.06;
    const d = [_d.x, _d.y, _d.z];
    emit(0, o.x + d[0] * 0.05, o.y + d[1] * 0.05, o.z + d[2] * 0.05, 0, 0, 0, 1.2, 0.75, 0.4, 0.8, 0.06, fl * 0.7, fl * 0.4);        // 섬광 번짐
    emit(0, o.x, o.y, o.z, 0, 0, 0, 1.0, 0.45, 0.12, 0.3, 0.1, fl * 1.1, fl * 1.4);                                           // 넓은 주황 빛
    const ns = slot === 4 ? 10 : slot === 8 ? 14 : 4;
    for (let i = 0; i < ns; i++) { const v = coneVel(d, slot === 4 ? 0.35 : 0.22, 9 + rnd() * 14); emit(1, o.x, o.y, o.z, v[0], v[1], v[2], 1.3, 0.75, 0.3, 1, 0.08 + rnd() * 0.1, 0.03, 0.01, 7, 4); }
    for (let i = 0; i < 3; i++) {   // 옆으로 터지는 꽃잎 화염(소염기 구멍)
      const v = coneVel(d, 1.2, 4 + rnd() * 3); emit(1, o.x, o.y, o.z, v[0], v[1], v[2], 1.2, 0.6, 0.2, 0.8, 0.05, wid * 0.8, wid * 0.4, 18, 0);
    }
    const nsm = slot === 8 ? 10 : slot === 4 || slot === 7 ? 4 : 2;
    for (let i = 0; i < nsm; i++) {
      const v = coneVel(d, 0.5, 0.6 + rnd() * (slot === 8 ? 3 : 1.4)), back = slot === 8 && i % 2 ? -1 : 1;
      emit(2, o.x, o.y, o.z, v[0] * back, v[1] + 0.3, v[2] * back, 0.62, 0.6, 0.62, slot === 8 ? 0.55 : 0.32, 0.9 + rnd() * 0.8, 0.12, slot === 8 ? 1.4 : 0.55, 1.6, -0.5);
    }
  }
  // 총구 화염이 총구를 따라간다(weapons.js followFlash)
  function moveMuzzle(o) { for (const f of flames) if (f.m.visible) f.m.position.copy(o); }

  // ---- 피격·충돌 --------------------------------------------------------------------------------
  // kind: 'hit'(몸·보스) · 'ground'(지면) · 'slash'(검 · 하늘빛) · 'death'(궁극기 · 붉음)
  const HITC = { hit: [1.4, 0.7, 0.25], ground: [1.2, 0.8, 0.45], slash: [0.55, 1.1, 1.6], death: [1.6, 0.25, 0.12] };
  function hit(x, y, z, kind = 'hit', k = 1) {
    const c = HITC[kind] || HITC.hit, n = Math.round((kind === 'ground' ? 5 : 12) * k);
    emit(0, x, y, z, 0, 0, 0, c[0], c[1], c[2], 1, 0.1, 0.25 * k, 0.9 * k);
    emit(0, x, y, z, 0, 0, 0, 1.2, 1.2, 1.2, 1, 0.05, 0.4 * k, 0.15);
    for (let i = 0; i < n; i++) { const v = sph(5 + rnd() * 9 * k); if (kind === 'ground') v[1] = Math.abs(v[1]) + 2; emit(1, x, y, z, v[0], v[1], v[2], c[0], c[1], c[2], 1, 0.18 + rnd() * 0.25, 0.04, 0.012, 3.5, 9); }
    for (let i = 0; i < Math.round(3 * k); i++) { const v = sph(1.5 + rnd() * 2); emit(3, x, y, z, v[0], v[1] + 1, v[2], c[0], c[1] * 0.8, c[2] * 0.6, 1, 0.4 + rnd() * 0.4, 0.05, 0.02, 2, 3); }
    if (kind === 'ground') for (let i = 0; i < 2; i++) emit(2, x, y, z, (rnd() - 0.5) * 0.8, 0.6 + rnd() * 0.5, (rnd() - 0.5) * 0.8, 0.75, 0.68, 0.58, 0.45, 0.8 + rnd() * 0.5, 0.15, 0.7, 1.8, -0.2);
  }

  // ---- 검기 · 「死」 재질 -----------------------------------------------------------------------
  const slashMat = (edge, glow) => new T.ShaderMaterial({ uniforms: { uTime, uAge: { value: 0 }, uGlow: { value: glow ? 1 : 0 }, uEdge: { value: new T.Color(...edge) }, uSeed: { value: rnd() * 40 } }, vertexShader: SLASH_VS, fragmentShader: SLASH_FS, vertexColors: true, ...ADD });
  const deathMat = (map, glow) => new T.ShaderMaterial({ uniforms: { uTime, uAge: { value: 0 }, uGlow: { value: glow ? 1 : 0 }, map: { value: map } }, vertexShader: SLASH_VS, fragmentShader: DEATH_FS, ...ADD });
  const tracerMat = new T.ShaderMaterial({ uniforms: { uTint: { value: new T.Color(1, 0.45, 0.1) } }, vertexShader: SLASH_VS, fragmentShader: TRACER_FS, ...ADD });

  // ---- 칼날 잔상 리본 ---------------------------------------------------------------------------
  function ribbon(seg = 18, tint = [0.45, 0.85, 1.4]) {
    const n = seg + 1, pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), col = new Float32Array(n * 2 * 4), idx = [];
    for (let i = 0; i < n; i++) { uv.set([i / seg, 0, i / seg, 1], i * 4); if (i < seg) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); } }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setAttribute('color', new T.BufferAttribute(col, 4)); g.setIndex(idx);
    const m = new T.Mesh(g, new T.ShaderMaterial({ uniforms: { uTime, uTint: { value: new T.Color(...tint) } }, vertexShader: SLASH_VS, fragmentShader: RIBBON_FS, vertexColors: true, ...ADD }));
    m.frustumCulled = false; m.renderOrder = 7; m.visible = false; scene.add(m);
    const hist = [];   // {b:[x,y,z], t:[x,y,z], at}
    const R = { mesh: m, push(b, t, on) {
      if (on) hist.unshift({ b: [b.x, b.y, b.z], t: [t.x, t.y, t.z], at: time });
      while (hist.length > n || (hist.length && time - hist[hist.length - 1].at > 0.16)) hist.pop();
      if (hist.length < 2) { m.visible = false; return; }
      for (let i = 0; i < n; i++) {
        const h = hist[Math.min(i, hist.length - 1)], fresh = i < hist.length ? 1 : 0;
        pos.set(h.b, i * 6); pos.set(h.t, i * 6 + 3);
        col.set([1, 1, 1, fresh, 1, 1, 1, fresh], i * 8);
      }
      g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; m.visible = true;
    } };
    return R;
  }

  // ---- 폭발 --------------------------------------------------------------------------------------
  const ballGeo = new T.IcosahedronGeometry(1, coarse ? 3 : 4), ringGeo = new T.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const booms = [];
  function boom(x, y, z, gy, R, party) {
    const seed = rnd() * 50, dur = party ? 0.5 : 0.95;
    const ball = new T.Mesh(ballGeo, new T.ShaderMaterial({ uniforms: { uTime, uSeed: { value: seed }, uAge: { value: 0 }, uParty: { value: party ? 1 : 0 } }, vertexShader: BALL_VS, fragmentShader: BALL_FS, ...ADD, side: T.FrontSide }));
    ball.position.set(x, y + 0.4, z); ball.frustumCulled = false; ball.renderOrder = 7;
    const ring = new T.Mesh(ringGeo, new T.ShaderMaterial({ uniforms: { uAge: { value: 0 }, uSeed: { value: seed }, uParty: { value: party ? 1 : 0 }, uTint: { value: new T.Color(1.0, 0.7, 0.35) } }, vertexShader: SLASH_VS, fragmentShader: RING_FS, ...ADD }));
    ring.position.set(x, gy + 0.06, z); ring.frustumCulled = false; ring.renderOrder = 7;
    scene.add(ball, ring); booms.push({ ball, ring, t: 0, dur, R, party });
    // 빛 번짐(가짜 블룸) 두 겹
    emit(0, x, y + 0.6, z, 0, 0, 0, party ? 1.1 : 1.4, party ? 1.0 : 0.7, party ? 1.1 : 0.35, 0.7, 0.25, R * 0.5, R * 1.3);
    emit(0, x, y + 0.6, z, 0, 0, 0, 1.2, 1.1, 1.0, 0.8, 0.06, R * 0.6, R * 0.25);
    if (party) {
      for (let i = 0; i < 46; i++) { const v = sph(6 + rnd() * 9), c = rampParty(); emit(1, x, y + 0.4, z, v[0], Math.abs(v[1]) + 2, v[2], c[0], c[1], c[2], 1, 0.35 + rnd() * 0.35, 0.08, 0.02, 2.4, 5); }
      for (let i = 0; i < 50; i++) { const v = sph(2 + rnd() * 6), c = rampParty(); emit(3, x, y + 0.5, z, v[0], Math.abs(v[1]) * 1.4 + 1.5, v[2], c[0] * 1.4, c[1] * 1.4, c[2] * 1.4, 1, 1.0 + rnd() * 1.2, 0.14, 0.05, 1.6, 1.4); }
      for (let i = 0; i < 6; i++) emit(2, x + (rnd() - 0.5), y + 0.3, z + (rnd() - 0.5), (rnd() - 0.5) * 2, 0.8 + rnd(), (rnd() - 0.5) * 2, 0.5, 0.45, 0.55, 0.25, 1.0 + rnd() * 0.6, 0.4, 1.6, 1.8, -0.3);
      return;
    }
    for (let i = 0; i < 60; i++) { const v = sph(10 + rnd() * 18); emit(1, x, y + 0.4, z, v[0], Math.abs(v[1]) * 1.2 + 1, v[2], 1.5, 0.75, 0.3, 1, 0.3 + rnd() * 0.5, 0.12, 0.03, 2.2, 9); }
    for (let i = 0; i < 40; i++) { const v = sph(3 + rnd() * 7); emit(3, x, y + 0.6, z, v[0], Math.abs(v[1]) + 2, v[2], 1.5, 0.55, 0.15, 1, 1.0 + rnd() * 1.4, 0.12, 0.04, 1.2, 2.5); }
    for (let i = 0; i < 22; i++) {   // 검은 연기 기둥: 늦게 생겨 위로 퍼진다
      const v = sph(1.2 + rnd() * 2.5), sh = 0.035 + rnd() * 0.04;
      emit(2, x + v[0] * 0.3, y + 0.5 + rnd() * 0.8, z + v[2] * 0.3, v[0], Math.abs(v[1]) + 2.2 + rnd() * 1.5, v[2], sh, sh * 0.95, sh * 0.92, 0.82, 2.2 + rnd() * 1.6, R * 0.25, R * 0.75, 1.4, -0.6, 0.08 + rnd() * 0.2);
    }
  }
  const PARTY_C = [[1.6, 0.35, 0.6], [1.6, 1.25, 0.3], [0.35, 1.2, 1.6], [0.6, 1.6, 0.5], [1.0, 0.6, 1.7], [1.6, 1.6, 1.6]];
  const rampParty = () => PARTY_C[(rnd() * PARTY_C.length) | 0];

  function update(dt) {
    time += dt; uTime.value = time;
    for (const S of [add, smoke]) if (S.dirty) { S.dirty = false; for (const a of [S.P, S.V, S.C, S.Tm, S.K]) a.needsUpdate = true; }
    for (const f of flames) if (f.m.visible) { f.t -= dt; if (f.t <= 0) f.m.visible = false; else f.m.material.uniforms.uK.value = f.t / f.t0; }
    for (let i = booms.length - 1; i >= 0; i--) {
      const b = booms[i]; b.t += dt; const u = Math.min(1, b.t / b.dur);
      const s = (b.party ? 0.5 : 0.7) + b.R * (b.party ? 0.32 : 0.5) * (1 - Math.pow(1 - u, 2.4));
      b.ball.scale.setScalar(s); b.ball.position.y += dt * (b.party ? 0.3 : 1.1); b.ball.material.uniforms.uAge.value = u;
      const ru = Math.min(1, b.t / 0.55); b.ring.scale.setScalar(b.R * 1.15); b.ring.material.uniforms.uAge.value = ru;
      if (u >= 1 && ru >= 1) { scene.remove(b.ball, b.ring); b.ball.material.dispose(); b.ring.material.dispose(); booms.splice(i, 1); }
    }
  }
  function dispose() {
    for (const b of booms) scene.remove(b.ball, b.ring); booms.length = 0;
    for (const f of flames) scene.remove(f.m);
    scene.remove(add.mesh, smoke.mesh);
  }
  return { emit, hit, muzzle, moveMuzzle, boom, ribbon, slashMat, deathMat, tracerMat, update, dispose, coneVel, get time() { return time; }, stats: () => ({ add: add.n, smoke: smoke.n, booms: booms.length }) };
}
