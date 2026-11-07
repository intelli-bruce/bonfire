// node tools/spider.test.mjs — bf/spider.js 의 소유자·복제본 로직(스냅샷 검증, 소유권 경쟁, 피해, 거미줄 감속, 타격 판정)을 THREE 없이 확인한다.
// 모델 로딩(three/addons)은 node 에서 실패하므로 모든 검사는 동기 구간(로딩 실패 처리 전)에서 한다.
import { createSpiderBoss, BOSS } from '../bf/spider.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
console.warn = () => {};

const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } }, Quaternion: class {} };
function make(myId = 'bbb', players = [{ id: 'bbb', x: 0, z: 0, y: 0 }]) {
  const ev = [];
  const sp = createSpiderBoss({
    THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId, heightAt: () => 0, canStand: () => true,
    players: () => players, me: () => ({ ok: true, x: 0, y: 0, z: 0 }), pushMe() {}, onHitMe: (h) => ev.push(h),
    fx: { poof() {}, spark() {}, thump() {} },
  });
  return { sp, ev };
}
const snap = (o = {}) => ({ id: 'aaa', n: 1, b: 1000, ep: 0, hp: 400, mh: 480, x: 5, z: 6, r: 1, a: 'i', ac: 0, sa: 0, wt: null, w: [], m: [], ...o });

