// node tools/commander.test.mjs — bf/commander.js(대검 지휘관)의 정의 · 스냅샷 검증 · 허브 등록 · 몸 판정 · 패턴 3종 피해 · 분노 · 처치를 THREE 없이 확인한다.
import { createCommanderBoss, DEF, HITS, ACTS, KIND } from '../bf/commander.js';
import { createBossHub, KIND_LIST, createGiantBoss } from '../bf/bosses.js';
import { createSpiderBoss } from '../bf/spider.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
console.warn = () => {};

const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }, Quaternion: class {} };
const ME = { ok: true, x: 0, y: 0, z: 0 };
function ctxFor(myId = 'bbb', players = [{ id: 'bbb', x: 0, z: 0, y: 0 }], hits = []) {
  return {
    THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId, heightAt: () => 0, canStand: (x, z) => Math.abs(x) < 100 && Math.abs(z) < 100, canSwim: () => false, canFly: () => true, waterLevel: () => -5,
    players: () => players, me: () => ME, onHitMe: (h) => hits.push(h), fx: { poof() {}, spark() {}, thump() {}, crown() {} }, sfx() {}, shake() {}, camPos: () => ({ x: 0, y: 0, z: 0 }),
  };
}
const snap = (o = {}) => ({ kd: KIND, id: 'aaa', n: 1, b: 1000, ep: 0, hp: 400, mh: 6800, x: 5, z: 6, y: 0, r: 1, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], f: [], ...o });
const run = (b, sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) b.update(dt, t); };

// 1) 정의
ok(DEF.patterns.length >= 3 && ['sweep', 'smash', 'thrust'].every((c) => DEF.patterns.some((p) => p.code === c)), 'three patterns: sweep, smash, thrust');
ok(DEF.patterns.every((p) => HITS[p.code]) && HITS.quake, 'every pattern (and the quake) has a damage entry');
ok(DEF.hull.length >= 10 && DEF.hull.every((h) => h[3] > 0.3), 'a body made of capsules');
ok(DEF.hp >= 6000 && DEF.hpPerExtra >= 2000 && DEF.file === 'commander.glb', 'hp on the 10x scale, model file');
for (const a of ACTS) ok(!['i', 'w', 's', 'sw', 'sp', 'wb', 'sm', 'd', 'h'].includes(a), `action ${a} is not a spider code`);

// 2) 허브 등록 · 스냅샷 검증 · 옛 클라이언트
ok(KIND_LIST.includes('commander'), 'hub kind list has the commander');
{
  const b = createCommanderBoss(ctxFor());
  ok(b.applySnapshot(snap({ hp: NaN }), 'aaa') === false, 'NaN hp refused');
  ok(b.applySnapshot(snap({ a: 'sw' }), 'aaa') === false, 'a spider action code is refused');
  ok(b.applySnapshot({ ...snap(), kd: 'golem' }, 'aaa') === false, "another kind's snapshot is refused");
  ok(b.applySnapshot(snap(), 'aaa') === true && b.view.active && !b.view.owner && b.view.hp === 400, 'valid snapshot makes a replica');
  ok(b.snapshot() === null && b.damage('boss', 0, 10, 'x') === false, 'a replica neither streams nor books damage');
  ok(b.applySnapshot(snap({ a: 'smash', ac: 1, pt: [[0.42, 0], ['x', 0], [9, 0]] }), 'aaa') && b.debug.act.cur && b.debug.act.cur.code === 'smash' && b.debug.B.pt.every((q) => Math.abs(q[0]) <= 1), 'replica starts the pattern, fissure angles clamped');
  const old = createSpiderBoss({ THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId: 'zzz', heightAt: () => 0, canStand: () => true, players: () => [], me: () => ME, pushMe() {}, onHitMe() {}, fx: { poof() {}, spark() {}, thump() {} } });
  ok(old.applySnapshot(snap(), 'aaa') === false && !old.active, 'an old client (spider only) ignores the commander');
  const oldHub = createBossHub({ spider: old, golem: createGiantBoss(ctxFor(), 'golem') });
  ok(oldHub.applySnapshot(snap(), 'aaa') === false, 'a hub without the commander ignores its snapshots');
}
{ // 허브 라우팅
  const c = createCommanderBoss(ctxFor()), hub = createBossHub({ spider: createSpiderBoss({ THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId: 'bbb', heightAt: () => 0, canStand: () => true, players: () => [], me: () => ME, pushMe() {}, onHitMe() {}, fx: { poof() {}, spark() {}, thump() {} } }), commander: c });
  ok(hub.kinds.includes('commander') && hub.spawn(0, 20, 0, 'commander') && hub.kind === 'commander' && hub.view.title.includes('대검 지휘관'), 'hub spawns the commander by kind');
  hub.despawn(); ok(!hub.active, 'hub despawns it');
}

