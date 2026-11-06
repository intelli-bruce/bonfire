// bf/kit/controller.js — responsive avatar controller: fixed-step physics, buffered actions, animation selection,
// compact presence payload (netState) and remote reproduction (applyNet) with the cathedral counter rule.
// Optional water ({ level, surface(x, z) }): wading in the shallows, swimming at the surface once it gets deep.
// Combat feel: overhead chop (alternating hands, onStrike at the contact frame), knock(dx, dz) (a hit: shove + small hop), a second jump in the air,
// a flying roll out of a jump, rolls that chain almost back to back, and a dash that sprints leaned forward.
// No THREE import: works on avatar.root (an Object3D) and plain numbers.
import { SIT_HIP } from './avatar.js';

export const TUNING = {
  step: 1 / 120,            // physics fixed step (s)
  walk: 2.6, run: 5.6, crawl: 0.9,
  accel: 60, decel: 45,     // m/s² on the ground (≈0.1 s to full speed)
  airAccel: 14, airDrag: 0.4,
  turn: 16, crawlTurn: 5,   // facing turn rate (rad/s)
  gravity: 22, jumpV: 7.0,  // apex ≈1.1 m, ≈0.64 s airtime; running jump keeps horizontal momentum (≈3.6 m)
  coyote: 0.1, jumpBuffer: 0.12, actionBuffer: 0.3,
  dashDist: 4.6, dashDur: 0.3, dashCooldown: 0.5, dashJumpWindow: 0.15, dashLean: -0.32,   // dashLean: forward tilt (rad, model X) while dashing
  leapV: 5.0, leapSpeed: 10, leapGravity: 18, leapAirAccel: 6,
  rollDist: 2.2, rollDur: 0.28, rollLock: 0.05, rollChain: 0.2, rollCooldown: 0,   // the next roll may start rollChain s into this one (was 0.33 s lock + 0.15 s cooldown)
  airRollV0: 13, airRollV1: 8.5, airRollLift: 3.2, airRollGravity: 14,             // roll out of a jump: launched far along the heading, once per jump
  airJumps: 1, doubleJumpV: 6.4, doubleJumpGap: 0.1,                              // extra jumps in the air
  punchDur: 0.46, punchCooldown: 0.34, punchHit: 0.23, punchMove: 0.5,            // overhead chop: arm up, then down; contact frame at punchHit; walking speed factor while chopping
  knockSpeed: 5.4, knockHop: 3.4,
  landDur: 0.1, proneIn: 0.3, proneOut: 0.28,
  waveDur: 1.6, cheerDur: 1.2, nodDur: 1.33,
  stepUp: 0.4, snapDown: 0.35,
  // water (depth = still level - ground): wade from wadeIn, swim from swimIn (back on foot below swimOut); swimSink: root below the surface
  wadeIn: 0.12, wadeSlow: 0.55, swimIn: 0.8, swimOut: 0.62, swimSink: 0.6,
  swim: 2.2, swimFast: 3.5, swimAccel: 12, swimDecel: 6, swimTurn: 8, swimJumpV: 4.6, swimDashDist: 2.2,
  // diving: hold to sink (diveSink m/s), let go to float up (diveRise m/s); max depth below the surface; feet stay diveClear above the seabed;
  // a jump or fall into the sea plunges by (impact speed - plungeV0) * plungeK, at most plungeMax
  diveSink: 2.0, diveRise: 2.6, diveSurge: 5.0, diveMax: 6.5, diveClear: 0.55, plungeV0: 2.5, plungeK: 1.0, plungeMax: 6.5, plungeDrag: 9,
  netDelay: 100,            // remote interpolation buffer (ms)
};
const P = TUNING;

// presence codes
const ACT_CODE = { jump: 'j', djump: 'j2', dash: 'd', leap: 'dj', roll: 'r', sit: 's', prone: 'p', wave: 'w', dance: 'dn', cheer: 'ch', nod: 'nd', punch: 'pu', punchL: 'pl' };
const CODE_ACT = Object.fromEntries(Object.entries(ACT_CODE).map(([k, v]) => [v, k]));
// l: 0 idle 1 walk 2 run 3 rising 4 falling 5 leap 6 sit(ground) 7 sit(seat) 8 prone 9 crawl 10 dance 11 dash 12 roll 13 tread 14 swim
// w (water): omitted on land, 1 wading, 2 swimming
const ONE_SHOT_DUR = () => ({ dash: P.dashDur, roll: P.rollDur, wave: P.waveDur, cheer: P.cheerDur, nod: P.nodDur, punch: P.punchDur, punchL: P.punchDur });
const NO_SWIM = new Set(['sit', 'prone', 'roll', 'dance', 'cheer', 'nod', 'punch', 'punchL']);   // need footing

const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const r2 = (v) => Math.round(v * 100) / 100;

