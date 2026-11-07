// node tools/hydra.test.mjs — bf/hydra.js(뼈가면 히드라)의 로직을 THREE 없이 확인한다: 정의 · 스냅샷 검증 · 옛 클라이언트 호환 · 허브 라우팅 ·
// 머리별 판정(광선 · 펀치) · 머리 체력과 꺾임 · 패턴 4종 피해 · 처치.
import { createHydraBoss, DEF, ACTS, HITS, HEADS } from '../bf/hydra.js';
import { createGiantBoss, createBossHub } from '../bf/bosses.js';
import { createSpiderBoss } from '../bf/spider.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
console.warn = () => {};
const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } }, Quaternion: class {} };
const ME = { ok: true, x: 0, y: 0, z: 0 };
const ctxFor = (myId = 'bbb', players = [{ id: 'bbb', x: 0, z: 0, y: 0 }], hits = [], ev = []) => ({
  THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId, heightAt: () => 0, canStand: () => true, canSwim: () => false, canFly: () => true, waterLevel: () => -5,
  players: () => players, me: () => ME, onHitMe: (h) => hits.push(h), fx: { poof() {}, spark() {}, thump() {}, crown() {} }, sfx: (k, nm) => ev.push(nm), shake() {}, camPos: () => ({ x: 0, y: 0, z: 0 }),
});
const snap = (o = {}) => ({ kd: 'hydra', id: 'aaa', n: 1, b: 1000, ep: 0, hp: 4000, mh: 7200, x: 5, z: 6, y: 0, r: 1, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], f: [], hh: [1000, 1000, 1000], hm: 1152, ...o });
const run = (b, sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) b.update(dt, t); };

// 1) 정의
ok(DEF.patterns.length >= 3 && DEF.patterns.every((p) => HITS[p.code]), 'at least 3 patterns, each with a damage entry');
ok(DEF.hull.length >= 20 && DEF.hull.every((h) => h[3] > 0.3), 'a body of capsules');
ok([1, 2, 3].every((i) => DEF.hull.some((h) => h[5] === i)), 'every head has its own capsules');
ok(DEF.hp >= 5000 && DEF.file === 'hydra.glb' && DEF.title, 'hp on the x10 scale, model file, title');
for (const a of ACTS) ok(!['i', 'w', 's', 'sw', 'sp', 'wb', 'sm', 'd', 'h'].includes(a), `action ${a} is not a spider code`);
ok(HEADS.length === 3, 'three heads');

// 2) 스냅샷 검증 · 옛 클라이언트 호환
{
  const b = createHydraBoss(ctxFor());
  ok(b.applySnapshot(snap({ hp: NaN }), 'aaa') === false, 'NaN hp refused');
  ok(b.applySnapshot(snap({ hh: [1, 2] }), 'aaa') === false, 'head list must have 3 entries');
  ok(b.applySnapshot(snap({ hh: [1, 'x', 3] }), 'aaa') === false, 'head hp must be numbers');
  ok(b.applySnapshot(snap({ a: 'bite' }), 'aaa') === false, 'another boss code refused');
  ok(b.applySnapshot(snap({ kd: 'golem' }), 'aaa') === false, 'another kind refused');
  ok(b.applySnapshot(snap(), 'aaa') === true && b.view.active && !b.view.owner && b.view.hp === 4000 && b.view.headsUp === 3, 'valid snapshot makes a replica');
  ok(b.snapshot() === null && b.damage('boss', 1, 10, 'x') === false, 'a replica neither streams nor books damage');
  ok(b.applySnapshot(snap({ a: 'hbreath', ac: 1, pt: [[1, 2], ['x', 3], [1e9, 4], 'q', [5, 5]] }), 'aaa') && b.debug.B.pt.length === 2 && b.debug.B.pt[1][0] === 120, 'breath targets filtered, clamped, max 3');
  ok(b.debug.act.cur && b.debug.act.cur.code === 'hbreath', 'replica starts the pattern when the counter moves');
  const ev = []; const b2 = createHydraBoss(ctxFor('ccc', [], [], ev)); b2.on('headbreak', (e) => ev.push('hb' + e.head));
  b2.applySnapshot(snap(), 'aaa'); b2.applySnapshot(snap({ n: 2, hh: [1000, 0, 1000] }), 'aaa');
  ok(ev.includes('hb2') && b2.view.headsUp === 2, 'replica sees a head break from the snapshot');
  const old = createSpiderBoss({ THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId: 'zzz', heightAt: () => 0, canStand: () => true, players: () => [], me: () => ME, pushMe() {}, onHitMe() {}, fx: { poof() {}, spark() {}, thump() {} } });
  ok(old.applySnapshot(snap(), 'aaa') === false && !old.active, 'an old client (spider only) ignores the hydra');
  const oldHub = createBossHub({ spider: old, golem: createGiantBoss(ctxFor(), 'golem') });
  ok(oldHub.applySnapshot(snap(), 'aaa') === false, 'a hub without the hydra ignores it');
}

