// node tools/demon.test.mjs — 대악마(bf/demon.js + bf/bosses.js 확장 틀): 정의 · 스냅샷 · 처치 · 몸 판정 · 패턴 3종 피해 · 복제 재생 · 허브 등록을 THREE 없이 확인한다.
import { createGiantBoss, createBossHub, KINDS, KIND_LIST, ACTS, HITS } from '../bf/bosses.js';
import { DEMON, quakePoints, riftEnd } from '../bf/demon.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
console.warn = () => {};
const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } }, Quaternion: class {} };
const ME = { ok: true, x: 0, y: 0, z: 0 };
const sounds = [];
const ctxFor = (myId = 'bbb', players = [{ id: 'bbb', x: 0, z: 0, y: 0 }], hits = []) => ({
  THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId, heightAt: () => 0, canStand: () => true, canSwim: () => false, canFly: () => true, waterLevel: () => -5,
  players: () => players, me: () => ME, onHitMe: (h) => hits.push(h), fx: { poof() {}, spark() {}, thump() {}, crown() {} }, sfx: (k, nm) => sounds.push(k + ':' + nm), shake() {}, camPos: () => ({ x: 0, y: 0, z: 0 }),
});
const make = (myId, players, hits) => createGiantBoss(ctxFor(myId, players, hits), 'demon');
const snap = (o = {}) => ({ kd: 'demon', id: 'aaa', n: 1, b: 1000, ep: 0, hp: 4000, mh: 6800, x: 0, z: 0, y: 0, r: 0, a: 'idle', ac: 0, sa: 0, tx: 0, tz: 0, pt: [], f: [], ...o });

// 1) 정의 · 등록
ok(KINDS.demon === DEMON && KIND_LIST.includes('demon'), 'demon is registered');
ok(DEMON.patterns.length >= 3 && DEMON.patterns.every((p) => HITS[p.code]), 'three patterns with damage entries');
ok(['claw', 'rift', 'quake'].every((c) => ACTS.demon.has(c)), 'claw · rift · quake actions');
ok(DEMON.hp >= KINDS.golem.hp && DEMON.hpPerExtra > 0 && !DEMON.fly && !DEMON.water, 'hp on the same scale as the other giants, walks');
for (const a of ACTS.demon) ok(!['i', 'w', 's', 'sw', 'sp', 'wb', 'sm', 'd', 'h'].includes(a), `action ${a} is not a spider code`);
ok(DEMON.ext && ['run', 'anim', 'tick', 'intro', 'sound'].every((k) => typeof DEMON.ext[k] === 'function'), 'extension hooks');
for (const s of ['intro', 'die', 'claw', 'rift', 'quake', 'erupt']) { const calls = []; const f = () => calls.push(1); DEMON.ext.sound(s, { osc: f, noise: f, roar: f, rumble: f }); ok(calls.length > 0, `sound ${s} is synthesised`); }

// 2) 스냅샷 검증
{
  const b = make();
  ok(b.applySnapshot(snap({ hp: NaN }), 'aaa') === false, 'NaN hp refused');
  ok(b.applySnapshot(snap({ kd: 'golem' }), 'aaa') === false, 'another kind refused');
  ok(b.applySnapshot(snap({ a: 'slam' }), 'aaa') === false, 'a golem action is refused');
  ok(b.applySnapshot(snap(), 'aaa') && b.view.active && !b.view.owner && b.view.hp === 4000, 'valid snapshot makes a replica');
}

// 3) 소유자: 생성 → 등장 연출 → 피해 → 처치
{
  sounds.length = 0;
  const b = make('bbb', [{ id: 'bbb', x: 0, z: 0, y: 0 }, { id: 'ccc', x: 1, z: 1, y: 0 }]);
  ok(b.spawn(0, 20, 0) && b.view.maxHp === DEMON.hp + DEMON.hpPerExtra, 'spawn scales hp with players');
  ok(sounds.includes('demon:intro') && b.debug.fxl.length > 0, 'entrance: sound + ground ring');
  ok(b.damage('boss', 0, 10, 'p') === false, 'no damage while rising');
  b.debug.B.spawnT = 0;
  ok(b.damage('boss', 0, 100, 'p') && b.view.hp === b.view.maxHp - 100, 'damage books');
  b.debug.B.hp = 5; b.damage('boss', 0, 10, 'q');
  ok(b.view.dying && b.view.hp === 0 && sounds.includes('demon:die'), 'dies at 0');
}

