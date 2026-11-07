// node tools/bosses.test.mjs — bf/bosses.js 의 보스 3종·허브 로직(스냅샷 검증, 옛 클라이언트 호환, 허브 라우팅, 빈틈 없는 몸 판정, 패턴 피해, 처치)을 THREE 없이 확인한다.
// 모델 로딩은 node 에서 실패하므로(동적 import) 모든 검사는 동기 구간에서 한다.
import { createGiantBoss, createBossHub, createBossRoster, ROSTER_CAP, HID, tagOf, KINDS, ACTS, HITS } from '../bf/bosses.js';
import { createSpiderBoss } from '../bf/spider.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
console.warn = () => {};

const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } }, Quaternion: class {} };
const ME = { ok: true, x: 0, y: 0, z: 0 };
function ctxFor(myId = 'bbb', players = [{ id: 'bbb', x: 0, z: 0, y: 0 }], hits = []) {
  return {
    THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId, heightAt: (x, z) => (z < -20 ? -6 : 0), canStand: (x, z) => z >= -20, canSwim: (x, z) => z < -20, canFly: () => true, waterLevel: () => 0,
    players: () => players, me: () => ME, onHitMe: (h) => hits.push(h), fx: { poof() {}, spark() {}, thump() {}, crown() {} }, sfx() {}, shake() {}, camPos: () => ({ x: 0, y: 0, z: 0 }),
  };
}
const make = (kind, myId, players, hits) => createGiantBoss(ctxFor(myId, players, hits), kind);
const snap = (kind, o = {}) => ({ kd: kind, id: 'aaa', n: 1, b: 1000, ep: 0, hp: 400, mh: 600, x: 5, z: 6, y: 0, r: 1, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], f: [], ...o });

// 1) 정의: 보스마다 패턴 3개 이상, 캡슐 몸, 체력
for (const k of ['shark', 'golem', 'seraph']) {
  const D = KINDS[k];
  ok(D.patterns.length >= 3, `${k}: at least 3 patterns`);
  ok(D.hull.length >= 8 && D.hull.every((h) => h[3] > 0.3), `${k}: a body made of capsules`);
  ok(D.hp >= 400 && D.title && D.file.endsWith('.glb'), `${k}: hp, title, model file`);
  ok(D.patterns.every((p) => HITS[p.code]), `${k}: every pattern has a damage entry`);
}
ok(KINDS.shark.water && KINDS.seraph.fly && !KINDS.golem.fly, 'shark swims, seraph flies, golem walks');

// 2) 스냅샷 검증 · 옛 클라이언트 호환(거미 코드와 안 겹침)
for (const k of ['shark', 'golem', 'seraph']) {
  const b = make(k);
  ok(b.applySnapshot(snap(k, { hp: NaN }), 'aaa') === false, `${k}: NaN hp refused`);
  ok(b.applySnapshot(snap(k, { a: 'sw' }), 'aaa') === false, `${k}: a spider action code is refused`);
  ok(b.applySnapshot(snap(k === 'shark' ? 'golem' : 'shark'), 'aaa') === false, `${k}: another kind's snapshot is refused`);
  ok(b.applySnapshot(snap(k), 'aaa') === true && b.view.active && !b.view.owner && b.view.hp === 400, `${k}: valid snapshot makes a replica`);
  ok(b.snapshot() === null && b.damage('boss', 0, 10, 'x') === false, `${k}: a replica neither streams nor books damage`);
  const old = createSpiderBoss({ THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId: 'zzz', heightAt: () => 0, canStand: () => true, players: () => [], me: () => ME, pushMe() {}, onHitMe() {}, fx: { poof() {}, spark() {}, thump() {} } });
  ok(old.applySnapshot(snap(k), 'aaa') === false && !old.active, `${k}: an old client (spider only) ignores this boss`);
  for (const a of ACTS[k]) ok(!['i', 'w', 's', 'sw', 'sp', 'wb', 'sm', 'd', 'h'].includes(a), `${k}: action ${a} is not a spider code`);
}
{ // lists and points are validated
  const b = make('seraph');
  b.applySnapshot(snap('seraph', { f: [[1, 0, 0, 1], [2, 'x', 0, 1], 'bad', ...Array(20).fill([3, 1, 1, 1])] }), 'aaa');
  ok(b.debug.B.haz.length <= 8 && b.debug.B.haz.every((h) => Number.isFinite(h.x)), 'fire pools capped and sane');
  ok(b.applySnapshot(snap('seraph', { a: 'pillar', ac: 1, pt: [[1, 2], ['x', 3], [1e9, 4], 'q'] }), 'aaa') && b.debug.B.pt.length === 2 && b.debug.B.pt[1][0] === 120, 'pillar points are filtered and clamped');
  ok(b.debug.act.cur && b.debug.act.cur.code === 'pillar', 'replica starts the pattern when the counter moves');
}

