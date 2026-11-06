// node tools/solids.test.mjs — headless check of bf/solids.js with the real kit controller (mock avatar, flat ground y = 0).
import assert from 'node:assert/strict';
import { createSolids } from '../bf/solids.js';
import { createController, TUNING } from '../bf/kit/controller.js';

const mockAvatar = () => ({ root: { position: { set() {} }, rotation: { y: 0 } }, model: null, shadow: null, scale: 1, play() {}, update() {} });
function world(shapes) {
  const sol = createSolids({ margin: 0.2, step: TUNING.stepUp, reach: 2.0, baseAt: () => 0 });
  sol.set('t', shapes);
  const ctrl = createController({
    avatar: mockAvatar(), input: 'none', keyTarget: { addEventListener() {}, removeEventListener() {} }, spawn: { x: 0, z: 0, ry: 0 },
    groundY: (x, z, y) => Math.max(0, sol.topAt(x, z, y)), blocked: (x, z, y) => sol.blockedAt(x, z, y),
  });
  return { sol, ctrl };
}
const DT = 1 / 60;
function run(ctrl, secs, fn) { for (let t = 0; t < secs; t += DT) { if (fn) fn(t); ctrl.update(DT, 0); } return ctrl.state; }
const fwd = (ctrl, on = true) => ctrl.setStick(0, on ? -0.9 : 0);   // camera yaw 0: forward = -z; 0.9 of the stick walks (>= 0.92 runs)
const at = (ctrl, x, z) => ctrl.teleport(x, z, 0);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', n, name); };

ok('unit: step rule, margin, wall, pushOut', () => {
  const s = createSolids({ margin: 0.2, step: 0.4, reach: 2, baseAt: () => 0 });
  s.set('a', [{ type: 'circle', x: 0, z: 0, r: 1, h: 0.3 }, { type: 'circle', x: 5, z: 0, r: 1, h: 1.0 }, { type: 'circle', x: 10, z: 0, r: 1, h: 2.4 }, { type: 'circle', x: 15, z: 0, r: 1 }, { type: 'circle', x: 20, z: 0, r: 1, h: 0.02 }, { type: 'box', x0: 30, x1: 32, z0: 0, z1: 2, h: 1 }]);
  assert.equal(s.count, 5, 'a flat shape is dropped');
  assert.equal(s.blockedAt(0, 0, 0), false, 'a 0.3 step is walked up');
  assert.equal(s.topAt(0, 0, 0), 0.3);
  assert.equal(s.blockedAt(5, 0, 0), true, 'a 1 m rock blocks a body on the ground');
  assert.equal(s.blockedAt(5, 0, 0.7), false, 'but not one that is high enough');
  assert.equal(s.topAt(5, 0, 0.7), 1.0);
  assert.equal(s.topAt(5, 0, 0), -Infinity, 'nothing to stand on from below');
  assert.equal(s.blockedAt(1.19, 0, 0.0), false, 'a 0.3 step: free'); assert.equal(s.blockedAt(6.19, 0, 0), true); assert.equal(s.blockedAt(6.21, 0, 0), false, 'margin is 0.2');
  assert.equal(s.blockedAt(10, 0, 1.9), true, 'taller than reach is a wall for everyone');
  assert.equal(s.topAt(10, 0, 5), -Infinity);
  assert.equal(s.blockedAt(15, 0, 5), true, 'no height = wall');
  assert.equal(s.blockedAt(31, 1, 0), true, 'boxes work');
  const p = s.pushOut(5.5, 0, 0); assert.ok(p && Math.hypot(p.x - 5, p.z) > 1.2 && !s.blockedAt(p.x, p.z, 0), 'pushed out of the footprint');
  assert.equal(s.pushOut(50, 50, 0), null);
  assert.equal(s.blockedAt(5, 0, undefined), true, 'y omitted: everything blocks');
});

ok('walks into a tall prop: stops at its edge, never inside', () => {
  const { ctrl } = world([{ type: 'circle', x: 0, z: -5, r: 1, h: 3 }]);
  at(ctrl, 0, 0); fwd(ctrl); let minD = 9;
  run(ctrl, 4, () => { const s = ctrl.state; minD = Math.min(minD, Math.hypot(s.x, s.z + 5)); });
  assert.ok(minD >= 1.2 - 0.02, 'closest approach ' + minD);
  assert.ok(Math.abs(ctrl.state.y) < 1e-6, 'stayed on the ground');
});

ok('low prop (0.3): walked over, stood on, left again', () => {
  const { ctrl } = world([{ type: 'circle', x: 0, z: -3, r: 0.5, h: 0.3 }]);
  at(ctrl, 0, 0); fwd(ctrl); let top = false;
  run(ctrl, 3, () => { if (Math.abs(ctrl.state.y - 0.3) < 1e-3) top = true; });
  assert.ok(top, 'went over the top'); assert.ok(ctrl.state.z < -3.5 && Math.abs(ctrl.state.y) < 1e-3, 'came down the far side');
});

ok('jump onto a 0.5 log with a run-up: stands there, no jitter', () => {
  const { ctrl } = world([{ type: 'box', x0: -1, x1: 1, z0: -5, z1: -4.4, h: 0.5 }]);
  at(ctrl, 0, -2.5); fwd(ctrl); let jumped = false;
  run(ctrl, 2, () => { const s = ctrl.state; if (!jumped && s.z < -3.2) { ctrl.press('jump'); jumped = true; } if (jumped && s.grounded && s.y > 0.4) fwd(ctrl, false); });
  fwd(ctrl, false); run(ctrl, 1);
  const ys = []; run(ctrl, 1, () => ys.push(ctrl.state.y));
  assert.ok(Math.abs(ctrl.state.y - 0.5) < 1e-3, 'y ' + ctrl.state.y); assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-6, 'steady'); assert.equal(ctrl.state.grounded, true);
});