// 4) 몸 판정 (쉬는 자세 캡슐)
{
  const g = make(); g.spawn(0, 0, 0); g.debug.B.spawnT = 0;
  ok(g.hitTest(0, 0, 0.8, -0.4).length === 1, 'grenade between the legs hits (hips column)');
  ok(g.hitRay(0, 11, 40, 0, 0, -1, 80, 0.1) !== null, 'bullet at the chest hits');
  ok(g.hitRay(0, 13.6, 40, 0, 0, -1, 80, 0.1) !== null, 'bullet at the face hits');
  ok(g.hitRay(-5.6, 6, 40, 0, 0, -1, 80, 0.1) !== null, 'bullet at the clawed hand hits');
  ok(g.hitRay(0, 30, 40, 0, 0, -1, 80, 0.1) === null && g.hitTest(25, 0, 0.8, 0).length === 0, 'open air / ground misses');
}

// 5) 패턴 3종: 시간표대로 내게 피해
function play(code, me, ticks, moveTo) {   // moveTo: 패턴이 시작된 뒤 내가 피한 자리
  const hits = [];
  ME.x = me.x; ME.z = me.z; ME.y = me.y || 0;
  const b = make('bbb', [{ id: 'bbb', x: me.x, z: me.z, y: 0 }], hits);
  b.spawn(0, 0, 0); b.debug.B.spawnT = 0; b.debug.B.a = 'idle';
  const started = b.act(code);
  if (moveTo) { ME.x = moveTo.x; ME.z = moveTo.z; }
  for (let i = 0; i < ticks; i++) b.update(0.05, i * 0.05);
  return { started, hits, b };
}
{
  const c = play('claw', { x: 0, z: -9 }, 45);
  ok(c.started && c.hits.some((h) => h.src === 'claw' && h.boss === 'demon' && h.dmg >= 30), 'claw: rakes me in front');
  const cb = play('claw', { x: 0, z: -9 }, 45, { x: 0, z: 14 });
  ok(!cb.hits.length, 'claw: dodging behind it is safe');
  const r = play('rift', { x: 0, z: -24 }, 70);
  ok(r.started && r.hits.some((h) => h.src === 'rift'), 'rift: the chest beam sweeps over me');
  const rs = play('rift', { x: 0, z: -24 }, 70, { x: 30, z: 6 });
  ok(!rs.hits.some((h) => h.src === 'rift'), 'rift: running off to the side of the sweep is safe');
  const q = play('quake', { x: 0, z: -6 }, 30);
  ok(q.started && q.hits.some((h) => h.src === 'quake'), 'quake: the fist slam hits me close');
  const qj = play('quake', { x: 0, z: -6, y: 6 }, 30);
  ok(!qj.hits.length, 'quake: a high jump clears the slam');
}
{ // 균열 폭발 지점 · 광선 끝점: 시작 자리와 조준만으로 정해진다(모두 같은 곳)
  const a = quakePoints(0, 0, 0, false), b = quakePoints(0, 0, 0, false), rg = quakePoints(0, 0, 0, true);
  ok(a.length === 24 && JSON.stringify(a) === JSON.stringify(b) && rg.length === 40, 'quake points: 3 lines (rage 5), deterministic');
  ok(a.some((p) => Math.abs(p.x) < 0.01 && p.z < -30), 'quake points run along the aim');
  ok(a.every((p, i) => i % 8 === 0 || p.delay > a[i - 1].delay), 'quake: eruptions travel outward');
  const e0 = riftEnd(0, 0, 0, 0, -20, 0, false), e1 = riftEnd(0, 0, 0, 0, -20, 1, false);
  ok(e0.x * e1.x < 0 && Math.abs(Math.hypot(e0.x, e0.z) - 20) < 1e-6, 'rift sweeps across the target at its distance');
}
{ // 복제: 카운터가 바뀌면 같은 패턴을 재생해 내게도 맞는다
  const hits = []; ME.x = 0; ME.z = -24; ME.y = 0;
  const r = make('ccc', [{ id: 'ccc', x: 0, z: -24, y: 0 }], hits);
  r.applySnapshot(snap(), 'aaa');
  r.applySnapshot(snap({ a: 'rift', ac: 1, sa: 0, tx: 0, tz: -24 }), 'aaa');
  ok(r.debug.act.cur && r.debug.act.cur.code === 'rift', 'replica starts the rift');
  for (let i = 0; i < 70; i++) r.update(0.05, i * 0.05);
  ok(hits.some((h) => h.src === 'rift'), 'replica: the beam hits me too');
}

// 6) 허브
{
  const c = ctxFor('bbb');
  const hub = createBossHub({ golem: createGiantBoss(c, 'golem'), demon: createGiantBoss(c, 'demon') });
  ok(hub.kinds.includes('demon'), 'hub lists the demon');
  ok(hub.spawn(0, 20, 0, 'demon') && hub.kind === 'demon' && hub.view.title.includes('대악마'), 'hub spawns the demon');
  ok(hub.spawn(0, 20, 0, 'golem') === false, 'one boss at a time');
}

console.log(`${n - fails}/${n} demon checks passed`);
process.exit(fails ? 1 : 0);