// 3) 허브 라우팅: map 에 넣으면 붙는다
{
  const hy = createHydraBoss(ctxFor()), go = createGiantBoss(ctxFor(), 'golem');
  const hub = createBossHub({ golem: go, hydra: hy });
  ok(hub.kinds.includes('hydra'), 'hub lists the hydra');
  ok(hub.spawn(0, 0, 0, 'hydra') && hub.kind === 'hydra' && hub.view.title === DEF.title, 'hub spawns the hydra');
  ok(hub.spawn(0, 0, 0, 'golem') === false, 'one boss at a time');
  hub.despawn(); ok(!hub.active, 'hub despawns it');
  const hub2 = createBossHub({ golem: createGiantBoss(ctxFor(), 'golem'), hydra: createHydraBoss(ctxFor()) });
  ok(hub2.applySnapshot(snap(), 'aaa') && hub2.kind === 'hydra', 'hub routes a hydra snapshot');
}

// 4) 머리별 판정 · 머리 체력
{
  const hits = [], ev = [];
  const b = createHydraBoss(ctxFor('bbb', [{ id: 'bbb', x: 0, z: -40, y: 0 }], hits, ev));
  b.spawn(0, 0, 0);
  run(b, DEF.spawnT + 0.1);
  const hp0 = b.view.hp, h0 = b.view.heads[1];
  ok(h0 > 0 && h0 === Math.round(b.view.maxHp * DEF.headShare), 'each head has its own hp pool');
  // 가운데 머리를 옆에서 쏜다: 머리(three: x=0, y≈14.3, z≈-12.8)
  const r = b.hitRay(-30, 14.3, -12.8 + b.view.z, 1, 0, 0, 60, 0);
  ok(r && r.part === 'head' && r.id === 2, `a ray at the middle head reports head 2 (${JSON.stringify(r)})`);
  const rb = b.hitRay(0, 7.5, 30, 0, 0, -1, 60, 0);
  ok(rb && rb.part === 'body' && rb.id === 0, 'a ray at the rump hits the body');
  const rl = b.hitRay(-30, 12.0, -11.8 + b.view.z, 1, 0, 0, 60, 0);
  ok(rl && rl.id === 1, `a ray at the left head reports head 1 (${JSON.stringify(rl)})`);
  ok(b.hitTest(0, -12.8 + b.view.z, 0.6, 13.4).some((h) => h.id === 2), 'a punch at the middle head reports head 2');
  ok(b.damage('boss', 2, 100, 'p1') && b.view.hp === hp0 - 150 && b.view.heads[1] === h0 - 150, 'head hits deal 1.5x to the head and the total');
  ok(b.damage('boss', 0, 100, 'p2') && b.view.heads[0] === h0 && b.view.hp === hp0 - 250, 'body hits leave the heads alone');
  const brk = []; b.on('headbreak', (e) => brk.push(e.head));
  for (let i = 0; i < 40 && b.view.heads[1] > 0; i++) b.damage('boss', 2, 300, 'q' + i);
  ok(b.view.heads[1] === 0 && brk[0] === 2 && b.view.headsUp === 2 && ev.includes('headbreak'), 'a head breaks when its pool is empty');
  const before = b.view.hp; b.damage('boss', 2, 100, 'z'); ok(b.view.hp === before - 100, 'a broken head takes plain damage');
  for (let i = 0; i < 40 && b.view.heads[0] > 0; i++) b.damage('boss', 1, 300, 'r' + i);
  run(b, 0.1);
  ok(b.view.rage, 'two heads broken -> rage');
  const s = b.snapshot(); ok(Array.isArray(s.hh) && s.hh[0] === 0 && s.hh[1] === 0 && s.hh[2] > 0, 'snapshot carries head hp');
}