// 3) 소유자: 생성 · 피해 · 몸 판정 · 처치
{
  const b = createCommanderBoss(ctxFor('bbb', [{ id: 'bbb', x: 0, z: 0, y: 0 }, { id: 'ccc', x: 1, z: 1, y: 0 }]));
  ok(b.spawn(0, 20, 0) && b.owner && b.view.maxHp === DEF.hp + DEF.hpPerExtra, 'spawn scales hp with players');
  ok(b.damage('boss', 0, 10, 'p') === false, 'no damage while appearing');
  b.debug.B.spawnT = 0;
  const s = b.snapshot(); ok(s && s.kd === KIND && typeof s.y === 'number', 'owner snapshot');
  ok(b.damage('boss', 0, 10, 'p') === true && b.view.hp === b.view.maxHp - 10, 'damage books');
  ok(b.damage('boss', 0, 1e6, 'q') === true && b.view.hp === b.view.maxHp - 310, 'one hit is capped at 300');
  b.update(0, 0);
  ok(b.hitTest(0, 20, 0.5, 0).length === 1, 'a punch at the feet (between the legs) lands');
  ok(b.hitTest(0, 20 + 9, 0.5, 0).length === 0, 'nothing far in front of it (the sword is not the body)');
  ok(b.hitRay(0, 10, 0, 0, 0, 1, 80) && b.hitRay(0, 10, 0, 0, 0, 1, 80).d > 15, 'a ray to the chest hits the body');
  ok(b.hitRay(0, 30, 0, 0, 0, 1, 80) === null, 'a ray over the head misses');
  b.debug.B.hp = 1; b.damage('boss', 0, 5, 'z');
  ok(b.view.dying && b.snapshot().a === 'die', 'dies at 0 hp');
}

// 4) 패턴: 맞는 자리 · 넘는 법
function owner(players, hits) {
  const b = createCommanderBoss(ctxFor('bbb', players, hits));
  b.spawn(0, 0, 0); b.debug.B.spawnT = 0; b.debug.O.gap = 99; return b;
}
{ // 수평 베기: 앞쪽 반원 · 점프로 넘김
  const hits = [], b = owner([{ id: 'bbb', x: 0, z: -10, y: 0 }], hits);
  Object.assign(ME, { ok: true, x: 0, z: -10, y: 0 });
  ok(b.act('sweep'), 'sweep starts'); run(b, 1.2);
  ok(hits.some((h) => h.src === 'sweep' && h.boss === 'commander'), 'sweep hits me in front');
  const hits2 = [], b2 = owner([{ id: 'bbb', x: 0, z: -10, y: 0 }], hits2);
  Object.assign(ME, { x: 0, z: -10, y: 2.5 }); b2.act('sweep'); run(b2, 1.2);
  ok(!hits2.some((h) => h.src === 'sweep'), 'jumping over the sweep avoids it');
  const hits3 = [], b3 = owner([{ id: 'bbb', x: 0, z: -10, y: 0 }], hits3);
  Object.assign(ME, { x: 0, z: 12, y: 0 }); b3.act('sweep'); run(b3, 1.2);
  ok(!hits3.some((h) => h.src === 'sweep'), 'behind it is safe from the sweep');
}
{ // 내려찍기: 칼날 자리 + 앞으로 달리는 갈라짐(멀리서도 맞음)
  const hits = [], b = owner([{ id: 'bbb', x: 0, z: -8, y: 0 }], hits);
  Object.assign(ME, { ok: true, x: 0, z: -8, y: 0 });
  ok(b.act('smash'), 'smash starts'); run(b, 1.5);
  ok(hits.some((h) => h.src === 'smash'), 'smash hits me under the blade');
  const hits2 = [], b2 = owner([{ id: 'bbb', x: 0, z: -8, y: 0 }], hits2);
  Object.assign(ME, { x: 0.5, z: -30, y: 0 }); b2.act('smash'); run(b2, 3.0);
  ok(hits2.some((h) => h.src === 'quake') && !hits2.some((h) => h.src === 'smash'), 'the fissure reaches me 30 m away');
  const hits3 = [], b3 = owner([{ id: 'bbb', x: 0, z: -8, y: 0 }], hits3);
  Object.assign(ME, { x: 9, z: -30, y: 0 }); b3.act('smash'); run(b3, 3.0);
  ok(!hits3.length, 'stepping aside from the fissure line avoids it');
  const hits4 = [], b4 = owner([{ id: 'bbb', x: 0, z: -8, y: 0 }], hits4);
  b4.debug.B.rage = true; Object.assign(ME, { x: Math.sin(0.42) * -22, z: -Math.cos(0.42) * 22 - 11 + 11, y: 0 });
  b4.act('smash'); ok(b4.debug.B.pt.length === 3, 'raged smash splits into three fissures');
}
{ // 돌진 찌르기: 먼 목표까지 달려와 찌른다
  const hits = [], b = owner([{ id: 'bbb', x: 0, z: -30, y: 0 }], hits);
  Object.assign(ME, { ok: true, x: 0, z: -30, y: 0 });
  ok(b.act('thrust'), 'thrust starts'); run(b, 2.2);
  ok(hits.some((h) => h.src === 'thrust') && b.view.z < -15, 'thrust dashes ~20 m and hits me');
  const hits2 = [], b2 = owner([{ id: 'bbb', x: 0, z: -30, y: 0 }], hits2);
  Object.assign(ME, { x: 10, z: -30, y: 0 }); b2.debug.B.tx = 0; b2.act('thrust');
  ok(Math.abs(b2.debug.act.cur.to.x - b2.debug.B.x) < 40, 'dash length is capped');
}
{ // 분노 · AI 가 스스로 패턴을 고른다
  const hits = [], b = owner([{ id: 'bbb', x: 0, z: -9, y: 0 }], hits);
  Object.assign(ME, { ok: true, x: 0, z: -9, y: 0 });
  b.debug.O.gap = 0; b.debug.B.hp = b.view.maxHp * 0.3;
  const seen = new Set(); let rage = false; b.on('rage', () => { rage = true; });
  for (let i = 0; i < 2400; i++) { b.update(1 / 60, i / 60); if (b.view.act) seen.add(b.view.act); }
  ok(rage && b.view.rage, 'rage at 35%');
  ok(seen.size >= 1 && hits.length > 0, 'the AI attacks on its own');
}

console.log(`${n - fails}/${n} ok`);
if (fails) process.exit(1);
