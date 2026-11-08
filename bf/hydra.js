import { applyLook, spring, breath as breathe } from './bosslook.js';
// bf/hydra.js — 보스: 뼈 가면 히드라(머리 셋 달린 용). bf/bosses.js 의 허브(createBossHub)에 'hydra' 로 붙는다.
// 모델: tools/bosses/build_hydra.py (Blender) → bf/hydra.glb (Draco, LOD0/LOD1, 뼈대만 · 클립 없음). 움직임은 아래 animate() 가 뼈 이름으로 만든다.
//
// 네트워크는 다른 보스와 같다: 소유자 한 명이 AI 를 돌리고 `boss` 주제로 초당 8번 스냅샷(kd:'hydra')을 보낸다. 패턴은 카운터(ac)가 바뀔 때
// 모두가 같은 시간표로 재생하고(조준 sa · 목표 tx/tz · 머리별 목표 pt), 내가 맞았는지는 내 화면이 판정한다.
// 동작 코드는 모두 'h' 로 시작해 거미·다른 보스 코드와 겹치지 않는다(옛 클라이언트는 이 스냅샷을 거부한다).
//
// 머리별 판정: 머리 캡슐에 맞으면 id 가 머리 번호(1 왼 · 2 가운데 · 3 오른)다. 머리 피해는 1.5배이고 머리마다 따로 체력이 있다.
// 머리 체력이 0 이면 그 머리는 가면이 깨진 채 축 늘어지고 더는 불을 뿜지 않는다(전체 체력도 같이 깎인다). 머리 둘이 깨지거나 35% 아래면 분노.
//
// 패턴: hbreath(머리마다 다른 사람을 노리는 화염 브레스 + 불 장판) · hsnap(세 머리 물기) · hsweep(몸을 한 바퀴 돌리는 가시 꼬리 휩쓸기)
//       · hdive(날아올라 내리꽂는 비행 강하 + 충격파).

import { rayCapsule } from './weapons-core.js';
import { bossVfx } from './bossfx.js';   // 셰이더 재질 + 풀링 파티클(공용 · node 테스트에선 아무것도 안 하는 가짜)

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapA = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const r2 = (v) => Math.round(v * 100) / 100;
const finite = (v, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : null);
const beats = (stA, idA, stB, idB) => stA < stB || (stA === stB && idA < idB);
const outranks = (epA, bornA, idA, epB, bornB, idB) => (epA !== epB ? epA > epB : beats(bornA, idA, bornB, idB));
const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const faceTo = (dx, dz) => Math.atan2(-dx, -dz);
const bl = (p) => [p[0], p[2], -p[1]];   // Blender(x, y 앞, z 위) → three(x, z, -y)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addS = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------------------------------------------------------------------------------------------------------------------
// 골격 좌표 (build_hydra.py 와 같은 값, Blender 좌표)
// ---------------------------------------------------------------------------------------------------------------------
const NECKS = {
  L: [[-1.9, 5.0, 8.7], [-3.9, 7.0, 10.3], [-5.7, 8.7, 11.6], [-6.7, 10.1, 12.2], [-7.8, 13.1, 11.7]],
  C: [[0, 5.4, 9.2], [0, 7.6, 11.6], [0, 9.6, 13.4], [0, 11.1, 14.4], [0, 14.3, 14.0]],
  R: [[1.9, 5.0, 8.7], [3.9, 7.0, 10.3], [5.7, 8.7, 11.6], [6.7, 10.1, 12.2], [7.8, 13.1, 11.7]],
};
// 재질별 전용 조명(bf/bosslook.js) — [key, wrap, rim, spec, 발광색, 발광세기, 발광에 색맵]
export const LOOK = {
  exact: {
    hydra_scale:    [1.0, [0.28, 0.07, 0.04], 0.55, 0.9, '#000000', 0, false],  // 젖은 비늘: 키 하이라이트가 비늘 결을 따라 반짝
    hydra_bone:     [1.1, [0.22, 0.16, 0.1], 0.45, 0.6, '#000000', 0, false],   // 뼈 가면
    hydra_spike:    [1.0, [0.12, 0.06, 0.04], 0.45, 1.0, '#000000', 0, false],
    hydra_membrane: [0.85, [0.55, 0.1, 0.05], 0.7, 0.3, '#3a0804', 0.12, true], // 날개막: 빛이 비쳐 붉게 번짐
    hydra_claw:     [0.8, [0.05, 0.03, 0.02], 0.4, 1.4, '#000000', 0, false],
    hydra_teeth:    [0.9, [0.2, 0.15, 0.08], 0.3, 0.9, '#000000', 0, false],
    hydra_gum:      [0.9, [0.45, 0.08, 0.05], 0.3, 1.0, '#000000', 0, false],
    hydra_mouth:    [0.7, [0.5, 0.1, 0.04], 0.2, 0.6, '#3a0a02', 0.3, false],
    hydra_tongue:   [0.8, [0.45, 0.08, 0.06], 0.2, 1.1, '#000000', 0, false],
  },
  glow: /hydra_(eye|pupil)/,
};
export const HEADS = ['L', 'C', 'R'];
const headTip = (k, len) => { const p = NECKS[k]; return addS(p[3], nrm(sub(p[4], p[3])), len); };
const mouthPt = (k) => addS(headTip(k, 3.2), [0, 0, -0.5], 1);
const TAIL = [[0, -4.6, 7.0], [0, -9.0, 5.2], [0, -13.2, 3.3], [0, -17.2, 2.0], [0, -21.6, 1.4]];
const LEGS = {
  FL: [[-2.6, 3.4, 7.2], [-3.8, 4.4, 4.0], [-3.6, 5.0, 1.0]], FR: [[2.6, 3.4, 7.2], [3.8, 4.4, 4.0], [3.6, 5.0, 1.0]],
  BL: [[-2.4, -3.6, 6.8], [-3.5, -1.9, 3.9], [-3.3, -4.0, 1.3]], BR: [[2.4, -3.6, 6.8], [3.5, -1.9, 3.9], [3.3, -4.0, 1.3]],
};
const WING = (s) => ({ sh: [2.0 * s, 2.4, 9.9], el: [6.2 * s, 1.2, 13.4], wr: [10.4 * s, -0.4, 14.8], f: [[18.6 * s, -2.6, 12.6], [17.6 * s, -6.6, 9.0], [14.4 * s, -8.6, 6.8], [10.4 * s, -7.8, 6.6]] });

// 몸 캡슐: [뼈, a, b, 반지름, col(땅까지 기둥), 머리 번호(0 = 몸)]
function buildHull() {
  const h = [
    ['hips', [0, -4.6, 7.0], [0, 0, 7.6], 2.6, true, 0], ['chest', [0, 0, 7.6], [0, 5.0, 8.6], 2.9, true, 0], ['chest', [0, 1.0, 5.6], [0, 4.0, 5.8], 2.0, false, 0],
    ['t1', TAIL[0], TAIL[1], 2.0, false, 0], ['t2', TAIL[1], TAIL[2], 1.4, false, 0], ['t3', TAIL[2], TAIL[3], 0.95, false, 0], ['t4', TAIL[3], TAIL[4], 0.75, false, 0],
  ];
  HEADS.forEach((k, i) => {
    const p = NECKS[k];
    h.push([`n${k}1`, p[0], p[1], 1.45, false, 0], [`n${k}2`, p[1], p[2], 1.2, false, 0], [`n${k}3`, p[2], p[3], 1.05, false, 0]);
    h.push([`head${k}`, addS(p[3], nrm(sub(p[4], p[3])), -0.2), headTip(k, 3.3), 1.05, false, i + 1]);
    h.push([`jaw${k}`, addS(headTip(k, 0.4), [0, 0, -0.75], 1), addS(headTip(k, 3.0), [0, 0, -0.85], 1), 0.6, false, i + 1]);
  });
  for (const k in LEGS) { const p = LEGS[k]; h.push([`leg${k}`, p[0], p[1], 1.45, true, 0], [`shin${k}`, p[1], p[2], 1.05, true, 0]); }
  for (const [s, sd] of [[-1, 'L'], [1, 'R']]) {
    const w = WING(s);
    h.push([`wing${sd}1`, w.sh, w.el, 0.9, false, 0], [`wing${sd}2`, w.el, w.wr, 0.7, false, 0]);
    h.push([`wing${sd}3`, w.wr, w.f[0], 0.6, false, 0], [`wing${sd}3`, w.wr, w.f[1], 2.0, false, 0], [`wing${sd}3`, w.wr, w.f[2], 2.0, false, 0], [`wing${sd}2`, w.el, [8.0 * s, -5.0, 8.0], 2.2, false, 0]);
  }
  return h;
}

export const DEF = {
  name: '뼈가면 히드라', title: '세 머리의 재앙 · 히드라', file: 'hydra.glb', hp: 7200, hpPerExtra: 2400, headShare: 0.16, headMul: 1.5,
  hitReach: 36, camR: 1.15, camLift: 1.6, lodD: 85, speed: 4.4, turn: 0.95, spawnT: 3.8, dieT: 6.5, hull: buildHull(),
  patterns: [
    { code: 'hbreath', w: 5, cd: 7.0, minD: 0, maxD: 34, dur: 3.4 },
    { code: 'hsnap', w: 4, cd: 3.6, minD: 0, maxD: 17, dur: 1.6 },
    { code: 'hsweep', w: 3, cd: 6.5, minD: 0, maxD: 22, dur: 2.4 },
    { code: 'hdive', w: 3, cd: 10.5, minD: 12, maxD: 62, dur: 4.8 },
  ],
};
// 패턴 피해(내 HP 100 기준 — index.html 이 HP 1,000 에 맞춰 7.5배) · 넉백
export const HITS = { hbreath: [12, 0.8], hsnap: [30, 2.4], hsweep: [28, 3.2], hdive: [34, 3.0], hring: [16, 1.8], burn: [7, 0.2] };
export const ACTS = new Set(['idle', 'move', 'spawn', 'die', ...DEF.patterns.map((p) => p.code)]);
// index.html 이 쓰는 글귀
export const LOG = { spawn: '하늘이 붉게 물들고 뼈 가면 히드라가 내려앉습니다! 세 머리가 동시에 울부짖습니다.', die: '히드라의 마지막 머리가 쓰러졌습니다!', gone: '히드라' };
export const HIT_MSG = { hbreath: '히드라의 화염 브레스에 휩싸였습니다!', hsnap: '히드라의 머리에 물렸습니다!', hsweep: '가시 꼬리에 휩쓸렸습니다! (점프로 넘을 수 있습니다)', hdive: '내리꽂힌 히드라에 깔렸습니다!', hring: '충격파에 휩쓸렸습니다.' };