// 3) 소유자: 생성 · 스냅샷 · 피해 · 처치
for (const k of ['shark', 'golem', 'seraph']) {
  const b = make(k, 'bbb', [{ id: 'bbb', x: 0, z: 0, y: 0 }, { id: 'ccc', x: 1, z: 1, y: 0 }]);
  ok(b.spawn(0, k === 'shark' ? -40 : 20, 0) && b.owner && b.view.maxHp === KINDS[k].hp + KINDS[k].hpPerExtra, `${k}: spawn scales hp with players`);
  ok(b.damage('boss', 0, 10, 'p') === false, `${k}: no damage while appearing`);
  b.debug.B.spawnT = 0;
  const s = b.snapshot(); ok(s && s.kd === k && s.a === 'spawn' && typeof s.y === 'number', `${k}: owner snapshot`);
  ok(b.damage('boss', 0, 10, 'p') === true && b.view.hp === b.view.maxHp - 10, `${k}: damage books`);
  ok(b.damage('boss', 0, 10, 'p', 300) === false, `${k}: per-attacker gap`);
  ok(b.damage('boss', 0, 1e6, 'q') === true && b.view.hp === b.view.maxHp - 10 - 300, `${k}: one hit is capped at 300`);
  b.debug.B.hp = 5; b.damage('boss', 0, 10, 'r');
  ok(b.view.dying && b.view.hp === 0, `${k}: dies at 0`);
  ok(b.hitTest(0, 0, 50, 0).length === 0, `${k}: a dying boss takes no more hits`);
}

// 4) 빈틈 없는 몸: 쉬는 자세 캡슐(모델 없이)로 판정
{
  const g = make('golem'); g.spawn(0, 0, 0); g.debug.B.spawnT = 0; g.debug.B.y = 0;
  ok(g.hitTest(0, 0, 0.8, -0.4).length === 1, 'golem: a grenade on the ground between the legs hits (hips column)');
  ok(g.hitTest(0, 1.5, 1.2, 0.3).length === 1, 'golem: a low sword wave between the legs hits');
  ok(g.hitTest(-2.9, -0.5, 0.85, 0).length === 1, 'golem: a punch on a shin hits');
  ok(g.hitTest(0, 14, 0.85, 0).length === 0 && g.hitTest(20, 0, 0.85, 0).length === 0, 'golem: open ground misses');
  const r = g.hitRay(0, 10, 30, 0, 0, -1, 80, 0.1); ok(r && r.kind === 'boss' && r.d > 20 && r.d < 30, 'golem: a bullet from the front hits the chest');
  ok(g.hitRay(0, 30, 30, 0, 0, -1, 80, 0.1) === null, 'golem: a bullet over the head misses');
  const s = make('shark'); s.spawn(0, -40, 0); s.debug.B.spawnT = 0; s.debug.B.y = -1.5;
  ok(s.hitRay(30, -1, -40, -1, 0, 0, 80, 0.1) !== null, 'shark: a bullet at the flank hits');
  ok(s.hitTest(0, -40 + 9, 1, -1.5).length === 1, 'shark: a sword at the snout hits');
  const a = make('seraph'); a.spawn(0, 0, 0); a.debug.B.spawnT = 0; a.debug.B.y = 4.2;
  ok(a.hitRay(-10, 4.2 + 12, 30, 0, 0, -1, 80, 0.1) !== null, 'seraph: the feathered wing is part of the body');
  ok(a.hitRay(10, 4.2 + 12, 30, 0, 0, -1, 80, 0.1) !== null, 'seraph: the bat wing is part of the body');
  ok(a.hitTest(0, 0, 0.8, 0).length === 0, 'seraph: flying — the ground under it is not its body');
}