export function createController({
  avatar, groundY = () => 0, blocked = () => false, camera = null, input = 'keyboard',
  spawn = { x: 0, z: 0, ry: 0 }, onAction = null, keyTarget = window, clock = () => performance.now(), water = null,
  onStrike = null,      // local: my punch reached its contact frame ('punch' | 'punchL')
  onRemoteAct = null,   // remote: a one-shot action of that avatar starts on the delayed timeline
} = {}) {
  const sy = spawn.y ?? groundY(spawn.x || 0, spawn.z || 0);
  const s = {                                   // authoritative physics state
    x: spawn.x || 0, y: sy, z: spawn.z || 0, ry: spawn.ry || 0,
    vx: 0, vy: 0, vz: 0, grounded: true, speed: 0,
    act: null, actT: 0, actDur: 0, dir: 0, vEnd: 0, v0: 0,
    seat: null, airDashUsed: false, lastGround: 0, jumpedAt: -9, dashEnd: -9, dashGround: false,
    dashReady: 0, rollReady: 0, time: 0, counter: 0, lastCode: '', key: 0,
    swim: 0, splash: 0, plunge: 0,              // water state (0 land, 1 wading, 2 swimming); splash counts entries into deep water; plunge = impact speed of the last entry from the air
    dive: 0, diveV: 0, plungeV: 0, plungeFresh: false, diveKey: false, diveBtn: false,   // metres below the swim surface, its rate, plunge speed (decays), hold-to-sink (key C / button)
    airJumps: 0, airRoll: false, rollAir: false, punchReady: 0, punchSide: 0, struck: true,
  };
  const prev = { x: s.x, y: s.y, z: s.z };
  const vis = { ox: 0, oy: 0, oz: 0, yaw: s.ry };
  let acc = 0, buffered = null, lastLanded = -9, airPeak = s.y;
  const keys = new Set();
  let stick = { x: 0, y: 0, on: false };
  let camYawLast = 0, leanCur = 0, poseName = null, poseKey = 0;   // poseName: page-chosen seated pose (fishing)
  // remote mode
  let remote = false, samples = [], events = [], offs = null, rAs, rL = 0, rSeat = null, rLastT = -1, rWrap = 0, rSpeed = 0, rPrevPos = null, rAir = false, rW = 0;

  // ------------------------------------------------------------ water
  // groundY(x, z, y): y = the body height, so a pier deck counts only for someone standing on it (not for a swimmer under it)
  const depthAt = (x, z) => (water ? water.level - groundY(x, z, s.y) : 0);
  // what the body rests on: the ground, or (deep enough to swim) the swell surface minus swimSink (and minus the dive depth)
  function floorAt(x, z) {
    const g = groundY(x, z, s.y); if (!water) return g;
    if (water.level - g >= (s.swim === 2 ? P.swimOut : P.swimIn)) {
      const top = water.surface(x, z) - P.swimSink;
      return Math.max(g + (s.dive > 0.05 ? P.diveClear : 0), top - s.dive, g);
    }
    return g;
  }
  function updateWater() {
    if (!water) return;
    const d = depthAt(s.x, s.z), was = s.swim;
    if (!s.grounded) return;                             // in the air nothing changes (a leap out of the water stays a swimmer) until touch-down
    s.swim = d >= (was === 2 ? P.swimOut : P.swimIn) ? 2 : d > P.wadeIn ? 1 : 0;
    if (s.swim !== 2) { s.dive = 0; s.diveV = 0; s.plungeV = 0; }
    if (s.swim === 2 && was !== 2) {
      s.splash++; if (!s.plungeFresh) s.plunge = 0; s.plungeFresh = false;   // plunge = impact speed only when this entry came from the air
      if (s.act && s.act !== 'dash' && s.act !== 'wave') { s.act = null; s.key++; }   // postures, rolls, emotes end in deep water
      const sp = Math.hypot(s.vx, s.vz); if (sp > P.swimFast) { s.vx *= P.swimFast / sp; s.vz *= P.swimFast / sp; }
    }
  }

  // ------------------------------------------------------------ input
  const KEYMAP = { KeyQ: 'dash', Space: 'jump', KeyC: 'roll', KeyF: 'punch', KeyX: 'sit', KeyZ: 'prone', KeyV: 'wave', Digit1: 'dance', Digit2: 'cheer', Digit3: 'nod' };
  const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
  const typing = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
  function onKeyDown(e) {
    if (typing(e)) return;
    if (MOVE.has(e.code)) { keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); return; }
    if (e.code === 'KeyC') s.diveKey = true;                  // hold C in deep water to dive (C is the roll everywhere else)
    const a = KEYMAP[e.code]; if (!a) return;
    if (e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    press(a);
  }
  function onKeyUp(e) { keys.delete(e.code); if (e.code === 'KeyC') s.diveKey = false; }
  function onBlur() { keys.clear(); s.diveKey = false; }
  if (input === 'keyboard') {
    keyTarget.addEventListener('keydown', onKeyDown); keyTarget.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur);
  }
  function moveInput(camYaw) {
    let f = 0, r = 0, run = keys.has('ShiftLeft') || keys.has('ShiftRight'), mag = 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
    if (stick.on && (stick.x || stick.y)) {
      f = -stick.y; r = stick.x; const m = Math.hypot(f, r); mag = Math.min(1, m); run = run || m >= 0.92;
      if (m > 0) { f /= m; r /= m; }
    } else { const m = Math.hypot(f, r); if (m > 0) { f /= m; r /= m; } }
    if (!f && !r) return { x: 0, z: 0, mag: 0, run };
    const sn = Math.sin(camYaw), cs = Math.cos(camYaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    return { x: -sn * f + cs * r, z: -cs * f - sn * r, mag: mag < 0.25 ? 0.25 : mag, run };
  }

  // ------------------------------------------------------------ actions
  function bump(act) { s.counter++; s.lastCode = ACT_CODE[act] || ''; onAction && onAction(act, s.counter); }
  function setAct(act, dur = 0) { s.act = act; s.actT = 0; s.actDur = dur; s.key++; }
  const locked = () => {
    if (s.act === 'dash') return P.dashDur - s.actT;            // only jump cancels a ground dash (→ dash-jump)
    if (s.act === 'roll' && s.actT < P.rollLock) return P.rollLock - s.actT;
    if (s.act === 'proneIn' || s.act === 'proneOut') return s.actDur - s.actT;
    return 0;
  };
  let lastMove = { x: 0, z: 0, mag: 0, run: false };
  const facingDir = () => (lastMove.mag > 0 ? Math.atan2(-lastMove.x, -lastMove.z) : s.ry);
  const punching = () => s.act === 'punch' || s.act === 'punchL';
  const canJumpNow = () => s.grounded || (s.time - s.lastGround <= P.coyote && s.jumpedAt < s.lastGround);

  // Returns true if started now; otherwise buffers.
  function press(a) {
    if (remote) return false;
    if (s.swim === 2 && NO_SWIM.has(a)) return false;      // not buffered either: nothing fires on the way out of the water
    lastMove = moveInput(camYawLast);
    if (a === 'punch') s.punchDir = camYawLast;   // a chop goes where the camera looks
    const ok = tryStart(a);
    if (!ok) {
      const lock = locked();
      const win = a === 'jump' ? Math.max(P.jumpBuffer, lock + P.jumpBuffer) : Math.max(P.actionBuffer, lock + 0.12);
      buffered = { a, until: s.time + win };
    } else buffered = null;
    return ok;
  }
  function tryStart(a) {
    if (s.swim === 2 && NO_SWIM.has(a)) return false;      // a buffered Z/X from the shallows must not start after landing in deep water
    // sit / prone toggles and stand-ups
    if (s.act === 'sit') {
      if (a === 'sit' || a === 'jump') { standUp(); return true; }
      standUp();                                         // any other action: stand and do it at once
    }
    if (s.act === 'prone') {
      if (a === 'prone' || a === 'jump') { setAct('proneOut', P.proneOut); bump('prone'); return true; }
      setAct('proneOut', P.proneOut); return false;      // stand up first; the action is buffered and runs right after
    }
    if (a === 'jump') {
      // dash-jump: during a ground dash or within the window after it
      if (s.swim !== 2 && ((s.act === 'dash' && s.dashGround) || (s.act !== 'dash' && s.time - s.dashEnd <= P.dashJumpWindow && s.dashGround && canJumpNow()))) {
        const d = s.dir;
        s.vx = -Math.sin(d) * P.leapSpeed; s.vz = -Math.cos(d) * P.leapSpeed; s.vy = P.leapV;
        s.grounded = false; s.jumpedAt = s.time; s.ry = d; s.dashEnd = -9;
        setAct('leap'); bump('leap'); return true;
      }
      if (locked() > 0) return false;
      if (s.swim === 2 && s.grounded && s.dive > 0.35) { s.plungeV = 0; s.diveV = -P.diveSurge; return true; }   // under water Space = swim up (no buoyancy wait)
      if (!canJumpNow()) {
        // second jump in the air (not in deep water; a short gap after the first so a double tap is not both at once)
        if (s.swim === 2 || s.grounded || s.airJumps >= P.airJumps || s.time - s.jumpedAt < P.doubleJumpGap) return false;
        s.airJumps++; s.vy = P.doubleJumpV; s.jumpedAt = s.time;
        if (s.act === 'roll' || s.act === 'leap' || s.act === 'land' || punching() || isEmote(s.act)) s.act = null;
        bump('djump'); s.key++; return true;
      }
      if (s.act === 'roll' || s.act === 'land' || punching() || isEmote(s.act)) s.act = null;
      s.vy = s.swim === 2 ? P.swimJumpV : P.jumpV; s.grounded = false; s.jumpedAt = s.time;   // in deep water: a small leap and splash
      bump('jump'); s.key++; return true;
    }
    if (locked() > 0) return false;
    if (a === 'dash') {
      if (s.time < s.dashReady) return false;
      if (!s.grounded && (s.airDashUsed || s.act === 'leap')) return false;
      const d = facingDir();
      s.dir = d; s.ry = d; s.dashGround = s.grounded;
      if (!s.grounded) { s.airDashUsed = true; s.vy = 0; }
      const sw = s.swim === 2 && s.grounded;               // in the water: a short burst from swimming speed
      s.vEnd = lastMove.mag > 0 ? (sw ? (lastMove.run ? P.swimFast : P.swim) : (lastMove.run ? P.run : P.walk)) * lastMove.mag : (sw ? 0.8 : 1.5);
      s.v0 = 2 * (sw ? P.swimDashDist : P.dashDist) / P.dashDur - s.vEnd;
      s.dashReady = s.time + P.dashCooldown;
      setAct('dash', P.dashDur); bump('dash'); return true;
    }
    if (a === 'roll') {
      if (s.act === 'roll' && s.actT < P.rollChain) return false;       // chained rolls: the next one may start late in this one
      if (!s.grounded) {                                               // flying roll out of a jump: launched far along the heading, once per jump
        if (s.airRoll || s.swim === 2 || s.act === 'dash') return false;
        const hs = Math.hypot(s.vx, s.vz);
        const d = lastMove.mag > 0 ? facingDir() : (hs > 1 ? Math.atan2(-s.vx, -s.vz) : s.ry);
        s.dir = d; s.ry = d; s.rollAir = true; s.airRoll = true;
        s.v0 = P.airRollV0; s.vEnd = P.airRollV1; s.vy = Math.max(s.vy, P.airRollLift);
        setAct('roll', P.rollDur); bump('roll'); return true;
      }
      if (s.time < s.rollReady) return false;
      const d = facingDir(); s.dir = d; s.ry = d; s.rollAir = false;
      s.vEnd = lastMove.mag > 0 ? P.run : 1;
      s.v0 = Math.max(s.vEnd * 0.6, 2 * P.rollDist / P.rollDur - s.vEnd);
      setAct('roll', P.rollDur); bump('roll'); return true;
    }
    if (a === 'punch') {
      if (s.time < s.punchReady) return false;
      if (s.act === 'roll' && s.actT < P.rollChain) return false;
      const nm = s.punchSide ? 'punchL' : 'punch'; s.punchSide ^= 1;
      s.punchReady = s.time + P.punchCooldown; s.struck = false;
      if (s.punchDir !== undefined) s.ry = s.punchDir;
      setAct(nm, P.punchDur); bump(nm); return true;
    }
    if (!s.grounded) return false;                       // postures and emotes need the ground
    if (a === 'sit') { s.vx = s.vz = 0; s.seat = null; setAct('sit'); bump('sit'); return true; }
    if (a === 'prone') { s.vx *= 0.3; s.vz *= 0.3; setAct('proneIn', P.proneIn); bump('prone'); return true; }
    if (a === 'wave' || a === 'cheer' || a === 'nod') { setAct(a, ONE_SHOT_DUR()[a]); bump(a); return true; }
    if (a === 'dance') { if (s.act === 'dance') { s.act = null; return true; } setAct('dance'); bump('dance'); return true; }
    return false;
  }
  const isEmote = (a) => a === 'wave' || a === 'cheer' || a === 'nod' || a === 'dance';

  function sitAt(x, y, z, ry, id) {
    if (remote) return;
    const vx0 = s.x + vis.ox, vy0 = s.y + vis.oy, vz0 = s.z + vis.oz;
    s.x = x; s.z = z; s.y = y - SIT_HIP * avatar.scale; s.ry = ry; s.vx = s.vy = s.vz = 0; s.grounded = true;
    prev.x = s.x; prev.y = s.y; prev.z = s.z;
    vis.ox = vx0 - s.x; vis.oy = vy0 - s.y; vis.oz = vz0 - s.z;      // slide into the seat visually
    s.seat = { x, y, z, ry, id: id ?? 1 };
    setAct('sit'); bump('sit');
  }
  function standUp() {
    if (s.act !== 'sit' && s.act !== 'prone') return;
    if (s.act === 'prone') { setAct('proneOut', P.proneOut); return; }
    const vx0 = s.x + vis.ox, vy0 = s.y + vis.oy, vz0 = s.z + vis.oz;
    if (s.seat) {   // step off the seat to a free spot (forward first)
      const cand = [0, 0.6, -0.6, 1.2, -1.2, Math.PI];
      let done = false;
      for (const dist of [0.65, 0.95, 1.3]) {
        for (const da of cand) {
          const a = s.seat.ry + da, nx = s.seat.x - Math.sin(a) * dist, nz = s.seat.z - Math.cos(a) * dist;
          if (!blocked(nx, nz)) { s.x = nx; s.z = nz; done = true; break; }
        }
        if (done) break;
      }
      s.y = groundY(s.x, s.z, s.y);
      prev.x = s.x; prev.y = s.y; prev.z = s.z;
      vis.ox = vx0 - s.x; vis.oy = vy0 - s.y; vis.oz = vz0 - s.z;
    }
    s.seat = null; s.act = null; s.key++;
  }

  // ------------------------------------------------------------ physics
  function moveH(dx, dz) {
    const nx = s.x + dx; let hit = false;
    if (dx) { if (blocked(nx, s.z) || groundY(nx, s.z, s.y) > s.y + P.stepUp) { s.vx = 0; hit = true; } else s.x = nx; }
    const nz = s.z + dz;
    if (dz) { if (blocked(s.x, nz) || groundY(s.x, nz, s.y) > s.y + P.stepUp) { s.vz = 0; hit = true; } else s.z = nz; }
    return hit;
  }
  function approach(tx, tz, accel, decel, h) {
    const dx = tx - s.vx, dz = tz - s.vz, d = Math.hypot(dx, dz); if (d < 1e-6) return;
    const speeding = tx * tx + tz * tz > s.vx * s.vx + s.vz * s.vz;
    const m = Math.min(d, (speeding ? accel : decel) * h);
    s.vx += dx / d * m; s.vz += dz / d * m;
  }
  function turnTo(target, rate, h) { const d = wrapPi(target - s.ry); const m = rate * h; s.ry = wrapPi(s.ry + (Math.abs(d) <= m ? d : Math.sign(d) * m)); }

  function step(h, mv) {
    s.time += h;
    lastMove = mv;
    if (s.act) s.actT += h;
    const moving = mv.mag > 0;
    if (!s.struck && punching() && s.actT >= P.punchHit) { s.struck = true; onStrike && onStrike(s.act); }
    // cancels by movement
    if (moving && s.act === 'sit') standUp();
    if (moving && isEmote(s.act)) s.act = null;
    // timed segment ends
    if (s.act === 'dash' && s.actT >= P.dashDur) {
      s.act = null; s.dashEnd = s.time;
      const sp = s.vEnd; s.vx = -Math.sin(s.dir) * sp; s.vz = -Math.cos(s.dir) * sp;
    }
    if (s.act === 'roll' && s.actT >= s.actDur) {
      s.act = null; s.rollReady = s.time + P.rollCooldown;
      const sp = moving ? Math.max(s.vEnd, (mv.run ? P.run : P.walk) * mv.mag * wadeK()) : s.vEnd;
      s.vx = -Math.sin(s.dir) * sp; s.vz = -Math.cos(s.dir) * sp;
    }
    if (s.act === 'proneIn' && s.actT >= P.proneIn) { s.act = 'prone'; s.actT = 0; }
    if (s.act === 'proneOut' && s.actT >= P.proneOut) { s.act = null; s.key++; }
    if ((s.act === 'wave' || s.act === 'cheer' || s.act === 'nod' || s.act === 'land' || punching()) && s.actT >= s.actDur) s.act = null;
    // buffered input
    if (buffered) {
      if (s.time > buffered.until) buffered = null;
      else if (tryStart(buffered.a)) buffered = null;
    }
    // velocities
    if (s.act === 'dash') {
      const u = Math.min(1, s.actT / P.dashDur), sp = s.vEnd + (s.v0 - s.vEnd) * (1 - u);
      s.vx = -Math.sin(s.dir) * sp; s.vz = -Math.cos(s.dir) * sp;
      if (!s.dashGround) s.vy = 0;
    } else if (s.act === 'roll') {
      const u = Math.min(1, s.actT / s.actDur), sp = s.vEnd + (s.v0 - s.vEnd) * (1 - u);
      s.vx = -Math.sin(s.dir) * sp; s.vz = -Math.cos(s.dir) * sp;
    } else if (s.act === 'sit' || s.act === 'proneIn' || s.act === 'proneOut') {
      approach(0, 0, P.decel, P.decel, h);
    } else if (s.act === 'prone') {
      const t = P.crawl * mv.mag; approach(mv.x * t, mv.z * t, P.accel * 0.3, P.decel, h);
      if (moving) turnTo(Math.atan2(-mv.x, -mv.z), P.crawlTurn, h);
    } else if (s.grounded && s.swim === 2) {
      const t = (mv.run ? P.swimFast : P.swim) * mv.mag;
      approach(mv.x * t, mv.z * t, P.swimAccel, P.swimDecel, h);
      if (moving) turnTo(Math.atan2(-mv.x, -mv.z), P.swimTurn, h);
    } else if (s.grounded) {
      const t = (mv.run ? P.run : P.walk) * mv.mag * wadeK() * (punching() ? P.punchMove : 1);
      approach(mv.x * t, mv.z * t, P.accel, P.decel, h);
      if (moving && !punching()) turnTo(Math.atan2(-mv.x, -mv.z), P.turn, h);
    } else {
      // air control: steer toward input, keep momentum without input
      const hs = Math.hypot(s.vx, s.vz);
      if (moving) {
        const t = Math.max(hs, (mv.run ? P.run : P.walk) * mv.mag);
        approach(mv.x * t, mv.z * t, s.act === 'leap' ? P.leapAirAccel : P.airAccel, s.act === 'leap' ? P.leapAirAccel : P.airAccel, h);
        if (!punching()) turnTo(Math.atan2(-mv.x, -mv.z), P.turn * 0.5, h);
      } else { const k = Math.max(0, 1 - P.airDrag * h); s.vx *= k; s.vz *= k; }
    }
    if (s.act === 'sit' && s.seat) { s.speed = 0; return; }   // seated: pinned
    // diving: sink while held, float up (buoyancy) otherwise; only in deep water on a swimmer's footing
    if (s.swim === 2 && s.grounded) {
      if (s.plungeV > 0) { s.dive = Math.min(P.diveMax, s.dive + s.plungeV * h); s.diveV = s.plungeV; s.plungeV = Math.max(0, s.plungeV - P.plungeDrag * h); }   // the momentum of a dive in
      else if (s.diveV < 0) { s.dive = Math.max(0, s.dive + s.diveV * h); s.diveV = Math.min(0, s.diveV + 9 * h); }                                          // surge up (Space)
      else if (s.diveKey || s.diveBtn) { s.dive = Math.min(P.diveMax, s.dive + P.diveSink * h); s.diveV = P.diveSink; }
      else { s.diveV = 0; if (s.dive > 0) s.dive = Math.max(0, s.dive - P.diveRise * h); }
      const room = Math.max(0, water.surface(s.x, s.z) - P.swimSink - (groundY(s.x, s.z, s.y) + P.diveClear));   // never into the seabed
      if (s.dive > room) { s.dive = room; if (s.diveV > 0) s.diveV = 0; }
    }
    // integrate
    moveH(s.vx * h, s.vz * h);
    const g = floorAt(s.x, s.z);
    if (s.grounded) {
      if (s.y - g <= P.snapDown) {
        if (s.swim && Math.abs(g - s.y) > 0.03) vis.oy -= g - s.y;   // floating up / finding the sand: ease the step visually
        s.y = g; s.vy = 0; s.lastGround = s.time;
      }
      else { s.grounded = false; s.vy = 0; airPeak = s.y; }
    } else {
      const grav = s.act === 'dash' && !s.dashGround ? 0 : (s.act === 'leap' ? P.leapGravity : (s.act === 'roll' && s.rollAir ? P.airRollGravity : P.gravity));
      s.vy -= grav * h; s.y += s.vy * h; airPeak = Math.max(airPeak, s.y);
      if (s.y <= g && s.vy <= 0) {
        const vHit = -s.vy;
        s.y = g; s.vy = 0; s.grounded = true; s.lastGround = s.time; s.airDashUsed = false; lastLanded = s.time; s.rollAir = false;
        if (water && depthAt(s.x, s.z) >= P.swimOut && (s.swim === 2 || depthAt(s.x, s.z) >= P.swimIn)) {   // splash-down: updateWater counts it
          const wasSwim = s.swim === 2; s.swim = 0; if (s.act === 'leap') s.act = null;
          if (!wasSwim) { s.plunge = vHit; s.plungeFresh = true; s.plungeV = Math.min(P.plungeMax, Math.max(0, vHit - P.plungeV0) * P.plungeK); }   // a dive from the pier goes under, then buoyancy floats you up
        }
        else if (s.act === 'leap' || s.act === null) { setAct('land', P.landDur); }
        else if (s.act === 'dash') { s.dashGround = true; }
      }
    }
    if (s.grounded) { airPeak = s.y; s.airJumps = 0; s.airRoll = false; }
    updateWater();
    s.speed = Math.hypot(s.vx, s.vz);
  }
  // shallow water drags the legs: full speed at the edge, wadeSlow just before swimming depth
  const wadeK = () => (s.swim === 1 ? 1 - (1 - P.wadeSlow) * Math.min(1, Math.max(0, (depthAt(s.x, s.z) - P.wadeIn) / (P.swimIn - P.wadeIn))) : 1);

  // ------------------------------------------------------------ animation selection
  // airborne over deep water after a jump or a fall off the pier / the beach (not a leap out of the sea): the diving pose
  const overDeep = () => !!water && s.swim !== 2 && (s.act === null || s.act === 'jump') && s.y - water.level < 4 && depthAt(s.x, s.z) >= P.swimIn - 0.1;
  function locoCode() {
    const a = s.act;
    if (s.swim === 2 && s.grounded) return s.dive > 0.3 && s.diveV > 0.4 ? 15 : (a === 'dash' || s.speed > 0.3 ? 14 : 13);
    if (a === 'sit') return s.seat ? 7 : 6;
    if (a === 'prone' || a === 'proneIn') return s.speed > 0.15 && a === 'prone' ? 9 : 8;
    if (a === 'dance') return 10;
    if (a === 'dash') return 11;
    if (a === 'roll') return 12;
    if (a === 'leap') return 5;
    if (!s.grounded) return overDeep() ? 16 : (s.vy > 0.3 ? 3 : 4);
    if (s.speed > 3.9) return 2;
    if (s.speed > 0.15) return 1;
    return 0;
  }
  function animFor(l, act, speed, key) {
    // l: posture code; act: one-shot ('dash','roll','wave','cheer','nod','land','jump') currently playing or null
    if (l === 13 || l === 14 || l === 15) {              // in the water: strokes; a dash is a fast burst of them; 15 = sinking head first
      if (act === 'dash') return ['swim', { fade: 0.08, timeScale: 2.4 }];
      if (l === 15) return ['diveDown', { fade: 0.18 }];
      if (act === 'wave') return ['wave', { fade: 0.15, key }];
      return l === 14 ? ['swim', { fade: 0.2, timeScale: Math.min(1.8, Math.max(0.7, speed / P.swim)) }] : ['tread', { fade: 0.25 }];
    }
    switch (act) {
      case 'dash': return ['dashRun', { fade: 0.06, key, timeScale: 1.7 }];   // a sprint cycle, legs flying (the controller leans the body in)
      case 'leap': return ['leap', { fade: 0.08, key }];
      case 'roll': return ['roll', { fade: 0.05, key, timeScale: 0.55 / P.rollDur }];
      case 'punch': return ['punch', { fade: 0.04, key }];
      case 'punchL': return ['punchL', { fade: 0.04, key }];
      case 'wave': return ['wave', { fade: 0.15, key }];
      case 'cheer': return ['cheer', { fade: 0.12, key }];
      case 'nod': return ['nod', { fade: 0.15, key, timeScale: 1 }];
      case 'land': return speed > 1.2 ? null : ['land', { fade: 0.06, key }];
      case 'proneOut': return ['idle', { fade: 0.26 }];
    }
    switch (l) {
      case 3: return ['jump', { fade: 0.06, key }];
      case 4: return ['fall', { fade: 0.15 }];
      case 5: return ['leap', { fade: 0.08, key }];
      case 16: return ['diveJump', { fade: 0.1 }];
      case 6: return ['sitGround', { fade: 0.22 }];
      case 7: return ['sit', { fade: 0.22 }];
      case 8: return ['prone', { fade: 0.28 }];
      case 9: return ['crawl', { fade: 0.2, timeScale: Math.max(0.4, speed / P.crawl) }];
      case 10: return ['dance', { fade: 0.15 }];
      case 11: return ['dashRun', { fade: 0.06, key, timeScale: 1.7 }];
      case 12: return ['roll', { fade: 0.05, key, timeScale: 0.55 / P.rollDur }];
      case 2: return ['run', { fade: 0.15, timeScale: Math.max(0.6, speed / 5.0) }];
      case 1: return ['walk', { fade: 0.12, timeScale: Math.max(0.55, speed / 2.3) }];
      default: return ['idle', { fade: 0.14 }];
    }
  }
  let lastAnimLand = false;
  function driveAnim() {
    const l = locoCode();
    let one = null;
    if (s.act === 'dash' || s.act === 'roll' || s.act === 'wave' || s.act === 'cheer' || s.act === 'nod' || s.act === 'leap' || s.act === 'proneOut' || punching()) one = s.act;
    if (s.act === 'land') one = 'land';
    let pick = animFor(l, one, s.speed, s.key);
    if (!pick) pick = animFor(l, null, s.speed, s.key);   // moving landing: keep locomotion
    if (poseName && s.act === 'sit' && s.seat) pick = [poseName, { fade: 0.2, key: poseKey }];   // seated on a fishing chair: the page picks the pose
    avatar.play(pick[0], pick[1]);
  }

  // ------------------------------------------------------------ per-frame update
  function update(dt, camYaw) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    if (camYaw === undefined && camera) { const e = camera.getWorldDirection ? camera.getWorldDirection(camera.position.clone()) : null; camYaw = e ? Math.atan2(-e.x, -e.z) : camYawLast; }
    camYawLast = camYaw ?? camYawLast;
    if (remote) { updateRemote(dt); return; }
    const mv = moveInput(camYawLast);
    acc += dt;
    let n = 0;
    while (acc >= P.step && n < 12) { prev.x = s.x; prev.y = s.y; prev.z = s.z; step(P.step, mv); acc -= P.step; n++; }
    if (n === 12) acc = 0;
    const al = acc / P.step;
    const k = 1 - Math.exp(-dt / 0.09);                  // visual offset decay (seat slides, corrections)
    vis.ox -= vis.ox * k; vis.oy -= vis.oy * k; vis.oz -= vis.oz * k;
    const px = prev.x + (s.x - prev.x) * al + vis.ox, py = prev.y + (s.y - prev.y) * al + vis.oy, pz = prev.z + (s.z - prev.z) * al + vis.oz;
    vis.yaw = wrapPi(vis.yaw + wrapPi(s.ry - vis.yaw) * (1 - Math.exp(-dt * 30)));
    place(px, py, pz, vis.yaw, s.swim === 2, s.act === 'dash' && s.swim !== 2 ? P.dashLean : 0, dt);
    driveAnim();
    avatar.update(dt);
  }
  function place(x, y, z, yaw, swimming, lean = 0, dt = 0.016) {
    avatar.root.position.set(x, y, z); avatar.root.rotation.y = yaw;
    leanCur += (lean - leanCur) * (1 - Math.exp(-dt * 16));   // sprint tilt: the whole model pivots about the feet (model X, root frame)
    if (avatar.model && avatar.model.rotation) avatar.model.rotation.x = Math.abs(leanCur) < 0.002 ? 0 : leanCur;
    const g = groundY(x, z, y + 0.3), hgt = Math.max(0, y - g), sh = avatar.shadow;
    if (sh) sh.visible = !swimming;                       // no blob shadow on the seabed
    if (sh && !swimming) { sh.position.y = g - y + 0.02; const k = Math.max(0.35, 1 - hgt * 0.35); sh.scale.set(0.95 * k, 1, 0.95 * k); }
  }

  // ------------------------------------------------------------ network
  function netState() {
    const o = { x: r2(s.x), y: r2(s.y), z: r2(s.z), r: r2(wrapPi(s.ry)), l: locoCode(), a: s.lastCode, as: s.counter, t: Math.round(clock()) % 1e6 };
    if (s.act === 'sit' && s.seat && s.seat.id !== 1) o.s = s.seat.id;
    if (s.swim) o.w = s.swim;
    return o;
  }
  // remote: a = code of the latest action started, as = action counter (first sight = baseline only; a newer counter starts `a`).
  // Postures (sit/prone/dance) come from l, so late joiners see them without replaying anything.
  let rAct = null, rActT = 0, rKey = 0, rDisp = { x: 0, y: 0, z: 0, ry: 0 }, rInit = false;
  function applyNet(o, now = clock()) {
    if (!o || typeof o !== 'object') return;
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!num(o.x) || !num(o.z)) return;
    remote = true;
    let tl = now;
    if (num(o.t)) {
      let t = o.t + rWrap;
      if (rLastT >= 0 && t < rLastT - 5e5) { rWrap += 1e6; t += 1e6; }
      rLastT = t;
      const est = now - t;
      offs = offs === null || est < offs ? est : offs + (est - offs) * 0.02;
      tl = t + offs;
    }
    const y = num(o.y) ? o.y : groundY(o.x, o.z), ry = num(o.r) ? o.r : 0;
    if (samples.length && tl <= samples[samples.length - 1].t) tl = samples[samples.length - 1].t + 1;
    const lc = Number.isInteger(o.l) ? o.l : 0, seat = o.s ?? null, w = o.w === 1 || o.w === 2 ? o.w : 0;
    samples.push({ t: tl, x: o.x, y, z: o.z, ry, l: lc, seat, w });
    if (samples.length > 40) samples.shift();
    if (!rInit) { rInit = true; rDisp = { x: o.x, y, z: o.z, ry }; rPrevPos = { x: o.x, z: o.z }; }
    if (samples.length === 1) { rL = lc; rSeat = seat; rW = w; }
    const as = o.as;
    if (typeof as === 'number' && Number.isInteger(as) && as >= 0 && as <= 1e9) {
      if (rAs === undefined) rAs = as;                       // first sight: baseline only, never replay
      else if (as > rAs) {
        const leap = as - rAs; rAs = as;
        const act = CODE_ACT[o.a];
        // played when the interpolated timeline reaches this sample, so animation and motion stay aligned
        if (leap <= 1000 && act && act !== 'sit' && act !== 'prone' && act !== 'dance') events.push({ t: tl, act });
      }
    }
  }
  function updateRemote(dt) {
    const now = clock(), rt = now - P.netDelay;
    let tgt = null;
    if (samples.length) {
      while (samples.length > 2 && samples[1].t <= rt) samples.shift();
      // posture code / seat of the newest sample at or before the render time
      const cur = samples[1] && samples[1].t <= rt ? samples[1] : samples[0];
      if (cur.t <= rt || samples.length === 1) { rL = cur.l; rSeat = cur.seat; rW = cur.w; }
      const a = samples[0], b = samples[1];
      if (!b || rt <= a.t) tgt = { ...a };
      else if (rt <= b.t) {
        const u = (rt - a.t) / (b.t - a.t);
        tgt = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, ry: a.ry + wrapPi(b.ry - a.ry) * u };
      } else {                                           // ran past the newest sample: brief extrapolation, then hold
        const ex = Math.min(rt - b.t, 120) / Math.max(1, b.t - a.t);
        tgt = { x: b.x + (b.x - a.x) * ex, y: b.y, z: b.z + (b.z - a.z) * ex, ry: b.ry };
      }
    }
    if (tgt) {
      const k = 1 - Math.exp(-dt / 0.03);
      rDisp.x += (tgt.x - rDisp.x) * k; rDisp.y += (tgt.y - rDisp.y) * k; rDisp.z += (tgt.z - rDisp.z) * k;
      rDisp.ry = wrapPi(rDisp.ry + wrapPi(tgt.ry - rDisp.ry) * (1 - Math.exp(-dt / 0.05)));
    }
    // speed from the interpolated path
    if (rPrevPos && dt > 0) {
      const v = Math.hypot(rDisp.x - rPrevPos.x, rDisp.z - rPrevPos.z) / dt;
      rSpeed += (v - rSpeed) * (1 - Math.exp(-dt / 0.1));
    }
    rPrevPos = { x: rDisp.x, z: rDisp.z };
    // one-shot actions (from the counter), fired on the delayed timeline
    while (events.length && events[0].t <= rt) { const e = events.shift(); rAct = e.act; rActT = 0; rKey++; if (onRemoteAct) { try { onRemoteAct(e.act); } catch (err) { /* effects must not break the avatar */ } } }
    if (events.length > 8) events.splice(0, events.length - 8);
    if (rAct) { rActT += dt; const d = ONE_SHOT_DUR()[rAct]; if (d && rActT >= d + 0.02) rAct = null; if ((rAct === 'jump' || rAct === 'djump') && (rActT > 0.5 || (rActT > 0.12 && rL !== 3))) rAct = null; if (rAct === 'leap' && rL !== 5 && rActT > 0.15) rAct = null; }
    const air = rL === 3 || rL === 4 || rL === 5 || rL === 16;
    if (rAir && !air && rL <= 2 && rSpeed < 1.2) { rAct = 'land'; rActT = 0; rKey++; }
    if (rAct === 'land' && rActT > P.landDur) rAct = null;
    rAir = air;
    if (rL >= 6 && rL <= 10 && rAct && rAct !== 'land') rAct = null;       // postures override
    if (rW === 2 && rAct && rAct !== 'dash' && rAct !== 'wave' && rAct !== 'jump' && rAct !== 'djump') rAct = null;   // nothing else plays in deep water
    if ((rAct === 'wave' || rAct === 'cheer' || rAct === 'nod') && rSpeed > 0.6) rAct = null;
    // mirror into state for page code
    s.x = rDisp.x; s.y = rDisp.y; s.z = rDisp.z; s.ry = rDisp.ry; s.speed = rSpeed; s.act = rAct || postureName(rL); s.swim = rW; s.grounded = !air;
    place(rDisp.x, rDisp.y, rDisp.z, rDisp.ry, rW === 2, rAct === 'dash' && rW !== 2 ? P.dashLean : 0, dt);
    const jumpish = rAct === 'jump' || rAct === 'djump';
    let one = jumpish ? null : rAct;
    let l = rL;
    if (jumpish) l = 3;
    let pick = animFor(l, one, rSpeed, rKey);
    if (!pick) pick = animFor(l, null, rSpeed, rKey);
    // remote locomotion uses the interpolated speed
    if (poseName && rL === 7) pick = [poseName, { fade: 0.2, key: poseKey }];
    avatar.play(pick[0], pick[1]);
    avatar.update(dt);
  }
  const postureName = (l) => ({ 6: 'sit', 7: 'sit', 8: 'prone', 9: 'prone', 10: 'dance' })[l] || null;

  function dispose() {
    if (input === 'keyboard') { keyTarget.removeEventListener('keydown', onKeyDown); keyTarget.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); }
  }

  const api = {
    get state() { return { x: s.x, y: s.y, z: s.z, ry: s.ry, speed: s.speed, act: s.act, grounded: s.grounded, seat: remote ? rSeat : (s.seat && s.seat.id), counter: s.counter, swim: s.swim, splash: s.splash, plunge: s.plunge, dive: s.dive, diveV: s.diveV }; },
    update, press, sitAt, standUp, netState, applyNet, dispose,
    // a hit on me: shove along (dx, dz) with a small hop (halved and flat in deep water); ends whatever I was doing
    knock(dx, dz, power = 1) {
      if (remote) return false;
      const len = Math.hypot(dx, dz); if (!(len > 1e-6)) return false;
      dx /= len; dz /= len;
      if (s.act === 'sit') standUp();
      s.act = null; s.key++; buffered = null;
      const sw = s.swim === 2, sp = P.knockSpeed * power * (sw ? 0.5 : 1);
      s.vx = dx * sp; s.vz = dz * sp;
      if (!sw) { s.vy = P.knockHop * power; s.grounded = false; s.jumpedAt = s.time; }
      return true;
    },
    setStick(x, y) { stick = { x: x || 0, y: y || 0, on: !!(x || y) }; },   // joystick: x right, y down (screen); |v| ≥ 0.92 runs
    teleport(x, z, ry) { s.x = prev.x = x; s.z = prev.z = z; s.swim = 0; s.dive = s.diveV = s.plungeV = 0; s.y = 99; s.y = prev.y = floorAt(x, z); updateWater(); if (ry !== undefined) s.ry = vis.yaw = ry; s.vx = s.vz = s.vy = 0; },   // y = 99 first: probe from above, so a deck counts
    // seated pose override (e.g. 'fishSit' / 'fishCast'); a new key restarts a one-shot
    setPose(name, key) { poseName = name || null; poseKey = key === undefined ? poseKey + 1 : key; },
    setDive(on) { if (!remote) s.diveBtn = !!on; },   // hold-to-sink for a touch button (key C does the same)
    // climb out of the sea onto a deck at (x, y, z): the body slides there visually
    climbTo(x, y, z, ry) {
      if (remote) return;
      const vx0 = s.x + vis.ox, vy0 = s.y + vis.oy, vz0 = s.z + vis.oz;
      s.x = prev.x = x; s.y = prev.y = y; s.z = prev.z = z; s.vx = s.vy = s.vz = 0; s.grounded = true; s.swim = 0; s.dive = s.diveV = s.plungeV = 0; s.act = null; s.key++;
      if (ry !== undefined) s.ry = ry;
      vis.ox = vx0 - s.x; vis.oy = vy0 - s.y; vis.oz = vz0 - s.z;
    },
    get isRemote() { return remote; },
    _s: s,
  };
  return api;
}