// 꼬리 휩쓸기 궤적 셰이더(공용 slash 는 호 끝이 뚝 끊겨서, 앞날 → 꼬리로 점점 사라지는 이 전용을 쓴다). 부채꼴 안 각도 φ∈[-len, 0] 가 앞날 0 → 꼬리 끝 -len.
const ARC_LEN = 2.2;
const ARC_V = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_F = /* glsl */`uniform vec3 uC; uniform vec3 uHot; uniform float uO; uniform float uT; uniform float uLen; uniform float uTime; varying vec2 vUv;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main(){
  vec2 d = vUv - 0.5; float r = length(d) * 2.0, ang = atan(d.y, d.x);
  float tr = clamp(-ang / uLen, 0.0, 1.0);                       // 0 = 앞날, 1 = 꼬리 끝
  float t = clamp((r - 0.6) / 0.4, 0.0, 1.0);                    // 0 = 안쪽, 1 = 바깥
  float n = vn(vec2(ang * 9.0 - uTime * 3.0, r * 16.0)) * 0.65 + vn(vec2(ang * 23.0, r * 40.0 + uTime * 2.0)) * 0.35;
  float blade = smoothstep(0.0, 0.25, t) * smoothstep(1.0, 0.72, t);
  float edge = exp(-pow((t - 0.8) * 7.0, 2.0)) * pow(1.0 - tr, 2.5);
  float fade = pow(1.0 - tr, 1.7);
  float a = (blade * (0.25 + 0.85 * n) * fade + edge * 0.9) * smoothstep(uT - 0.25, uT + 0.05, n * 0.8 + (1.0 - tr) * 0.3);
  a *= uO; if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uC, uHot, clamp(edge * 1.3, 0.0, 1.0)) * a, a);
}`;