// 5) 패턴: 소유자가 시작하면 시간표대로 내게 피해(맞는 판정은 내 화면)
{
  const hits = [];
  const g = make('golem', 'bbb', [{ id: 'bbb', x: 0, z: -8, y: 0 }], hits); ME.x = 0; ME.z = -8; ME.y = 0;
  g.spawn(0, 0, 0); g.debug.B.spawnT = 0; g.debug.B.a = 'idle';
  ok(g.act('slam'), 'golem: slam starts');
  for (let i = 0; i < 40; i++) g.update(0.05, i * 0.05);
  ok(hits.some((h) => h.src === 'slam' && h.dmg >= 30 && h.boss === 'golem'), 'golem: slam lands on me in front');
  const hits2 = [];
  const s = make('shark', 'bbb', [{ id: 'bbb', x: 0, z: -49, y: 0 }], hits2); ME.x = 0; ME.z = -49; ME.y = 0;
  s.spawn(0, -40, 0); s.debug.B.spawnT = 0;
  ok(s.act('bite'), 'shark: bite starts');
  for (let i = 0; i < 30; i++) s.update(0.05, i * 0.05);
  ok(hits2.some((h) => h.src === 'bite'), 'shark: bite lands at the mouth');
  const hits3 = [];
  const t = make('golem', 'bbb', [{ id: 'bbb', x: 0, z: -8, y: 0 }], hits3); ME.y = 6;   // jumping high: the slam misses
  t.spawn(0, 0, 0); t.debug.B.spawnT = 0; t.act('slam');
  for (let i = 0; i < 40; i++) t.update(0.05, i * 0.05);
  ok(!hits3.length, 'golem: a high jump clears the slam');
  ME.y = 0;
}
{ // lunge: leaves the water, lands at the target, goes back to the water
  const hits = [];
  const s = make('shark', 'bbb', [{ id: 'bbb', x: 0, z: -10, y: 0 }], hits); ME.x = 0; ME.z = -10;
  s.spawn(0, -30, 0); s.debug.B.spawnT = 0;
  ok(s.act('lunge'), 'shark: lunge starts');
  let maxY = -99, minZ = 0; for (let i = 0; i < 100; i++) { s.update(0.05, i * 0.05); maxY = Math.max(maxY, s.view.y); minZ = Math.max(minZ, s.view.z); }
  ok(maxY > 4, 'shark: it leaps clear of the water');
  ok(hits.some((h) => h.src === 'lunge'), 'shark: the lunge lands on me on the beach');
  ok(s.view.z < -25, 'shark: it slides back into the sea');
}
{ // replica follows the counter and plays the same pattern
  const hits = [];
  const r = make('seraph', 'ccc', [{ id: 'ccc', x: 3, z: 3, y: 0 }], hits); ME.x = 3; ME.z = 3; ME.y = 0;
  r.applySnapshot(snap('seraph', { x: 0, z: 30, y: 4 }), 'aaa');
  r.applySnapshot(snap('seraph', { x: 0, z: 30, y: 4, a: 'dive', ac: 1, tx: 3, tz: 3 }), 'aaa');
  for (let i = 0; i < 60; i++) r.update(0.05, i * 0.05);
  ok(hits.some((h) => h.src === 'dive'), 'replica: the dive lands on me');
}

// 6) 허브: 종류별 라우팅, 한 번에 하나
{
  const c = ctxFor('bbb');
  const spider = createSpiderBoss({ ...c, pushMe() {} });
  const hub = createBossHub({ spider, shark: createGiantBoss(c, 'shark'), golem: createGiantBoss(c, 'golem'), seraph: createGiantBoss(c, 'seraph') });
  ok(hub.kinds.length === 4, 'hub: four kinds');
  ok(hub.spawn(0, 20, 0, 'golem') && hub.kind === 'golem' && hub.view.title.includes('골렘'), 'hub: spawn a golem');
  ok(hub.spawn(0, 20, 0, 'spider') === false, 'hub: only one boss at a time');
  ok(hub.BOSS.hitReach === KINDS.golem.hitReach, 'hub: reach of the live boss');
  hub.despawn(); ok(!hub.active, 'hub: despawn');
  ok(hub.applySnapshot({ id: 'aaa', n: 1, b: 1000, ep: 0, hp: 400, mh: 480, x: 5, z: 6, r: 1, a: 'i', ac: 0, sa: 0, wt: null, w: [], m: [] }, 'aaa') && hub.kind === 'spider', 'hub: a snapshot without kd is the spider (old clients)');
  ok(hub.applySnapshot(snap('shark', { b: 2000 }), 'ddd') === false && hub.kind === 'spider', 'hub: a later-born other boss does not replace the live one');
  ok(hub.applySnapshot(snap('shark', { b: 500 }), 'ddd') && hub.kind === 'shark', 'hub: an earlier-born boss wins');
  ok(hub.applySnapshot(snap('dragon'), 'aaa') === false, 'hub: unknown kind refused');
}