// 1) a valid snapshot makes a replica; garbage is refused
{
  const { sp } = make();
  ok(sp.applySnapshot(snap({ hp: NaN }), 'aaa') === false, 'NaN hp refused');
  ok(sp.applySnapshot(snap({ x: 1e6 }), 'aaa') === true && sp.debug.R.tx === 90, 'out-of-range x is clamped to the world, not fatal');
  sp.despawn();
  ok(sp.applySnapshot(snap({ a: 'zz' }), 'aaa') === false, 'unknown anim code refused');
  ok(!sp.active, 'nothing active after refusals');
  ok(sp.applySnapshot(snap(), 'aaa') === true, 'valid snapshot accepted');
  const v = sp.view;
  ok(v.active && !v.owner && v.hp === 400 && v.maxHp === 480 && sp.ownerId === 'aaa', 'replica state: active, not owner, hp, ownerId');
  ok(sp.snapshot() === null, 'a replica never streams');
  ok(sp.damage('boss', 0, 10, 'x') === false, 'a replica does not book damage');
}
// 2) lists are validated (bad entries dropped, caps applied)
{
  const { sp } = make();
  sp.applySnapshot(snap({ w: [[1, 0, 0, 1], [2, 'x', 0, 1], 'bad', ...Array(20).fill([3, 1, 1, 1])], m: [[1, 1, 1, 0, 20, 'w'], [2, 1, 1, 0, 20, 'q'], [3, 2, 2, 0, 20, 'k']] }), 'aaa');
  const d = sp.debug.B;
  ok(d.webs.length <= 7 && d.webs.every((w) => Number.isFinite(w.x)), 'webs capped and sane');
  ok(d.minions.length === 2 && d.minions.every((m) => ['i', 'w', 'k'].includes(m.a)), 'minions: bad anim code dropped');
}
// 3) ownership: higher epoch wins, same epoch -> earlier birth, then smaller id; stale ones are ignored
{
  const { sp } = make();
  sp.applySnapshot(snap({ ep: 0, b: 1000 }), 'ccc');
  ok(sp.ownerId === 'ccc', 'first owner');
  ok(sp.applySnapshot(snap({ ep: 0, b: 2000 }), 'ddd') === false && sp.ownerId === 'ccc', 'later birth at the same epoch loses');
  ok(sp.applySnapshot(snap({ ep: 0, b: 1000 }), 'ddd') === false && sp.ownerId === 'ccc', 'same birth: larger id loses');
  ok(sp.applySnapshot(snap({ ep: 0, b: 1000 }), 'aaa') === true && sp.ownerId === 'aaa', 'same birth: smaller id wins');
  ok(sp.applySnapshot(snap({ ep: 1, b: 1000 }), 'zzz') === true && sp.ownerId === 'zzz', 'higher epoch (takeover) wins');
  ok(sp.applySnapshot(snap({ ep: 0, b: 1 }), 'aaa') === false && sp.ownerId === 'zzz', 'lower epoch ignored');
}
// 4) the owner: spawn, stream, damage rules, a rival outranking it
{
  const { sp } = make('bbb');
  ok(sp.spawn(0, 0, 0) === true && sp.owner && sp.view.hp === BOSS.hp, 'spawn: owner with full hp');
  ok(sp.spawn(1, 1, 0) === false, 'cannot spawn twice');
  const dbg = sp.debug;
  dbg.B.spawnT = 0;   // past the rise
  for (let i = 1; i <= 8; i++) dbg.B.minions.push({ id: i, x: i, z: i, ry: 0, hp: 20, a: 'w' });
  for (let i = 1; i <= 7; i++) dbg.B.webs.push({ id: i, x: i, z: i, age: 1 });
  const s = sp.snapshot();
  ok(s && s.id === 'bbb' && s.n === 1 && s.m.length === 8 && s.w.length === 7, 'snapshot content');
  ok(JSON.stringify(s).length < 1500, `snapshot fits the 2048-byte inbound limit (${JSON.stringify(s).length} B)`);
  ok(sp.snapshot().n === 2, 'sequence number grows');
  ok(sp.damage('boss', 0, 10, 'p1') === true && sp.view.hp === BOSS.hp - 10, 'a hit takes 10');
  ok(sp.damage('boss', 0, 10, 'p1') === false, 'same attacker inside the cooldown is ignored');
  ok(sp.damage('boss', 0, 999, 'p2') === true && sp.view.hp === BOSS.hp - 10 - 25, 'one hit is capped at 25');
  ok(sp.damage('minion', 3, 10, 'p1') === true && dbg.B.minions.find((m) => m.id === 3).hp === 10, 'minion takes damage');
  dbg.B.hp = 5; dbg.O.hitAt.clear();
  ok(sp.damage('boss', 0, 10, 'p3') === true && sp.view.dying && sp.view.hp === 0, 'death: hp 0, dying');
  ok(sp.damage('boss', 0, 10, 'p4') === false, 'no damage after death');
}
{
  const { sp } = make('bbb');
  sp.spawn(0, 0, 0);
  ok(sp.damage('boss', 0, 10, 'p1') === false, 'invulnerable while rising');
  ok(sp.applySnapshot(snap({ ep: 0, b: sp.view.born + 5 }), 'aaa') === false && sp.owner, 'a later-born rival does not take my boss');
  ok(sp.applySnapshot(snap({ ep: 0, b: sp.view.born - 5 }), 'aaa') === true && !sp.owner && sp.ownerId === 'aaa', 'an earlier-born rival outranks me: I yield');
}
// 5) webs slow only inside the circle; hit tests
{
  const { sp } = make();
  sp.applySnapshot(snap({ x: 20, z: 20, w: [[1, 3, 3, 1]] }), 'aaa');
  ok(sp.slowAt(3, 3) === BOSS.web.slow, 'slow inside a web');
  ok(sp.slowAt(3 + BOSS.web.radius + 0.5, 3) === 1, 'no slow outside');
  const dbg = sp.debug; dbg.B.spawnT = 0;
  ok(sp.hitTest(20, 20, 0.85, 0).some((h) => h.kind === 'boss'), 'punch on the body hits the boss');
  ok(!sp.hitTest(40, 40, 0.85, 0).length, 'punch far away hits nothing');
  dbg.B.minions.push({ id: 9, x: 30, z: 30, ry: 0, hp: 20, a: 'i' });
  ok(sp.hitTest(30.3, 30, 0.85, 0).some((h) => h.kind === 'minion' && h.id === 9), 'punch on a minion hits it');
}

console.log(`${n - fails}/${n} spider checks passed`);
process.exit(fails ? 1 : 0);
