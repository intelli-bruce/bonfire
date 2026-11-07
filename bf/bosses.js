// bf/bosses.js — 보스 3종(메갈로돈 · 초거대 바위 골렘 · 반천사·반악마) 과, 기존 인면 거미까지 한 창구로 묶는 허브.
// 모델: tools/bosses/build_bosses.py (Blender) → bf/shark.glb · bf/golem.glb · bf/seraph.glb (Draco 압축, LOD0/LOD1, 뼈대만 · 클립 없음).
//
// 네트워크 구조는 거미와 같다: 한 명(소유자)의 화면이 AI 를 돌리고 `boss` 주제로 초당 8번 스냅샷을 보낸다. 패턴은 카운터(ac)가 바뀔 때
// 모두가 같은 시간표로 재생하고(조준 sa · 목표 tx/tz · 점들 pt 동봉), 내가 맞았는지는 내 화면에서 판정한다.
// 스냅샷의 `kd` 가 보스 종류다. 동작 코드는 거미의 코드와 겹치지 않게 지어 옛 클라이언트는 이 스냅샷을 거부한다(엉뚱한 거미가 뜨지 않음).
//
//   const g = createGiantBoss(ctx, 'golem')   // 거미와 같은 API: spawn · despawn · update · snapshot · applySnapshot · hitTest · hitRay · damage · slowAt · view · on
//   const hub = createBossHub({ spider, shark, golem, seraph })   // index.html 이 SPIDER 자리에 쓰는 것. spawn(x, z, ry, kind)
//
// 피격 판정(빈틈 없는 몸): 보스마다 뼈에 붙은 캡슐 목록(HULL). 캡슐끼리 겹치게 잡았고, `col` 캡슐은 땅까지 기둥으로도 친다
// (다리 사이·배 밑 땅에 떨어진 수류탄·검기도 맞는다).

import { raySphere, rayCapsule } from './weapons-core.js';
import { DEMON } from './demon.js';   // 대악마: 정의 + 확장(ext) 은 bf/demon.js

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapA = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const r2 = (v) => Math.round(v * 100) / 100;
const finite = (v, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : null);
const beats = (stA, idA, stB, idB) => stA < stB || (stA === stB && idA < idB);
const outranks = (epA, bornA, idA, epB, bornB, idB) => (epA !== epB ? epA > epB : beats(bornA, idA, bornB, idB));
const ease = (t) => t * t * (3 - 2 * t);
const faceTo = (dx, dz) => Math.atan2(-dx, -dz);
// Blender(x, y 앞, z 위) → three(x, z, -y)
const bl = (p) => [p[0], p[2], -p[1]];

// ---------------------------------------------------------------------------------------------------------------------
// 종류별 정의 — 길이는 m. pattern: code · 가중치 · 쿨타임 · 거리 조건 · 길이(dur) · 시간표는 아래 각 보스의 run() 이 정한다.
// ---------------------------------------------------------------------------------------------------------------------
export const KINDS = {
  shark: {
    name: '메갈로돈', title: '심연의 이빨 · 메갈로돈', file: 'shark.glb', hp: 5200, hpPerExtra: 1700, hitReach: 30, camR: 0.65, camLift: 1.0, lodD: 70,
    speed: 7.5, turn: 1.4, spawnT: 2.4, dieT: 5.5, fly: false, water: true,
    // 몸 캡슐: [뼈, a(Blender), b(Blender), 반지름, col]
    hull: [['head', [0, 9.6, 0.3], [0, 6.0, 0.3], 1.6], ['head', [0, 6.0, 0.2], [0, 3.0, 0.05], 2.45], ['body', [0, 3.0, 0], [0, -0.5, 0.05], 2.55],
      ['t1', [0, -0.5, 0.05], [0, -3.5, 0.1], 2.05], ['t2', [0, -3.5, 0.1], [0, -6.8, 0.15], 1.25], ['t3', [0, -6.8, 0.15], [0, -9.5, 0.25], 0.75],
      ['t3', [0, -9.0, 0.4], [0, -11.2, 4.0], 0.7], ['t3', [0, -9.0, 0.0], [0, -10.4, -2.6], 0.6], ['body', [0, 1.4, 2.4], [0, -1.6, 5.0], 0.75],
      ['jaw', [-1.6, 5.0, -1.6], [1.6, 5.0, -1.6], 0.9], ['jaw', [0, 5.0, -1.7], [0, 8.2, -1.1], 1.0],
      ['pecL', [-1.9, 3.8, -1.3], [-5.6, 1.0, -2.6], 0.55], ['pecR', [1.9, 3.8, -1.3], [5.6, 1.0, -2.6], 0.55]],
    patterns: [
      { code: 'bite', w: 5, cd: 3.4, minD: 0, maxD: 15, dur: 1.5 },
      { code: 'lunge', w: 4, cd: 7.5, minD: 9, maxD: 34, dur: 4.4 },
      { code: 'tail', w: 3, cd: 5.5, minD: 0, maxD: 17, dur: 1.8 },
      { code: 'rush', w: 3, cd: 9, minD: 14, maxD: 45, dur: 2.6, water: true },
    ],
  },
  golem: {
    name: '바위 골렘', title: '태고의 심장 · 바위 골렘', file: 'golem.glb', hp: 6400, hpPerExtra: 2100, hitReach: 30, camR: 1.0, camLift: 1.2, lodD: 80,
    speed: 3.6, turn: 0.75, spawnT: 3.2, dieT: 6.0, fly: false, water: false,
    hull: [['hips', [0, 0, 6.4], [0, 0.1, 8.6], 3.0, true], ['spine', [-3.0, 0.8, 11.0], [3.0, 0.8, 11.0], 3.2, true], ['spine', [0, -0.8, 11.8], [0, 0.6, 9.0], 3.0],
      ['head', [0, 2.0, 12.2], [0, 3.6, 12.3], 1.6],
      ['armL', [-5.4, 0.6, 12.0], [-6.6, 1.2, 7.8], 1.9], ['foreL', [-6.6, 1.2, 7.8], [-6.8, 2.2, 4.0], 1.8], ['fistL', [-6.8, 2.2, 4.0], [-6.9, 2.7, 2.4], 2.1],
      ['armR', [5.4, 0.6, 12.0], [6.6, 1.2, 7.8], 1.9], ['foreR', [6.6, 1.2, 7.8], [6.8, 2.2, 4.0], 1.8], ['fistR', [6.8, 2.2, 4.0], [6.9, 2.7, 2.4], 2.1],
      ['thighL', [-2.2, 0, 6.0], [-2.8, 0.8, 3.4], 1.9], ['shinL', [-2.8, 0.8, 3.4], [-2.9, 0.4, 0.6], 1.9],
      ['thighR', [2.2, 0, 6.0], [2.8, 0.8, 3.4], 1.9], ['shinR', [2.8, 0.8, 3.4], [2.9, 0.4, 0.6], 1.9]],
    patterns: [
      { code: 'slam', w: 5, cd: 6.5, minD: 0, maxD: 17, dur: 2.7 },
      { code: 'hurl', w: 4, cd: 6.0, minD: 13, maxD: 64, dur: 2.4 },
      { code: 'charge', w: 3, cd: 9.5, minD: 12, maxD: 46, dur: 3.6 },
    ],
  },
  seraph: {
    name: '반천사·반악마', title: '타락한 심판자 · 세라프', file: 'seraph.glb', hp: 6000, hpPerExtra: 2000, hitReach: 32, camR: 1.0, camLift: 1.6, lodD: 80,
    speed: 6.0, turn: 1.1, spawnT: 3.4, dieT: 6.0, fly: true, water: false, hover: 4.2,
    hull: [['hips', [0, 0, 6.4], [0, 0, 8.6], 1.7], ['chest', [0, 0.1, 8.6], [0, 0.1, 11.4], 2.1], ['chest', [-2.8, 0, 11.6], [2.8, 0, 11.6], 1.25],
      ['head', [0, 0.3, 12.4], [0, 0.4, 14.1], 1.05],
      ['armL', [-3.0, 0, 11.4], [-3.9, 0.6, 8.8], 0.85], ['foreL', [-3.9, 0.6, 8.8], [-4.2, 1.8, 6.0], 0.75],
      ['armR', [3.0, 0, 11.4], [3.9, 0.6, 8.8], 0.85], ['foreR', [3.9, 0.6, 8.8], [4.2, 1.8, 6.0], 0.75],
      ['thighL', [-1.1, 0, 7.0], [-1.3, 0.5, 3.8], 1.05], ['shinL', [-1.3, 0.5, 3.8], [-1.35, 0, 0.6], 0.9],
      ['thighR', [1.1, 0, 7.0], [1.3, 0.5, 3.8], 1.05], ['shinR', [1.3, 0.5, 3.8], [1.35, 0, 0.6], 0.9],
      ['wingL1', [-1.2, -1.1, 11.4], [-7.0, -2.0, 14.5], 1.0], ['wingL2', [-7.0, -2.0, 14.5], [-15.5, -2.8, 12.6], 0.9], ['wingL2', [-5.5, -2.2, 12.0], [-13.0, -3.2, 10.0], 2.0], ['wingL2', [-6.0, -2.4, 9.0], [-12.0, -3.4, 7.0], 1.7],
      ['wingR1', [1.2, -1.1, 11.4], [7.0, -2.0, 14.5], 1.0], ['wingR2', [7.0, -2.0, 14.5], [16.4, -3.2, 10.6], 1.0], ['wingR2', [6.0, -2.3, 12.6], [13.5, -3.0, 12.0], 1.8], ['wingR2', [5.5, -2.6, 10.5], [12.0, -3.2, 8.0], 1.7]],
    patterns: [
      { code: 'pillar', w: 4, cd: 7.5, minD: 0, maxD: 70, dur: 3.0 },
      { code: 'hellfire', w: 4, cd: 8.0, minD: 6, maxD: 60, dur: 2.6 },
      { code: 'dive', w: 3, cd: 10, minD: 10, maxD: 60, dur: 4.2 },
    ],
  },
  demon: DEMON,
};
export const KIND_LIST = ['spider', 'shark', 'golem', 'seraph', 'demon', 'commander'];
// 패턴 피해(내 HP 100 기준) · 넉백 세기
export const HITS = {
  bite: [32, 2.4], lunge: [34, 2.8], tail: [22, 2.6], rush: [26, 2.2],
  slam: [34, 2.6], wave: [18, 1.6], hurl: [26, 2.0], charge: [30, 3.0],
  pillar: [30, 1.4], hellfire: [16, 1.2], burn: [7, 0.2], dive: [34, 3.0], ring: [16, 1.8],
  ...DEMON.hits,
};
const A_BASE = ['idle', 'move', 'spawn', 'die'];
export const ACTS = {};
for (const k in KINDS) ACTS[k] = new Set([...A_BASE, ...KINDS[k].patterns.map((p) => p.code)]);