// 7) 여러 마리 동시 소환(명부): 같은 종류 중복 · 개별/전체 삭제 · 상한 · born 별 스냅샷 라우팅 · 맞은 보스로 피해
{
  const spCtx = { THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId: 'bbb', heightAt: () => 0, canStand: () => true, players: () => [{ id: 'bbb', x: 0, z: 0, y: 0 }], me: () => ME, pushMe() {}, onHitMe() {}, fx: { poof() {}, spark() {}, thump() {} } };
  const F = { spider: () => createSpiderBoss(spCtx) };
  for (const k of ['shark', 'golem', 'seraph']) F[k] = () => createGiantBoss(ctxFor('bbb'), k);
  const R = createBossRoster(F, { me: () => ({ x: 0, z: 0 }) });
  const evs = []; R.on('spawn', (e) => evs.push(e));
  const b1 = R.spawn(0, 20, 0, 'golem'), b2 = R.spawn(40, 20, 0, 'golem'), b3 = R.spawn(-40, 20, 0, 'seraph'), b4 = R.spawn(0, -40, 0, 'shark');
  ok(b1 && b2 && b3 && b4 && new Set([b1, b2, b3, b4]).size === 4, 'roster: four bosses, two of the same kind, distinct ids');
  ok(R.count === 4 && R.views().filter((v) => v.kind === 'golem').length === 2, 'roster: same kind twice');
  ok(evs.length === 4 && evs.every((e) => e.born > 0), 'roster: spawn events carry the boss id');
  ok(R.snapshots().length === 4 && new Set(R.snapshots().map((q) => q.b)).size === 4, 'roster: one snapshot per boss, each with its own id');
  for (const v of R.views()) R.get(v.born).debug.B.spawnT = 0;
  // 피해는 맞은 보스에만
  const id2 = tagOf(b2) * HID;
  ok(R.of(id2) === R.get(b2) && R.damage('boss', id2, 50, 'p') === true, 'roster: a hit id routes to its boss');
  ok(R.get(b2).view.hp === R.get(b2).view.maxHp - 50 && R.get(b1).view.hp === R.get(b1).view.maxHp, 'roster: other boss untouched');
  // 처치: 체력 0 → 쓰러짐
  for (let i = 0; i < 40 && R.get(b3).view.hp > 0; i++) R.damage('boss', tagOf(b3) * HID, 300, 'k' + i);
  ok(R.get(b3).view.hp <= 0 && R.get(b3).view.dying, 'roster: one boss can be killed on its own');
  ok(R.count === 4, 'roster: a dying boss stays until its fall ends');
  // 개별 삭제
  R.despawn(b1);
  ok(R.count === 3 && !R.get(b1) && R.get(b2), 'roster: delete one');
  // 상한
  const more = []; for (let i = 0; i < 10; i++) more.push(R.spawn(i * 5, 30, 0, 'golem'));
  ok(R.count === ROSTER_CAP && R.full && more.filter(Boolean).length === ROSTER_CAP - 3, `roster: capped at ${ROSTER_CAP}`);
  ok(R.spawn(0, 0, 0, 'golem') === false, 'roster: spawn refused when full');
  // 전체 삭제
  R.despawn();
  ok(R.count === 0 && !R.active && R.snapshots().length === 0, 'roster: delete all');
  // 복제본: 다른 접속자의 보스 여러 마리를 born 으로 구분
  const Q = createBossRoster(F, { me: () => ({ x: 0, z: 0 }) });
  ok(Q.applySnapshot(snap('golem', { b: 111 }), 'aaa') && Q.applySnapshot(snap('golem', { b: 222, x: 30 }), 'aaa') && Q.applySnapshot(snap('shark', { b: 333 }), 'aaa'), 'replica roster: three bosses from one peer');
  ok(Q.count === 3 && !Q.owner && Q.snapshots().length === 0, 'replica roster: three replicas, none owned');
  ok(Q.applySnapshot(snap('golem', { b: 222, n: 2, hp: 100, x: 31 }), 'aaa') && Q.get(222).view.hp === 100 && Q.get(111).view.hp === 400, 'replica roster: an update reaches only its boss');
  ok(Q.applySnapshot(snap('shark', { b: 222, n: 3 }), 'aaa') === false, 'replica roster: a kind clash on one id is refused');
  ok(Q.applySnapshot({ kd: 'golem', hp: 1 }, 'aaa') === false, 'replica roster: a snapshot without an id is refused');
  ok(Q.damage('boss', tagOf(111) * HID, 10, 'p') === false, 'replica roster: replicas do not book damage');
  Q.despawn(111); ok(Q.count === 2 && !Q.get(111), 'replica roster: delete by id');
  const hits = Q.hitTest(30, 6, 1, 1); ok(hits.every((h) => Q.of(h.id) && Math.floor(h.id / HID) === tagOf(h.born)), 'replica roster: hits carry the boss tag');
}

console.log(`${n - fails}/${n} boss checks passed`);
process.exit(fails ? 1 : 0);