// ---------------------------------------------------------------------------------------------------------------------
export function createHydraBoss(ctx) {
  const kind = 'hydra', D = DEF;
  const { THREE, scene } = ctx;
  const VX = bossVfx(THREE, scene);   // 셰이더 재질 + 풀링 파티클(보스 공용)
  const acc = {};   // 초당 방출량을 프레임 수와 무관하게 맞추는 누적기
  const rate = (k, perSec, dt) => { const v = (acc[k] || 0) + perSec * dt, n = Math.floor(v); acc[k] = v - n; return n; };
  const B = { kind, active: false, owner: false, ownerId: '', ep: 0, born: 0, x: 0, z: 0, y: 0, ry: 0, hp: 0, maxHp: 0, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], seq: 0, spawnT: 0, dieT: 0, rage: false, haz: [], hh: [0, 0, 0], hMax: 0, pitch: 0 };
  const R = { tx: 0, tz: 0, ty: 0, try_: 0, lastAc: 0, lastSnap: 0 };
  const O = { cd: {}, gap: 1.2, hitAt: new Map(), hazId: 0 };
  const act = { cur: null };
  const listeners = {};
  const emit = (k, v) => { for (const f of listeners[k] || []) { try { f(v); } catch (e) { /* listener */ } } };
  const myHit = {};
  let assets = null, loading = null, loadFailed = false, rig = null;
  const fxl = [];
  const hazVis = new Map();
  const capsW = [];
  const headUp = (i) => B.hh[i] > 0;
  const headsUp = () => B.hh.filter((v) => v > 0).length;

  // ---------- 에셋 ----------
  function load() {
    if (assets) return Promise.resolve(assets);
    if (loading) return loading;
    loading = (async () => {
      const { loadBossGlb } = await import('./bossload.js');   // KTX2 판 먼저, 안 되면 JPEG 판
      const g = await loadBossGlb(ctx, D.file);
      assets = { g }; return assets;
    })().catch((e) => { loadFailed = true; console.warn('[bonfire] boss assets failed', kind, e && e.message); throw e; });
    return loading;
  }
  function makeRig() {
    const root = assets.g.scene, bones = {}, lods = [], mats = new Set();
    root.traverse((o) => {
      if (o.isBone) bones[o.name] = o;
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
        if (/_LOD(\d)/.test(o.name) || /_LOD(\d)/.test(o.parent && o.parent.name || '')) lods.push(o);
        for (const m of [].concat(o.material)) mats.add(m);
      }
    });
    let eyeMat = null;
    for (const m of mats) {
      if (!m.isMeshStandardMaterial) continue;
      m.metalness = Math.min(m.metalness, 0.5);
      if (/eye/.test(m.name)) eyeMat = m;
    }
    const base = new Map(); for (const m of mats) base.set(m, { e: m.emissive.clone(), i: m.emissiveIntensity });
    root.updateMatrixWorld(true);
    const rest = {};
    for (const n in bones) {
      const b = bones[n], wq = new THREE.Quaternion(); b.getWorldQuaternion(wq);
      const inv = wq.clone().invert();
      rest[n] = { q: b.quaternion.clone(), X: new THREE.Vector3(1, 0, 0).applyQuaternion(inv), Y: new THREE.Vector3(0, 1, 0).applyQuaternion(inv), Z: new THREE.Vector3(0, 0, 1).applyQuaternion(inv), invW: b.matrixWorld.clone().invert() };
    }
    const local = (bn, p) => { const v = new THREE.Vector3(...bl(p)); if (bones[bn]) v.applyMatrix4(rest[bn].invW); return v; };
    const hull = D.hull.map(([bn, a, b, r, col, hd]) => ({ bone: bones[bn], a: local(bn, a), b: local(bn, b), r, col: !!col, hd }));
    const mouths = HEADS.map((k) => ({ bone: bones[`head${k}`], p: local(`head${k}`, mouthPt(k)) }));
    const tail = { bone: bones.t4, p: local('t4', TAIL[4]) };   // 꼬리 끝(휩쓸기 궤적·불똥)
    const light = new THREE.PointLight('#ff5a1e', 0, 46, 1.6); root.add(light); light.position.set(0, 13, -9);
    scene.add(root);
    const qs = { q: new THREE.Quaternion(), qa: new THREE.Quaternion() };
    const R = { root, bones, lods, mats, base, rest, hull, mouths, tail, light, eyeMat, flash: 0, flashK: 1, qs, lod: -1, sp: {} };
    applyLook(THREE, R, LOOK, 'hydraLook');
    return R;
  }
  function pose(name, ax, ay, az) {
    const b = rig && rig.bones[name]; if (!b) return;
    const r = rig.rest[name], q = rig.qs.q.copy(r.q), t = rig.qs.qa;
    if (ay) q.multiply(t.setFromAxisAngle(r.Y, ay));
    if (ax) q.multiply(t.setFromAxisAngle(r.X, ax));
    if (az) q.multiply(t.setFromAxisAngle(r.Z, az));
    b.quaternion.copy(q);
  }
  function disposeRig() {
    if (!rig) return;
    scene.remove(rig.root); rig.light.intensity = 0;
    for (const m of rig.mats) { const b = rig.base.get(m); if (b) { m.emissive.copy(b.e); m.emissiveIntensity = b.i; } }
    rig = null;
  }

  // ---------- 생명 주기 ----------
  function resetState() {
    B.active = false; B.owner = false; B.ownerId = ''; B.a = 'idle'; B.haz = []; B.spawnT = 0; B.dieT = 0; B.rage = false; B.pt = []; B.y = 0; B.pitch = 0;
    O.cd = {}; for (const p of D.patterns) O.cd[p.code] = p.cd * 0.4; O.gap = 1.4; O.hitAt.clear();
    act.cur = null; disposeRig();
    for (const f of fxl) killFx(f); fxl.length = 0;
    for (const [, v] of hazVis) scene.remove(v.g); hazVis.clear();
    capsW.length = 0;
  }
  const baseY = (x, z) => ctx.heightAt(x, z);
  const standOk = (x, z) => ctx.canStand(x, z);
  function spawn(x, z, ry, born) {
    if (B.active) return false;
    const n = Math.max(1, ctx.players().length);
    resetState();
    B.active = true; B.owner = true; B.ownerId = ctx.myId; B.ep = 0; B.born = born > 0 ? born : Date.now(); B.seq = 0;
    B.x = x; B.z = z; B.ry = ry; B.y = baseY(x, z); B.maxHp = B.hp = D.hp + D.hpPerExtra * (n - 1);
    B.hMax = Math.round(B.maxHp * D.headShare); B.hh = [B.hMax, B.hMax, B.hMax];
    B.a = 'spawn'; B.spawnT = D.spawnT; B.ac++;
    R.tx = x; R.tz = z; R.ty = B.y; R.try_ = ry; R.lastSnap = performance.now();
    emit('spawn', { owner: true, kind });
    intro();
    load().then(() => { if (B.active && !rig) rig = makeRig(); }).catch(() => despawn());
    return true;
  }
  function despawn() { const was = B.active; resetState(); if (was) emit('despawn', { kind }); }
  function intro() {   // 하늘에서 날개를 치며 내려앉는다: 바닥에 붉은 원 → 착지 때 흙먼지 · 충격파 · 큰 흔들림
    ctx.sfx(kind, 'intro', B.x, B.z); ctx.shake(0.7, 2.0);
    addFx({ type: 'ring', x: B.x, z: B.z, r0: 18, r1: 6, t: 0, life: D.spawnT * 0.8, hit: false, warn: true, color: '#ff3a1a' });
    setTimeout(() => {
      if (!B.active) return;
      ctx.shake(1.3, 1.2); ctx.sfx(kind, 'impact', B.x, B.z);
      for (let i = 0; i < 12; i++) ctx.fx.poof(B.x + (Math.random() - 0.5) * 16, ctx.heightAt(B.x, B.z) + 0.2, B.z + (Math.random() - 0.5) * 16, 6);
      const gy = ctx.heightAt(B.x, B.z);   // 착지: 날개바람에 밀린 흙먼지 고리 · 파편 · 섬광 · 불티
      VX.impact(B.x, gy, B.z, { color: '#ffc890', hot: '#ffffff', sparks: 40, smokeKind: 'dust', smokeN: 24, size: 2.2 });
      VX.burst('debris', B.x, gy, B.z, { n: 44, speed: 1.3, spread: 3 }); VX.burst('fire', B.x, gy, B.z, { n: 14, color: '#c02010', speed: 2, size: 1.4 });
      addFx({ type: 'ring', x: B.x, z: B.z, r0: 4, r1: 30, t: 0, life: 1.4, hit: false, color: '#e0b090' });
    }, D.spawnT * 820);
  }

  // ---------- 소유자 AI ----------
  function nearest(x, z) {
    let best = null, bd = 1e9;
    for (const p of ctx.players()) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
    return best ? { p: best, d: bd } : null;
  }
  function stepTo(dx, dz, sp, dt) {
    const nx = B.x + dx * sp * dt, nz = B.z + dz * sp * dt;
    if (standOk(nx, nz)) { B.x = nx; B.z = nz; return true; }
    if (standOk(nx, B.z)) { B.x = nx; return true; }
    if (standOk(B.x, nz)) { B.z = nz; return true; }
    return false;
  }
  function pickPattern(tg) {
    const ok = [];
    for (const p of D.patterns) {
      if (O.cd[p.code] > 0 || tg.d < p.minD || tg.d > p.maxD) continue;
      if (p.code === 'hbreath' && !headsUp()) continue;
      ok.push(p);
    }
    if (!ok.length) return null;
    let tot = 0; for (const p of ok) tot += p.w;
    let r = Math.random() * tot;
    for (const p of ok) { r -= p.w; if (r <= 0) return p; }
    return ok[0];
  }
  function ownerBegin(p, tg) {
    O.cd[p.code] = p.cd * (B.rage ? 0.7 : 1);
    B.sa = tg ? faceTo(tg.p.x - B.x, tg.p.z - B.z) : B.ry;
    B.tx = tg ? r2(tg.p.x) : B.x; B.tz = tg ? r2(tg.p.z) : B.z;
    B.pt = [];
    if (p.code === 'hbreath') {   // 머리마다 노릴 자리: 가까운 사람 순, 모자라면 첫 목표 둘레
      const ps = ctx.players().map((q) => ({ q, d: Math.hypot(q.x - B.x, q.z - B.z) })).filter((o) => o.d < 40).sort((a, b) => a.d - b.d);
      for (let i = 0; i < 3; i++) {
        const o = ps[i % Math.max(1, ps.length)], a = (i - 1) * 0.5, base = o ? o.q : { x: B.tx, z: B.tz };
        const j = ps.length > i ? 0 : 6;
        B.pt.push([r2(base.x + Math.sin(B.sa + a) * j), r2(base.z + Math.cos(B.sa + a) * j)]);
      }
    }
    if (p.code === 'hdive') { const d = Math.hypot(B.tx - B.x, B.tz - B.z), k = Math.min(1, 45 / (d || 1)); B.tx = r2(B.x + (B.tx - B.x) * k); B.tz = r2(B.z + (B.tz - B.z) * k); if (!standOk(B.tx, B.tz)) { B.tx = r2(B.x); B.tz = r2(B.z); } }
    B.ac++; startPattern(p.code, false);
  }
  function startPattern(code, net) {
    const p = D.patterns.find((q) => q.code === code); if (!p) return;
    B.a = code;
    act.cur = { code, t: 0, dur: p.dur * (B.rage ? 0.85 : 1), from: { x: B.x, z: B.z, y: B.y, ry: B.ry }, to: { x: B.tx, z: B.tz }, ev: new Set(), net, pt: B.pt.slice(0, 3) };
    ctx.sfx(kind, code, B.x, B.z);
  }
  function ownerUpdate(dt) {
    for (const k in O.cd) O.cd[k] = Math.max(0, O.cd[k] - dt);
    if (B.spawnT > 0) { B.spawnT -= dt; if (B.spawnT <= 0) B.a = 'idle'; return; }
    if (B.dieT > 0) { B.dieT -= dt; if (B.dieT <= 0) emit('request-despawn', { dead: true }); return; }
    if (!B.rage && (B.hp <= B.maxHp * 0.35 || headsUp() <= 1)) { B.rage = true; emit('rage', { kind }); ctx.sfx(kind, 'rage', B.x, B.z); }
    for (const h of B.haz) h.age += dt;
    B.haz = B.haz.filter((h) => h.age < 7.5);
    if (act.cur) return;
    const tg = nearest(B.x, B.z);
    if (!tg) { B.a = 'idle'; return; }
    O.gap = Math.max(0, O.gap - dt);
    const want = faceTo(tg.p.x - B.x, tg.p.z - B.z), dd = wrapA(want - B.ry), tm = D.turn * (B.rage ? 1.3 : 1) * dt;
    if (O.gap <= 0 && Math.abs(dd) < 0.7) { const p = pickPattern(tg); if (p) { ownerBegin(p, tg); return; } }
    if (tg.d > 13) {
      B.ry = wrapA(B.ry + clamp(dd, -tm, tm));
      const moved = Math.abs(dd) < 1.2 && stepTo(-Math.sin(B.ry), -Math.cos(B.ry), D.speed * (B.rage ? 1.25 : 1), dt);
      B.a = moved ? 'move' : 'idle';
      return;
    }
    B.ry = wrapA(B.ry + clamp(dd, -tm, tm)); B.a = 'idle';
  }

  // ---------- 패턴 시간표 (모두 같은 것을 돈다) ----------
  const fwd = (ry) => [-Math.sin(ry), -Math.cos(ry)];
  function once(a, key, at) { if (a.t >= at && !a.ev.has(key)) { a.ev.add(key); return true; } return false; }
  function moveBy(dist) { const [fx, fz] = fwd(B.ry), nx = B.x + fx * dist, nz = B.z + fz * dist; if (standOk(nx, nz)) { B.x = nx; B.z = nz; return true; } return false; }
  const restW = (p) => { const [x, y, z] = bl(p), c = Math.cos(B.ry), s = Math.sin(B.ry); return { x: B.x + x * c + z * s, y: B.y + y, z: B.z - x * s + z * c }; };
  const tv = THREE.Vector3 ? new THREE.Vector3() : null;
  function mouthW(i) {   // 머리 i 의 입(세계 좌표)
    if (rig && rig.mouths[i].bone && tv) { tv.copy(rig.mouths[i].p).applyMatrix4(rig.mouths[i].bone.matrixWorld); return { x: tv.x, y: tv.y, z: tv.z }; }
    return restW(mouthPt(HEADS[i]));
  }
  function tailW() {   // 꼬리 끝(세계 좌표)
    if (rig && rig.tail.bone && tv) { tv.copy(rig.tail.p).applyMatrix4(rig.tail.bone.matrixWorld); return { x: tv.x, y: tv.y, z: tv.z }; }
    return restW(TAIL[4]);
  }
  // 입 → 목표로 뻗는 불줄기의 방향·길이(눈에 보이는 원뿔과 같은 값)
  function flameVec(m, q, k) {
    const gy = ctx.heightAt(q[0], q[1]) + 0.4, dx = q[0] - m.x, dy = gy - m.y, dz = q[1] - m.z, l = Math.hypot(dx, dy, dz) || 1;
    return { ux: dx / l, uy: dy / l, uz: dz / l, L: l * (0.6 + 0.65 * k), gy };
  }
  function runPattern(dt) {
    const a = act.cur; if (!a) return;
    a.t += dt;
    const F = a.from, T = a.to, tgA = faceTo(T.x - F.x, T.z - F.z);
    const turnTo = (w, k) => { B.ry = wrapA(B.ry + clamp(wrapA(w - B.ry), -k * dt, k * dt)); };
    const g = (x, z) => ctx.heightAt(x, z);
    if (a.code === 'hbreath') {   // 0~1.0 s 머리를 뒤로 젖혀 숨을 모음(입 안이 달아오름) → 1.0~2.9 s 머리마다 자기 목표로 불줄기 → 땅에 불 장판
      turnTo(tgA, 1.1);
      if (once(a, 'charge', 0.15)) ctx.sfx(kind, 'charge', B.x, B.z);
      if (a.t < 1.0) for (let i = 0; i < 3; i++) {   // 숨 모음: 입 둘레에 불씨가 모이고 빛이 차오른다(머리마다 따로)
        if (!headUp(i)) continue;
        const m = mouthW(i), c = ease(clamp(a.t, 0, 1));
        for (let s = rate('ch' + i, 30 + 110 * c, dt); s-- > 0;) { const an = Math.random() * TAU, rr = 2.2 + Math.random() * 2.8 * (1 - 0.6 * c); VX.burst('ember', m.x + Math.cos(an) * rr, m.y + (Math.random() - 0.4) * rr, m.z + Math.sin(an) * rr, { n: 1, speed: 0.3, spread: 0.3, size: 0.8 + c }); }
        for (let s = rate('chl' + i, 8 + 30 * c, dt); s-- > 0;) VX.burst('light', m.x, m.y, m.z, { n: 1, color: '#ff8a30', hot: '#fff0c0', spread: 1.2, speed: 0.5, size: 0.8 + c });
      }
      if (a.t >= 1.0 && a.t < 2.9) {
        if (once(a, 'fire', 1.0)) {
          ctx.sfx(kind, 'flame', B.x, B.z); ctx.shake(0.45, 1.8);
          for (let i = 0; i < 3; i++) if (headUp(i)) { const m = mouthW(i); VX.burst('flash', m.x, m.y, m.z, { color: '#ffb060', size: 0.8 }); VX.burst('fire', m.x, m.y, m.z, { n: 12, speed: 2, size: 1.2 }); VX.burst('spark', m.x, m.y, m.z, { n: 18 }); }
        }
        for (let i = 0; i < 3; i++) {
          if (!headUp(i) || !a.pt[i]) continue;
          const m = mouthW(i), q = a.pt[i], k = clamp((a.t - 1.0) / 0.6, 0, 1);
          const ex = m.x + (q[0] - m.x) * (0.6 + 0.6 * k), ez = m.z + (q[1] - m.z) * (0.6 + 0.6 * k);
          if (!a.ev.has('f' + i)) { a.ev.add('f' + i); addFx({ type: 'flame', i, t: 0, life: 1.9 }); }
          hitLine(m.x, m.z, ex, ez, 1.2 + 2.6 * k, 'hbreath', 4.5);
          if (a.t > 1.6 && once(a, 'pool' + i, 1.6) && B.owner && B.haz.length < 8) B.haz.push({ id: ++O.hazId, x: r2(q[0]), z: r2(q[1]), age: 0 });
          if (ctx.fx && Math.random() < dt * 24) ctx.fx.spark(ex + (Math.random() - 0.5) * 3, g(ex, ez) + Math.random() * 2, ez + (Math.random() - 0.5) * 3);
          if (VX.ok) {   // 불줄기: 입에서 목표로 쏠리는 불길 · 불씨 · 불똥, 땅에 닿으면 바닥이 타오르고 연기가 인다
            const fv = flameVec(m, q, k), cone = 3.2 * k + 0.3, fwd3 = [fv.ux, fv.uy, fv.uz];
            for (let s = rate('fl' + i, 150, dt); s-- > 0;) {
              const tt = Math.random() * fv.L, f0 = tt / fv.L, rc = cone * (0.12 + 0.88 * f0) * 0.5;
              VX.burst('fire', m.x + fv.ux * tt + (Math.random() - 0.5) * rc, m.y + fv.uy * tt + (Math.random() - 0.5) * rc, m.z + fv.uz * tt + (Math.random() - 0.5) * rc, { n: 1, dir: fwd3, speed: 2.5, up: 0.4, spread: 0.2, size: 0.55 + 0.85 * f0 });
            }
            for (let s = rate('fe' + i, 45, dt); s-- > 0;) { const tt = Math.random() * fv.L; VX.burst('ember', m.x + fv.ux * tt, m.y + fv.uy * tt, m.z + fv.uz * tt, { n: 1, dir: fwd3, speed: 1.2, spread: 1.2 }); }
            for (let s = rate('fs' + i, 28, dt); s-- > 0;) { const tt = fv.L * (0.3 + 0.7 * Math.random()); VX.burst('spark', m.x + fv.ux * tt, m.y + fv.uy * tt, m.z + fv.uz * tt, { n: 1, dir: fwd3, speed: 0.7, color: '#ffc060' }); }
            if (0.6 + 0.65 * k >= 0.95) {   // 불줄기가 땅에 닿은 곳
              if (once(a, 'gl' + i, a.t)) { VX.burst('flash', q[0], fv.gy + 0.6, q[1], { color: '#ff9040', size: 0.9 }); VX.burst('debris', q[0], fv.gy, q[1], { n: 12, color: '#3a2a20' }); }
              for (let s = rate('gf' + i, 70, dt); s-- > 0;) VX.burst('fire', q[0], fv.gy, q[1], { n: 1, spread: 2.2, up: 0.9, size: 1.1 + k * 0.5 });
              for (let s = rate('gs' + i, 16, dt); s-- > 0;) VX.burst('smoke', q[0], fv.gy + 1, q[1], { n: 1, spread: 2, size: 1.1 });
              for (let s = rate('gm' + i, 26, dt); s-- > 0;) VX.burst('ember', q[0], fv.gy + 0.5, q[1], { n: 1, spread: 2.2, speed: 1.6 });
            }
          }
          if (a.t > 1.6 && once(a, 'scorch' + i, 1.6)) {   // 불 장판이 생기는 순간: 폭발하듯 번진 뒤 가라앉는다
            const gq = g(q[0], q[1]);
            VX.impact(q[0], gq, q[1], { color: '#ff6a1a', hot: '#fff0b0', sparks: 24, smokeN: 8, size: 1.3 }); VX.burst('fire', q[0], gq, q[1], { n: 22, speed: 2, size: 1.4, spread: 2 });
            addFx({ type: 'ring', x: q[0], z: q[1], r0: 1, r1: 8, t: 0, life: 0.6, hit: false, color: '#ff8a3a' });
          }
        }
      }
    } else if (a.code === 'hsnap') {   // 세 머리가 차례로 앞을 덮쳐 문다
      turnTo(tgA, 1.6);
      if (a.t > 0.45 && a.t < 0.8) moveBy(3 * dt / 0.35);
      for (let i = 0; i < 3; i++) if (headUp(i) && once(a, 'bite' + i, 0.7 + i * 0.12)) {
        const m = mouthW(i), [fx, fz] = fwd(B.ry);
        const c = { x: m.x + fx, z: m.z + fz };   // 머리가 땅까지 내리꽂힌다: 입 앞 반지름 6 m
        hitCircle(c.x, c.z, 6, 'hsnap', 4.5); ctx.fx.poof(c.x, g(c.x, c.z) + 0.2, c.z, 4); ctx.sfx(kind, 'snap', c.x, c.z); ctx.shake(0.3, 0.3);
        const gc = g(c.x, c.z);   // 물리는 순간: 입 앞 섬광 · 땅을 때린 흙먼지·파편·불티 · 작은 충격파 고리
        VX.burst('flash', m.x, m.y, m.z, { color: '#ffd9a0', size: 0.55 });
        VX.impact(c.x, gc, c.z, { color: '#ffc890', hot: '#ffffff', sparks: 22, smokeKind: 'dust', smokeN: 10, size: 1.3 }); VX.burst('debris', c.x, gc, c.z, { n: 16, speed: 1.1 });
        VX.burst('fire', m.x, m.y, m.z, { n: 6, speed: 1.2, size: 0.9 });
        addFx({ type: 'ring', x: c.x, z: c.z, r0: 1, r1: 8, t: 0, life: 0.5, hit: false, color: '#ffd0a0' });
      }
      if (a.t > 0.5 && a.t < 1.1) for (let i = 0; i < 3; i++) if (headUp(i)) {   // 내리꽂는 동안 입에서 흐르는 불티
        const m = mouthW(i); for (let s = rate('sn' + i, 40, dt); s-- > 0;) VX.burst('ember', m.x, m.y, m.z, { n: 1, spread: 0.6, speed: 0.8 });
      }
    } else if (a.code === 'hsweep') {   // 0.5 s 웅크림 → 몸을 한 바퀴 돌리며 가시 꼬리로 바닥을 쓸어버림(점프로 넘김) → 버팀
      if (a.t < 0.5) turnTo(tgA, 1.2);
      else if (a.t < 1.7) {
        const s = ease((a.t - 0.5) / 1.2); B.ry = wrapA(a.rot0 === undefined ? (a.rot0 = B.ry) : a.rot0 + s * TAU * (B.rage ? -1 : 1)); if (Math.random() < dt * 14) { const tp = restW(TAIL[4]); ctx.fx.poof(tp.x, g(tp.x, tp.z) + 0.2, tp.z, 3); }
        if (VX.ok) {   // 꼬리 끝이 바닥을 긁으며 도는 길: 흙먼지 · 파편 · 바깥으로 튀는 불똥
          const tp = tailW(), gt = g(tp.x, tp.z), ox = tp.x - B.x, oz = tp.z - B.z, ol = Math.hypot(ox, oz) || 1, sp = clamp(Math.sin(clamp((a.t - 0.5) / 1.2, 0, 1) * Math.PI) * 1.4, 0.2, 1);
          for (let n = rate('td', 90 * sp, dt); n-- > 0;) VX.burst('dust', tp.x, gt, tp.z, { n: 1, up: 0.7, speed: 0.6, size: 1.2 });
          for (let n = rate('tb', 30 * sp, dt); n-- > 0;) VX.burst('debris', tp.x, gt, tp.z, { n: 1, spread: 3, dir: [ox / ol, 0.25, oz / ol], speed: 0.5 });
          for (let n = rate('ts', 70 * sp, dt); n-- > 0;) VX.burst('spark', tp.x, gt + 0.6, tp.z, { n: 1, color: '#ffc890', dir: [ox / ol, 0.2, oz / ol], speed: 0.8 });
        }
      }
      if (once(a, 'arc', 0.5)) addFx({ type: 'arc', t: 0, life: 1.25 });
      if (once(a, 'whoosh', 0.6)) ctx.sfx(kind, 'hsweep', B.x, B.z);
      if (once(a, 'hit', 1.1)) {
        hitAnnulus(B.x, B.z, 4, 25, 'hsweep', 2.2); ctx.shake(0.8, 0.7); addFx({ type: 'ring', x: B.x, z: B.z, r0: 6, r1: 26, t: 0, life: 0.9, hit: true, dmg: 'hring', color: '#e8d6c0' });
        VX.burst('flash', B.x, g(B.x, B.z) + 1, B.z, { color: '#ffe0b0', size: 1.4 }); VX.burst('debris', B.x, g(B.x, B.z), B.z, { n: 34, speed: 1.4, spread: 4 });
      }
    } else if (a.code === 'hdive') {   // 날아오름(1.4 s) → 활강해 내리꽂음(0.9 s) → 충격파 · 흙먼지 → 다시 일어섬
      const up = 1.4, dn = 0.9;
      if (once(a, 'flap', 0.05)) ctx.sfx(kind, 'flap', B.x, B.z);
      if (a.t < up) {
        turnTo(tgA, 1.8); B.y = F.y + 20 * ease(a.t / up); B.pitch = -0.25 * (a.t / up); if (once(a, 'lift', 0.25)) for (let i = 0; i < 8; i++) ctx.fx.poof(F.x + (Math.random() - 0.5) * 16, g(F.x, F.z) + 0.2, F.z + (Math.random() - 0.5) * 16, 5);
        if (once(a, 'gust', 0.25)) { const gf = g(F.x, F.z); VX.ring('dust', F.x, gf, F.z, 5, { n: 26, speed: 1.4, size: 1.3 }); VX.ring('debris', F.x, gf, F.z, 4, { n: 12 }); VX.burst('flash', F.x, gf + 1, F.z, { color: '#ffd0a0', size: 1.1 }); }
        for (let n = rate('up', 70 * (1 - a.t / up * 0.6), dt); n-- > 0;) { const an = Math.random() * TAU, rr = 3 + Math.random() * 11; VX.burst('dust', F.x + Math.cos(an) * rr, g(F.x, F.z), F.z + Math.sin(an) * rr, { n: 1, up: 0.5, speed: 1.2 }); }   // 날갯바람이 쓸어 올리는 먼지
        for (let i = 0; i < 3; i++) if (headUp(i)) { const m = mouthW(i); for (let n = rate('dm' + i, 24, dt); n-- > 0;) VX.burst('fire', m.x, m.y, m.z, { n: 1, spread: 0.4, size: 0.8 }); }   // 울부짖는 입에서 새는 불길
      } else if (a.t < up + dn) {
        const s = (a.t - up) / dn, e = s * s; B.x = F.x + (T.x - F.x) * e; B.z = F.z + (T.z - F.z) * e;
        B.y = lerp(F.y + 20, g(B.x, B.z) + 0.5, e); B.pitch = 0.55 * Math.sin(s * Math.PI * 0.5);
        if (once(a, 'mark', up)) addFx({ type: 'ring', x: T.x, z: T.z, r0: 11, r1: 9, t: 0, life: dn, hit: false, warn: true, color: '#ff4a20' });
        for (let n = rate('dv', 200, dt); n-- > 0;) { const o = 10; VX.burst('fire', B.x + (Math.random() - 0.5) * o, B.y + 3 + (Math.random() - 0.3) * 9, B.z + (Math.random() - 0.5) * o, { n: 1, size: 2.6, up: 0.1, spread: 0.3 }); }   // 급강하 불꼬리
        for (let n = rate('dvl', 70, dt); n-- > 0;) VX.burst('light', B.x + (Math.random() - 0.5) * 12, B.y + 2 + Math.random() * 8, B.z + (Math.random() - 0.5) * 12, { n: 1, color: '#ff8a40', hot: '#ffe8c0', size: 1.4, spread: 0.3 });
        for (let n = rate('dvs', 60, dt); n-- > 0;) VX.burst('spark', B.x + (Math.random() - 0.5) * 14, B.y + 2 + Math.random() * 8, B.z + (Math.random() - 0.5) * 14, { n: 1, color: '#ffe0b0', dir: [0, 1, 0], speed: 0.6 });   // 바람을 가르는 줄
        for (let n = rate('dvm', 22, dt); n-- > 0;) VX.burst('smoke', B.x, B.y + 5, B.z, { n: 1, spread: 3, size: 1.3 });
        { const gm = g(T.x, T.z); for (let n = rate('mk', 40, dt); n-- > 0;) { const an = Math.random() * TAU, rr = 4 + Math.random() * 6; VX.burst('light', T.x + Math.cos(an) * rr, gm + 0.3, T.z + Math.sin(an) * rr, { n: 1, color: '#ff6a30', hot: '#ffd8b0', spread: 0.3, speed: 0.3 }); } }   // 떨어질 자리에 붉은 빛 티끌
      } else {
        if (once(a, 'impact', up + dn)) {
          hitCircle(T.x, T.z, 10, 'hdive', 0); ctx.shake(1.5, 1.1); ctx.sfx(kind, 'impact', T.x, T.z);
          addFx({ type: 'ring', x: T.x, z: T.z, r0: 4, r1: 28, t: 0, life: 1.3, hit: true, dmg: 'hring', color: '#ffb080' });
          for (let i = 0; i < 10; i++) ctx.fx.poof(T.x + (Math.random() - 0.5) * 14, g(T.x, T.z) + 0.2, T.z + (Math.random() - 0.5) * 14, 6);
          const gi = g(T.x, T.z);   // 내리꽂힘: 큰 섬광 · 불티·불길 · 파편 · 먼지 고리, 땅에 그을음이 남는다
          VX.impact(T.x, gi, T.z, { color: '#ffb080', hot: '#ffffff', sparks: 60, smokeKind: 'dust', smokeN: 26, size: 2.2 });
          VX.burst('debris', T.x, gi, T.z, { n: 50, speed: 1.4, spread: 4 }); VX.burst('light', T.x, gi, T.z, { n: 30, speed: 3, color: '#ff9a50' }); VX.burst('fire', T.x, gi, T.z, { n: 24, color: '#c02010', speed: 2.2, size: 1.6, spread: 3 });
          VX.ring('dust', T.x, gi, T.z, 5, { n: 28, speed: 1.6, size: 1.5 }); VX.ring('debris', T.x, gi, T.z, 4, { n: 14 });
          addFx({ type: 'scar', x: T.x, z: T.z, r: 9, t: 0, life: 2.4 });
        }
        const s = clamp((a.t - up - dn - 0.3) / 1.4, 0, 1); B.y = lerp(g(B.x, B.z) + 0.5, baseY(B.x, B.z), ease(s)); B.pitch = 0.55 * (1 - s);
      }
    }
    if (a.t >= a.dur) { act.cur = null; B.pitch = 0; if (B.owner) { O.gap = B.rage ? 0.6 : 1.1; B.a = 'idle'; B.y = baseY(B.x, B.z); } }
  }

  // ---------- 효과 (모두) ----------
  let fxRes = null;
  function res() {
    if (fxRes) return fxRes;
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
    fxRes = {
      ring: new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2), disc: new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
      ball: new THREE.SphereGeometry(1, 14, 10),
      cone: new THREE.CylinderGeometry(1, 0.12, 1, 20, 6, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),   // 입(원점) → +z 로 넓어지는 불줄기
      // 꼬리 휩쓸기 궤적: 바깥 반지름 1, 안쪽 0.6, 앞날(각도 0)에서 뒤로 2.2 라디안 부채꼴(ARC_F 가 각도로 사라지게 한다)
      arc: new THREE.RingGeometry(0.6, 1, 56, 1, -ARC_LEN, ARC_LEN).rotateX(-Math.PI / 2),
      add,
    };
    return fxRes;
  }
  function addFx(f) { fxl.push(f); return f; }
  function killFx(f) {
    if (f.g) { scene.remove(f.g); f.g.traverse((o) => { if (o.material && o.material.userData.own) o.material.dispose(); }); }
    if (f.extra) for (const o of f.extra) { scene.remove(o); if (o.material.userData.own) o.material.dispose(); }   // 불줄기 입 빛 구슬·열기 장판은 그룹 밖에 있다
  }
  const ownMat = (c, o = 1) => { const m = new THREE.MeshBasicMaterial({ color: c, ...res().add, opacity: o }); m.userData.own = true; return m; };
  const vMat = (mode, c, o = 1, opt) => (VX.ok && VX.mat(mode, c, o, opt)) || ownMat(c, o);   // 셰이더 재질(없으면 단색)
  function tickFx(dt, t) {
    const m = ctx.me();
    VX.tick(dt);
    for (let i = fxl.length - 1; i >= 0; i--) {
      const f = fxl[i]; f.t += dt;
      if (f.t < 0) continue;
      const u = f.t / f.life;
      if (f.type === 'ring') {
        const r = f.r0 + (f.r1 - f.r0) * Math.min(1, u), y = ctx.heightAt(f.x, f.z) + 0.25;
        if (!f.g) {
          f.g = new THREE.Group(); f.g.renderOrder = 3;
          if (f.warn) {   // 바닥 표식: 돌아가는 문장 + 붉은 바닥 빛
            const sg = new THREE.Mesh(res().disc, vMat('sigil', f.color || '#ff3a1a', 0.9, { hot: '#ffd8b0', inner: 0.2 })), fl = new THREE.Mesh(res().disc, vMat('pool', f.color || '#ff3a1a', 0.3, { hot: '#ffb070' }));
            f.g.add(fl, sg); f.parts = { sg, fl };
          } else {   // 충격파: 셰이더 고리 + 안쪽 열기 장판, 출발할 때 먼지 고리와 섬광
            const rg = new THREE.Mesh(res().disc, vMat('shock', f.color || '#ffffff', 0.9, { hot: '#ffffff', inner: 0.72 })), fl = new THREE.Mesh(res().disc, vMat('pool', f.color || '#ffffff', 0.25, { hot: '#fff6e0' }));
            f.g.add(rg, fl); f.parts = { rg, fl };
            VX.ring('dust', f.x, y, f.z, f.r0, { n: 18, color: f.color }); VX.burst('flash', f.x, y + 0.5, f.z, { color: f.color, size: 0.5 + f.r1 / 30 });
          }
          scene.add(f.g);
        }
        f.g.position.set(f.x, y, f.z); f.g.scale.set(r, 1, r);
        if (f.warn) { f.parts.sg.rotation.y = f.t * 0.8; f.parts.sg.material.opacity = 0.9 * Math.min(1, f.t / 0.25) * (1 - 0.3 * u); f.parts.fl.material.opacity = 0.15 + 0.25 * u; }
        else {
          f.parts.rg.material.opacity = 1.1 * (1 - u); f.parts.rg.material.uT = u * 0.9; f.parts.fl.material.opacity = 0.3 * (1 - u) * (1 - u);
          for (let n = rate('rg' + i, 30, dt); n-- > 0;) { const an = Math.random() * TAU; VX.burst('dust', f.x + Math.cos(an) * r, y, f.z + Math.sin(an) * r, { n: 1, speed: 0.4, color: f.color }); }
        }
        if (f.hit && m.ok && !f.done) {
          const d = Math.hypot(m.x - f.x, m.z - f.z);
          if (Math.abs(d - r) < 1.4 && m.y - floorAt(m.x, m.z) < 1.1) { f.done = true; hitMe(f.dmg || 'hring', (m.x - f.x) / (d || 1), (m.z - f.z) / (d || 1)); }
        }
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      } else if (f.type === 'flame') {   // 머리 하나의 불줄기: 입에서 목표 쪽으로 길어지며 일렁인다
        const a = act.cur, q = a && a.code === 'hbreath' ? a.pt[f.i] : null;
        if (!q || !headUp(f.i) || u >= 1) { killFx(f); fxl.splice(i, 1); continue; }
        if (!f.g) {   // 바깥 불길(주황) · 속불(노랑) 두 겹의 흐르는 노이즈 원뿔 + 입 빛 구슬 + 땅에 닿는 곳의 열기 장판
          f.g = new THREE.Group();
          const o = new THREE.Mesh(res().cone, vMat('beam', '#ff5a14', 1.0, { hot: '#ffb060' })), c = new THREE.Mesh(res().cone, vMat('beam', '#ffd27a', 1.1, { hot: '#ffffff' })), gl = new THREE.Mesh(res().ball, vMat('orb', '#ff7a1e', 0.8, { hot: '#ffe8a0' })), hot = new THREE.Mesh(res().disc, vMat('pool', '#ff4a10', 0.9, { hot: '#ffd070' }));
          c.scale.set(0.45, 0.45, 0.92); f.g.add(o, c); f.parts = { o, c, gl, hot }; f.extra = [gl, hot]; hot.renderOrder = 3; scene.add(f.g, gl, hot);
        }
        const mo = mouthW(f.i), gy = ctx.heightAt(q[0], q[1]) + 0.4, k = clamp(f.t / 0.5, 0, 1);
        const dx = q[0] - mo.x, dy = gy - mo.y, dz = q[1] - mo.z, L = Math.hypot(dx, dy, dz) * (0.6 + 0.65 * k);
        f.g.position.set(mo.x, mo.y, mo.z); f.g.lookAt(mo.x + dx, mo.y + dy, mo.z + dz);
        const fl = 1 + 0.12 * Math.sin(t * 40 + f.i * 2) + 0.08 * Math.sin(t * 67 + f.i);
        f.g.scale.set(3.2 * fl * k + 0.3, 3.2 * fl * k + 0.3, L);
        const fade = clamp((f.life - f.t) / 0.3, 0, 1);
        f.parts.o.material.opacity = 1.0 * fade; f.parts.c.material.opacity = 1.1 * fade; f.parts.o.material.uT = f.parts.c.material.uT = (1 - fade) * 0.9;
        f.parts.gl.position.set(mo.x, mo.y, mo.z); f.parts.gl.scale.setScalar(0.9 * fl);
        f.parts.gl.material.opacity = 0.7 * fade;
        // 불줄기가 땅에 닿는 곳의 열기 장판(줄기가 충분히 뻗었을 때만 켜진다)
        const reach = clamp((0.6 + 0.65 * k - 0.85) / 0.15, 0, 1), hs = 2.2 + 2.4 * k;
        f.parts.hot.position.set(q[0], gy - 0.25, q[1]); f.parts.hot.scale.set(hs * fl, 1, hs * fl); f.parts.hot.material.opacity = 0.9 * reach * fade;
      } else if (f.type === 'glow') {   // 숨 모을 때 입 안의 빛 덩어리: 커지며 일렁인다
        const a = act.cur;
        if (!a || a.code !== 'hbreath' || a.t > 1.05 || !headUp(f.i)) { killFx(f); fxl.splice(i, 1); continue; }
        if (!f.g) { f.g = new THREE.Group(); f.parts = { in: new THREE.Mesh(res().ball, vMat('orb', '#ff7a1e', 0.9, { hot: '#ffe8a0' })), out: new THREE.Mesh(res().ball, vMat('orb', '#ff3a08', 0.5, { hot: '#ff9a30' })) }; f.g.add(f.parts.out, f.parts.in); scene.add(f.g); }
        const mo = mouthW(f.i), gk = 0.25 + 0.9 * clamp(a.t, 0, 1) * (1 + 0.2 * Math.sin(t * 30));
        f.g.position.set(mo.x, mo.y, mo.z); f.parts.in.scale.setScalar(gk); f.parts.out.scale.setScalar(gk * 1.9); f.parts.out.material.opacity = 0.5 * clamp(a.t, 0, 1);
      } else if (f.type === 'arc') {   // 꼬리 휩쓸기 궤적: 꼬리 끝을 따라 도는 하얀 날 + 흩어지는 꼬리(부채꼴 셋이 겹침)
        const a = act.cur;
        if (!a || a.code !== 'hsweep' || u >= 1) { killFx(f); fxl.splice(i, 1); continue; }
        if (!f.g) {
          const mk = (c, h, o) => { const mm = new THREE.ShaderMaterial({ vertexShader: ARC_V, fragmentShader: ARC_F, uniforms: { uC: { value: new THREE.Color(c) }, uHot: { value: new THREE.Color(h) }, uO: { value: o }, uT: { value: 0 }, uLen: { value: ARC_LEN }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }); mm.userData.own = true; return mm; };
          f.g = new THREE.Mesh(res().arc, mk('#ff9a50', '#fff0d8', 1)); f.g.renderOrder = 4; f.g.scale.setScalar(24); scene.add(f.g);
        }
        const tp = tailW(), ang = Math.atan2(-(tp.z - B.z), tp.x - B.x), env = Math.min(1, f.t / 0.12) * clamp((f.life - f.t) / 0.25, 0, 1), U = f.g.material.uniforms;
        f.g.position.set(B.x, ctx.heightAt(B.x, B.z) + 0.45, B.z); f.g.rotation.y = ang; f.g.scale.set(24, 24, B.rage ? -24 : 24);
        U.uO.value = 0.9 * env; U.uT.value = u * 0.4; U.uTime.value = t;
      } else if (f.type === 'scar') {   // 내리꽂힌 자리의 그을음: 열기가 식으며 가장자리부터 사라진다
        if (!f.g) { f.g = new THREE.Mesh(res().disc, vMat('pool', '#ff4a10', 0.9, { hot: '#ffd070' })); f.g.renderOrder = 2; scene.add(f.g); }
        f.g.position.set(f.x, ctx.heightAt(f.x, f.z) + 0.14, f.z); f.g.scale.set(f.r, 1, f.r);
        f.g.material.opacity = 0.95 * Math.min(1, f.t / 0.1) * (1 - u) * (1 - u); f.g.material.uT = u * 0.85;
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      }
    }
  }
  function hazVisual(h) {
    let v = hazVis.get(h.id);
    if (!v) {
      const g = new THREE.Group(), disc = new THREE.Mesh(res().disc, vMat('pool', '#ff3a08', 0.55, { hot: '#ffd070' })), ring = new THREE.Mesh(res().disc, vMat('shock', '#ff7a20', 0.8, { hot: '#ffe0a0', inner: 0.8 })), flames = [];
      for (let k = 0; k < 7; k++) { const f = new THREE.Mesh(res().ball, vMat('orb', k % 2 ? '#ff4a10' : '#ff8a2a', 0.7, { hot: '#ffe8a0' })); f.userData.ph = Math.random() * TAU; f.userData.r = Math.random() * 3.4; f.userData.a = Math.random() * TAU; g.add(f); flames.push(f); }
      g.add(disc, ring); scene.add(g); v = { g, disc, ring, flames }; hazVis.set(h.id, v);
    }
    return v;
  }

  // ---------- 내게 맞았나 (내 화면) ----------
  const floorAt = (x, z) => Math.max(ctx.heightAt(x, z), ctx.waterLevel ? ctx.waterLevel() - 0.6 : -1e9);
  function hitMe(src, dx, dz) {
    const m = ctx.me(); if (!m.ok) return false;
    if ((myHit[src] || 0) > 0) return false;
    myHit[src] = src === 'burn' ? 0.5 : src === 'hbreath' ? 0.45 : 0.8;
    const h = HITS[src] || [15, 1.5];
    ctx.onHitMe({ src, boss: kind, dmg: h[0] * (B.rage ? 1.15 : 1), dx, dz, power: h[1] });
    return true;
  }
  function hitCircle(x, z, r, src, hmax) {
    const m = ctx.me(); if (!m.ok) return false;
    const d = Math.hypot(m.x - x, m.z - z); if (d > r) return false;
    const up = m.y - floorAt(m.x, m.z);
    if (hmax > 0 ? up > hmax : up > 3.5) return false;
    return hitMe(src, (m.x - x) / (d || 1), (m.z - z) / (d || 1));
  }
  function hitAnnulus(x, z, r0, r1, src, hmax) {
    const m = ctx.me(); if (!m.ok) return false;
    const d = Math.hypot(m.x - x, m.z - z); if (d < r0 || d > r1 || m.y - floorAt(m.x, m.z) > hmax) return false;
    return hitMe(src, (m.x - x) / (d || 1), (m.z - z) / (d || 1));
  }
  function hitLine(ax, az, bx, bz, w, src, hmax) {   // 불줄기: 입 아래 → 끝까지의 선분에서 w 안
    const m = ctx.me(); if (!m.ok) return false;
    const abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz || 1, u = clamp(((m.x - ax) * abx + (m.z - az) * abz) / l2, 0, 1);
    const d = Math.hypot(m.x - (ax + abx * u), m.z - (az + abz * u));
    if (d > w * (0.4 + 0.6 * u) || m.y - floorAt(m.x, m.z) > hmax) return false;
    const L = Math.sqrt(l2); return hitMe(src, abx / L, abz / L);
  }

  // ---------- 모습 (모두) ----------
  function animate(dt, t) {
    if (!rig) return;
    const sp = B.spawnT > 0 ? clamp(1 - B.spawnT / D.spawnT, 0, 1) : 1, se = 1 - (1 - sp) * (1 - sp);
    const dying = B.a === 'die', dk = dying ? clamp(1 - B.dieT / D.dieT, 0, 1) : 0;
    const dieU = dying ? (rig.dieU = Math.min(1, (rig.dieU || 0) + dt / 2.6)) : (rig.dieU = 0);
    const a = act.cur, at = a ? a.t : 0, code = a ? a.code : B.a;
    let y = B.y, pitch = B.pitch || 0, roll = 0;
    const walk = B.a === 'move' ? 1 : 0;
    rig.ph = (rig.ph || 0) + dt * (walk ? 2.6 : 1.4) * (B.rage ? 1.25 : 1);
    const ph = rig.ph, s = Math.sin(ph);
    const flying = code === 'hdive' && at < 2.4 || B.spawnT > 0;
    // 다리: 대각선 쌍(FL+BR / FR+BL)이 함께
    const lg = flying ? 0 : walk;
    pose('legFL', 0.4 * s * lg + (flying ? 0.6 : 0), 0, 0); pose('legBR', 0.4 * s * lg - (flying ? 0.5 : 0), 0, 0);
    pose('legFR', -0.4 * s * lg + (flying ? 0.6 : 0), 0, 0); pose('legBL', -0.4 * s * lg - (flying ? 0.5 : 0), 0, 0);
    for (const k of ['FL', 'FR', 'BL', 'BR']) pose('shin' + k, (flying ? -0.8 : -0.3 * Math.max(0, (k === 'FL' || k === 'BR' ? -s : s)) * lg), 0, 0);
    // 꼬리: 느린 물결, 휩쓸기 때는 크게 휜다
    const sw = code === 'hsweep' ? Math.sin(clamp((at - 0.4) / 1.4, 0, 1) * Math.PI) * (B.rage ? -1 : 1) : 0;
    for (let i = 1; i <= 4; i++) pose('t' + i, 0.04 * Math.sin(t * 0.9 + i), spring(rig.sp, 't' + i, 0.12 * Math.sin(t * 0.8 - i * 0.7) * (1 + walk) - sw * 0.35, dt, 30 - i * 4, 6 - i * 0.6), 0);   // 마디마다 늦게 따라오는 꼬리
    // 날개: 평소엔 반쯤 접어 들고(숨에 맞춰 살짝 들썩), 날 때는 크게 친다. 접기·펴기·날갯짓 세기는 스프링으로 부드럽게 넘어가고,
    // 내려치기는 빠르고 올리기는 느리며(비대칭), 팔꿈치·손목 마디가 어깨보다 늦게 따라와 날개 끝이 채찍처럼 휜다.
    const SP = rig.sp, brt = breathe(t, 0.16);
    const fold = clamp(spring(SP, 'fold', flying ? 0 : 1, dt, 10, 5.5), 0, 1.1), amp = Math.max(0, spring(SP, 'amp', flying ? 1 : 0, dt, 8, 5));
    rig.wph = (rig.wph || 0) + dt * 7.0;
    const wp = rig.wph, stroke = (q) => { const u = ((q / (2 * Math.PI)) % 1 + 1) % 1; return u < 0.42 ? Math.cos(u / 0.42 * Math.PI) : -Math.cos((u - 0.42) / 0.58 * Math.PI); };
    const f1 = stroke(wp) * amp, f2 = stroke(wp - 0.6) * amp, f3 = stroke(wp - 1.1) * amp;
    const breath = code === 'hbreath' ? ease(clamp(at / 0.6, 0, 1)) * clamp((a ? a.dur : 1) - at, 0, 1) : 0;
    const idleW = 0.05 * brt * fold + 0.03 * Math.sin(t * 0.5) * fold;
    pose('wingL1', 0.1 * f1, 0.35 * fold, -0.65 * f1 + 0.45 * fold - 0.25 * breath + idleW); pose('wingL2', 0, -0.7 * fold, -0.45 * f2 - 0.04 * brt * fold); pose('wingL3', 0, -0.25 * fold, -0.3 * f3);
    pose('wingR1', 0.1 * f1, -0.35 * fold, 0.65 * f1 - 0.45 * fold + 0.25 * breath - idleW); pose('wingR2', 0, 0.7 * fold, 0.45 * f2 + 0.04 * brt * fold); pose('wingR3', 0, 0.25 * fold, 0.3 * f3);
    if (amp > 0.05) y += 0.6 * amp * Math.sin(wp + 0.4);   // 날갯짓마다 몸이 들썩
    pose('chest', -0.05 * breath + 0.035 * brt - 0.04 * f1, 0, 0);
    pose('hips', -0.015 * brt, 0, 0);
    // 목 · 머리: 머리마다 따로 일렁이고, 브레스 때는 자기 목표를 본다. 깨진 머리는 축 늘어진다
    for (let i = 0; i < 3; i++) {
      const k = HEADS[i], up = headUp(i), off = i * 2.1;
      let yaw = 0.18 * Math.sin(t * 0.7 + off) + (i - 1) * 0.12, pit = 0.1 * Math.sin(t * 0.9 + off), jaw = 0.08 + 0.06 * Math.sin(t * 1.3 + off);
      if (code === 'hbreath' && up) {
        const q = a.pt[i];
        if (q) { const hp = restW(NECKS[k][3]); yaw = clamp(wrapA(faceTo(q[0] - hp.x, q[1] - hp.z) - B.ry), -1.2, 1.2) * 0.33; }
        if (at < 1.0) { pit = 0.45 * ease(at); jaw = 0.25 * ease(at); }
        else { pit = -0.3 + 0.05 * Math.sin(t * 20 + off); jaw = 0.75; }
      }
      if (code === 'hsnap' && up) { const k0 = 0.7 + i * 0.12, u = clamp((at - (k0 - 0.45)) / 0.45, 0, 1); pit = 0.35 * ease(u) * (at < k0 ? 1 : 0) - (at >= k0 && at < k0 + 0.3 ? 0.55 : 0); jaw = at < k0 ? 0.8 * u : clamp(1 - (at - k0) / 0.12, 0, 1) * 0.8; }
      if (code === 'spawn' || code === 'hdive' && at < 1.4) { pit = 0.3; jaw = 0.6 + 0.2 * Math.sin(t * 11 + off); }
      if (!up) { pit = -0.55 + 0.05 * Math.sin(t * 0.6 + off); yaw *= 0.3; jaw = 0.35; }
      if (dying) { const dd = clamp(dieU * 1.6 - i * 0.25, 0, 1); pit = lerp(pit, -0.9, ease(dd)); jaw = lerp(jaw, 0.5, dd); }
      { const hk = code === 'hsnap' ? 3 : 1; pit = spring(rig.sp, 'p' + k, pit, dt, 45 * hk * hk, 11 * hk); yaw = spring(rig.sp, 'y' + k, yaw, dt, 40, 10); }   // 목: 관성 있게
      pose(`n${k}1`, pit * 0.35, yaw, 0); pose(`n${k}2`, pit * 0.35, yaw, 0); pose(`n${k}3`, pit * 0.3, yaw, 0);
      pose(`head${k}`, up ? pit * 0.2 : -0.3, yaw * 0.5, up ? 0 : 0.4);
      pose(`jaw${k}`, -0.75 * jaw, 0, 0);
    }
    if (B.spawnT > 0) { y = B.y + 34 * (1 - se) ** 1.5; pitch = -0.25 * (1 - se); }
    if (dying) { roll = 0.5 * ease(dieU); y = B.y - 1.5 * ease(dieU) - 7 * clamp((dk - 0.55) / 0.45, 0, 1); }
    rig.root.position.set(B.x, y, B.z);
    rig.root.rotation.order = 'YXZ'; rig.root.rotation.set(-pitch, B.ry, roll);
    const cp = ctx.camPos ? ctx.camPos() : null;
    const want = cp && Math.hypot(cp.x - B.x, cp.z - B.z) > D.lodD ? 1 : 0;
    if (want !== rig.lod) { rig.lod = want; for (const o of rig.lods) o.visible = new RegExp('_LOD' + want).test(o.name) || new RegExp('_LOD' + want).test(o.parent && o.parent.name || ''); }
    // 눈 · 입 안 불빛: 브레스 때 밝아지고, 분노하면 붉게 떨린다
    const glow = dying ? 1 - dk : 1;
    if (rig.eyeMat) rig.eyeMat.emissiveIntensity = (rig.base.get(rig.eyeMat).i || 1) * glow * (1 + (B.rage ? 0.4 * Math.sin(t * 9) : 0));
    rig.light.intensity = (code === 'hbreath' ? (at < 1 ? 60 * at : 140) : 10 + (B.rage ? 20 : 0)) * glow;
    if (rig.flash > 0) {
      rig.flash = Math.max(0, rig.flash - dt); const on = rig.flash > 0;
      for (const m of rig.mats) { if (!m.emissive || m === rig.eyeMat) continue; const b = rig.base.get(m); if (on) { m.emissive.setRGB(1, 0.05, 0.03); m.emissiveIntensity = 1.2 * rig.flashK; } else { m.emissive.copy(b.e); m.emissiveIntensity = b.i; } }
    }
  }
  function refreshHull() {
    capsW.length = 0;
    if (rig) {
      rig.root.updateMatrixWorld(true);
      const va = new THREE.Vector3(), vb = new THREE.Vector3();
      for (const h of rig.hull) {
        va.copy(h.a); vb.copy(h.b);
        const M = h.bone ? h.bone.matrixWorld : rig.root.matrixWorld; va.applyMatrix4(M); vb.applyMatrix4(M);
        capsW.push({ ax: va.x, ay: va.y, az: va.z, bx: vb.x, by: vb.y, bz: vb.z, r: h.r, col: h.col, hd: h.hd });
      }
      return;
    }
    for (const [, a, b, r, col, hd] of D.hull) { const A = restW(a), Bp = restW(b); capsW.push({ ax: A.x, ay: A.y, az: A.z, bx: Bp.x, by: Bp.y, bz: Bp.z, r, col: !!col, hd }); }
  }

  // ---------- 프레임 ----------
  function update(dt, t) {
    for (const k in myHit) myHit[k] = Math.max(0, myHit[k] - dt);
    if (!B.active) return;
    if (loadFailed) { despawn(); return; }
    if (!rig && assets) rig = makeRig();
    const now = performance.now();
    if (B.owner) ownerUpdate(dt);
    else {
      const k = Math.min(1, dt * 8);
      if (!act.cur || !['hdive', 'hsweep', 'hsnap'].includes(act.cur.code)) { B.x += (R.tx - B.x) * k; B.z += (R.tz - B.z) * k; B.y += (R.ty - B.y) * k; B.ry = wrapA(B.ry + wrapA(R.try_ - B.ry) * k); }
      if (B.spawnT > 0) B.spawnT -= dt;
      if (B.a === 'die' && B.dieT > 0) B.dieT -= dt;
      for (const h of B.haz) h.age += dt;
      const quiet = now - R.lastSnap;
      if (quiet > 7000) { const dead = B.a === 'die'; despawn(); emit('gone', { dead, kind }); return; }
      if (quiet > 2600 && B.a !== 'die') {
        const ids = ctx.players().map((p) => p.id).sort();
        if (ids[0] === ctx.myId) { B.owner = true; B.ownerId = ctx.myId; B.ep++; act.cur = null; O.gap = 1.2; O.hazId = Math.max(O.hazId, ...B.haz.map((h) => h.id), 0); for (const p of D.patterns) O.cd[p.code] = O.cd[p.code] || 0; emit('takeover', { kind }); }
      }
    }
    if (B.a !== 'die' && B.spawnT <= 0) {
      if (act.cur && act.cur.code === 'hbreath' && !act.cur.ev.has('glow')) { act.cur.ev.add('glow'); for (let i = 0; i < 3; i++) if (headUp(i)) addFx({ type: 'glow', i, t: 0, life: 1.1 }); }
      runPattern(dt);
    }
    const m = ctx.me();
    for (const h of B.haz) if (m.ok && h.age < 7 && Math.hypot(m.x - h.x, m.z - h.z) < 4.5 && m.y - floorAt(m.x, m.z) < 1.5) hitMe('burn', 0, 0);
    if (THREE.Mesh) {
      tickFx(dt, t);
      const seen = new Set();
      for (const h of B.haz) {
        seen.add(h.id); const v = hazVisual(h), k = clamp(h.age / 0.3, 0, 1) * clamp((7.5 - h.age) / 1.2, 0, 1), gy = ctx.heightAt(h.x, h.z) + 0.12;
        v.g.position.set(h.x, gy, h.z); v.disc.scale.set(4.5 * k, 1, 4.5 * k); v.ring.scale.set(4.6, 1, 4.6); v.disc.material.opacity = 0.45 * k; v.ring.material.opacity = 0.7 * k;
        for (const f of v.flames) { const q = f.userData, fl = 0.6 + 0.4 * Math.sin(t * 9 + q.ph); f.position.set(Math.cos(q.a) * q.r, 0.6 + fl * 1.2, Math.sin(q.a) * q.r); f.scale.set(0.55 * k, (1.4 + fl) * k, 0.55 * k); }
        if (VX.ok && k > 0.1) {   // 장판 위로 불길이 일고 불씨가 오르며 가끔 연기가 피어오른다
          for (let n = rate('hf' + h.id, 40 * k, dt); n-- > 0;) { const an = Math.random() * TAU, rr = Math.sqrt(Math.random()) * 4.2; VX.burst('fire', h.x + Math.cos(an) * rr, gy, h.z + Math.sin(an) * rr, { n: 1, size: 0.9 * k }); }
          for (let n = rate('he' + h.id, 12 * k, dt); n-- > 0;) { const an = Math.random() * TAU, rr = Math.sqrt(Math.random()) * 4.2; VX.burst('ember', h.x + Math.cos(an) * rr, gy, h.z + Math.sin(an) * rr, { n: 1 }); }
          for (let n = rate('hs' + h.id, 4 * k, dt); n-- > 0;) VX.burst('smoke', h.x, gy + 2, h.z, { n: 1, spread: 2 });
        }
      }
      for (const [id, v] of hazVis) if (!seen.has(id)) { scene.remove(v.g); hazVis.delete(id); }
    }
    animate(dt, t);
    refreshHull();
  }

  // ---------- 플레이어의 공격 ----------
  function segDist(px, py, pz, c) {
    const abx = c.bx - c.ax, aby = c.by - c.ay, abz = c.bz - c.az, l2 = abx * abx + aby * aby + abz * abz || 1;
    const u = clamp(((px - c.ax) * abx + (py - c.ay) * aby + (pz - c.az) * abz) / l2, 0, 1);
    return Math.hypot(px - (c.ax + abx * u), py - (c.ay + aby * u), pz - (c.az + abz * u));
  }
  function segDistXZ(px, pz, c) {
    const abx = c.bx - c.ax, abz = c.bz - c.az, l2 = abx * abx + abz * abz;
    const u = l2 > 1e-6 ? clamp(((px - c.ax) * abx + (pz - c.az) * abz) / l2, 0, 1) : 0;
    return Math.hypot(px - (c.ax + abx * u), pz - (c.az + abz * u));
  }
  const alive = () => B.active && B.spawnT <= 0 && B.a !== 'die' && B.dieT <= 0;
  function hitTest(cx, cz, radius, y) {   // 펀치·검기·수류탄: 가장 가까운 캡슐(머리면 머리 번호)
    if (!alive()) return [];
    if (!capsW.length) refreshHull();
    const py = y + 0.9; let best = null;
    for (const c of capsW) {
      const d = segDist(cx, py, cz, c) - c.r;
      if (d < radius + 0.35 && (!best || d < best.d)) best = { d, hd: c.hd };
      if (!best && c.col && segDistXZ(cx, cz, c) < c.r + radius && py < Math.max(c.ay, c.by) + c.r && py > ctx.heightAt(cx, cz) - 1.5) best = { d: 9, hd: 0 };
    }
    return best ? [{ kind: 'boss', id: best.hd }] : [];
  }
  function hitRay(ox, oy, oz, dx, dy, dz, maxD, radius = 0) {
    if (!alive()) return null;
    if (!capsW.length) refreshHull();
    let best = null;
    for (const c of capsW) {
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.r + radius, maxD);
      if (t >= 0 && (!best || t < best.d - (c.hd ? 0.6 : 0))) best = { kind: 'boss', id: c.hd, d: t, part: c.hd ? 'head' : 'body' };   // 머리와 몸이 겹치면 머리
    }
    return best;
  }
  function damage(k, id, amount, fromId, cdMs) {
    if (!B.owner || !B.active || k !== 'boss') return false;
    if (B.spawnT > 0 || B.dieT > 0 || B.hp <= 0) return false;
    const now = performance.now(), last = O.hitAt.get(fromId) || -1e9;
    if (now - last < (typeof cdMs === 'number' ? cdMs : 220)) return false;
    if (O.hitAt.size > 400) O.hitAt.clear();
    O.hitAt.set(fromId, now);
    let amt = clamp(amount, 1, 300);
    const hi = Number.isInteger(id) && id >= 1 && id <= 3 ? id - 1 : -1;
    if (hi >= 0 && headUp(hi)) {
      amt *= D.headMul;
      B.hh[hi] = Math.max(0, B.hh[hi] - amt);
      if (!headUp(hi)) headBreak(hi);
    }
    B.hp = Math.max(0, B.hp - amt);
    if (rig) { const fast = typeof cdMs === 'number' && cdMs < 150; rig.flash = fast ? Math.max(rig.flash, 0.05) : 0.12; rig.flashK = fast ? 0.3 : 1; }
    if (B.hp <= 0) die(fromId);
    emit('hp', { hp: B.hp, maxHp: B.maxHp });
    return true;
  }
  function headBreak(i) {   // 머리 하나가 꺾였다(모두): 가면 조각 · 소리 · 흔들림
    const m = mouthW(i);
    ctx.sfx(kind, 'headbreak', m.x, m.z); ctx.shake(0.6, 0.8);
    for (let k = 0; k < 6; k++) ctx.fx.poof(m.x + (Math.random() - 0.5) * 3, m.y - Math.random() * 2, m.z + (Math.random() - 0.5) * 3, 4);
    VX.impact(m.x, m.y - 0.6, m.z, { color: '#f0e0c0', hot: '#ffffff', sparks: 34, smokeN: 8, size: 1.8 }); VX.burst('debris', m.x, m.y, m.z, { n: 30, color: '#d8ccb0', speed: 1.1 }); VX.burst('fire', m.x, m.y, m.z, { n: 12, speed: 1.6, size: 1.2 });   // 가면 파편 · 불티
    emit('headbreak', { head: i + 1, left: headsUp(), kind });
  }
  function die(by) {
    B.a = 'die'; B.dieT = D.dieT; B.ac++; act.cur = null; B.haz = []; B.pitch = 0;
    ctx.sfx(kind, 'die', B.x, B.z); ctx.shake(1.1, 1.6); emit('die', { by, kind });
  }
  function slowAt() { return 1; }

  // ---------- 네트워크 ----------
  function snapshot() {
    if (!B.active || !B.owner) return null;
    return {
      kd: kind, id: ctx.myId, n: ++B.seq, b: B.born, ep: B.ep, hp: Math.round(B.hp), mh: B.maxHp, x: r2(B.x), z: r2(B.z), y: r2(B.y), r: r2(B.ry), a: B.a, ac: B.ac,
      sa: r2(B.sa), tx: B.tx, tz: B.tz, pt: B.pt.slice(0, 3), rg: B.rage ? 1 : 0, hh: B.hh.map((v) => Math.round(v)), hm: B.hMax,
      f: B.haz.slice(0, 8).map((h) => [h.id, h.x, h.z, r2(h.age)]),
    };
  }
  function applySnapshot(d, senderId) {
    if (!d || typeof d !== 'object' || d.kd !== kind) return false;
    const x = finite(d.x, -120, 120), z = finite(d.z, -140, 120), y = finite(d.y, -40, 80), ry = finite(d.r, -7, 7), hp = finite(d.hp, 0, 99999), mh = finite(d.mh, 1, 99999);
    const born = finite(d.b, 0, 1e15), ep = finite(d.ep, 0, 1e6), ac = finite(d.ac, 0, 1e9);
    if ([x, z, y, ry, hp, mh, born, ep, ac].some((v) => v === null) || !ACTS.has(d.a)) return false;
    const hh = Array.isArray(d.hh) && d.hh.length === 3 ? d.hh.map((v) => finite(v, 0, 99999)) : null;
    if (!hh || hh.some((v) => v === null)) return false;
    if (B.active && B.owner) {
      if (!outranks(ep, born, senderId, B.ep, B.born, ctx.myId)) return false;
      resetState();
    } else if (B.active && B.ownerId && B.ownerId !== senderId && !outranks(ep, born, senderId, B.ep, B.born, B.ownerId)) return false;
    if (!B.active) {
      resetState(); B.active = true; B.x = x; B.z = z; B.y = y; B.ry = ry; B.spawnT = d.a === 'spawn' ? D.spawnT : 0; R.lastAc = ac; B.hh = hh.slice();
      load().then(() => { if (B.active && !rig) rig = makeRig(); }).catch(() => despawn());
      emit('spawn', { owner: false, kind });
      if (d.a === 'spawn') intro();
    }
    B.owner = false; B.ownerId = senderId; B.ep = ep; B.born = born; B.maxHp = mh; B.rage = d.rg === 1; B.hMax = finite(d.hm, 1, 99999) ?? Math.round(mh * D.headShare);
    R.tx = x; R.tz = z; R.ty = y; R.try_ = ry; R.lastSnap = performance.now();
    for (let i = 0; i < 3; i++) { const was = headUp(i); B.hh[i] = hh[i]; if (was && !headUp(i) && d.a !== 'die') headBreak(i); }
    if (hp < B.hp && rig) { rig.flash = 0.12; rig.flashK = B.hp - hp >= 12 ? 1 : 0.3; }
    if (hp !== B.hp) { B.hp = hp; emit('hp', { hp, maxHp: mh }); }
    if (d.a === 'die' && B.a !== 'die') { B.a = 'die'; B.dieT = D.dieT; act.cur = null; ctx.sfx(kind, 'die', B.x, B.z); emit('die', { kind }); }
    if (ac !== R.lastAc) {
      const adv = ac - R.lastAc; R.lastAc = ac;
      if (adv > 0 && adv < 6 && D.patterns.some((p) => p.code === d.a)) {
        B.sa = finite(d.sa, -7, 7) ?? ry; B.tx = finite(d.tx, -120, 120) ?? x; B.tz = finite(d.tz, -140, 120) ?? z;
        B.pt = Array.isArray(d.pt) ? d.pt.slice(0, 3).filter((q) => Array.isArray(q) && finite(q[0], -120, 120) !== null && finite(q[1], -140, 120) !== null).map((q) => [finite(q[0], -120, 120), finite(q[1], -140, 120)]) : [];
        startPattern(d.a, true);
      }
    }
    if (d.a !== 'die') B.a = d.a;
    if (Array.isArray(d.f)) {
      const hs = [];
      for (const q of d.f.slice(0, 8)) {
        if (!Array.isArray(q)) continue;
        const id = finite(q[0], 0, 1e9), hx = finite(q[1], -120, 120), hz = finite(q[2], -140, 120), age = finite(q[3], 0, 60);
        if ([id, hx, hz, age].some((v) => v === null)) continue;
        hs.push({ id, x: hx, z: hz, age });
      }
      B.haz = hs;
    }
    return true;
  }

  return {
    kind, load, spawn, despawn, update, snapshot, applySnapshot, hitTest, hitRay, damage, slowAt,
    on(k, f) { (listeners[k] = listeners[k] || []).push(f); },
    act(code) { const p = D.patterns.find((q) => q.code === code); if (B.owner && B.active && !act.cur && B.spawnT <= 0 && B.dieT <= 0 && p) { ownerBegin(p, nearest(B.x, B.z)); return true; } return false; },   // test hook
    get active() { return B.active; }, get owner() { return B.owner; }, get ownerId() { return B.ownerId; },
    get view() { return { kind, name: D.name, title: D.title, born: B.born, active: B.active, owner: B.owner, hp: B.hp, maxHp: B.maxHp, a: B.a, rage: B.rage, x: B.x, z: B.z, y: B.y, ry: B.ry, minions: 0, webs: 0, haz: B.haz.length, proj: fxl.length, spawnT: B.spawnT, dying: B.a === 'die', camR: D.camR, camLift: D.camLift, act: act.cur ? act.cur.code : '', heads: B.hh.slice(), headsUp: headsUp() }; },
    get debug() { return { B, O, R, rig, fxl, act, capsW, myHit, hazVis, mouthW }; },
    BOSS: { hitReach: D.hitReach }, DEF: D,
  };
}