// ---------------------------------------------------------------------------------------------------------------------
export function createGiantBoss(ctx, kind) {
  const D = KINDS[kind]; if (!D) throw new Error('unknown boss ' + kind);
  const { THREE, scene } = ctx;
  const B = { kind, active: false, owner: false, ownerId: '', ep: 0, born: 0, x: 0, z: 0, y: 0, ry: 0, hp: 0, maxHp: 0, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], seq: 0, spawnT: 0, dieT: 0, rage: false, haz: [] };
  const R = { tx: 0, tz: 0, ty: 0, try_: 0, lastAc: 0, lastSnap: 0 };
  const O = { cd: {}, gap: 1.2, hitAt: new Map(), hazId: 0, wander: 0 };
  const act = { cur: null };        // 지금 재생 중인 패턴(모두): { code, t, dur, from:{x,z,y,ry}, to:{x,z}, ev:Set, net }
  const listeners = {};
  const emit = (k, v) => { for (const f of listeners[k] || []) { try { f(v); } catch (e) { /* listener */ } } };
  const myHit = {};                 // 내 화면 쪽 패턴별 재피격 대기(s)
  let assets = null, loading = null, loadFailed = false, rig = null;
  const fxl = [];                   // 진행 중인 효과(충격파·바위·빛 기둥·불덩이) — 모두 같은 시간표로 시뮬레이트
  const hazVis = new Map();
  const capsW = [];                 // 매 프레임 갱신되는 세계 좌표 캡슐 [{ax,ay,az,bx,by,bz,r,col}]

  // ---------- 에셋 ----------
  function load() {
    if (assets) return Promise.resolve(assets);
    if (loading) return loading;
    loading = (async () => {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      const ld = new GLTFLoader();
      const dr = new DRACOLoader(); dr.setDecoderPath(ctx.dracoPath || 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
      ld.setDRACOLoader(dr);
      const g = await new Promise((res, rej) => ld.load(new URL(D.file, ctx.baseUrl).href, res, undefined, rej));
      assets = { g };
      return assets;
    })().catch((e) => { loadFailed = true; console.warn('[bonfire] boss assets failed', kind, e && e.message); throw e; });
    return loading;
  }
  function makeRig() {
    const root = assets.g.scene; // 한 번에 보스 하나: 복제하지 않고 그대로 쓴다
    const bones = {}, lods = [], mats = new Set();
    root.traverse((o) => {
      if (o.isBone) bones[o.name] = o;
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
        if (/_LOD(\d)/.test(o.name) || /_LOD(\d)/.test(o.parent && o.parent.name || '')) lods.push(o);
        for (const m of [].concat(o.material)) mats.add(m);
      }
    });
    for (const m of mats) {
      if (!m.isMeshStandardMaterial) continue;
      m.metalness = Math.min(m.metalness, 0.55);   // 환경맵 없는 밤: 금속이 검게 죽지 않게
      if (m.emissive.getHex() === 0) { m.emissive.copy(m.color).multiplyScalar(kind === 'golem' ? 0.12 : 0.16); }
    }
    const base = new Map(); for (const m of mats) base.set(m, { e: m.emissive.clone(), i: m.emissiveIntensity });
    root.updateMatrixWorld(true);
    // 뼈마다: 쉬는 자세 사원수 · 세계축(오른쪽 x · 위 y · 앞 -z)을 뼈 자신의 좌표로 옮긴 것 · 쉬는 세계 행렬의 역(캡슐용)
    const rest = {};
    for (const n in bones) {
      const b = bones[n], wq = new THREE.Quaternion(); b.getWorldQuaternion(wq);
      const inv = wq.clone().invert();
      rest[n] = { q: b.quaternion.clone(), p: b.position.clone(), X: new THREE.Vector3(1, 0, 0).applyQuaternion(inv), Y: new THREE.Vector3(0, 1, 0).applyQuaternion(inv), Z: new THREE.Vector3(0, 0, 1).applyQuaternion(inv), invW: b.matrixWorld.clone().invert() };
    }
    const hull = D.hull.map(([bn, a, b, r, col]) => {
      const bo = bones[bn], A = new THREE.Vector3(...bl(a)), Bv = new THREE.Vector3(...bl(b));
      if (bo) { A.applyMatrix4(rest[bn].invW); Bv.applyMatrix4(rest[bn].invW); }
      return { bone: bo, a: A, b: Bv, r, col: !!col };
    });
    let light = null;
    if (kind === 'golem') { light = new THREE.PointLight('#ff7a2a', 0, 34, 1.6); root.add(light); light.position.set(0, 10.6, -3.6); }
    if (kind === 'seraph') { light = new THREE.PointLight('#ffd890', 0, 40, 1.5); root.add(light); light.position.set(0, 14.3, 1.6); }
    if (D.ext && D.ext.light) light = D.ext.light(THREE, root);
    scene.add(root);
    const qs = { q: new THREE.Quaternion(), e: new THREE.Euler(), qa: new THREE.Quaternion() };
    return { root, bones, lods, mats, base, rest, hull, light, flash: 0, flashK: 1, qs, lod: -1, glow: 0 };
  }
  // 뼈를 쉬는 자세에서 세계축 기준 (오른쪽 x, 위 y, 앞 z) 각도만큼 돌린다
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
    scene.remove(rig.root);
    if (rig.light) rig.light.intensity = 0;
    for (const m of rig.mats) { const b = rig.base.get(m); if (b) { m.emissive.copy(b.e); m.emissiveIntensity = b.i; } }
    rig = null;
  }

  // ---------- 생명 주기 ----------
  function resetState() {
    B.active = false; B.owner = false; B.ownerId = ''; B.a = 'idle'; B.haz = []; B.spawnT = 0; B.dieT = 0; B.rage = false; B.pt = []; B.y = 0;
    O.cd = {}; for (const p of D.patterns) O.cd[p.code] = p.cd * 0.4; O.gap = 1.2; O.hitAt.clear();
    act.cur = null; disposeRig();
    for (const f of fxl) killFx(f); fxl.length = 0;
    for (const [, v] of hazVis) { scene.remove(v.g); } hazVis.clear();
    capsW.length = 0;
    if (D.ext && D.ext.reset) D.ext.reset(X);
  }
  function baseY(x, z) {   // 몸 뿌리의 높이(땅·물·공중)
    if (D.water) return ctx.waterLevel() - 1.5;
    if (D.fly) return ctx.heightAt(x, z) + D.hover;
    return ctx.heightAt(x, z);
  }
  function standOk(x, z) { return D.water ? ctx.canSwim(x, z) : D.fly ? ctx.canFly(x, z) : ctx.canStand(x, z); }
  function spawn(x, z, ry, born) {
    if (B.active) return false;
    const n = Math.max(1, ctx.players().length);
    resetState();
    B.active = true; B.owner = true; B.ownerId = ctx.myId; B.ep = 0; B.born = born > 0 ? born : Date.now(); B.seq = 0;
    B.x = x; B.z = z; B.ry = ry; B.y = baseY(x, z); B.maxHp = B.hp = D.hp + D.hpPerExtra * (n - 1);
    B.a = 'spawn'; B.spawnT = D.spawnT; B.ac++;
    R.tx = x; R.tz = z; R.ty = B.y; R.try_ = ry; R.lastSnap = performance.now();
    emit('spawn', { owner: true, kind });
    intro();
    load().then(() => { if (B.active && !rig) rig = makeRig(); }).catch(() => despawn());
    return true;
  }
  function despawn() { const was = B.active; resetState(); if (was) emit('despawn', { kind }); }

  // ---------- 등장 연출 (모두) ----------
  function intro() {
    const g = ctx.heightAt(B.x, B.z);
    ctx.sfx(kind, 'intro', B.x, B.z);
    ctx.shake(0.9, 2.2);
    if (D.ext && D.ext.intro) { D.ext.intro(X); return; }
    if (kind === 'shark') { for (let i = 0; i < 4; i++) setTimeout(() => ctx.fx.crown(B.x + (Math.random() - 0.5) * 8, ctx.waterLevel(), B.z + (Math.random() - 0.5) * 8, 24), i * 260); }
    else if (kind === 'golem') { for (let i = 0; i < 10; i++) setTimeout(() => ctx.fx.poof(B.x + (Math.random() - 0.5) * 12, g + 0.1, B.z + (Math.random() - 0.5) * 12, 6), i * 180); addFx({ type: 'ring', x: B.x, z: B.z, r0: 2, r1: 26, t: 0, life: 1.6, hit: false, color: '#c8a070' }); }
    else { addFx({ type: 'beam', x: B.x, z: B.z, r: 7, t: 0, warn: 0, life: 2.6, hit: false, intro: true }); }
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
  function goalFor(tg) {   // 어디로 갈지: 상어는 플레이어에 가장 가까운 물, 날개는 18~26 m 거리, 골렘은 곧장
    if (kind === 'shark') {
      let best = null, bd = 1e9;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        for (const r of [9, 14, 20, 28]) {
          const x = tg.p.x + Math.sin(a) * r, z = tg.p.z + Math.cos(a) * r;
          if (!ctx.canSwim(x, z)) continue;
          const d = r * 2 + Math.hypot(x - B.x, z - B.z) * 0.35; if (d < bd) { bd = d; best = { x, z }; }
          break;
        }
      }
      return best;
    }
    if (D.fly) { const d = tg.d, k = d > 24 ? 1 : d < 16 ? -1 : 0; return k ? { x: B.x + (tg.p.x - B.x) / (d || 1) * k * 10, z: B.z + (tg.p.z - B.z) / (d || 1) * k * 10 } : null; }
    return tg.d > 11 ? { x: tg.p.x, z: tg.p.z } : null;
  }
  function pickPattern(tg) {
    const ok = [];
    for (const p of D.patterns) {
      if (O.cd[p.code] > 0 || tg.d < p.minD || tg.d > p.maxD) continue;
      if (p.water && !ctx.canSwim(tg.p.x, tg.p.z) && !ctx.canSwim((tg.p.x + B.x) / 2, (tg.p.z + B.z) / 2)) continue;
      if (kind === 'shark' && p.code === 'bite') { const m = mouth(); if (Math.hypot(tg.p.x - m.x, tg.p.z - m.z) > 13) continue; }
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
    if (kind === 'shark' && p.code === 'lunge') {   // 물에서 뛰어올라 플레이어 자리까지(최대 30 m)
      const d = Math.hypot(B.tx - B.x, B.tz - B.z), k = Math.min(1, 30 / (d || 1)); B.tx = r2(B.x + (B.tx - B.x) * k); B.tz = r2(B.z + (B.tz - B.z) * k);
    }
    if (kind === 'seraph' && p.code === 'pillar') {
      for (const q of ctx.players()) if (Math.hypot(q.x - B.x, q.z - B.z) < 70 && B.pt.length < 4) B.pt.push([r2(q.x), r2(q.z)]);
      for (let i = 0; i < (B.rage ? 4 : 2); i++) { const a = Math.random() * TAU, r = 5 + Math.random() * 9; B.pt.push([r2(B.tx + Math.sin(a) * r), r2(B.tz + Math.cos(a) * r)]); }
    }
    if (kind === 'seraph' && p.code === 'hellfire') {
      for (let i = 0; i < (B.rage ? 5 : 3); i++) { const a = Math.random() * TAU, r = i === 0 ? 0 : 4 + Math.random() * 6; B.pt.push([r2(B.tx + Math.sin(a) * r), r2(B.tz + Math.cos(a) * r)]); }
    }
    B.ac++; startPattern(p.code, false);
  }
  function startPattern(code, net) {
    const p = D.patterns.find((q) => q.code === code); if (!p) return;
    B.a = code;
    act.cur = { code, t: 0, dur: p.dur * (B.rage ? 0.85 : 1), from: { x: B.x, z: B.z, y: B.y, ry: B.ry }, to: { x: B.tx, z: B.tz }, ev: new Set(), net, pt: B.pt.slice(0, 8) };
    ctx.sfx(kind, code, B.x, B.z);
  }
  function ownerUpdate(dt) {
    for (const k in O.cd) O.cd[k] = Math.max(0, O.cd[k] - dt);
    if (B.spawnT > 0) { B.spawnT -= dt; if (B.spawnT <= 0) B.a = 'idle'; return; }
    if (B.dieT > 0) { B.dieT -= dt; if (B.dieT <= 0) emit('request-despawn', { dead: true }); return; }
    if (!B.rage && B.hp <= B.maxHp * 0.35) { B.rage = true; emit('rage', { kind }); ctx.sfx(kind, 'rage', B.x, B.z); }
    // 불 장판 수명
    for (const h of B.haz) h.age += dt;
    B.haz = B.haz.filter((h) => h.age < 7.5);
    if (act.cur) return;
    const tg = nearest(B.x, B.z);
    if (!tg) { B.a = 'idle'; return; }
    O.gap = Math.max(0, O.gap - dt);
    const want = faceTo(tg.p.x - B.x, tg.p.z - B.z), dd = wrapA(want - B.ry);
    const tm = D.turn * (B.rage ? 1.3 : 1) * dt;
    if (O.gap <= 0 && Math.abs(dd) < 0.7) { const p = pickPattern(tg); if (p) { ownerBegin(p, tg); return; } }
    const goal = goalFor(tg);
    if (goal) {
      const gx = goal.x - B.x, gz = goal.z - B.z, gd = Math.hypot(gx, gz);
      if (gd > 1.5) {
        const gw = faceTo(gx, gz), gdd = wrapA(gw - B.ry);
        B.ry = wrapA(B.ry + clamp(kind === 'shark' ? gdd : (Math.abs(dd) < 1.2 ? gdd : dd), -tm, tm));
        const moved = Math.abs(gdd) < 1.3 && stepTo(-Math.sin(B.ry), -Math.cos(B.ry), D.speed * (B.rage ? 1.25 : 1), dt);
        B.a = moved ? 'move' : 'idle';
        if (!moved && kind === 'shark') B.ry = wrapA(B.ry + tm);   // 막혔으면 돌아 나간다
        return;
      }
    }
    B.ry = wrapA(B.ry + clamp(dd, -tm, tm)); B.a = kind === 'shark' ? 'move' : 'idle';
    if (kind === 'shark') stepTo(-Math.sin(B.ry), -Math.cos(B.ry), D.speed * 0.4, dt);   // 상어는 멈추지 않고 맴돈다
  }

  // ---------- 패턴 시간표 (모두 같은 것을 돈다) ----------
  const fwd = (ry) => [-Math.sin(ry), -Math.cos(ry)];
  function mouth() { const [fx, fz] = fwd(B.ry); return { x: B.x + fx * 9.0, z: B.z + fz * 9.0 }; }
  function once(a, key, at) { if (a.t >= at && !a.ev.has(key)) { a.ev.add(key); return true; } return false; }
  function runPattern(dt) {
    const a = act.cur; if (!a) return;
    a.t += dt;
    const u = a.t / a.dur, F = a.from, T = a.to;
    const tgA = faceTo(T.x - F.x, T.z - F.z);
    const turnTo = (w, k) => { B.ry = wrapA(B.ry + clamp(wrapA(w - B.ry), -k * dt, k * dt)); };
    const g = (x, z) => ctx.heightAt(x, z);
    if (kind === 'shark') {
      if (a.code === 'bite') {   // 짧게 앞으로 튀며 물기
        turnTo(tgA, 2.2);
        if (a.t > 0.35 && a.t < 0.75) { const m0 = mouth(); if (Math.hypot(T.x - m0.x, T.z - m0.z) > 3) moveBy(7.5 * dt / 0.4); }
        if (once(a, 'snap', 0.7)) { const m = mouth(); hitCone(m.x, m.z, B.ry, 7.5, 0.9, 'bite', 3.5); ctx.sfx(kind, 'snap', m.x, m.z); ctx.fx.crown(m.x, ctx.waterLevel(), m.z, 18); }
      } else if (a.code === 'lunge') {   // 물 밖 돌진: 뛰어올라(1.2 s) 덮치고, 모래 위에서 몸부림친 뒤(1.4 s) 물로 미끄러져 돌아간다
        const up = 0.55, fl = 1.25, back = 2.6;
        if (a.t < up) { turnTo(tgA, 3); B.y = F.y - 0.6 * ease(a.t / up); }
        else if (a.t < up + fl) {
          const s = ease((a.t - up) / fl); B.x = F.x + (T.x - F.x) * s; B.z = F.z + (T.z - F.z) * s;
          const ground = Math.max(ctx.waterLevel(), g(B.x, B.z) + 2.2);
          B.y = lerp(F.y, ground, s) + Math.sin(s * Math.PI) * 7.5; B.pitch = (0.5 - s) * 1.1;
          if (once(a, 'jump', up)) { ctx.fx.crown(F.x, ctx.waterLevel(), F.z, 30); ctx.sfx(kind, 'splash', F.x, F.z); ctx.shake(0.4, 0.6); }
        } else if (a.t < up + fl + back) {
          const s = (a.t - up - fl) / back;
          if (once(a, 'land', up + fl)) { hitCircle(T.x, T.z, 7.5, 'lunge', 3); ctx.sfx(kind, 'snap', T.x, T.z); ctx.shake(0.8, 0.8); for (let i = 0; i < 5; i++) ctx.fx.poof(T.x + (Math.random() - 0.5) * 8, g(T.x, T.z) + 0.2, T.z + (Math.random() - 0.5) * 8, 5); addFx({ type: 'ring', x: T.x, z: T.z, r0: 3, r1: 14, t: 0, life: 0.8, hit: true, dmg: 'ring', color: '#e8e2d0' }); }
          const ss = ease(clamp((s - 0.35) / 0.65, 0, 1));
          B.x = T.x + (F.x - T.x) * ss; B.z = T.z + (F.z - T.z) * ss;
          B.y = lerp(Math.max(ctx.waterLevel(), g(T.x, T.z) + 2.2), F.y, ss); B.pitch = 0; B.roll = Math.sin(a.t * 9) * 0.25 * (1 - ss);
        } else { B.roll = 0; }
      } else if (a.code === 'tail') {   // 몸을 비틀어 꼬리치기: 뒤쪽 부채꼴 + 물결 충격파
        if (once(a, 'whip', 0.8)) {
          const [fx, fz] = fwd(B.ry), tx = B.x - fx * 11, tz = B.z - fz * 11;
          hitCone(B.x, B.z, B.ry + Math.PI, 17, 1.25, 'tail', 4);
          addFx({ type: 'ring', x: tx, z: tz, r0: 2, r1: 20, t: 0, life: 1.2, hit: true, dmg: 'ring', color: '#d8f4ff', water: true });
          ctx.fx.crown(tx, ctx.waterLevel(), tz, 30); ctx.sfx(kind, 'splash', tx, tz); ctx.shake(0.5, 0.6);
        }
      } else if (a.code === 'rush') {   // 수면 돌진: 입을 벌리고 일직선
        if (a.t < 0.6) turnTo(tgA, 2.4);
        else if (a.t < 2.1) {
          const moved = moveBy(24 * dt); if (Math.random() < dt * 20) { const m = mouth(); ctx.fx.crown(m.x, ctx.waterLevel(), m.z, 6); }
          const m = mouth(); if (!a.ev.has('hit') && hitCircle(m.x, m.z, 5, 'rush', 0)) a.ev.add('hit');
          if (!moved) a.t = Math.max(a.t, 2.1);
        }
      }
    } else if (kind === 'golem') {
      if (a.code === 'slam') {   // 두 팔을 들어 내려찍기 → 충격파 세 겹
        turnTo(tgA, 0.9);
        if (once(a, 'hit', 1.25)) {
          const [fx, fz] = fwd(B.ry), cx = B.x + fx * 6, cz = B.z + fz * 6;
          hitCircle(cx, cz, 7, 'slam', 0); ctx.shake(1.2, 1.0); ctx.sfx(kind, 'slam', cx, cz);
          for (let i = 0; i < 3; i++) addFx({ type: 'ring', x: cx, z: cz, r0: 3, r1: 26, t: -i * 0.28, life: 1.5, hit: true, dmg: 'wave', color: '#d9b080' });
          for (let i = 0; i < 8; i++) ctx.fx.poof(cx + (Math.random() - 0.5) * 9, g(cx, cz) + 0.2, cz + (Math.random() - 0.5) * 9, 6);
        }
      } else if (a.code === 'hurl') {   // 바위를 뜯어 던진다
        turnTo(tgA, 1.2);
        if (once(a, 'grab', 0.5)) { const [fx, fz] = fwd(B.ry), x = B.x + fx * 4 + Math.cos(B.ry) * 6, z = B.z + fz * 4 - Math.sin(B.ry) * 6; ctx.fx.poof(x, g(x, z), z, 8); ctx.sfx(kind, 'grab', x, z); }
        if (once(a, 'throw', 1.35)) {
          const s = handPos('fistR'), d = Math.hypot(T.x - s.x, T.z - s.z), fl = clamp(d / 26, 0.6, 2.2);
          addFx({ type: 'rock', sx: s.x, sy: s.y, sz: s.z, x: T.x, z: T.z, t: 0, life: fl, hit: true });
          ctx.sfx(kind, 'whoosh', s.x, s.z);
        }
      } else if (a.code === 'charge') {   // 발 구르기 → 일직선 돌진
        if (a.t < 0.9) { turnTo(tgA, 1.6); if (once(a, 'stomp', 0.5)) { ctx.shake(0.5, 0.5); ctx.sfx(kind, 'step', B.x, B.z); } }
        else if (a.t < 2.9) {
          const moved = moveBy(16 * (B.rage ? 1.2 : 1) * dt);
          if (Math.random() < dt * 10) ctx.fx.poof(B.x + (Math.random() - 0.5) * 6, g(B.x, B.z) + 0.1, B.z + (Math.random() - 0.5) * 6, 4);
          const [fx, fz] = fwd(B.ry); if (!a.ev.has('hit') && hitCircle(B.x + fx * 3, B.z + fz * 3, 6, 'charge', 0)) a.ev.add('hit');
          if (Math.floor(a.t * 3.2) !== Math.floor((a.t - dt) * 3.2)) { ctx.shake(0.35, 0.3); ctx.sfx(kind, 'step', B.x, B.z); }
          if (!moved) { a.t = Math.max(a.t, 2.9); ctx.shake(0.8, 0.6); }
        }
      }
    } else if (D.ext && D.ext.run) { D.ext.run(X, a, dt, { F, T, tgA, turnTo });
    } else if (kind === 'seraph') {
      if (a.code === 'pillar') {   // 빛 기둥: 표식 → 1.3 s 뒤 내리꽂힘
        turnTo(tgA, 1.2);
        if (once(a, 'mark', 0.3)) for (const q of a.pt) addFx({ type: 'beam', x: q[0], z: q[1], r: 4.2, t: 0, warn: 1.3, life: 2.2, hit: true });
      } else if (a.code === 'hellfire') {   // 지옥불: 오른손에서 불덩이 → 떨어진 자리에 불 장판
        turnTo(tgA, 1.4);
        if (once(a, 'cast', 0.9)) {
          const s = handPos('foreR');
          a.pt.forEach((q, i) => addFx({ type: 'fireball', sx: s.x, sy: s.y, sz: s.z, x: q[0], z: q[1], t: -i * 0.18, life: 1.0 + i * 0.05, hit: true }));
          ctx.sfx(kind, 'fire', s.x, s.z);
        }
      } else if (a.code === 'dive') {   // 비행 강하: 높이 솟구쳤다가 내리꽂고 다시 오른다
        const up = 1.2, dn = 0.75;
        if (a.t < up) { turnTo(tgA, 2); B.y = F.y + 16 * ease(a.t / up); B.pitch = -0.3 * (a.t / up); }
        else if (a.t < up + dn) {
          const s = (a.t - up) / dn, e = s * s; B.x = F.x + (T.x - F.x) * e; B.z = F.z + (T.z - F.z) * e;
          B.y = lerp(F.y + 16, g(B.x, B.z) + 1.0, e); B.pitch = 0.9 * Math.sin(s * Math.PI * 0.5);
        } else {
          if (once(a, 'impact', up + dn)) { hitCircle(T.x, T.z, 9, 'dive', 0); ctx.shake(1.3, 1.0); ctx.sfx(kind, 'impact', T.x, T.z); addFx({ type: 'ring', x: T.x, z: T.z, r0: 3, r1: 24, t: 0, life: 1.2, hit: true, dmg: 'ring', color: '#ffd9a0' }); for (let i = 0; i < 8; i++) ctx.fx.poof(T.x + (Math.random() - 0.5) * 10, g(T.x, T.z) + 0.2, T.z + (Math.random() - 0.5) * 10, 6); }
          const s = clamp((a.t - up - dn - 0.3) / 1.5, 0, 1); B.y = lerp(g(B.x, B.z) + 1.0, baseY(B.x, B.z), ease(s)); B.pitch = 0.9 * (1 - s);
        }
      }
    }
    if (a.t >= a.dur) { act.cur = null; B.pitch = 0; B.roll = 0; if (B.owner) { O.gap = B.rage ? 0.6 : 1.0; B.a = 'idle'; B.y = baseY(B.x, B.z); } }
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function moveBy(dist) { const [fx, fz] = fwd(B.ry), nx = B.x + fx * dist, nz = B.z + fz * dist; if (standOk(nx, nz)) { B.x = nx; B.z = nz; return true; } return false; }
  function handPos(bn) {
    const v = new THREE.Vector3();
    if (rig && rig.bones[bn]) { rig.bones[bn].getWorldPosition(v); return { x: v.x, y: v.y, z: v.z }; }
    const [fx, fz] = fwd(B.ry); return { x: B.x + fx * 3, y: B.y + 8, z: B.z + fz * 3 };
  }

  // ---------- 효과 (모두) ----------
  let fxRes = null;
  function res() {
    if (fxRes) return fxRes;
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
    fxRes = {
      ring: new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2),
      disc: new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0),
      rock: new THREE.DodecahedronGeometry(1.6, 1),
      ball: new THREE.SphereGeometry(1, 14, 10),
      rockMat: new THREE.MeshStandardMaterial({ color: '#6d665c', roughness: 0.95, flatShading: true, emissive: '#1a1410' }),
      fireMat: new THREE.MeshBasicMaterial({ color: '#ff7a1c', ...add, opacity: 0.95 }),
      coreMat: new THREE.MeshBasicMaterial({ color: '#fff0b0', ...add }),
      add,
    };
    return fxRes;
  }
  function addFx(f) { fxl.push(f); return f; }
  function killFx(f) { if (f.g) { scene.remove(f.g); f.g.traverse((o) => { if (o.material && o.material.userData.own) o.material.dispose(); }); } }
  const ownMat = (c, o = 1) => { const m = new THREE.MeshBasicMaterial({ color: c, ...res().add, opacity: o }); m.userData.own = true; return m; };
  function tickFx(dt) {
    const m = ctx.me();
    for (let i = fxl.length - 1; i >= 0; i--) {
      const f = fxl[i]; f.t += dt;
      if (f.t < 0) continue;
      const u = f.t / f.life;
      if (f.type === 'ring') {   // 땅(물)을 따라 퍼지는 충격파: 띠가 지나갈 때 땅에 있으면 맞는다(점프로 넘김)
        const r = f.r0 + (f.r1 - f.r0) * Math.min(1, u);
        if (!f.g) { f.g = new THREE.Mesh(res().ring, ownMat(f.color || '#ffffff', 0.9)); f.g.renderOrder = 3; scene.add(f.g); }
        const y = f.water ? ctx.waterLevel() + 0.15 : ctx.heightAt(f.x, f.z) + 0.25;
        f.g.position.set(f.x, y, f.z); f.g.scale.set(r, 1, r); f.g.material.opacity = 0.85 * (1 - u);
        if (f.hit && m.ok && !f.done) {
          const d = Math.hypot(m.x - f.x, m.z - f.z), onG = m.y - (f.water ? Math.max(ctx.heightAt(m.x, m.z), ctx.waterLevel() - 1) : ctx.heightAt(m.x, m.z)) < 1.1;
          if (Math.abs(d - r) < 1.4 && onG) { f.done = true; hitMe(f.dmg || 'wave', (m.x - f.x) / (d || 1), (m.z - f.z) / (d || 1)); }
        }
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      } else if (f.type === 'rock' || f.type === 'fireball') {   // 포물선 투사체: 떨어진 자리 주변이 맞는다
        const s = Math.min(1, u), ty = ctx.heightAt(f.x, f.z) + 0.5;
        if (!f.g) {
          if (f.type === 'rock') { f.g = new THREE.Mesh(res().rock, res().rockMat); }
          else { f.g = new THREE.Group(); const c = new THREE.Mesh(res().ball, res().coreMat), o = new THREE.Mesh(res().ball, res().fireMat); o.scale.setScalar(1.8); c.scale.setScalar(0.9); f.g.add(o, c); }
          scene.add(f.g);
        }
        const px = f.sx + (f.x - f.sx) * s, pz = f.sz + (f.z - f.sz) * s, py = f.sy + (ty - f.sy) * s + Math.sin(s * Math.PI) * (f.type === 'rock' ? 9 : 6);
        f.g.position.set(px, py, pz); f.g.rotation.x += dt * 4; f.g.rotation.z += dt * 3;
        if (f.type === 'fireball' && Math.random() < dt * 30) ctx.fx.spark(px, py, pz);
        if (s >= 1) {
          killFx(f); fxl.splice(i, 1);
          ctx.shake(f.type === 'rock' ? 0.7 : 0.35, 0.5);
          if (f.type === 'rock') {
            ctx.sfx(kind, 'impact', f.x, f.z);
            for (let k = 0; k < 6; k++) ctx.fx.poof(f.x + (Math.random() - 0.5) * 6, ty, f.z + (Math.random() - 0.5) * 6, 6);
            if (f.hit) hitCircle(f.x, f.z, 5.5, 'hurl', 0);
            addFx({ type: 'ring', x: f.x, z: f.z, r0: 1, r1: 10, t: 0, life: 0.7, hit: false, color: '#c9a77c' });
          } else {
            ctx.sfx(kind, 'burst', f.x, f.z);
            for (let k = 0; k < 6; k++) ctx.fx.spark(f.x + (Math.random() - 0.5) * 4, ty + Math.random() * 2, f.z + (Math.random() - 0.5) * 4);
            if (f.hit) hitCircle(f.x, f.z, 4.8, 'hellfire', 0);
            if (B.owner && B.active && B.haz.length < 8) B.haz.push({ id: ++O.hazId, x: r2(f.x), z: r2(f.z), age: 0 });
          }
        }
      } else if (f.type === 'beam') {   // 빛 기둥: 바닥 표식(warn) → 기둥(내리꽂힐 때 원 안이면 맞음)
        if (!f.g) {
          f.g = new THREE.Group();
          const mark = new THREE.Mesh(res().ring, ownMat('#ffd27a', 0.9)), fill = new THREE.Mesh(res().disc, ownMat('#ffcc66', 0.2)), col = new THREE.Mesh(res().cyl, ownMat('#fff1c4', 0)), core = new THREE.Mesh(res().cyl, ownMat('#ffffff', 0));
          f.g.add(mark, fill, col, core); f.parts = { mark, fill, col, core }; scene.add(f.g);
        }
        const gy = ctx.heightAt(f.x, f.z) + 0.2, P = f.parts;
        f.g.position.set(f.x, gy, f.z);
        P.mark.scale.set(f.r, 1, f.r); P.fill.scale.set(f.r * Math.min(1, f.t / Math.max(0.01, f.warn)), 1, f.r * Math.min(1, f.t / Math.max(0.01, f.warn)));
        const on = f.t >= f.warn, k = on ? clamp(1 - (f.t - f.warn) / (f.life - f.warn), 0, 1) : 0;
        P.col.scale.set(f.r * (0.6 + 0.4 * k), 60, f.r * (0.6 + 0.4 * k)); P.col.material.opacity = on ? 0.55 * k : 0;
        P.core.scale.set(f.r * 0.35, 60, f.r * 0.35); P.core.material.opacity = on ? 0.9 * k : 0;
        P.mark.material.opacity = on ? 0.3 * k : 0.6 + 0.4 * Math.sin(f.t * 20); P.fill.material.opacity = on ? 0 : 0.25;
        if (on && !f.fired) {
          f.fired = true; ctx.shake(0.35, 0.4);
          if (!f.intro) ctx.sfx(kind, 'beam', f.x, f.z);
          for (let k2 = 0; k2 < 5; k2++) ctx.fx.spark(f.x + (Math.random() - 0.5) * f.r, gy + Math.random() * 3, f.z + (Math.random() - 0.5) * f.r);
          if (f.hit) hitCircle(f.x, f.z, f.r, 'pillar', 0);
        }
        if (f.t >= f.life) { killFx(f); fxl.splice(i, 1); }
      }
    }
  }
  function hazVisual(h) {
    let v = hazVis.get(h.id);
    if (!v) {
      const g = new THREE.Group(), disc = new THREE.Mesh(res().disc, ownMat('#ff4a10', 0.55)), ring = new THREE.Mesh(res().ring, ownMat('#ffb040', 0.8));
      const flames = [];
      for (let k = 0; k < 7; k++) { const f = new THREE.Mesh(res().ball, ownMat(k % 2 ? '#ff6a1a' : '#ffb24a', 0.7)); f.userData.ph = Math.random() * TAU; f.userData.r = Math.random() * 3.4; f.userData.a = Math.random() * TAU; g.add(f); flames.push(f); }
      g.add(disc, ring); scene.add(g); v = { g, disc, ring, flames }; hazVis.set(h.id, v);
    }
    return v;
  }

  // ---------- 내게 맞았나 (내 화면) ----------
  const floorAt = (x, z) => Math.max(ctx.heightAt(x, z), ctx.waterLevel() - 0.6);   // 헤엄치는 사람은 물 표면이 바닥
  function hitMe(src, dx, dz) {
    const m = ctx.me(); if (!m.ok) return false;
    if ((myHit[src] || 0) > 0) return false;
    myHit[src] = src === 'burn' ? 0.5 : 0.8;
    const h = HITS[src] || [15, 1.5];
    ctx.onHitMe({ src, boss: kind, dmg: h[0] * (B.rage ? 1.15 : 1), dx, dz, power: h[1] });
    return true;
  }
  function hitCircle(x, z, r, src, hmax) {
    const m = ctx.me(); if (!m.ok) return false;
    const d = Math.hypot(m.x - x, m.z - z); if (d > r) return false;
    if (hmax > 0 && m.y - floorAt(m.x, m.z) > hmax) return false;
    if (hmax === 0 && m.y - floorAt(m.x, m.z) > 3.5) return false;   // 높이 뛴 사람은 넘긴다
    return hitMe(src, (m.x - x) / (d || 1), (m.z - z) / (d || 1));
  }
  function hitCone(x, z, dir, range, half, src, hmax) {
    const m = ctx.me(); if (!m.ok) return false;
    const dx = m.x - x, dz = m.z - z, d = Math.hypot(dx, dz);
    if (d > range || (d > 4 && Math.abs(wrapA(faceTo(dx, dz) - dir)) > half)) return false;
    if (m.y - floorAt(m.x, m.z) > hmax) return false;
    return hitMe(src, dx / (d || 1), dz / (d || 1));
  }

  // ---------- 모습 (모두) ----------
  function animate(dt, t) {
    if (!rig) return;
    const sp = B.spawnT > 0 ? clamp(1 - B.spawnT / D.spawnT, 0, 1) : 1, se = 1 - (1 - sp) * (1 - sp);
    const dying = B.a === 'die', dk = dying ? clamp(1 - B.dieT / D.dieT, 0, 1) : 0;
    const dieU = dying ? (rig.dieU = Math.min(1, (rig.dieU || 0) + dt / 2.2)) : (rig.dieU = 0);
    const a = act.cur, at = a ? a.t : 0, code = a ? a.code : B.a;
    let y = B.y, pitch = B.pitch || 0, roll = B.roll || 0, yaw = B.ry;
    rig.ph = (rig.ph || 0) + dt * (B.a === 'move' || code === 'rush' || code === 'charge' ? (kind === 'golem' ? 2.4 : 5.5) : 1.6) * (B.rage ? 1.25 : 1);
    const ph = rig.ph;
    if (kind === 'shark') {
      const amp = code === 'rush' ? 0.32 : B.a === 'move' ? 0.22 : 0.1, sw = ph * 1.6;
      const tailWhip = code === 'tail' ? Math.sin(clamp((at - 0.35) / 0.7, 0, 1) * Math.PI * 2) * 0.9 : 0;
      pose('head', 0, Math.sin(sw) * amp * 0.25, 0);
      pose('t1', 0, Math.sin(sw - 0.8) * amp * 0.6 + tailWhip * 0.4, 0); pose('t2', 0, Math.sin(sw - 1.6) * amp + tailWhip * 0.6, 0); pose('t3', 0, Math.sin(sw - 2.4) * amp * 1.3 + tailWhip * 0.7, 0);
      const jaw = code === 'bite' ? (at < 0.6 ? ease(at / 0.6) : clamp(1 - (at - 0.7) / 0.15, 0, 1)) : code === 'lunge' ? (at > 0.4 && at < 1.85 ? 1 : at < 3 ? 0.35 + 0.3 * Math.sin(at * 14) : 0) : code === 'rush' ? 0.85 : code === 'spawn' ? 0.9 : 0.12 + 0.06 * Math.sin(t * 0.9);
      pose('jaw', -0.62 * jaw, 0, 0);
      pose('pecL', 0, 0, 0.12 * Math.sin(sw * 0.5)); pose('pecR', 0, 0, -0.12 * Math.sin(sw * 0.5));
      if (B.spawnT > 0) { y = B.y - 10 * (1 - se) + Math.sin(se * Math.PI) * 9; pitch = (0.6 - se) * 1.2; }   // 물 밖으로 솟구쳤다 떨어진다
      if (dying) { roll = Math.PI * ease(dieU); y = B.y + 1.2 - 8 * clamp((dk - 0.3) / 0.7, 0, 1); }
      if (code === 'tail') roll = Math.sin(clamp((at - 0.3) / 0.8, 0, 1) * Math.PI) * 0.5;
    } else if (kind === 'golem') {
      const walk = B.a === 'move' || code === 'charge' ? 1 : 0, s = Math.sin(ph), c = Math.cos(ph);
      let armL = 0.15 * s * walk, armR = -0.15 * s * walk, fore = -0.25, spine = 0.06 * Math.sin(t * 0.7), headP = 0;
      if (code === 'slam') { const up = ease(clamp(at / 1.0, 0, 1)), dn = clamp((at - 1.0) / 0.25, 0, 1); armL = armR = -2.6 * up * (1 - dn) + 0.2 * dn; fore = -0.25 - 0.6 * up * (1 - dn); spine = -0.25 * up * (1 - dn) + 0.45 * dn * clamp(1 - (at - 1.4) / 1.0, 0, 1); }
      if (code === 'hurl') { const k1 = ease(clamp(at / 0.5, 0, 1)), k2 = clamp((at - 0.5) / 0.6, 0, 1), k3 = clamp((at - 1.2) / 0.25, 0, 1); armR = 0.9 * k1 * (1 - k2) - 2.7 * k2 * (1 - k3) + 0.6 * k3; spine = 0.3 * k1 * (1 - k2) - 0.2 * k2 + 0.25 * k3; }
      if (code === 'charge') { spine = 0.35; headP = -0.2; }
      if (B.spawnT > 0) { y = B.y - 16 * (1 - se); spine = 0.5 * (1 - se); armL = armR = -1.2 * (1 - se) * Math.sin(se * 3); }
      pose('spine', spine, 0.05 * Math.sin(ph * 0.5) * walk, 0); pose('head', headP, 0.1 * Math.sin(t * 0.4), 0);
      pose('armL', armL, 0, 0.1); pose('armR', armR, 0, -0.1); pose('foreL', fore, 0, 0); pose('foreR', fore, 0, 0);
      pose('thighL', 0.45 * s * walk, 0, 0); pose('thighR', -0.45 * s * walk, 0, 0); pose('shinL', -0.35 * Math.max(0, -s) * walk, 0, 0); pose('shinR', -0.35 * Math.max(0, s) * walk, 0, 0);
      y += Math.abs(c) * 0.35 * walk;
      if (walk && Math.sign(s) !== rig.lastStep) { rig.lastStep = Math.sign(s); ctx.shake(0.18, 0.25); if (B.a === 'move') ctx.sfx(kind, 'step', B.x, B.z); }
      if (dying) { pitch = 1.35 * ease(dieU); y = B.y - 2 - 6 * clamp((dk - 0.4) / 0.6, 0, 1); }
      const hk = dying ? 1 - dk : se;
      rig.glow = hk * (0.8 + 0.2 * Math.sin(t * 3.1) + (B.rage ? 0.5 : 0));
      if (rig.light) rig.light.intensity = 60 * rig.glow;
    } else if (D.ext && D.ext.anim) { const o = { y, pitch, roll }; D.ext.anim(X, o, dt, t, { a, at, code, se, dying, dk, dieU, ph }); y = o.y; pitch = o.pitch; roll = o.roll;
    } else if (kind === 'seraph') {
      const fl = Math.sin(ph * 1.6), flap = code === 'dive' ? (at < 1.2 ? 1 : 0.15) : 1;
      pose('wingL1', 0, 0.15 * fl, -0.55 * fl * flap); pose('wingL2', 0, 0, -0.35 * Math.sin(ph * 1.6 - 0.7) * flap);
      pose('wingR1', 0, -0.15 * fl, 0.55 * fl * flap); pose('wingR2', 0, 0, 0.35 * Math.sin(ph * 1.6 - 0.7) * flap);
      let aL = 0.1, aR = 0.1, fL = -0.3, fR = -0.3;
      if (code === 'pillar') { const k = ease(clamp(at / 0.5, 0, 1)) * clamp((a ? a.dur : 1) - at, 0, 1); aL = -2.6 * k; fL = -0.2; }
      if (code === 'hellfire') { const k = ease(clamp(at / 0.6, 0, 1)) * clamp((a ? a.dur : 1) - at, 0, 1); aR = -1.5 * k; fR = -0.1; }
      if (code === 'dive' && at > 1.0) { aL = aR = 0.6; }
      pose('armL', aL, 0, 0.15); pose('armR', aR, 0, -0.15); pose('foreL', fL, 0, 0); pose('foreR', fR, 0, 0);
      pose('thighL', 0.25 + 0.08 * Math.sin(t * 1.3), 0, 0); pose('thighR', 0.3 + 0.08 * Math.sin(t * 1.3 + 1), 0, 0); pose('shinL', -0.5, 0, 0); pose('shinR', -0.6, 0, 0);
      pose('chest', 0.05 * Math.sin(t * 1.1), 0, 0); pose('head', 0.08 * Math.sin(t * 0.8), 0, 0);
      y += 0.6 * Math.sin(ph * 1.6 + 1.2);
      if (B.spawnT > 0) y = B.y + 30 * (1 - se);
      if (dying) { pitch = -0.4 * dieU; roll = 0.6 * dieU; y = lerp(B.y, ctx.heightAt(B.x, B.z) - 1.5, ease(clamp(dk * 1.6, 0, 1))) - 6 * clamp((dk - 0.6) / 0.4, 0, 1); }
      rig.glow = dying ? 1 - dk : 1;
      if (rig.light) rig.light.intensity = 40 * rig.glow * (0.85 + 0.15 * Math.sin(t * 4));
    }
    rig.root.position.set(B.x, y, B.z);
    rig.root.rotation.order = 'YXZ'; rig.root.rotation.set(-pitch, yaw, roll);
    rig.root.scale.setScalar(kind === 'golem' && B.spawnT > 0 ? 0.6 + 0.4 * se : 1);
    // LOD: 카메라 거리
    const cp = ctx.camPos ? ctx.camPos() : null;
    const want = cp && Math.hypot(cp.x - B.x, cp.z - B.z) > D.lodD ? 1 : 0;
    if (want !== rig.lod) { rig.lod = want; for (const o of rig.lods) o.visible = new RegExp('_LOD' + want).test(o.name) || new RegExp('_LOD' + want).test(o.parent && o.parent.name || ''); }
    // 피격 깜빡임
    if (rig.flash > 0) {
      rig.flash = Math.max(0, rig.flash - dt); const on = rig.flash > 0;
      for (const m of rig.mats) { if (!m.emissive) continue; const b = rig.base.get(m); if (on) { m.emissive.setRGB(1, 0.05, 0.03); m.emissiveIntensity = 1.2 * rig.flashK; } else { m.emissive.copy(b.e); m.emissiveIntensity = b.i; } }
    }
  }
  const tmpA = { x: 0, y: 0, z: 0 };
  function refreshHull() {   // 세계 좌표 캡슐: 모델이 있으면 뼈 따라, 없으면 쉬는 자세 그대로(테스트·로딩 중)
    capsW.length = 0;
    if (rig) {
      rig.root.updateMatrixWorld(true);
      const va = new THREE.Vector3(), vb = new THREE.Vector3();
      for (const h of rig.hull) {
        va.copy(h.a); vb.copy(h.b);
        if (h.bone) { va.applyMatrix4(h.bone.matrixWorld); vb.applyMatrix4(h.bone.matrixWorld); } else { va.applyMatrix4(rig.root.matrixWorld); vb.applyMatrix4(rig.root.matrixWorld); }
        capsW.push({ ax: va.x, ay: va.y, az: va.z, bx: vb.x, by: vb.y, bz: vb.z, r: h.r, col: h.col });
      }
      return;
    }
    const c = Math.cos(B.ry), s = Math.sin(B.ry);
    const tw = (p) => { const [x, y, z] = bl(p); tmpA.x = B.x + x * c + z * s; tmpA.y = B.y + y; tmpA.z = B.z - x * s + z * c; return tmpA; };
    for (const [, a, b, r, col] of D.hull) { const A = tw(a), ax = A.x, ay = A.y, az = A.z, Bp = tw(b); capsW.push({ ax, ay, az, bx: Bp.x, by: Bp.y, bz: Bp.z, r, col: !!col }); }
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
      if (!act.cur || !['lunge', 'rush', 'dive', 'charge', 'bite'].includes(act.cur.code)) { B.x += (R.tx - B.x) * k; B.z += (R.tz - B.z) * k; B.y += (R.ty - B.y) * k; B.ry = wrapA(B.ry + wrapA(R.try_ - B.ry) * k); }
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
    if (B.a !== 'die' && B.spawnT <= 0) runPattern(dt);
    // 불 장판: 내 발밑이면 0.5 s 마다 화상
    const m = ctx.me();
    for (const h of B.haz) if (m.ok && h.age < 7 && Math.hypot(m.x - h.x, m.z - h.z) < 4.5 && m.y - floorAt(m.x, m.z) < 1.5) hitMe('burn', 0, 0);
    if (THREE.Mesh) {
      tickFx(dt);
      if (D.ext && D.ext.tick) D.ext.tick(X, dt, t);
      const seen = new Set();
      for (const h of B.haz) {
        seen.add(h.id); const v = hazVisual(h), k = clamp(h.age / 0.3, 0, 1) * clamp((7.5 - h.age) / 1.2, 0, 1), gy = ctx.heightAt(h.x, h.z) + 0.12;
        v.g.position.set(h.x, gy, h.z); v.disc.scale.set(4.5 * k, 1, 4.5 * k); v.ring.scale.set(4.6, 1, 4.6); v.disc.material.opacity = 0.45 * k; v.ring.material.opacity = 0.7 * k;
        for (const f of v.flames) { const q = f.userData, fl = 0.6 + 0.4 * Math.sin(t * 9 + q.ph); f.position.set(Math.cos(q.a) * q.r, 0.6 + fl * 1.2, Math.sin(q.a) * q.r); f.scale.set(0.55 * k, (1.4 + fl) * k, 0.55 * k); }
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
  function hitTest(cx, cz, radius, y) {   // 펀치·검기·수류탄: 몸 캡슐에 닿거나, 기둥(col) 캡슐 아래 땅이면 맞는다
    const out = [];
    if (!alive()) return out;
    if (!capsW.length) refreshHull();
    const py = y + 0.9;
    for (const c of capsW) {
      if (segDist(cx, py, cz, c) < c.r + radius + 0.35) { out.push({ kind: 'boss', id: 0 }); return out; }
      if (c.col && segDistXZ(cx, cz, c) < c.r + radius && py < Math.max(c.ay, c.by) + c.r && py > ctx.heightAt(cx, cz) - 1.5) { out.push({ kind: 'boss', id: 0 }); return out; }
    }
    return out;
  }
  function hitRay(ox, oy, oz, dx, dy, dz, maxD, radius = 0) {
    if (!alive()) return null;
    if (!capsW.length) refreshHull();
    let best = null;
    for (const c of capsW) { const t = rayCapsule(ox, oy, oz, dx, dy, dz, c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.r + radius, maxD); if (t >= 0 && (!best || t < best.d)) best = { kind: 'boss', id: 0, d: t, part: 'body' }; }
    return best;
  }
  function damage(k, id, amount, fromId, cdMs) {
    if (!B.owner || !B.active || k !== 'boss') return false;
    if (B.spawnT > 0 || B.dieT > 0 || B.hp <= 0) return false;
    const now = performance.now(), last = O.hitAt.get(fromId) || -1e9;
    if (now - last < (typeof cdMs === 'number' ? cdMs : 220)) return false;
    if (O.hitAt.size > 400) O.hitAt.clear();
    O.hitAt.set(fromId, now);
    B.hp = Math.max(0, B.hp - clamp(amount, 1, 300));
    if (rig) { const fast = typeof cdMs === 'number' && cdMs < 150; rig.flash = fast ? Math.max(rig.flash, 0.05) : 0.12; rig.flashK = fast ? 0.3 : 1; }
    if (B.hp <= 0) die(fromId);
    emit('hp', { hp: B.hp, maxHp: B.maxHp });
    return true;
  }
  function die(by) {
    B.a = 'die'; B.dieT = D.dieT; B.ac++; act.cur = null; B.haz = []; B.pitch = 0; B.roll = 0;
    ctx.sfx(kind, 'die', B.x, B.z); ctx.shake(1.0, 1.4); emit('die', { by, kind });
  }
  function slowAt() { return 1; }

  // ---------- 네트워크 ----------
  function snapshot() {
    if (!B.active || !B.owner) return null;
    return {
      kd: kind, id: ctx.myId, n: ++B.seq, b: B.born, ep: B.ep, hp: Math.round(B.hp), mh: B.maxHp, x: r2(B.x), z: r2(B.z), y: r2(B.y), r: r2(B.ry), a: B.a, ac: B.ac,
      sa: r2(B.sa), tx: B.tx, tz: B.tz, pt: B.pt.slice(0, 8), rg: B.rage ? 1 : 0,
      f: B.haz.slice(0, 8).map((h) => [h.id, h.x, h.z, r2(h.age)]),
    };
  }
  function applySnapshot(d, senderId) {
    if (!d || typeof d !== 'object' || d.kd !== kind) return false;
    const x = finite(d.x, -120, 120), z = finite(d.z, -140, 120), y = finite(d.y, -40, 80), ry = finite(d.r, -7, 7), hp = finite(d.hp, 0, 99999), mh = finite(d.mh, 1, 99999);
    const born = finite(d.b, 0, 1e15), ep = finite(d.ep, 0, 1e6), ac = finite(d.ac, 0, 1e9);
    if ([x, z, y, ry, hp, mh, born, ep, ac].some((v) => v === null) || !ACTS[kind].has(d.a)) return false;
    if (B.active && B.owner) {
      if (!outranks(ep, born, senderId, B.ep, B.born, ctx.myId)) return false;
      resetState();
    } else if (B.active && B.ownerId && B.ownerId !== senderId && !outranks(ep, born, senderId, B.ep, B.born, B.ownerId)) return false;
    const fresh = !B.active;
    if (fresh) {
      resetState(); B.active = true; B.x = x; B.z = z; B.y = y; B.ry = ry; B.spawnT = d.a === 'spawn' ? D.spawnT : 0; R.lastAc = ac;
      load().then(() => { if (B.active && !rig) rig = makeRig(); }).catch(() => despawn());
      emit('spawn', { owner: false, kind });
      if (d.a === 'spawn') intro();
    }
    B.owner = false; B.ownerId = senderId; B.ep = ep; B.born = born; B.maxHp = mh; B.rage = d.rg === 1;
    R.tx = x; R.tz = z; R.ty = y; R.try_ = ry; R.lastSnap = performance.now();
    if (hp < B.hp && rig) { rig.flash = 0.12; rig.flashK = B.hp - hp >= 12 ? 1 : 0.3; }
    if (hp !== B.hp) { B.hp = hp; emit('hp', { hp, maxHp: mh }); }
    if (d.a === 'die' && B.a !== 'die') { B.a = 'die'; B.dieT = D.dieT; act.cur = null; ctx.sfx(kind, 'die', B.x, B.z); emit('die', { kind }); }
    if (ac !== R.lastAc) {
      const adv = ac - R.lastAc; R.lastAc = ac;
      if (adv > 0 && adv < 6 && D.patterns.some((p) => p.code === d.a)) {
        B.sa = finite(d.sa, -7, 7) ?? ry; B.tx = finite(d.tx, -120, 120) ?? x; B.tz = finite(d.tz, -140, 120) ?? z;
        B.pt = Array.isArray(d.pt) ? d.pt.slice(0, 8).filter((q) => Array.isArray(q) && finite(q[0], -120, 120) !== null && finite(q[1], -140, 120) !== null).map((q) => [finite(q[0], -120, 120), finite(q[1], -140, 120)]) : [];
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

  // 확장(ext) 에 넘기는 도구 묶음
  const X = { THREE, scene, ctx, B, D, kind, S: {}, pose, hitCircle, hitCone, hitMe, addFx, handPos, moveBy, once, get rig() { return rig; } };

  return {
    kind, load, spawn, despawn, update, snapshot, applySnapshot, hitTest, hitRay, damage, slowAt,
    on(k, f) { (listeners[k] = listeners[k] || []).push(f); },
    act(code) { const p = D.patterns.find((q) => q.code === code); if (B.owner && B.active && !act.cur && B.spawnT <= 0 && B.dieT <= 0 && p) { ownerBegin(p, nearest(B.x, B.z)); return true; } return false; },   // test hook
    get active() { return B.active; }, get owner() { return B.owner; }, get ownerId() { return B.ownerId; },
    get view() { return { kind, name: D.name, title: D.title, born: B.born, active: B.active, owner: B.owner, hp: B.hp, maxHp: B.maxHp, a: B.a, rage: B.rage, x: B.x, z: B.z, y: B.y, ry: B.ry, minions: 0, webs: 0, haz: B.haz.length, proj: fxl.length, spawnT: B.spawnT, dying: B.a === 'die', camR: D.camR, camLift: D.camLift, act: act.cur ? act.cur.code : '' }; },
    get debug() { return { B, O, R, rig, fxl, act, capsW, myHit, hazVis }; },
    BOSS: { hitReach: D.hitReach }, DEF: D,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 허브: 거미 + 세 보스를 하나처럼 (한 번에 하나만 살아 있다)
// ---------------------------------------------------------------------------------------------------------------------
export function createBossHub(map) {
  const KL = [...KIND_LIST, ...Object.keys(map).filter((k) => !KIND_LIST.includes(k))];   // 따로 만든 보스 모듈(예: bf/hydra.js)도 map 에 넣으면 붙는다
  const all = KL.filter((k) => map[k]).map((k) => map[k]);
  const kindOf = (b) => KL.find((k) => map[k] === b);
  const cur = () => all.find((b) => b.active) || null;
  const listeners = {};
  for (const b of all) for (const ev of ['spawn', 'despawn', 'gone', 'die', 'rage', 'takeover', 'request-despawn', 'hp', 'headbreak']) b.on(ev, (v) => { for (const f of listeners[ev] || []) { try { f({ ...(v || {}), kind: kindOf(b) }); } catch (e) { /* listener */ } } });
  const spiderView = (v) => ({ ...v, kind: 'spider', name: '인면 거미', title: '인면 거미 · 직녀', camR: 1, camLift: 1, act: '' });
  const hub = {
    kinds: KL.filter((k) => map[k]),
    get active() { return !!cur(); }, get owner() { const c = cur(); return !!(c && c.owner); }, get ownerId() { const c = cur(); return c ? c.ownerId : ''; },
    get kind() { const c = cur(); return c ? kindOf(c) : ''; },
    get view() { const c = cur(); if (!c) return { active: false, kind: '', born: 0, hp: 0, maxHp: 0, minions: 0, spawnT: 0, dying: false, rage: false, x: 0, z: 0, ry: 0, camR: 1, camLift: 1 }; return kindOf(c) === 'spider' ? spiderView(c.view) : c.view; },
    get BOSS() { const c = cur(); return c ? c.BOSS : { hitReach: 34 }; },
    get MINI() { return map.spider ? map.spider.MINI : null; },
    get debug() { const c = cur(); return c ? c.debug : null; },
    get(k) { return map[k] || null; },
    spawn(x, z, ry, kind = 'spider') { if (cur()) return false; const b = map[kind]; return b ? b.spawn(x, z, ry) : false; },
    despawn() { for (const b of all) if (b.active) b.despawn(); },
    update(dt, t) { for (const b of all) b.update(dt, t); },
    snapshot() { const c = cur(); return c ? c.snapshot() : null; },
    applySnapshot(d, senderId) {
      if (!d || typeof d !== 'object') return false;
      const k = typeof d.kd === 'string' ? d.kd : 'spider', b = map[k];
      if (!b) return false;
      const c = cur();
      if (c && c !== b) {   // 다른 보스가 살아 있다: 먼저 태어난 쪽이 이긴다
        const born = typeof d.b === 'number' ? d.b : Infinity;
        if (c.owner && !(born < c.view.born)) return false;
        if (!c.owner && c.ownerId !== senderId && !(born < c.view.born)) return false;
        c.despawn();
      }
      return b.applySnapshot(d, senderId);
    },
    hitTest(cx, cz, r, y) { const c = cur(); return c ? c.hitTest(cx, cz, r, y) : []; },
    hitRay(...a) { const c = cur(); return c ? c.hitRay(...a) : null; },
    damage(...a) { const c = cur(); return c ? c.damage(...a) : false; },
    slowAt(x, z) { const c = cur(); return c ? c.slowAt(x, z) : 1; },
    act(code) { const c = cur(); return c ? c.act(code) : false; },
    on(k, f) { (listeners[k] = listeners[k] || []).push(f); },
  };
  return hub;
}

// ---------- 여러 마리 동시 소환: 보스 명부(roster) ----------
// const R = createBossRoster({ spider: () => createSpiderBoss(ctx), golem: () => createGiantBoss(gctx, 'golem'), … }, { cap: 8, me: () => ({ x, z }) })
// 보스마다 따로 만든 인스턴스를 born(태어난 시각 ms, 접속자 모두에게 같은 값)으로 구분한다. 같은 종류도 여러 마리.
// 허브와 같은 이름(active · owner · view · BOSS · hitTest · hitRay · damage · slowAt · update · on)을 그대로 내므로 무기 코드는 그대로 쓴다.
// 맞은 곳 id 는 「보스 꼬리표 × HID + 안쪽 id」로 묶어 보낸다(꼬리표 = born % 90000 + 1, 무기 메시지 id 상한 1e9 안).
export const ROSTER_CAP = 8;
export const HID = 10000;
export const tagOf = (born) => (Math.floor(born) % 90000) + 1;
export function createBossRoster(factories, opt = {}) {
  const cap = opt.cap || ROSTER_CAP;
  const meFn = opt.me || (() => ({ x: 0, z: 0 }));
  const KL = [...KIND_LIST, ...Object.keys(factories).filter((k) => !KIND_LIST.includes(k))];
  const list = [];                    // [{ kind, b, born, tag }]
  const listeners = {};
  const EVS = ['spawn', 'despawn', 'gone', 'die', 'rage', 'takeover', 'request-despawn', 'hp', 'headbreak'];
  let lastBorn = 0;
  const emit = (ev, v) => { for (const f of listeners[ev] || []) { try { f(v); } catch (e) { /* listener */ } } };
  function make(kind) {
    const f = factories[kind]; if (!f) return null;
    const b = f(); if (!b) return null;
    const e = { kind, b, born: 0, tag: 0 };
    for (const ev of EVS) b.on(ev, (v) => emit(ev, { ...(v || {}), kind, born: e.born || b.view.born }));
    return e;
  }
  const setBorn = (e, born) => { e.born = born; e.tag = tagOf(born); };
  const live = () => list.filter((e) => e.b.active);
  const byTag = (tag) => list.find((e) => e.tag === tag && e.b.active) || null;
  const viewOf = (e) => { const v = e.b.view; return e.kind === 'spider' ? { camR: 1, camLift: 1, act: '', ...v, kind: 'spider', name: '인면 거미', title: '인면 거미 · 직녀', born: e.born } : { ...v, born: e.born }; };
  function nearest() {
    const m = meFn(); let best = null, bd = 1e18;
    for (const e of live()) { const v = e.b.view; if (v.dying && best) continue; const d = (v.x - m.x) ** 2 + (v.z - m.z) ** 2 + (v.dying ? 1e12 : 0); if (d < bd) { bd = d; best = e; } }
    return best;
  }
  const enc = (e, id) => e.tag * HID + (Math.round(id) % HID);
  function prune() { for (let i = list.length - 1; i >= 0; i--) if (!list[i].b.active) list.splice(i, 1); }
  const R = {
    cap, kinds: KL.filter((k) => factories[k]),
    get count() { return live().length; },
    get full() { return live().length >= cap; },
    get active() { return live().length > 0; },
    get owner() { return live().some((e) => e.b.owner); },
    get ownerId() { const e = nearest(); return e ? e.b.ownerId : ''; },
    get kind() { const e = nearest(); return e ? e.kind : ''; },
    get view() { const e = nearest(); return e ? viewOf(e) : { active: false, kind: '', born: 0, hp: 0, maxHp: 0, minions: 0, spawnT: 0, dying: false, rage: false, x: 0, z: 0, ry: 0, camR: 1, camLift: 1 }; },
    views() { return live().map(viewOf); },
    get BOSS() { const e = nearest(); return e ? e.b.BOSS : { hitReach: 34 }; },
    get MINI() { const e = list.find((q) => q.kind === 'spider'); return e ? e.b.MINI : null; },
    get debug() { const e = nearest(); return e ? e.b.debug : null; },
    get(born) { const e = list.find((q) => q.born === born && q.b.active); return e ? e.b : null; },
    of(id) { const e = byTag(Math.floor(id / HID)); return e ? e.b : null; },
    spawn(x, z, ry, kind = 'spider') {
      prune();
      if (live().length >= cap) return false;
      const e = make(kind); if (!e) return false;
      const born = Math.max(Date.now(), lastBorn + 1);
      if (!e.b.spawn(x, z, ry, born)) return false;
      lastBorn = born; setBorn(e, e.b.view.born || born); list.push(e);
      return e.born;
    },
    despawn(born) { for (const e of list.slice()) if (born === undefined || e.born === born) { if (e.b.active) e.b.despawn(); } prune(); },
    update(dt, t) { for (const e of list.slice()) e.b.update(dt, t); prune(); },
    snapshots() { const out = []; for (const e of live()) if (e.b.owner) { const s = e.b.snapshot(); if (s) out.push(s); } return out; },
    snapshot() { return R.snapshots()[0] || null; },
    applySnapshot(d, senderId) {
      if (!d || typeof d !== 'object' || typeof d.b !== 'number' || !Number.isFinite(d.b) || d.b <= 0) return false;
      const kind = typeof d.kd === 'string' ? d.kd : 'spider';
      if (!factories[kind]) return false;
      const ex = list.find((q) => q.born === d.b);
      if (ex) return ex.kind === kind ? ex.b.applySnapshot(d, senderId) : false;
      prune();
      if (live().length >= cap) return false;
      const e = make(kind); if (!e) return false;
      if (!e.b.applySnapshot(d, senderId)) { if (e.b.active) e.b.despawn(); return false; }
      setBorn(e, d.b); list.push(e);
      return true;
    },
    hitTest(cx, cz, r, y) { const out = []; for (const e of live()) for (const h of e.b.hitTest(cx, cz, r, y)) out.push({ ...h, id: enc(e, h.id), born: e.born }); return out; },
    hitRay(...a) { let best = null; for (const e of live()) { const h = e.b.hitRay(...a); if (h && (!best || h.d < best.d)) best = { ...h, id: enc(e, h.id), born: e.born }; } return best; },
    damage(kind, id, ...rest) { const e = byTag(Math.floor(id / HID)); return e ? e.b.damage(kind, id % HID, ...rest) : false; },
    slowAt(x, z) { let s = 1; for (const e of live()) s = Math.min(s, e.b.slowAt(x, z)); return s; },
    act(code, born) { const e = born ? list.find((q) => q.born === born && q.b.active) : nearest(); return e && e.b.act ? e.b.act(code) : false; },
    on(k, f) { (listeners[k] = listeners[k] || []).push(f); },
  };
  return R;
}