// 5) 패턴 4종이 나를 맞힌다 + 처치
function fight(code, me, players) {
  const hits = [];
  const b = createHydraBoss(ctxFor('bbb', players || [{ id: 'bbb', x: me.x, z: me.z, y: 0 }], hits));
  b.spawn(0, 0, 0); run(b, DEF.spawnT + 0.1);
  Object.assign(ME, { ok: true, y: 0 }, me);
  b.debug.O.gap = 99;
  ok(b.act(code), `${code}: starts`);
  run(b, DEF.patterns.find((p) => p.code === code).dur + 0.3);
  return { b, hits };
}
{
  const { hits, b } = fight('hbreath', { x: 0, z: -24 });
  ok(hits.some((h) => h.src === 'hbreath'), 'breath burns me in front');
  ok(b.view.haz > 0, 'breath leaves fire pools');
  ok(b.debug.B.pt.length === 3, 'one target per head');
}
ok(fight('hsnap', { x: 0, z: -15 }).hits.some((h) => h.src === 'hsnap'), 'snap bites me in front');
ok(fight('hsweep', { x: 14, z: 6 }).hits.some((h) => h.src === 'hsweep'), 'tail sweep hits me at the side');
{ ME.y = 5; const { hits } = fight('hsweep', { x: 14, z: 6, y: 5 }); ok(!hits.some((h) => h.src === 'hsweep'), 'jumping over the tail sweep avoids it'); ME.y = 0; }
{
  const { hits, b } = fight('hdive', { x: 0, z: -30 });
  ok(hits.some((h) => h.src === 'hdive' || h.src === 'hring'), 'flying dive lands on me');
  ok(Math.hypot(b.view.x, b.view.z + 30) < 2, 'dive moves the hydra to the target');
}
{ // 깨진 머리는 불을 뿜지 않는다
  const b = createHydraBoss(ctxFor('bbb', [{ id: 'bbb', x: 0, z: -24, y: 0 }]));
  b.spawn(0, 0, 0); run(b, DEF.spawnT + 0.1); b.debug.B.hh = [0, 0, 0];
  ok(b.act('hbreath') === true, 'act hook still starts');
  b.debug.act.cur = null; b.debug.O.gap = 0; for (const k in b.debug.O.cd) b.debug.O.cd[k] = 0;
  let saw = false; for (let i = 0; i < 400; i++) { b.update(1 / 60, i / 60); if (b.view.act === 'hbreath') saw = true; }
  ok(!saw, 'the AI never picks breath with no heads left');
}
{ // 처치
  const ev = [];
  const b = createHydraBoss(ctxFor('bbb', [{ id: 'bbb', x: 0, z: -40, y: 0 }], [], ev));
  const died = []; b.on('die', (e) => died.push(e)); const req = []; b.on('request-despawn', (e) => req.push(e));
  b.spawn(0, 0, 0); run(b, DEF.spawnT + 0.1);
  for (let i = 0; i < 200 && b.view.hp > 0; i++) b.damage('boss', 0, 300, 'k' + i);
  ok(b.view.hp === 0 && died.length === 1 && b.view.dying, 'killed');
  ok(b.hitRay(0, 7.5, 30, 0, 0, -1, 60, 0) === null, 'a dead hydra is not a target');
  run(b, DEF.dieT + 0.2); ok(req.length === 1 && req[0].dead, 'asks to be removed after the death scene');
}

console.log(`${n - fails}/${n} passed`);
if (fails) process.exit(1);