ok('1.4 m rock: a plain walk is blocked, a jump gets on, then walk across the top and off the far side', () => {
  const shapes = [{ type: 'circle', x: 0, z: -4, r: 1.2, h: 1.4 }];
  { const { ctrl } = world(shapes); at(ctrl, 0, 0); fwd(ctrl); run(ctrl, 3); assert.ok(Math.abs(ctrl.state.y) < 1e-6 && ctrl.state.z > -4 + 1.4 - 0.05, 'blocked at the side'); }
  const { ctrl } = world(shapes); at(ctrl, 0, -1.5); fwd(ctrl); let j = false, onTop = false, zOnTop = 0;
  run(ctrl, 2.2, () => { const s = ctrl.state; if (!j && s.z < -2.0) { ctrl.press('jump'); j = true; } if (Math.abs(s.y - 1.4) < 1e-3) { onTop = true; zOnTop = s.z; } });
  assert.ok(onTop, 'stood on the rock (max y ' + ctrl.state.y + ')');
  run(ctrl, 3);   // keep walking forward: across the top, off the far edge, down
  assert.ok(ctrl.state.z < -5.4 && Math.abs(ctrl.state.y) < 1e-3, 'walked off the far side to the ground: z ' + ctrl.state.z + ' y ' + ctrl.state.y);
});

ok('1.9 m rock: a single jump is not enough, a double jump is', () => {
  const shapes = [{ type: 'circle', x: 0, z: -4, r: 1.2, h: 1.9 }];
  const attempt = (double) => {
    const { ctrl } = world(shapes); at(ctrl, 0, -1.5); fwd(ctrl); let j = false, d = false, top = false;
    run(ctrl, 2.5, () => { const s = ctrl.state;
      if (!j && s.z < -2.2) { ctrl.press('jump'); j = true; }
      if (double && j && !d && s.y > 0.9 && s.grounded === false) { ctrl.press('jump'); d = true; }
      if (Math.abs(s.y - 1.9) < 1e-3) top = true; });
    return top;
  };
  assert.equal(attempt(false), false, 'single jump'); assert.equal(attempt(true), true, 'double jump');
});

ok('2.3 m prop is a wall even with a double jump', () => {
  const { ctrl } = world([{ type: 'circle', x: 0, z: -4, r: 1.2, h: 2.3 }]);
  at(ctrl, 0, -1.5); fwd(ctrl); let j = false, d = false, maxY = 0, minD = 9;
  run(ctrl, 3, () => { const s = ctrl.state; maxY = Math.max(maxY, s.y); minD = Math.min(minD, Math.hypot(s.x, s.z + 4));
    if (!j && s.z < -2.2) { ctrl.press('jump'); j = true; } if (j && !d && s.y > 0.9 && !s.grounded) { ctrl.press('jump'); d = true; } });
  assert.ok(minD >= 1.4 - 0.02, 'never inside: ' + minD); assert.ok(maxY < 2.3);
});

ok('slides along a wall instead of sticking, and no wall crossing over many random runs', () => {
  const shapes = [{ type: 'box', x0: -3, x1: 3, z0: -6, z1: -5, h: 3 }, { type: 'circle', x: 5, z: -3, r: 0.8, h: 1.0 }, { type: 'circle', x: -5, z: -3, r: 0.8, h: 3 }];
  const { sol, ctrl } = world(shapes);
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let bad = 0, jumps = 0;
  for (let k = 0; k < 40; k++) {
    at(ctrl, (rnd() - 0.5) * 16, 2 + rnd() * 2);
    let heading = rnd() * Math.PI * 2, tt = 0;
    run(ctrl, 6, (t) => {
      if (t - tt > 0.5) { tt = t; heading += (rnd() - 0.5) * 2; if (rnd() < 0.3) { ctrl.press('jump'); jumps++; } if (rnd() < 0.1) ctrl.press('dash'); if (rnd() < 0.1) ctrl.press('roll'); }
      ctrl.setStick(Math.cos(heading), Math.sin(heading));
      const s = ctrl.state; if (sol.blockedAt(s.x, s.z, s.y) && s.grounded) bad++;
    });
  }
  assert.equal(bad, 0, 'frames spent inside a footprint');
  assert.ok(jumps > 20);
});

ok('standing on a prop whose neighbour is taller than a step: that side blocks', () => {
  const { ctrl } = world([{ type: 'box', x0: -1, x1: 1, z0: -1, z1: 1, h: 0.6 }, { type: 'box', x0: -1, x1: 1, z0: -3, z1: -1.2, h: 1.6 }]);
  ctrl.teleport(0, 0, 0); assert.ok(Math.abs(ctrl.state.y - 0.6) < 1e-6, 'teleport lands on the top: ' + ctrl.state.y);
  fwd(ctrl); run(ctrl, 2); assert.ok(ctrl.state.z > -1.05 && Math.abs(ctrl.state.y - 0.6) < 1e-3, 'stopped at the tall one: z ' + ctrl.state.z + ' y ' + ctrl.state.y);
});
console.log('all', n, 'passed');
