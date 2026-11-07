import { applyLook, spring, breath } from './bosslook.js';
// bf/commander.js — 보스 「대검 지휘관」: 검정·금 판금 갑옷, 찢어진 금문양 망토, 금테 대검, 열린 투구 속 썩은 얼굴(키 약 14 m).
// 모델: tools/bosses/build_commander.py (Blender) → bf/commander.glb (Draco, Commander_LOD0/LOD1, 뼈대만 · 클립 없음).
//
// API 는 bf/bosses.js 의 createGiantBoss 와 같다(spawn · despawn · update · snapshot · applySnapshot · hitTest · hitRay · damage · slowAt · view · on · act).
// 허브(createBossHub)에 `commander` 로 끼워 쓴다. 네트워크도 같다: 소유자가 AI 를 돌리고 `boss` 주제로 스냅샷(kd: 'commander')을 보내며,
// 패턴은 카운터(ac)가 바뀔 때 모두가 같은 시간표로 재생하고, 내가 맞았는지는 내 화면에서 판정한다.
//
// 패턴: sweep 대검 수평 베기(점프로 넘김) · smash 내려찍기 + 앞으로 갈라지는 충격파 · thrust 돌진 찌르기. 분노(35%)하면 더 빠르고 충격파가 세 갈래.
// 효과음은 모두 합성(ctx.audio() → { actx, out, buf })이라 녹음 파일이 없다.

import { rayCapsule } from './weapons-core.js';

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

// 재질별 전용 조명(bf/bosslook.js) — [key, wrap, rim, spec, 발광색, 발광세기, 발광에 색맵]
export const LOOK = {
  exact: {
    cmd_armor: [1.05, [0.06, 0.05, 0.05], 0.55, 1.3, '#000000', 0, false],   // 검은 판금: 키 하이라이트·테두리로 형태가 선다
    cmd_plate: [1.0, [0.06, 0.05, 0.05], 0.5, 1.2, '#000000', 0, false],
    cmd_gold:  [1.15, [0.3, 0.18, 0.05], 0.5, 1.6, '#3a2006', 0.25, false],
    cmd_blade: [1.1, [0.05, 0.05, 0.06], 0.5, 1.8, '#000000', 0, false],
    cmd_grip:  [0.9, [0.1, 0.05, 0.03], 0.3, 0.2, '#000000', 0, false],
    cmd_cape:  [0.95, [0.32, 0.05, 0.03], 0.55, 0.15, '#000000', 0, false],
    cmd_skin:  [0.95, [0.42, 0.14, 0.08], 0.45, 0.6, '#ff6a3a', 0.03, true], // 썩은 얼굴: 붉은 산란·젖은 윤기
    cmd_gum:   [0.9, [0.4, 0.08, 0.06], 0.3, 0.9, '#000000', 0, false],
    cmd_tooth: [0.9, [0.2, 0.15, 0.08], 0.3, 0.9, '#000000', 0, false],
    cmd_eyeball: [0.9, [0.3, 0.2, 0.15], 0.3, 1.2, '#000000', 0, false],
  },
  glow: /cmd_(iris|pupil)/,
};
export const KIND = 'commander';
export const DEF = {
  name: '대검 지휘관', title: '몰락한 왕의 칼 · 대검 지휘관', file: 'commander.glb', hp: 6800, hpPerExtra: 2200, hitReach: 30, camR: 1.0, camLift: 1.4, lodD: 75,
  speed: 5.2, turn: 1.0, spawnT: 3.6, dieT: 6.2,
  // 몸 캡슐: [뼈, a(Blender), b(Blender), 반지름, col(땅까지 기둥)] — 대검은 몸이 아니라서 넣지 않는다
  hull: [['hips', [0, 0, 6.2], [0, 0, 8.2], 1.9, true], ['spine', [0, 0.1, 8.3], [0, 0.1, 11.0], 2.3, true], ['spine', [-3.4, 0, 11.4], [3.4, 0, 11.4], 1.45],
    ['head', [0, 0.3, 12.3], [0, 0.3, 13.9], 1.05], ['cape1', [0, -1.9, 10.6], [0, -2.3, 5.2], 1.1], ['cape2', [0, -2.3, 5.2], [0, -2.6, 1.4], 0.9],
    ['armL', [-2.9, 0, 11.2], [-3.5, 0.3, 8.5], 0.9], ['foreL', [-3.5, 0.3, 8.5], [-3.7, 1.3, 6.2], 0.8],
    ['armR', [2.9, 0, 11.2], [3.5, 0.3, 8.5], 0.9], ['foreR', [3.5, 0.3, 8.5], [3.7, 1.3, 6.2], 0.8],
    ['thighL', [-1.1, 0, 7.0], [-1.3, 0.4, 3.8], 1.1, true], ['shinL', [-1.3, 0.4, 3.8], [-1.35, 0.2, 0.5], 0.85, true],
    ['thighR', [1.1, 0, 7.0], [1.3, 0.4, 3.8], 1.1, true], ['shinR', [1.3, 0.4, 3.8], [1.35, 0.2, 0.5], 0.85, true]],
  sword: { bone: 'handR', grip: [3.72, 1.45, 6.15], tip: [4.15, 9.6, 0.55] },
  patterns: [
    { code: 'sweep', w: 5, cd: 4.2, minD: 0, maxD: 16, dur: 2.3 },
    { code: 'smash', w: 4, cd: 7.0, minD: 4, maxD: 34, dur: 3.0 },
    { code: 'thrust', w: 3, cd: 8.5, minD: 12, maxD: 42, dur: 3.2 },
  ],
};
// 패턴 피해(내 HP 100 기준 — index.html 이 HP 1,000 에 맞춰 7.5배) · 넉백
export const HITS = { sweep: [30, 2.8], smash: [36, 2.4], quake: [18, 1.7], thrust: [34, 3.4] };
export const ACTS = new Set(['idle', 'move', 'spawn', 'die', ...DEF.patterns.map((p) => p.code)]);
// index.html 이 합치는 문구
export const LOG = { spawn: '땅 밑에서 금빛 문장이 타오르고 대검 지휘관이 걸어 나옵니다!', die: '대검 지휘관이 무릎을 꿇고 쓰러졌습니다! 대검이 땅에 박힙니다.', gone: '대검 지휘관' };
export const HURT_NAME = '대검 지휘관';
export const HIT_MSG = { sweep: '대검 수평 베기에 맞았습니다! (점프로 넘을 수 있습니다)', smash: '내려찍은 대검에 깔렸습니다!', quake: '갈라진 땅의 충격파에 휩쓸렸습니다.', thrust: '돌진 찌르기에 꿰뚫렸습니다!' };

