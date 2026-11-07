// bf/bossfx.js — 보스 공격 이펙트 공용 엔진: 셰이더 재질(노이즈·디졸브·가산 블렌딩·프레넬 빛 번짐) + 풀링된 파티클 3종.
//
//   const V = bossVfx(THREE, scene)          // 장면마다 하나(캐시). THREE 에 ShaderMaterial/Points 가 없으면(node 테스트) 아무것도 안 하는 가짜.
//   V.mat('shock', '#ffd9a0', 0.9)          // 기존 MeshBasicMaterial 자리에 그대로 꽂는다(.opacity 를 그대로 쓴다 · .uT 로 디졸브 진행)
//   V.burst('spark', x, y, z, { n, color, speed, up })   // 불꽃·잔불·연기·섬광·먼지·물보라·독·파편·불길·빛 입자
//   V.tick(dt)                               // 보스마다 불러도 한 프레임에 한 번만 돈다
//
// 성능: 파티클은 풀 3개(가산 점 · 줄 잔상 · 연기 점)에 고정 버퍼, 드로우 콜 3개. 죽은 입자는 크기 0(버퍼 재할당 없음).
// 재질 모드: shock(땅 충격파 고리) · pool(바닥 장판·균열·그을음) · beam(광선·빛 기둥) · slash(검기·손톱 궤적) · orb(불덩이·독침 빛) · sigil(문장 고리)

const MODES = { shock: 0, pool: 1, beam: 2, slash: 3, orb: 4, sigil: 5 };
const cache = new WeakMap();
const NOOP = { mat: () => null, burst() {}, ring() {}, tick() {}, impact() {}, ok: false };

const NOISE = /* glsl */`
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
float ridge(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * (1.0 - abs(vn(p) * 2.0 - 1.0)); p *= 2.1; a *= 0.55; } return s; }
`;

const VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz);
  gl_Position = projectionMatrix * viewMatrix * w; }`;

const FRAG = /* glsl */`
uniform vec3 uC; uniform vec3 uHot; uniform float uO; uniform float uT; uniform float uTime; uniform float uIn; uniform float uSeed;
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vW;
${NOISE}
void main(){
  float a = 0.0; vec3 col = uC; float tm = uTime + uSeed * 17.0;
#if MODE == 0
  // 충격파: 고리 띠 안쪽→바깥 그라데이션, 바깥 가장자리가 하얗게 달고 노이즈로 끊긴다(디졸브는 uT)
  vec2 d = vUv - 0.5; float r = length(d) * 2.0, ang = atan(d.y, d.x);
  float t = clamp((r - uIn) / max(1e-3, 1.0 - uIn), 0.0, 1.0);
  float n = fbm(vec2(ang * 5.0, t * 3.0 - tm * 2.0));
  float band = pow(t, 2.2) * smoothstep(1.0, 0.86, t);
  float edge = smoothstep(0.62, 0.92, t) * smoothstep(1.0, 0.9, t);
  a = band * (0.55 + 0.9 * n) * smoothstep(uT - 0.25, uT + 0.05, n);
  col = mix(uC, uHot, edge * 0.9) * (1.0 + edge * 1.5);
#elif MODE == 1
  // 장판·균열: 흐르는 fbm 열 + 갈라진 줄(ridge) 이 밝게 달아오르고, 가장자리는 노이즈로 녹아 사라진다
  vec2 d = vUv - 0.5; float r = length(d) * 2.0;
  float heat = fbm(d * 5.0 + vec2(tm * 0.4, -tm * 0.55));
  float cr = pow(ridge(d * 7.0 + uSeed * 3.0), 6.0);
  float rim = smoothstep(1.0, 0.55 + 0.25 * heat, r);
  a = rim * (0.35 * heat + 1.3 * cr) * smoothstep(uT - 0.2, uT + 0.1, heat);
  col = mix(uC, uHot, clamp(cr * 1.4, 0.0, 1.0)) * (0.8 + 1.4 * cr);
#elif MODE == 2
  // 광선·기둥: 길이 방향으로 흐르는 노이즈, 프레넬로 가장자리 빛 번짐, 가운데는 하얗게 탄다
  float fr = abs(dot(normalize(vN), normalize(vV)));
  float flow = fbm(vec2(vUv.x * 6.0, vUv.y * 8.0 - tm * 6.0));
  float streak = pow(vn(vec2(vUv.x * 24.0, vUv.y * 2.0 - tm * 9.0)), 3.0);
  float ends = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
  a = ends * (pow(fr, 1.6) * (0.6 + 0.8 * flow) + streak * 0.7) * smoothstep(uT - 0.2, uT + 0.1, flow);
  col = mix(uC, uHot, pow(fr, 4.0)) * (1.0 + 1.2 * pow(fr, 6.0));
#elif MODE == 3
  // 검기·손톱 궤적: 호의 각도 방향으로 꼬리가 가늘어지고, 앞날은 하얀 날, 뒤는 노이즈로 흩어진다
  vec2 d = vUv - 0.5; float r = length(d) * 2.0, ang = atan(d.y, d.x) / 6.2831 + 0.5;
  float t = clamp((r - uIn) / max(1e-3, 1.0 - uIn), 0.0, 1.0);
  float n = fbm(vec2(ang * 14.0 - tm * 3.0, t * 4.0));
  float blade = smoothstep(0.0, 0.25, t) * smoothstep(1.0, 0.7, t);
  float edge = exp(-pow((t - 0.78) * 9.0, 2.0));
  a = (blade * (0.4 + 0.8 * n) + edge * 1.4) * smoothstep(uT - 0.3, uT, n * 0.8 + t * 0.35);
  col = mix(uC, uHot, edge) * (1.0 + edge * 1.8);
#elif MODE == 4
  // 구체(불덩이·독 빛): 프레넬 테두리 + 안쪽에서 끓는 노이즈
  float fr = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float n = fbm(vW.xz * 0.8 + vW.y * 0.6 + vec2(tm * 1.5, -tm * 2.1));
  a = (pow(fr, 1.5) * 1.2 + (1.0 - fr) * 0.55 * n) * smoothstep(uT - 0.2, uT + 0.1, n);
  col = mix(uHot, uC, clamp(fr * 1.3, 0.0, 1.0)) * (1.0 + 0.8 * n);
#else
  // 문장 고리: 바깥 가는 줄 + 돌아가는 룬 점선
  vec2 d = vUv - 0.5; float r = length(d) * 2.0, ang = atan(d.y, d.x);
  float t = clamp((r - uIn) / max(1e-3, 1.0 - uIn), 0.0, 1.0);
  float line = exp(-pow((t - 0.85) * 14.0, 2.0)) + 0.6 * exp(-pow((t - 0.35) * 18.0, 2.0));
  float rune = step(0.55, fract(ang * 3.8197 + tm * 0.3)) * smoothstep(0.45, 0.6, t) * smoothstep(0.75, 0.6, t);
  a = (line + rune * 0.8) * (0.7 + 0.3 * sin(tm * 6.0 + ang * 3.0));
  col = mix(uC, uHot, line * 0.6) * 1.4;
#endif
  a *= uO; if (a < 0.002) discard;
  gl_FragColor = vec4(col * a, a);
}`;

// ---------- 파티클 ----------
const P_VERT = /* glsl */`
attribute vec3 aCol; attribute float aSize; attribute float aA; uniform float uScale;
varying vec3 vC; varying float vA;
void main(){ vC = aCol; vA = aA; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`;
const P_FRAG_ADD = /* glsl */`
varying vec3 vC; varying float vA;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0) discard;
  float core = exp(-r * r * 9.0), halo = exp(-r * r * 2.4) * 0.45; float a = (core + halo) * vA;
  gl_FragColor = vec4(vC * a + vec3(core * core * vA * 0.6), a); }`;
const P_FRAG_SMOKE = /* glsl */`
varying vec3 vC; varying float vA;
${NOISE}
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0) discard;
  float n = vn(gl_PointCoord * 4.0 + vA * 9.0); float a = smoothstep(1.0, 0.2, r + n * 0.35) * vA;
  gl_FragColor = vec4(vC, a); }`;
const L_VERT = /* glsl */`attribute vec3 aCol; varying vec3 vC; void main(){ vC = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const L_FRAG = /* glsl */`varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`;

// 입자 종류: [풀, 수명, 속도, 위쪽, 중력, 끌림, 크기0, 크기1, 기본색, 뜨거운색, 퍼짐]
const KIND = {
  spark:  ['line', 0.55, 16, 0.6, 18, 2.0, 0, 0, '#ffb050', '#fff4d0', 0.3],
  ember:  ['add', 1.6, 2.5, 2.2, -1.2, 1.2, 0.35, 0.1, '#ff6a1a', '#ffd080', 0.8],
  fire:   ['add', 0.7, 2.2, 5.5, -3, 2.5, 2.2, 0.6, '#ff4a10', '#ffe0a0', 0.9],
  flash:  ['add', 0.16, 0, 0, 0, 0, 14, 22, '#ffe0b0', '#ffffff', 0],
  light:  ['add', 1.2, 1.5, 4, -2, 1.5, 0.5, 0.15, '#ffd27a', '#ffffff', 1.2],
  venom:  ['add', 0.7, 7, 2.5, 14, 2.0, 0.6, 0.2, '#6dff2a', '#e8ffb0', 0.3],
  splash: ['add', 1.0, 9, 9, 20, 0.8, 0.7, 0.4, '#bfe8ff', '#ffffff', 0.5],
  smoke:  ['smoke', 1.6, 2, 2.2, -0.6, 1.6, 2.0, 5.5, '#2a2522', '#2a2522', 1.0],
  dust:   ['smoke', 1.2, 7, 1.0, -0.2, 3.0, 1.6, 4.5, '#9a8468', '#9a8468', 0.6],
  mist:   ['smoke', 1.2, 5, 3, -0.4, 2.2, 2.4, 6.5, '#e6f4ff', '#e6f4ff', 0.6],
  debris: ['smoke', 1.1, 10, 9, 26, 0.5, 0.6, 0.5, '#3e3830', '#3e3830', 0.4],
  web:    ['line', 0.6, 9, 1.0, 6, 3.0, 0, 0, '#eef4ff', '#ffffff', 0.4],
};

export function bossVfx(THREE, scene) {
  if (!THREE || !THREE.ShaderMaterial || !THREE.Points || !THREE.BufferGeometry || !scene) return NOOP;
  let V = cache.get(scene); if (V) return V;
  const TIME = { value: 0 };
  const tmpC = new THREE.Color(), tmpH = new THREE.Color();

  function mat(mode, color, opacity = 1, o = {}) {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, defines: { MODE: MODES[mode] ?? 0 },
      uniforms: { uC: { value: new THREE.Color(color) }, uHot: { value: new THREE.Color(o.hot || '#ffffff') }, uO: { value: opacity }, uT: { value: 0 }, uTime: TIME, uIn: { value: o.inner ?? 0.86 }, uSeed: { value: Math.random() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    // 기존 코드가 쓰던 material.opacity · material.color 를 유니폼으로 잇는다
    Object.defineProperty(m, 'opacity', { get: () => m.uniforms.uO.value, set: (v) => { m.uniforms.uO.value = v; }, configurable: true });
    Object.defineProperty(m, 'uT', { get: () => m.uniforms.uT.value, set: (v) => { m.uniforms.uT.value = v; }, configurable: true });
    m.color = m.uniforms.uC.value;
    m.userData.own = true;
    return m;
  }

  function pool(kind, N) {
    const isLine = kind === 'line', verts = isLine ? N * 2 : N;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(verts * 3), col = new Float32Array(verts * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    let size = null, alpha = null;
    if (!isLine) {
      size = new Float32Array(N); alpha = new Float32Array(N);
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aA', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    }
    const H = (typeof window !== 'undefined' && window.innerHeight) || 900;
    const m = isLine
      ? new THREE.ShaderMaterial({ vertexShader: L_VERT, fragmentShader: L_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
      : new THREE.ShaderMaterial({ vertexShader: P_VERT, fragmentShader: kind === 'smoke' ? P_FRAG_SMOKE : P_FRAG_ADD, uniforms: { uScale: { value: H * 0.85 } }, transparent: true, depthWrite: false, blending: kind === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending });
    const o = isLine ? new THREE.LineSegments(g, m) : new THREE.Points(g, m);
    o.frustumCulled = false; o.renderOrder = kind === 'smoke' ? 5 : 6; scene.add(o);
    // 입자 상태: x y z vx vy vz age life s0 s1 r g b hr hg hb grav drag
    const st = new Float32Array(N * 18); for (let i = 0; i < N; i++) st[i * 18 + 7] = -1;
    return { N, st, pos, col, size, alpha, g, isLine, next: 0, live: 0 };
  }
  const pools = { add: pool('add', 2400), line: pool('line', 1200), smoke: pool('smoke', 700) };

  function emit(P, x, y, z, vx, vy, vz, life, s0, s1, c, h, grav, drag) {
    let i = P.next, tries = 0;
    while (P.st[i * 18 + 7] >= 0 && P.st[i * 18 + 6] < P.st[i * 18 + 7] && tries++ < 32) i = (i + 1) % P.N;   // 빈 칸 찾기, 없으면 가장 오래된 것을 덮는다
    P.next = (i + 1) % P.N;
    const s = P.st, k = i * 18;
    s[k] = x; s[k + 1] = y; s[k + 2] = z; s[k + 3] = vx; s[k + 4] = vy; s[k + 5] = vz; s[k + 6] = 0; s[k + 7] = life;
    s[k + 8] = s0; s[k + 9] = s1; s[k + 10] = c.r; s[k + 11] = c.g; s[k + 12] = c.b; s[k + 13] = h.r; s[k + 14] = h.g; s[k + 15] = h.b; s[k + 16] = grav; s[k + 17] = drag;
  }

  // burst(kind, x, y, z, { n, color, hot, speed, up, size, life, spread, dir:[x,y,z] })
  function burst(kind, x, y, z, o = {}) {
    const K = KIND[kind]; if (!K) return;
    const P = pools[K[0]], n = o.n ?? (kind === 'flash' ? 1 : 10);
    tmpC.set(o.color || K[8]); tmpH.set(o.hot || K[9]);
    const sp = K[2] * (o.speed ?? 1), up = K[3] * (o.up ?? 1), spread = (o.spread ?? 1) * K[10], sz = o.size ?? 1, lf = o.life ?? 1, dir = o.dir;
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), v = sp * (0.35 + 0.65 * Math.random());
      let vx = Math.sin(ph) * Math.cos(th) * v, vy = Math.abs(Math.cos(ph)) * v * 0.5 + up * (0.5 + Math.random() * 0.8), vz = Math.sin(ph) * Math.sin(th) * v;
      if (dir) { vx = vx * 0.35 + dir[0] * sp; vy = vy * 0.35 + dir[1] * sp; vz = vz * 0.35 + dir[2] * sp; }
      emit(P, x + (Math.random() - 0.5) * spread * 2, y + (Math.random() - 0.5) * spread, z + (Math.random() - 0.5) * spread * 2, vx, vy, vz,
        K[1] * lf * (0.6 + Math.random() * 0.6), K[6] * sz * (0.7 + Math.random() * 0.6), K[7] * sz * (0.7 + Math.random() * 0.6), tmpC, tmpH, K[4], K[5]);
    }
  }
  // 둘레를 따라 한꺼번에(충격파 먼지 고리·물보라 고리)
  function ring(kind, x, y, z, r, o = {}) {
    const n = o.n ?? 24, K = KIND[kind]; if (!K) return;
    const P = pools[K[0]]; tmpC.set(o.color || K[8]); tmpH.set(o.hot || K[9]);
    const sp = K[2] * (o.speed ?? 1), sz = o.size ?? 1;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2, cx = Math.cos(a), cz = Math.sin(a), v = sp * (0.6 + Math.random() * 0.5);
      emit(P, x + cx * r, y + 0.2, z + cz * r, cx * v, K[3] * (o.up ?? 1) * (0.4 + Math.random() * 0.8), cz * v, K[1] * (0.6 + Math.random() * 0.6), K[6] * sz, K[7] * sz, tmpC, tmpH, K[4], K[5]);
    }
  }

  let last = -1;
  function tick(dt) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - last < 4) return; last = now;   // 보스 여럿이 불러도 프레임당 한 번
    dt = Math.min(0.05, dt); TIME.value += dt;
    for (const name in pools) {
      const P = pools[name], s = P.st;
      for (let i = 0; i < P.N; i++) {
        const k = i * 18, life = s[k + 7];
        if (life < 0) continue;
        s[k + 6] += dt; const u = s[k + 6] / life;
        if (u >= 1) {
          s[k + 7] = -1;
          if (P.isLine) { P.pos.fill(0, i * 6, i * 6 + 6); P.col.fill(0, i * 6, i * 6 + 6); } else { P.size[i] = 0; P.alpha[i] = 0; }
          continue;
        }
        const dr = Math.exp(-s[k + 17] * dt);
        s[k + 3] *= dr; s[k + 5] *= dr; s[k + 4] = s[k + 4] * dr - s[k + 16] * dt;
        s[k] += s[k + 3] * dt; s[k + 1] += s[k + 4] * dt; s[k + 2] += s[k + 5] * dt;
        const heat = Math.max(0, 1 - u * 2.2), fade = name === 'smoke' ? Math.sin(Math.PI * Math.min(1, u * 1.1)) * 0.3 : (1 - u) * (1 - u);
        const r = s[k + 10] + (s[k + 13] - s[k + 10]) * heat, g = s[k + 11] + (s[k + 14] - s[k + 11]) * heat, b = s[k + 12] + (s[k + 15] - s[k + 12]) * heat;
        if (P.isLine) {   // 속도 방향 잔상(빠를수록 길다)
          const j = i * 6, L = 0.035;
          P.pos[j] = s[k]; P.pos[j + 1] = s[k + 1]; P.pos[j + 2] = s[k + 2];
          P.pos[j + 3] = s[k] - s[k + 3] * L; P.pos[j + 4] = s[k + 1] - s[k + 4] * L; P.pos[j + 5] = s[k + 2] - s[k + 5] * L;
          P.col[j] = r * fade * 2; P.col[j + 1] = g * fade * 2; P.col[j + 2] = b * fade * 2; P.col[j + 3] = 0; P.col[j + 4] = 0; P.col[j + 5] = 0;
        } else {
          const j = i * 3; P.pos[j] = s[k]; P.pos[j + 1] = s[k + 1]; P.pos[j + 2] = s[k + 2];
          P.col[j] = r; P.col[j + 1] = g; P.col[j + 2] = b;
          P.size[i] = s[k + 8] + (s[k + 9] - s[k + 8]) * u; P.alpha[i] = fade;
        }
      }
      const at = P.g.attributes; at.position.needsUpdate = true; at.aCol.needsUpdate = true;
      if (!P.isLine) { at.aSize.needsUpdate = true; at.aA.needsUpdate = true; }
    }
  }

  // 타격 한 방: 섬광 + 불꽃 + (연기) — 화면 흔들림 없이도 「맞았다」가 읽히게
  function impact(x, y, z, o = {}) {
    burst('flash', x, y + 0.6, z, { color: o.color, hot: o.hot, size: o.size ?? 1 });
    burst('spark', x, y + 0.4, z, { n: o.sparks ?? 26, color: o.color, hot: o.hot, speed: o.speed ?? 1 });
    if (o.smoke !== false) burst(o.smokeKind || 'smoke', x, y + 0.3, z, { n: o.smokeN ?? 6, size: o.size ?? 1, color: o.smokeColor });
  }

  V = { ok: true, mat, burst, ring, tick, impact, TIME };
  cache.set(scene, V);
  return V;
}