// ---------------------------------------------------------------------------------------------------------------------
export function createCommanderBoss(ctx) {
  const D = DEF, kind = KIND;
  const { THREE, scene } = ctx;
  const B = { kind, active: false, owner: false, ownerId: '', ep: 0, born: 0, x: 0, z: 0, y: 0, ry: 0, hp: 0, maxHp: 0, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], seq: 0, spawnT: 0, dieT: 0, rage: false, haz: [] };
  const R = { tx: 0, tz: 0, ty: 0, try_: 0, lastAc: 0, lastSnap: 0 };
  const O = { cd: {}, gap: 1.2, hitAt: new Map() };
  const act = { cur: null };
  const listeners = {};
  const emit = (k, v) => { for (const f of listeners[k] || []) { try { f(v); } catch (e) { /* listener */ } } };
  const myHit = {};
  let assets = null, loading = null, loadFailed = false, rig = null;
  const fxl = [];
  const capsW = [];

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
    const root = assets.g.scene;
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
      m.metalness = Math.min(m.metalness, 0.6);   // 환경맵 없는 밤: 금속이 검게 죽지 않게
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
    const hull = D.hull.map(([bn, a, b, r, col]) => ({ bone: bones[bn], a: local(bn, a), b: local(bn, b), r, col: !!col }));
    const sword = { bone: bones[D.sword.bone], grip: local(D.sword.bone, D.sword.grip), tip: local(D.sword.bone, D.sword.tip) };
    // 얼굴 조명(붉은 불씨) — 밤에도 투구 속 얼굴·이빨이 보이게, 그리고 눈빛
    const light = new THREE.PointLight('#ff6a3a', 0, 9, 1.8); root.add(light); light.position.set(0, 13.0, -2.4);
    const glow = new THREE.PointLight('#ffb050', 0, 26, 1.6); root.add(glow); glow.position.set(0, 9, -3.5);
    scene.add(root);
    const qs = { q: new THREE.Quaternion(), qa: new THREE.Quaternion() };
    const R = { root, bones, lods, mats, base, rest, hull, sword, light, glow, flash: 0, flashK: 1, qs, lod: -1, sp: {} };
    applyLook(THREE, R, LOOK, 'commanderLook');
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
    scene.remove(rig.root);
    rig.light.intensity = 0; rig.glow.intensity = 0;
    for (const m of rig.mats) { const b = rig.base.get(m); if (b) { m.emissive.copy(b.e); m.emissiveIntensity = b.i; } }
    rig = null;
  }

  // ---------- 효과음(합성) ----------
  function snd(name, x, z) {
    if (!ctx.audio) { if (ctx.sfx) ctx.sfx(kind, name, x, z); return; }
    const A = ctx.audio(); if (!A || !A.actx) return;
    const { actx, out, buf } = A, m = ctx.me();
    const lv = clamp(1.15 - Math.hypot(x - m.x, z - m.z) / 90, 0.12, 1), t = actx.currentTime;
    const env = (node, a, peak, dur, delay = 0) => { const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t + delay); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * lv), t + delay + a); g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur); node.connect(g); g.connect(out); };
    const osc = (type, f0, f1, a, peak, dur, delay = 0) => { const o = actx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t + delay); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + delay + dur); env(o, a, peak, dur, delay); o.start(t + delay); o.stop(t + delay + dur + 0.05); };
    const noise = (type, f0, f1, q, a, peak, dur, delay = 0) => { if (!buf) return; const s = actx.createBufferSource(), f = actx.createBiquadFilter(); s.buffer = buf; s.loop = true; f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t + delay); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + delay + dur); s.connect(f); env(f, a, peak, dur, delay); s.start(t + delay); s.stop(t + delay + dur + 0.05); };
    const growl = (f, dur, gr, peak = 0.55, delay = 0) => { const o = actx.createOscillator(), o2 = actx.createOscillator(), lfo = actx.createOscillator(), lg = actx.createGain(), lp = actx.createBiquadFilter(); o.type = 'sawtooth'; o2.type = 'square'; o.frequency.setValueAtTime(f * 1.3, t + delay); o.frequency.exponentialRampToValueAtTime(f * 0.7, t + delay + dur); o2.frequency.setValueAtTime(f * 0.51, t + delay); lfo.frequency.value = gr; lg.gain.value = f * 0.3; lfo.connect(lg); lg.connect(o.frequency); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1100, t + delay); lp.frequency.exponentialRampToValueAtTime(220, t + delay + dur); o.connect(lp); o2.connect(lp); env(lp, 0.12, peak, dur, delay); for (const n of [o, o2, lfo]) { n.start(t + delay); n.stop(t + delay + dur + 0.05); } };
    const clang = (f, peak = 0.35, dur = 1.6, delay = 0) => { for (const k of [1, 2.76, 5.4, 8.93]) osc('sine', f * k, f * k * 0.995, 0.003, peak / Math.sqrt(k), dur / Math.sqrt(k), delay); noise('highpass', 4000, 3000, 0.7, 0.002, peak * 0.6, 0.12, delay); };
    const rumble = (dur, peak = 0.8, delay = 0) => { osc('sine', 50, 28, 0.08, peak, dur, delay); noise('lowpass', 240, 50, 0.7, 0.1, peak * 0.9, dur, delay); };
    const whoosh = (dur, peak = 0.7, delay = 0) => noise('bandpass', 300, 2600, 2.4, dur * 0.6, peak, dur, delay);
    switch (name) {
      case 'intro': rumble(3.4, 1); clang(92, 0.4, 3.0, 0.2); growl(46, 2.8, 5, 0.6, 0.9); osc('sawtooth', 69, 65, 0.6, 0.12, 2.6, 0.9); break;
      case 'rage': growl(52, 2.4, 7, 0.7); clang(130, 0.3, 1.8); break;
      case 'die': growl(44, 3.4, 4, 0.6); for (let i = 0; i < 6; i++) clang(160 + i * 37, 0.22, 0.9, 1.2 + i * 0.22); rumble(2.2, 0.8, 2.4); break;
      case 'sweep': growl(70, 0.9, 9, 0.35); whoosh(0.6, 0.8, 0.75); break;
      case 'smash': growl(60, 1.2, 6, 0.45); whoosh(0.4, 0.6, 1.0); break;
      case 'thrust': growl(64, 1.0, 8, 0.45); whoosh(1.0, 0.7, 0.75); break;
      case 'impact': rumble(1.8, 1); clang(78, 0.45, 1.4); noise('bandpass', 900, 200, 1, 0.005, 0.9, 0.5); break;
      case 'crack': rumble(0.6, 0.6); noise('bandpass', 1400, 400, 1.2, 0.004, 0.6, 0.25); break;
      case 'clang': clang(210, 0.35, 1.0); break;
      case 'step': rumble(0.45, 0.4); clang(300 + Math.random() * 60, 0.05, 0.4); break;
      default: break;
    }
  }

  // ---------- 생명 주기 ----------
  function resetState() {
    B.active = false; B.owner = false; B.ownerId = ''; B.a = 'idle'; B.haz = []; B.spawnT = 0; B.dieT = 0; B.rage = false; B.pt = []; B.y = 0; B.pitch = 0;
    O.cd = {}; for (const p of D.patterns) O.cd[p.code] = p.cd * 0.4; O.gap = 1.2; O.hitAt.clear();
    act.cur = null; disposeRig();
    for (const f of fxl) killFx(f); fxl.length = 0;
    capsW.length = 0;
  }
  const baseY = (x, z) => ctx.heightAt(x, z);
  const standOk = (x, z) => ctx.canStand(x, z);
  function spawn(x, z, ry) {
    if (B.active) return false;
    const n = Math.max(1, ctx.players().length);
    resetState();
    B.active = true; B.owner = true; B.ownerId = ctx.myId; B.ep = 0; B.born = Date.now(); B.seq = 0;
    B.x = x; B.z = z; B.ry = ry; B.y = baseY(x, z); B.maxHp = B.hp = D.hp + D.hpPerExtra * (n - 1);
    B.a = 'spawn'; B.spawnT = D.spawnT; B.ac++;
    R.tx = x; R.tz = z; R.ty = B.y; R.try_ = ry; R.lastSnap = performance.now();
    emit('spawn', { owner: true, kind });
    intro();
    load().then(() => { if (B.active && !rig) rig = makeRig(); }).catch(() => despawn());
    return true;
  }
  function despawn() { const was = B.active; resetState(); if (was) emit('despawn', { kind }); }

  // ---------- 등장 연출: 땅에 금빛 문장 → 갈라지며 솟아오름 → 포효 ----------
  function intro() {
    const g = ctx.heightAt(B.x, B.z);
    snd('intro', B.x, B.z); ctx.shake(1.0, 2.6);
    addFx({ type: 'sigil', x: B.x, z: B.z, t: 0, life: D.spawnT + 0.8 });
    for (let i = 0; i < 3; i++) addFx({ type: 'ring', x: B.x, z: B.z, r0: 2, r1: 24, t: -0.6 - i * 0.5, life: 1.4, hit: false, color: '#ffc860' });
    for (let i = 0; i < 12; i++) setTimeout(() => { if (B.active) ctx.fx.poof(B.x + (Math.random() - 0.5) * 10, g + 0.1, B.z + (Math.random() - 0.5) * 10, 6); }, 300 + i * 170);
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
    const ok = D.patterns.filter((p) => !(O.cd[p.code] > 0) && tg.d >= p.minD && tg.d <= p.maxD);
    if (!ok.length) return null;
    let r = Math.random() * ok.reduce((s, p) => s + p.w, 0);
    for (const p of ok) { r -= p.w; if (r <= 0) return p; }
    return ok[0];
  }
  function ownerBegin(p, tg) {
    O.cd[p.code] = p.cd * (B.rage ? 0.7 : 1);
    B.sa = tg ? faceTo(tg.p.x - B.x, tg.p.z - B.z) : B.ry;
    B.tx = tg ? r2(tg.p.x) : B.x; B.tz = tg ? r2(tg.p.z) : B.z;
    B.pt = [];
    if (p.code === 'thrust') {   // 돌진 끝: 목표를 9 m 지나친 자리(최대 34 m), 칼끝이 목표에 닿게
      const dx = B.tx - B.x, dz = B.tz - B.z, d = Math.hypot(dx, dz) || 1, L = Math.min(34, Math.max(6, d - 9));
      B.tx = r2(B.x + dx / d * L); B.tz = r2(B.z + dz / d * L);
    }
    if (p.code === 'smash') {   // 충격파 갈래(각도): 평소 하나, 분노 셋
      B.pt = B.rage ? [[0, 0], [0.42, 0], [-0.42, 0]] : [[0, 0]];
    }
    B.ac++; startPattern(p.code, false);
  }
  function startPattern(code, net) {
    const p = D.patterns.find((q) => q.code === code); if (!p) return;
    B.a = code;
    act.cur = { code, t: 0, dur: p.dur * (B.rage ? 0.85 : 1), from: { x: B.x, z: B.z, y: B.y, ry: B.ry }, to: { x: B.tx, z: B.tz }, sa: B.sa, ev: new Set(), net, pt: B.pt.slice(0, 4) };
    snd(code, B.x, B.z);
  }
  function ownerUpdate(dt) {
    for (const k in O.cd) O.cd[k] = Math.max(0, O.cd[k] - dt);
    if (B.spawnT > 0) { B.spawnT -= dt; if (B.spawnT <= 0) B.a = 'idle'; return; }
    if (B.dieT > 0) { B.dieT -= dt; if (B.dieT <= 0) emit('request-despawn', { dead: true }); return; }
    if (!B.rage && B.hp <= B.maxHp * 0.35) { B.rage = true; emit('rage', { kind }); snd('rage', B.x, B.z); }
    if (act.cur) return;
    const tg = nearest(B.x, B.z);
    if (!tg) { B.a = 'idle'; return; }
    O.gap = Math.max(0, O.gap - dt);
    const want = faceTo(tg.p.x - B.x, tg.p.z - B.z), dd = wrapA(want - B.ry);
    const tm = D.turn * (B.rage ? 1.3 : 1) * dt;
    if (O.gap <= 0 && Math.abs(dd) < 0.6) { const p = pickPattern(tg); if (p) { ownerBegin(p, tg); return; } }
    B.ry = wrapA(B.ry + clamp(dd, -tm, tm));
    if (tg.d > 10 && Math.abs(dd) < 1.0) { const moved = stepTo(-Math.sin(B.ry), -Math.cos(B.ry), D.speed * (B.rage ? 1.25 : 1), dt); B.a = moved ? 'move' : 'idle'; }
    else B.a = 'idle';
  }

  // ---------- 패턴 시간표 (모두 같은 것을 돈다) ----------
  const fwd = (ry) => [-Math.sin(ry), -Math.cos(ry)];
  function once(a, key, at) { if (a.t >= at && !a.ev.has(key)) { a.ev.add(key); return true; } return false; }
  function moveBy(dist) { const [fx, fz] = fwd(B.ry), nx = B.x + fx * dist, nz = B.z + fz * dist; if (standOk(nx, nz)) { B.x = nx; B.z = nz; return true; } return false; }
  function runPattern(dt) {
    const a = act.cur; if (!a) return;
    a.t += dt;
    const F = a.from, T = a.to, k = a.dur / (D.patterns.find((p) => p.code === a.code).dur);   // 분노 때 시간표 압축 비율
    const at = a.t / k;   // 원래 시간표 기준 시각
    const turnTo = (w, s) => { B.ry = wrapA(B.ry + clamp(wrapA(w - B.ry), -s * dt, s * dt)); };
    const g = (x, z) => ctx.heightAt(x, z);
    if (a.code === 'sweep') {   // 오른쪽으로 감았다가 앞쪽 반원을 가로로 벤다 — 칼 높이 아래로 엎드릴 수 없으니 점프로 넘긴다
      if (at < 0.8) turnTo(a.sa, 1.6);
      if (once(a, 'swing', 0.95 * k)) {
        hitCone(B.x, B.z, B.ry, 15.5, 1.75, 'sweep', 1.9);
        addFx({ type: 'slash', x: B.x, z: B.z, ry: B.ry, y: g(B.x, B.z) + 2.4, t: 0, life: 0.45 });
        ctx.shake(0.45, 0.4);
        for (let i = 0; i < 5; i++) { const an = B.ry - 1.4 + i * 0.7; ctx.fx.poof(B.x - Math.sin(an) * 12, g(B.x, B.z) + 0.2, B.z - Math.cos(an) * 12, 4); }
      }
    } else if (a.code === 'smash') {   // 머리 위로 들었다가 내려찍기 → 칼날 자리 직사각형 + 앞으로 달려 나가는 땅 갈라짐(갈래마다)
      if (at < 1.1) turnTo(a.sa, 1.1);
      if (once(a, 'hit', 1.35 * k)) {
        const [fx, fz] = fwd(B.ry);
        hitLine(B.x + fx * 2, B.z + fz * 2, fx, fz, 12, 2.4, 'smash');
        const cx = B.x + fx * 11, cz = B.z + fz * 11;
        snd('impact', cx, cz); ctx.shake(1.3, 1.1);
        addFx({ type: 'ring', x: cx, z: cz, r0: 2, r1: 14, t: 0, life: 0.9, hit: true, dmg: 'quake', color: '#ffd28a' });
        for (let i = 0; i < 8; i++) ctx.fx.poof(cx + (Math.random() - 0.5) * 6, g(cx, cz) + 0.2, cz + (Math.random() - 0.5) * 6, 6);
        for (const q of a.pt) addFx({ type: 'fissure', x: cx, z: cz, dir: B.ry + q[0], t: 0, life: 1.6, len: 30, step: 0, hit: true });
      }
    } else if (a.code === 'thrust') {   // 칼을 뒤로 당겼다(0.75 s) → 일직선 돌진(1.0 s) → 칼끝 멈춤 · 회수
      const t0 = 0.75 * k, t1 = 1.75 * k;
      if (a.t < t0) turnTo(faceTo(T.x - F.x, T.z - F.z), 2.2);
      else if (a.t < t1) {
        const s = ease((a.t - t0) / (t1 - t0)), px = B.x, pz = B.z;
        const nx = F.x + (T.x - F.x) * s, nz = F.z + (T.z - F.z) * s;
        if (standOk(nx, nz)) { B.x = nx; B.z = nz; }
        if (once(a, 'go', t0)) { ctx.shake(0.5, 0.4); snd('step', B.x, B.z); }
        if (Math.random() < dt * 14) ctx.fx.poof(px + (Math.random() - 0.5) * 4, g(px, pz) + 0.1, pz + (Math.random() - 0.5) * 4, 3);
        const [fx, fz] = fwd(B.ry);
        if (!a.ev.has('hit') && (hitCircle(B.x + fx * 10, B.z + fz * 10, 3.6, 'thrust', 0) || hitCircle(B.x + fx * 4, B.z + fz * 4, 4.2, 'thrust', 0))) a.ev.add('hit');
      } else if (once(a, 'stop', t1)) { const [fx, fz] = fwd(B.ry); snd('clang', B.x + fx * 10, B.z + fz * 10); ctx.shake(0.6, 0.5); addFx({ type: 'ring', x: B.x + fx * 10, z: B.z + fz * 10, r0: 1, r1: 8, t: 0, life: 0.6, hit: false, color: '#fff0c0' }); }
    }
    if (a.t >= a.dur) { act.cur = null; if (B.owner) { O.gap = B.rage ? 0.5 : 0.9; B.a = 'idle'; B.y = baseY(B.x, B.z); } }
  }

  // ---------- 효과 ----------
  let fxRes = null;
  function res() {
    if (fxRes) return fxRes;
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
    fxRes = {
      ring: new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2),
      slash: new THREE.RingGeometry(6, 16.5, 48, 1, -Math.PI * 0.78, Math.PI * 1.56).rotateX(-Math.PI / 2).rotateY(Math.PI / 2),
      sigil: new THREE.RingGeometry(0.2, 1, 6, 1).rotateX(-Math.PI / 2),
      crack: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
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
      if (f.type === 'ring') {   // 땅을 따라 퍼지는 충격파: 띠가 지나갈 때 땅에 있으면 맞는다(점프로 넘김)
        const r = f.r0 + (f.r1 - f.r0) * Math.min(1, u);
        if (THREE.Mesh) {
          if (!f.g) { f.g = new THREE.Mesh(res().ring, ownMat(f.color || '#ffffff', 0.9)); f.g.renderOrder = 3; scene.add(f.g); }
          f.g.position.set(f.x, ctx.heightAt(f.x, f.z) + 0.25, f.z); f.g.scale.set(r, 1, r); f.g.material.opacity = 0.85 * (1 - u);
        }
        if (f.hit && m.ok && !f.done) {
          const d = Math.hypot(m.x - f.x, m.z - f.z);
          if (Math.abs(d - r) < 1.4 && m.y - floorAt(m.x, m.z) < 1.1) { f.done = true; hitMe(f.dmg || 'quake', (m.x - f.x) / (d || 1), (m.z - f.z) / (d || 1)); }
        }
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      } else if (f.type === 'fissure') {   // 땅 갈라짐: 0.8 s 동안 앞으로 30 m 달리며 1.5 m 마다 터진다
        const [fx, fz] = fwd(f.dir), reach = f.len * Math.min(1, f.t / 0.8);
        while (f.step * 1.5 < reach) {
          const s = f.step * 1.5, x = f.x + fx * s, z = f.z + fz * s, y = ctx.heightAt(x, z);
          f.step++;
          if (f.step % 3 === 0) { ctx.fx.poof(x, y + 0.2, z, 3); if (f.step % 6 === 0) snd('crack', x, z); }
          if (THREE.Mesh) {
            if (!f.g) { f.g = new THREE.Group(); scene.add(f.g); }
            const c = new THREE.Mesh(res().crack, ownMat(f.step % 2 ? '#ff7a20' : '#ffc24a', 0.9)); c.position.set(x, y + 0.12, z); c.rotation.y = f.dir + (Math.random() - 0.5) * 0.6; c.scale.set(0.5 + Math.random() * 0.5, 1, 1.9); f.g.add(c);
          }
          if (f.hit && m.ok && !f.done && Math.hypot(m.x - x, m.z - z) < 2.3 && m.y - floorAt(m.x, m.z) < 1.1) { f.done = true; hitMe('quake', -fz * 0.3 + fx, fx * 0.3 + fz); }
        }
        if (f.g) for (const c of f.g.children) c.material.opacity = 0.9 * clamp((f.life - f.t) / 0.6, 0, 1);
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      } else if (f.type === 'slash') {   // 수평 베기의 금빛 궤적(초승달)
        if (THREE.Mesh) {
          if (!f.g) { f.g = new THREE.Mesh(res().slash, ownMat('#ffe2a0', 0.85)); f.g.renderOrder = 4; scene.add(f.g); }
          f.g.position.set(f.x, f.y, f.z); f.g.rotation.y = f.ry; f.g.material.opacity = 0.85 * (1 - u) * (1 - u); f.g.scale.setScalar(0.9 + 0.15 * u);
        }
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      } else if (f.type === 'sigil') {   // 등장 문장: 금빛 육각 고리 셋이 돌며 밝아졌다 사라진다
        if (THREE.Mesh) {
          if (!f.g) { f.g = new THREE.Group(); for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(res().sigil, ownMat(k === 1 ? '#ff9a30' : '#ffd070', 0.8)); s.scale.setScalar(5 + k * 3.5); f.g.add(s); } scene.add(f.g); }
          f.g.position.set(f.x, ctx.heightAt(f.x, f.z) + 0.15, f.z);
          f.g.children.forEach((s, k) => { s.rotation.y = f.t * (k % 2 ? -0.6 : 0.8); s.material.opacity = 0.85 * Math.min(1, f.t / 0.6) * clamp((f.life - f.t) / 0.9, 0, 1); });
        }
        if (u >= 1) { killFx(f); fxl.splice(i, 1); }
      }
    }
  }

  // ---------- 내게 맞았나 (내 화면) ----------
  const floorAt = (x, z) => Math.max(ctx.heightAt(x, z), ctx.waterLevel ? ctx.waterLevel() - 0.6 : -1e9);
  function hitMe(src, dx, dz) {
    const m = ctx.me(); if (!m.ok) return false;
    if ((myHit[src] || 0) > 0) return false;
    myHit[src] = 0.8;
    const h = HITS[src] || [15, 1.5];
    ctx.onHitMe({ src, boss: kind, dmg: h[0] * (B.rage ? 1.15 : 1), dx, dz, power: h[1] });
    return true;
  }
  function hitCircle(x, z, r, src, hmax) {
    const m = ctx.me(); if (!m.ok) return false;
    const d = Math.hypot(m.x - x, m.z - z); if (d > r) return false;
    if (m.y - floorAt(m.x, m.z) > (hmax > 0 ? hmax : 3.5)) return false;
    return hitMe(src, (m.x - x) / (d || 1), (m.z - z) / (d || 1));
  }
  function hitCone(x, z, dir, range, half, src, hmax) {
    const m = ctx.me(); if (!m.ok) return false;
    const dx = m.x - x, dz = m.z - z, d = Math.hypot(dx, dz);
    if (d > range || (d > 3 && Math.abs(wrapA(faceTo(dx, dz) - dir)) > half)) return false;
    if (m.y - floorAt(m.x, m.z) > hmax) return false;
    return hitMe(src, dx / (d || 1), dz / (d || 1));
  }
  function hitLine(x, z, fx, fz, len, half, src) {   // 앞으로 len, 옆으로 ±half 직사각형
    const m = ctx.me(); if (!m.ok) return false;
    const dx = m.x - x, dz = m.z - z, along = dx * fx + dz * fz, side = -dx * fz + dz * fx;
    if (along < -1 || along > len || Math.abs(side) > half) return false;
    if (m.y - floorAt(m.x, m.z) > 3.5) return false;
    return hitMe(src, fx, fz);
  }

  // ---------- 모습 ----------
  function animate(dt, t) {
    if (!rig) return;
    const sp = B.spawnT > 0 ? clamp(1 - B.spawnT / D.spawnT, 0, 1) : 1, se = 1 - (1 - sp) * (1 - sp);
    const dying = B.a === 'die', dk = dying ? clamp(1 - B.dieT / D.dieT, 0, 1) : 0;
    const dieU = dying ? (rig.dieU = Math.min(1, (rig.dieU || 0) + dt / 2.4)) : (rig.dieU = 0);
    const a = act.cur, kk = a ? a.dur / D.patterns.find((p) => p.code === a.code).dur : 1, at = a ? a.t / kk : 0, code = a ? a.code : B.a;
    let y = B.y, pitch = 0;
    const walk = B.a === 'move' || (code === 'thrust' && at > 0.75 && at < 1.75) ? 1 : 0;
    rig.ph = (rig.ph || 0) + dt * (code === 'thrust' && walk ? 7 : walk ? 3.4 : 1.2) * (B.rage ? 1.2 : 1);
    const ph = rig.ph, s = Math.sin(ph), c = Math.cos(ph);
    // 기본 자세: 숨쉬기 · 칼을 앞으로 늘어뜨림
    let spX = 0.04 * Math.sin(t * 0.9), spY = 0, hdX = 0.05 * Math.sin(t * 0.6), hdY = 0.12 * Math.sin(t * 0.37);
    let aRx = 0.06 * Math.sin(t * 0.8), aRy = 0, aRz = 0, fRx = 0, aLx = 0.08 * s * walk, aLz = 0.05, fLx = -0.2, jaw = 0.12 + 0.06 * Math.sin(t * 1.7);
    let hipY = 0, crouch = 0;
    const br = breath(t, 0.2); spX += 0.035 * br; hdX -= 0.025 * br; aLz += 0.03 * br; aRz -= 0.03 * br;   // 숨: 가슴이 들리고 어깨가 오르내림
    if (code === 'sweep') {
      const w = ease(clamp(at / 0.8, 0, 1)), sw = clamp((at - 0.8) / 0.3, 0, 1), rec = clamp((at - 1.4) / 0.8, 0, 1);
      const e = sw < 1 ? ease(sw) : 1;
      spY = lerp(-1.0 * w, 1.1, e) * (1 - rec); aRx = (0.9 * w) * (1 - rec); aRz = (0.9 * w + 0.2 * e) * (1 - rec); fRx = 0.4 * w * (1 - rec);
      aLx = -0.4 * w * (1 - rec); aLz = 0.5 * w * (1 - rec); crouch = 0.6 * w * (1 - rec); jaw = 0.25 + 0.5 * e * (1 - rec);
    } else if (code === 'smash') {
      const up = ease(clamp(at / 1.1, 0, 1)), dn = clamp((at - 1.1) / 0.25, 0, 1), rec = clamp((at - 2.1) / 0.9, 0, 1);
      const e = dn * dn;
      aRx = lerp(-2.7 * up, 0.75, e) * (1 - rec); fRx = lerp(-0.5 * up, 0.15, e) * (1 - rec);
      aLx = lerp(-2.5 * up, 0.7, e) * (1 - rec); aLz = lerp(-0.35 * up, -0.4, e) * (1 - rec); fLx = lerp(-0.5, 0.2, e) * (1 - rec) - 0.2 * rec;
      spX = lerp(0.3 * up, -0.45, e) * (1 - rec); spY = -0.25 * up * (1 - rec); crouch = lerp(0, 1.4, e) * (1 - rec); jaw = 0.2 + 0.7 * e * (1 - rec);
    } else if (code === 'thrust') {
      const pull = ease(clamp(at / 0.75, 0, 1)), go = clamp((at - 0.75) / 0.25, 0, 1), rec = clamp((at - 2.2) / 1.0, 0, 1);
      aRx = lerp(-0.7 * pull, 1.45, ease(go)) * (1 - rec); fRx = lerp(-1.3 * pull, -0.55, ease(go)) * (1 - rec); aRy = 0.3 * go * (1 - rec);
      spY = lerp(-0.55 * pull, 0.35, ease(go)) * (1 - rec); spX = lerp(0, -0.3, go) * (1 - rec); crouch = 0.8 * pull * (1 - rec); jaw = 0.2 + 0.6 * go * (1 - rec);
      aLx = 0.6 * go * (1 - rec); aLz = -0.3 * go * (1 - rec);
    }
    if (B.spawnT > 0) {   // 땅에서 솟아오르며 고개를 들고 포효
      y = B.y - 15 * (1 - se); spX = -0.4 * (1 - se); hdX = 0.5 * (1 - sp) - 0.35 * Math.sin(sp * Math.PI); jaw = 0.15 + 0.85 * clamp((sp - 0.55) / 0.2, 0, 1) * clamp((1 - sp) / 0.12, 0, 1);
    }
    if (B.rage && !a) jaw = Math.max(jaw, 0.3 + 0.2 * Math.sin(t * 6));
    pose('hips', 0, hipY, 0);
    pose('spine', spX, spY + 0.05 * Math.sin(ph * 0.5) * walk, 0);
    pose('neck', hdX * 0.4, hdY * 0.4, 0); pose('head', hdX, hdY, 0);
    pose('jaw', 0.42 * jaw, 0, 0);
    pose('armR', aRx - 0.08 * s * walk, aRy, -aRz); pose('foreR', fRx, 0, 0);
    pose('armL', aLx, 0, aLz); pose('foreL', fLx, 0, 0);
    const kneel = dying ? ease(clamp(dieU * 1.5, 0, 1)) : 0;
    pose('thighL', 0.4 * s * walk - 0.35 * crouch - 1.3 * kneel, 0, 0); pose('thighR', -0.4 * s * walk - 0.25 * crouch - 0.2 * kneel, 0, 0);
    pose('shinL', -0.4 * Math.max(0, -s) * walk + 0.6 * crouch + 1.9 * kneel, 0, 0); pose('shinR', -0.4 * Math.max(0, s) * walk + 0.45 * crouch + 0.4 * kneel, 0, 0);
    // 망토: 마디 셋을 스프링으로 늦게 따라가게(걸음·몸 돌림·베기에 출렁이고 바람에 천천히 너울댄다)
    const SP = rig.sp, dry = rig.prevRy === undefined ? 0 : (((B.ry - rig.prevRy) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; rig.prevRy = B.ry;
    const turn = clamp(-dry / Math.max(dt, 1e-3) * 0.12, -0.5, 0.5), wind = 0.05 * Math.sin(t * 0.7) + 0.03 * Math.sin(t * 1.9 + 2);
    const t1 = 0.12 + 0.4 * walk + wind + 0.25 * crouch + 0.2 * Math.abs(spY), t1z = turn + 0.05 * Math.sin(t * 0.9) - 0.2 * spY;
    const c1 = spring(SP, 'c1', t1, dt, 22, 6), c1z = spring(SP, 'c1z', t1z, dt, 16, 4.5);
    const c2 = spring(SP, 'c2', 0.08 + 0.25 * walk + 1.1 * (t1 - c1) + 0.04 * Math.sin(t * 1.3 + 1), dt, 18, 4.5), c2z = spring(SP, 'c2z', 1.2 * (t1z - c1z) + 0.06 * Math.sin(t * 1.1), dt, 14, 3.8);
    const c3 = spring(SP, 'c3', 0.06 + 0.2 * walk + 1.2 * (t1 - c1) + 0.06 * Math.sin(t * 1.7 + 2), dt, 14, 3.5), c3z = spring(SP, 'c3z', 1.3 * (t1z - c1z) + 0.08 * Math.sin(t * 1.4 + 1), dt, 12, 3.2);
    pose('cape1', c1, 0, c1z); pose('cape2', c2, 0, c2z); pose('cape3', c3, 0, c3z);
    y -= crouch * 0.9 + Math.abs(c) * 0.25 * walk;
    if (walk && Math.sign(s) !== rig.lastStep) { rig.lastStep = Math.sign(s); ctx.shake(0.15, 0.22); if (B.a === 'move') snd('step', B.x, B.z); }
    if (dying) {   // 무릎을 꿇고(칼을 짚음) → 앞으로 무너지며 가라앉는다
      pose('armR', 0.8 * kneel, 0, -0.2); pose('spine', -0.5 * kneel, 0, 0); pose('head', 0.6 * kneel, 0, 0); pose('jaw', 0.6, 0, 0);
      y = B.y - 3.0 * kneel - 7 * clamp((dk - 0.55) / 0.45, 0, 1); pitch = 0.5 * clamp((dk - 0.35) / 0.4, 0, 1);
    }
    rig.root.position.set(B.x, y, B.z);
    rig.root.rotation.order = 'YXZ'; rig.root.rotation.set(-pitch, B.ry, 0);
    const lit = dying ? 1 - dk : se;
    rig.light.intensity = 26 * lit * (0.85 + 0.15 * Math.sin(t * 7) + (B.rage ? 0.5 : 0));
    rig.glow.intensity = 30 * lit * (code === 'smash' || code === 'sweep' || code === 'thrust' ? 1.6 : 1);
    const cp = ctx.camPos ? ctx.camPos() : null;
    const want = cp && Math.hypot(cp.x - B.x, cp.z - B.z) > D.lodD ? 1 : 0;
    if (want !== rig.lod) { rig.lod = want; for (const o of rig.lods) o.visible = new RegExp('_LOD' + want).test(o.name) || new RegExp('_LOD' + want).test(o.parent && o.parent.name || ''); }
    if (rig.flash > 0) {
      rig.flash = Math.max(0, rig.flash - dt); const on = rig.flash > 0;
      for (const m of rig.mats) { if (!m.emissive) continue; const b = rig.base.get(m); if (on) { m.emissive.setRGB(1, 0.05, 0.03); m.emissiveIntensity = 1.2 * rig.flashK; } else { m.emissive.copy(b.e); m.emissiveIntensity = b.i; } }
    }
  }
  const tmpA = { x: 0, y: 0, z: 0 };
  function refreshHull() {
    capsW.length = 0;
    if (rig) {
      rig.root.updateMatrixWorld(true);
      const va = new THREE.Vector3(), vb = new THREE.Vector3();
      for (const h of rig.hull) {
        va.copy(h.a); vb.copy(h.b);
        const M = h.bone ? h.bone.matrixWorld : rig.root.matrixWorld; va.applyMatrix4(M); vb.applyMatrix4(M);
        capsW.push({ ax: va.x, ay: va.y, az: va.z, bx: vb.x, by: vb.y, bz: vb.z, r: h.r, col: h.col });
      }
      return;
    }
    const cs = Math.cos(B.ry), sn = Math.sin(B.ry);
    const tw = (p) => { const [x, y, z] = bl(p); tmpA.x = B.x + x * cs + z * sn; tmpA.y = B.y + y; tmpA.z = B.z - x * sn + z * cs; return tmpA; };
    for (const [, a, b, r, col] of D.hull) { const A = tw(a), ax = A.x, ay = A.y, az = A.z, Bp = tw(b); capsW.push({ ax, ay, az, bx: Bp.x, by: Bp.y, bz: Bp.z, r, col: !!col }); }
  }
  function swordTip() {   // 칼끝 세계 좌표(효과용)
    if (rig && rig.sword.bone) { const v = rig.sword.tip.clone().applyMatrix4(rig.sword.bone.matrixWorld); return { x: v.x, y: v.y, z: v.z }; }
    const [fx, fz] = fwd(B.ry); return { x: B.x + fx * 10, y: B.y + 1, z: B.z + fz * 10 };
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
      if (!act.cur || act.cur.code !== 'thrust') { B.x += (R.tx - B.x) * k; B.z += (R.tz - B.z) * k; B.y += (R.ty - B.y) * k; B.ry = wrapA(B.ry + wrapA(R.try_ - B.ry) * k); }
      if (B.spawnT > 0) B.spawnT -= dt;
      if (B.a === 'die' && B.dieT > 0) B.dieT -= dt;
      const quiet = now - R.lastSnap;
      if (quiet > 7000) { const dead = B.a === 'die'; despawn(); emit('gone', { dead, kind }); return; }
      if (quiet > 2600 && B.a !== 'die') {
        const ids = ctx.players().map((p) => p.id).sort();
        if (ids[0] === ctx.myId) { B.owner = true; B.ownerId = ctx.myId; B.ep++; act.cur = null; O.gap = 1.2; for (const p of D.patterns) O.cd[p.code] = O.cd[p.code] || 0; emit('takeover', { kind }); }
      }
    }
    if (B.a !== 'die' && B.spawnT <= 0) runPattern(dt);
    tickFx(dt);
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
  function hitTest(cx, cz, radius, y) {
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
    B.a = 'die'; B.dieT = D.dieT; B.ac++; act.cur = null;
    snd('die', B.x, B.z); ctx.shake(1.1, 1.6); emit('die', { by, kind });
  }

  // ---------- 네트워크 ----------
  function snapshot() {
    if (!B.active || !B.owner) return null;
    return { kd: kind, id: ctx.myId, n: ++B.seq, b: B.born, ep: B.ep, hp: Math.round(B.hp), mh: B.maxHp, x: r2(B.x), z: r2(B.z), y: r2(B.y), r: r2(B.ry), a: B.a, ac: B.ac, sa: r2(B.sa), tx: B.tx, tz: B.tz, pt: B.pt.slice(0, 4), rg: B.rage ? 1 : 0, f: [] };
  }
  function applySnapshot(d, senderId) {
    if (!d || typeof d !== 'object' || d.kd !== kind) return false;
    const x = finite(d.x, -120, 120), z = finite(d.z, -140, 120), y = finite(d.y, -40, 80), ry = finite(d.r, -7, 7), hp = finite(d.hp, 0, 99999), mh = finite(d.mh, 1, 99999);
    const born = finite(d.b, 0, 1e15), ep = finite(d.ep, 0, 1e6), ac = finite(d.ac, 0, 1e9);
    if ([x, z, y, ry, hp, mh, born, ep, ac].some((v) => v === null) || !ACTS.has(d.a)) return false;
    if (B.active && B.owner) {
      if (!outranks(ep, born, senderId, B.ep, B.born, ctx.myId)) return false;
      resetState();
    } else if (B.active && B.ownerId && B.ownerId !== senderId && !outranks(ep, born, senderId, B.ep, B.born, B.ownerId)) return false;
    if (!B.active) {
      resetState(); B.active = true; B.x = x; B.z = z; B.y = y; B.ry = ry; B.spawnT = d.a === 'spawn' ? D.spawnT : 0; R.lastAc = ac;
      load().then(() => { if (B.active && !rig) rig = makeRig(); }).catch(() => despawn());
      emit('spawn', { owner: false, kind });
      if (d.a === 'spawn') intro();
    }
    B.owner = false; B.ownerId = senderId; B.ep = ep; B.born = born; B.maxHp = mh; B.rage = d.rg === 1;
    R.tx = x; R.tz = z; R.ty = y; R.try_ = ry; R.lastSnap = performance.now();
    if (hp < B.hp && rig) { rig.flash = 0.12; rig.flashK = B.hp - hp >= 12 ? 1 : 0.3; }
    if (hp !== B.hp) { B.hp = hp; emit('hp', { hp, maxHp: mh }); }
    if (d.a === 'die' && B.a !== 'die') { B.a = 'die'; B.dieT = D.dieT; act.cur = null; snd('die', B.x, B.z); emit('die', { kind }); }
    if (ac !== R.lastAc) {
      const adv = ac - R.lastAc; R.lastAc = ac;
      if (adv > 0 && adv < 6 && D.patterns.some((p) => p.code === d.a)) {
        B.sa = finite(d.sa, -7, 7) ?? ry; B.tx = finite(d.tx, -120, 120) ?? x; B.tz = finite(d.tz, -140, 120) ?? z;
        B.pt = Array.isArray(d.pt) ? d.pt.slice(0, 4).filter((q) => Array.isArray(q) && finite(q[0], -1, 1) !== null).map((q) => [finite(q[0], -1, 1), 0]) : [];
        if (d.a === 'smash' && !B.pt.length) B.pt = [[0, 0]];
        B.x = x; B.z = z; B.ry = ry;   // 패턴은 소유자와 같은 자리·방향에서 시작
        startPattern(d.a, true);
      }
    }
    if (d.a !== 'die') B.a = d.a;
    return true;
  }

  return {
    kind, load, spawn, despawn, update, snapshot, applySnapshot, hitTest, hitRay, damage, slowAt: () => 1,
    on(k, f) { (listeners[k] = listeners[k] || []).push(f); },
    act(code) { const p = D.patterns.find((q) => q.code === code); if (B.owner && B.active && !act.cur && B.spawnT <= 0 && B.dieT <= 0 && p) { ownerBegin(p, nearest(B.x, B.z)); return true; } return false; },   // test hook
    get active() { return B.active; }, get owner() { return B.owner; }, get ownerId() { return B.ownerId; },
    get view() { return { kind, name: D.name, title: D.title, born: B.born, active: B.active, owner: B.owner, hp: B.hp, maxHp: B.maxHp, a: B.a, rage: B.rage, x: B.x, z: B.z, y: B.y, ry: B.ry, minions: 0, webs: 0, haz: 0, proj: fxl.length, spawnT: B.spawnT, dying: B.a === 'die', camR: D.camR, camLift: D.camLift, act: act.cur ? act.cur.code : '' }; },
    get debug() { return { B, O, R, rig, fxl, act, capsW, myHit, swordTip }; },
    BOSS: { hitReach: D.hitReach }, DEF: D,
  };
}
