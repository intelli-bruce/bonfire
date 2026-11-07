// node tools/weapons.test.mjs — bf/weapons-core.js(슬롯·탄약·콤보·피해 표·광선 수학·메시지 검증) 와 bf/spider.js 의 hitRay / 무기별 피해 쿨다운을 THREE 없이 확인한다.
import fs from 'node:fs';
import * as C from '../bf/weapons-core.js';
import { createSpiderBoss, BOSS } from '../bf/spider.js';
import { boing, BOING_T } from '../bf/health.js';
import { pop, wobble, alphaAt, riseAt, GHOST } from '../bf/ghost.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
console.warn = () => {};

// 1) 슬롯 · 키 배정: 1~8 은 무기(1 맨손 2 검 3 M4A1 4 산탄총 5 권총 6 수류탄 7 저격총 8 RPG), 감정은 9·0·- 로 옮겼다(컨트롤러 키맵에서 확인)
{
  ok(Object.keys(C.SLOT_KEYS).join() === 'Digit1,Digit2,Digit3,Digit4,Digit5,Digit6,Digit7,Digit8', 'weapon keys are 1-8');
  ok(['fist', 'sword', 'rifle', 'shotgun', 'pistol', 'grenade', 'sniper', 'rpg'].every((k, i) => C.WEAPONS[i + 1].key === k), 'slot table 1..8');
  ok(C.wrapSlot(1, -1) === 8 && C.wrapSlot(8, 1) === 1 && C.wrapSlot(2, 1) === 3 && C.wrapSlot(3, -1) === 2, 'wheel wraps 1..8');
  ok(C.GUN_SLOTS.join() === '3,4,5,7,8' && !C.isGun(6) && !C.isGun(2), 'guns are 3 4 5 7 8');
  ok(C.WEAPONS[5].mag === 12 && !Number.isFinite(C.WEAPONS[5].reserve) && C.WEAPONS[7].mag === 5 && !Number.isFinite(C.WEAPONS[7].reserve), 'pistol 12/∞, sniper 5/∞');
  ok(C.WEAPONS[7].dmg >= 5 * C.WEAPONS[5].dmg && C.WEAPONS[7].bolt > 0 && C.WEAPONS[7].interval >= C.WEAPONS[7].bolt, 'sniper: heavy damage, bolt action paces the shots');
  const ctl = fs.readFileSync(new URL('../bf/kit/controller.js', import.meta.url), 'utf8');
  const km = ctl.match(/const KEYMAP = \{([^}]*)\}/)[1];
  ok(/Digit9: 'dance'/.test(km) && /Digit0: 'cheer'/.test(km) && /Minus: 'nod'/.test(km), 'emotes moved to 9 0 -');
  ok(!/Digit[1-8]\b/.test(km), 'controller no longer takes 1-8');
  ok(C.WEAPONS[3].mag === 30 && C.WEAPONS[3].reserve > 0 && C.WEAPONS[3].auto, 'M4A1: 30-round magazine, reserve, full auto');
}

// 2) 소총 탄약: 연사 간격 · 빈 탄창 · 장전(일반/빈) · 자동 완료
{
  const g = C.newGun(3), w = C.WEAPONS[3];
  ok(g.mag === 30 && g.reserve === w.reserve, 'fresh rifle');
  let t = 0, shots = 0;
  ok(C.fireOnce(g, t) && !C.fireOnce(g, t + w.interval * 0.5), 'rate limit between shots');
  shots = 1; t = w.interval;
  while (C.fireOnce(g, t)) { shots++; t += w.interval; if (shots > 40) break; }
  ok(shots === 30 && g.mag === 0 && C.fireState(g, t + 1) === 'empty', '30 shots then empty');
  ok(C.startReload(g, t) && !C.startReload(g, t), 'reload starts once');
  ok(C.fireState(g, t + 0.1) === 'reloading', 'cannot fire while reloading');
  ok(!C.tickReload(g, t + w.reloadEmptyT - 0.05), 'not done early');
  ok(C.tickReload(g, t + w.reloadEmptyT + 0.01) && g.mag === 30 && g.reserve === w.reserve - 30, 'empty reload: +30 from the reserve');
  C.fireOnce(g, t + 5); C.fireOnce(g, t + 5.2);
  ok(g.mag === 28 && C.startReload(g, t + 6) && near(g.reload.until - (t + 6), w.reloadT), 'partial reload is the shorter one');
  C.tickReload(g, t + 9);
  ok(g.mag === 30 && g.reserve === w.reserve - 32, 'partial reload tops up only what was shot');
  const low = C.newGun(3); low.mag = 0; low.reserve = 12;
  C.startReload(low, 0); C.tickReload(low, 10);
  ok(low.mag === 12 && low.reserve === 0, 'a short reserve fills what is left');
  const none = C.newGun(3); none.mag = 0; none.reserve = 0;
  ok(!C.startReload(none, 0), 'no reload without reserve');
  const full = C.newGun(3); ok(!C.startReload(full, 0), 'no reload on a full magazine');
  ok(C.ammoText(g) === `${g.mag} / ∞`, 'HUD ammo text: the reserve is unlimited (30 / ∞)');
}

// 3) 산탄총: 한 발씩 장전, 장전 중 쏘면 끊김
{
  const g = C.newGun(4), w = C.WEAPONS[4];
  for (let i = 0; i < 6; i++) C.fireOnce(g, i * (w.interval + 0.01));
  ok(g.mag === 0, 'six shells fired');
  const t = 10; C.startReload(g, t);
  C.tickReload(g, t + w.reloadT + w.shellT * 2.1);
  ok(g.mag === 2, 'shells go in one at a time');
  ok(C.fireState(g, t + w.reloadT + w.shellT * 2.1 + w.interval) === 'ok', 'with a shell in, firing interrupts the reload');
  ok(C.fireOnce(g, t + 5) && g.reload === null && g.mag === 1, 'firing cancels the reload');
  C.startReload(g, t + 6); C.tickReload(g, t + 20);
  ok(g.mag === 6 && g.reserve === w.reserve - 5 - 4 + 0 || g.mag === 6, 'shotgun refilled to 6');
}

// 4) 검: 클릭 한 번 = 베기(검기) 한 번. 최소 간격만 두고 빠른 클릭은 빠르게, 단계는 1→2→3→1, 늦으면 처음으로
{
  const s = C.newSword();
  ok(C.swordSwing(s, 0) === 0, 'first swing = 0');
  ok(C.swordSwing(s, C.SWORD_MIN * 0.5) === -1, 'only a minimum gap between clicks');
  ok(C.swordSwing(s, C.SWORD_MIN + 0.001) === 1, 'a fast click cuts the swing and starts the next one');
  ok(C.swordSwing(s, 2 * C.SWORD_MIN + 0.002) === 2 && C.swordSwing(s, 3 * C.SWORD_MIN + 0.003) === 0, 'steps cycle 1-2-3-1 without a recovery lock');
  const t = C.newSword(); let n = 0; for (let k = 0; k < 20; k++) if (C.swordSwing(t, k * 0.15) >= 0) n++;
  ok(n === 20, 'clicking every 0.15 s gives a slash every click (20 in 3 s)');
  const u = C.newSword(); C.swordSwing(u, 0);
  ok(C.swordSwing(u, C.COMBO[0].dur + C.COMBO_WINDOW + 0.2) === 0, 'too late: the combo resets');
  ok(C.SWORD_LAUNCH < C.SWORD_MIN && C.SWORD_LAUNCH <= 0.1, 'the crescent leaves right after the click');
}

// 4b) 검 궁극기: 쿨 15 s, 난무 중 일반 베기 막힘, 타격 시간표는 난무 안
{
  const s = C.newSword();
  ok(C.ultReady(s, 0) && C.ultStart(s, 0), 'ultimate ready at start');
  ok(!C.ultStart(s, 1) && Math.abs(C.ultLeft(s, 1) - (C.ULT.cd - 1)) < 1e-9, 'cooldown counts down');
  ok(C.swordSwing(s, 0.3) === -1, 'no normal swing during the rush');
  ok(C.swordSwing(s, C.ULT.rushT + 0.3) === 0, 'normal swings come back after it');
  ok(!C.ultStart(s, C.ULT.cd - 0.01) && C.ultStart(s, C.ULT.cd + 0.01), 'ready again after 15 s');
  const ts = Array.from({ length: C.ULT.rushHits }, (_, i) => C.ultHitT(i));
  ok(ts.every((v, i) => v > 0 && v < C.ULT.rushT && (i === 0 || v > ts[i - 1])), 'rush hits inside the rush, in order');
  ok(C.ultDmg('u').amount > C.COMBO[2].slash * 4 && C.ultDmg('r').amount > 0 && C.ultDmg('x') === null, 'the 死 crescent hits hard');
  const h = C.sanitizeWpn(C.wpnMsg.hit(2, 0, false, ['b', 0], 1, 'u')); ok(h && h.x === 'u', 'ultimate hit report keeps its kind');
  ok(C.sanitizeWpn({ k: 'h', w: 3, h: ['b', 0], x: 'u' }).x === undefined, 'only the sword can claim an ultimate hit');
  const um = C.sanitizeWpn(C.wpnMsg.ult([1, 2, 3], 0.5)); ok(um && um.k === 'u' && um.a === 0.5, 'ultimate message ok');
  ok(C.reachOk(2, 'u', C.ULT.range, 3) && !C.reachOk(2, 'm', C.ULT.range, 3), 'the 死 crescent reaches far, a melee hit does not');
}

// 4c) 수류탄: 포물선 · 튕김 · 범위 피해 · 메시지
{
  const flat = () => 0;
  const v = C.throwVel(0, 0.1); ok(v[2] < 0 && v[1] > 0 && Math.abs(v[0]) < 1e-9, 'thrown forward (-Z at yaw 0) and up');
  const arc = C.grenadeArc([0, 1.5, 0], v, flat);
  ok(arc.land[2] < -6 && arc.land[2] > -20 && arc.land[1] === C.GREN.radius, 'lands 6-20 m ahead on flat ground');
  let ys = arc.pts.map((p) => p[1]), peak = Math.max(...ys); ok(peak > 1.5, 'parabola rises before it falls');
  const p = [0, 3, 0], vv = [0, -8, 0]; let bounced = false; for (let i = 0; i < 60 && !bounced; i++) bounced = C.grenadeStep(p, vv, 1 / 60, flat);
  ok(bounced && vv[1] > 0 && vv[1] < 8, 'bounces off the ground, losing speed');
  const far = C.grenadeArc([0, 1.5, 0], C.throwVel(0, -0.6), flat), near = C.grenadeArc([0, 1.5, 0], C.throwVel(0, 0.6), flat);
  ok(Math.abs(far.land[2]) > Math.abs(near.land[2]), 'looking up throws farther than looking down');
  ok(C.grenadeDmg(0) === C.GREN.dmg && C.grenadeDmg(C.GREN.r * 0.5) < C.GREN.dmg && C.grenadeDmg(C.GREN.r * 0.5) > C.GREN.minDmg && C.grenadeDmg(C.GREN.r + 0.1) === 0, 'damage falls off with distance, none outside the radius');
  ok(C.dmgFor(6, 'm', 0, 0).amount === C.GREN.dmg && C.dmgFor(6, 'm', 0, 99).amount === C.grenadeDmg(C.GREN.r), 'grenade damage by reported distance (clamped)');
  const g = C.sanitizeWpn(C.wpnMsg.grenade([1, 2, 3], v)); ok(g && g.k === 'g' && g.v.length === 3, 'grenade message ok');
  ok(C.sanitizeWpn({ k: 'g', o: [0, 0, 0], v: [0, 0, 300] }) === null, 'impossible throw speed refused');
  ok(C.GREN.fuse > 1.5 && C.GREN.fuse < 3.5, 'delayed fuse');
}

// 4d) 조준(우클릭): 줌 · 명중률 · 저격총 스코프
{
  ok(C.adsFov(60, 3, 0) === 60 && C.adsFov(60, 3, 1) < 45 && C.adsFov(60, 7, 1) < 12, 'aim zooms in, the sniper scope a lot');
  ok(C.adsFov(60, 2, 1) === 60, 'no zoom without a gun');
  for (const s of C.GUN_SLOTS) ok(C.spreadFor(s, 1, false) < C.spreadFor(s, 0, false), `aiming tightens the spread (slot ${s})`);
  ok(C.spreadFor(7, 1, false) === 0 && C.spreadFor(7, 0, false) > 0.03, 'sniper: exact when scoped, wild from the hip');
  ok(C.spreadFor(3, 0, true) > C.spreadFor(3, 0, false), 'moving spreads more');
  ok(C.ADS[7].scope && !C.ADS[3].scope, 'only the sniper has a scope screen');
  const f = C.sanitizeWpn(C.wpnMsg.fire(7, [1, 2, 3], [0, 0, -1], 50, 1, 9, ['b', 0], 1)); ok(f && f.w === 7 && f.z === 1, 'sniper shot with aim state');
  ok(C.sanitizeWpn(C.wpnMsg.fire(5, [1, 2, 3], [0, 0, -1], 50, 0, 9)).w === 5 && C.sanitizeWpn({ k: 'f', w: 6, o: [0, 0, 0], d: [0, 0, -1] }) === null, 'pistol shots ok, a grenade is not a gun');
  ok(C.dmgFor(5, 'm', 0, 1).key === 'pistol' && C.dmgFor(7, 'm', 0, 1).amount === C.WEAPONS[7].dmg, 'pistol / sniper damage keys');
  ok(C.sanitizeWpn(C.wpnMsg.reload(7, false)).w === 7 && C.sanitizeWpn(C.wpnMsg.reload(5, true)).e === 1, 'pistol / sniper reload');
}

// 4e) 새 총 탄약: 권총 12발 · 저격총 5발 · 볼트 간격
{
  for (const [slot, mag] of [[5, 12], [7, 5]]) {
    const g = C.newGun(slot), w = C.WEAPONS[slot]; let t = 0, n = 0;
    while (C.fireOnce(g, t)) { n++; t += w.interval; if (n > 30) break; }
    ok(n === mag && C.needsAutoReload(g, t), `slot ${slot}: ${mag} rounds then auto reload`);
    C.startReload(g, t); C.tickReload(g, t + 10); ok(g.mag === mag && C.ammoText(g) === `${mag} / ∞`, `slot ${slot}: refilled ${mag} / ∞`);
  }
  const g = C.newGun(7); C.fireOnce(g, 0); ok(!C.fireOnce(g, C.WEAPONS[7].bolt * 0.9), 'sniper: no second shot before the bolt is worked');
}

// 5) 피해 표: 보내는 사람이 말한 값은 쓰지 않는다
{
  ok(C.dmgFor(1, 'm', 0, 1).amount === 15, 'punch 15');
  ok(C.dmgFor(2, 'm', 2, 1).amount === C.COMBO[2].melee && C.dmgFor(2, 'sl', 0, 1).amount === C.COMBO[0].slash, 'sword melee / slash by combo step');
  ok(C.dmgFor(3, 'm', 0, 1).amount === C.WEAPONS[3].dmg, 'rifle per bullet');
  ok(C.dmgFor(4, 'm', 0, 99).amount === C.WEAPONS[4].dmg * C.WEAPONS[4].pellets, 'shotgun: pellets capped at 7');
  ok(C.dmgFor(4, 'm', 0, 3).amount === C.WEAPONS[4].dmg * 3, 'shotgun: n pellets');
  ok(C.dmgFor(9, 'm', 0, 1) === null, 'unknown weapon');
  ok(C.dmgFor(3, 'm', 0, 1).cd < C.dmgFor(1, 'm', 0, 1).cd, 'a rifle may land faster than a fist');
  ok(C.reachOk(3, 'm', 100, 32) && !C.reachOk(3, 'm', 400, 32) && C.reachOk(2, 'sl', 40, 32) && !C.reachOk(2, 'm', 80, 32), 'reach checks by weapon');
}

// 6) 광선 수학
{
  ok(near(C.raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 1, 100), 9), 'ray hits a sphere front');
  ok(C.raySphere(0, 0, 0, 0, 0, -1, 5, 0, -10, 1, 100) === -1 && C.raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 1, 5) === -1, 'miss / out of range');
  ok(C.raySphere(0, 0, 0, 0, 0, -1, 0, 0, 0.2, 1, 100) === 0, 'starting inside = 0');
  ok(near(C.rayCapsule(0, 1, 0, 0, 0, -1, 0, 0, -10, 0, 3, -10, 0.5, 100), 9.5) || C.rayCapsule(0, 1, 0, 0, 0, -1, 0, 0, -10, 0, 3, -10, 0.5, 100) > 0, 'ray hits a vertical leg capsule');
  ok(C.rayCapsule(0, 1, 0, 0, 0, -1, 3, 0, -10, 3, 3, -10, 0.5, 100) === -1, 'capsule off to the side is missed');
  ok(C.rayCapsule(0, 5, 0, 0, 0, -1, 0, 0, -10, 0, 3, -10, 0.5, 100) === -1, 'passing above the capsule');
  ok(near(C.rayCylY(0, 1, 0, 0, 0, -1, 0, -10, 2, 0, 5, 100), 8), 'ray hits an upright cylinder');
  ok(C.rayCylY(0, 9, 0, 0, 0, -1, 0, -10, 2, 0, 5, 100) === -1, 'over the cylinder');
  ok(near(C.rayCylY(0, 10, 0, 0, -1, 0, 0, 0, 2, 0, 5, 100), 5), 'straight down onto the top');
  for (let i = 0; i < 200; i++) {
    const r1 = (i * 0.6180339) % 1, r2 = (i * 0.7548776) % 1, d = C.spreadDir(0, 0, -1, 0.05, r1, r2);
    if (!near(Math.hypot(...d), 1, 1e-9) || Math.atan2(Math.hypot(d[0], d[1]), -d[2]) > 0.06) { ok(false, `spread cone (${i})`); break; }
  }
  ok(C.spreadDir(0, 0, -1, 0, 0.3, 0.3)[2] === -1, 'no spread = same direction');
}

// 7) 네트워크 메시지 검증
{
  const f = C.wpnMsg.fire(3, [1, 2, 3], [0, 0, -1], 40, 1, 12345, ['b', 0]);
  const s = C.sanitizeWpn(JSON.parse(JSON.stringify(f)));
  ok(s && s.k === 'f' && s.w === 3 && s.h.kind === 'boss' && s.l === 40 && s.d[2] === -1, 'a fire message round-trips');
  ok(JSON.stringify(f).length < 200, `fire message is small (${JSON.stringify(f).length} B)`);
  ok(C.sanitizeWpn({ k: 'f', w: 3, o: [1, 2, 3], d: [0, 0, 0], l: 10 }) === null, 'zero direction refused');
  ok(C.sanitizeWpn({ k: 'f', w: 1, o: [1, 2, 3], d: [0, 0, -1] }) === null, 'a fist cannot send a shot');
  ok(C.sanitizeWpn({ k: 'f', w: 3, o: [1e9, 2, 3], d: [0, 0, -1] }).o[0] === 140, 'out-of-world origin is clamped into the world');
  ok(C.sanitizeWpn({ k: 'f', w: 3, o: [1, 2, 3], d: [0, 0, -1], h: ['x', 1] }) === null, 'unknown hit kind refused');
  ok(C.sanitizeWpn({ k: 'f', w: 3, o: [1, 2, 'a'], d: [0, 0, -1] }) === null, 'non-numeric origin refused');
  const sw = C.sanitizeWpn(C.wpnMsg.swing(2, [1, 2, 3], 1.5)); ok(sw && sw.c === 2, 'swing ok');
  ok(C.sanitizeWpn({ k: 's', c: 5, o: [0, 0, 0], a: 0 }).c === 2, 'combo step clamped');
  ok(C.sanitizeWpn({ k: 's', c: 1, o: [0, 0, 0], a: 99 }).a === 7, 'angle clamped');
  const h = C.sanitizeWpn(C.wpnMsg.hit(2, 1, true, ['m', 7], 1)); ok(h && h.sl === 1 && h.h.kind === 'minion' && h.h.id === 7, 'damage report ok');
  ok(C.sanitizeWpn({ k: 'h', w: 2, h: ['b', -4] }).h.id === 0, 'negative id clamped');
  ok(C.sanitizeWpn(C.wpnMsg.reload(4, true)).e === 1 && C.sanitizeWpn({ k: 'r', w: 2 }) === null, 'reload ok, only guns reload');
  ok(C.sanitizeWpn('x') === null && C.sanitizeWpn(null) === null && C.sanitizeWpn({ k: 'zz' }) === null, 'garbage refused');
}

// 8) 소총 장전 애니메이션 단계
{
  const a = C.rifleReloadPose(0, false), m = C.rifleReloadPose(0.4, false), e = C.rifleReloadPose(1, false);
  ok(a.mag === 0 && a.handle === 0, 'starts with the magazine seated');
  ok(m.magGone === true, 'the old magazine is out and gone mid-reload');
  ok(e.mag === 0 && e.handle === 0 && e.tilt === 0, 'ends seated, handle forward, level');
  ok(Math.max(...[0.1, 0.2, 0.3].map((u) => C.rifleReloadPose(u, false).mag)) > 0.9, 'the magazine slides fully out');
  const emp = Array.from({ length: 101 }, (_, i) => C.rifleReloadPose(i / 100, true));
  ok(Math.max(...emp.map((p) => p.handle)) > 0.95 && emp[100].handle === 0 && emp[0].handle === 0, 'an empty magazine ends with the charging handle pulled and released');
  ok(Math.max(...Array.from({ length: 101 }, (_, i) => C.rifleReloadPose(i / 100, false).handle)) === 0, 'a partial reload does not touch the handle');
}

// 9) 보스 hitRay · 무기별 피해 쿨다운 (모델 없는 근사: 원기둥)
{
  const THREE = { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(o) { return this.set(o.x, o.y, o.z); } }, Quaternion: class {} };
  const sp = createSpiderBoss({
    THREE, scene: { add() {}, remove() {} }, baseUrl: 'file:///x/', myId: 'me', heightAt: () => 0, canStand: () => true,
    players: () => [{ id: 'me', x: 0, z: 0, y: 0 }], me: () => ({ ok: true, x: 0, y: 0, z: 0 }), pushMe() {}, onHitMe() {}, fx: { poof() {}, spark() {}, thump() {} },
  });
  sp.spawn(0, -40, 0); const dbg = sp.debug; dbg.B.spawnT = 0;
  const ray = (oz, d = -1) => sp.hitRay(0, 1.5, oz, 0, 0, d, 200, 0.05);
  const hb = ray(0);
  ok(hb && hb.kind === 'boss' && hb.d > 20 && hb.d < 40, `a bullet toward the boss hits it (${hb && hb.d.toFixed(1)} m)`);
  ok(sp.hitRay(0, 1.5, 0, 1, 0, 0, 200, 0.05) === null, 'a bullet to the side misses');
  ok(sp.hitRay(0, 1.5, 0, 0, 0, -1, 10, 0.05) === null, 'range limit');
  dbg.B.minions.push({ id: 5, x: 0, z: -10, ry: 0, hp: 20, a: 'w' });
  const hm = sp.hitRay(0, 0.6, 0, 0, 0, -1, 200, 0.05); ok(hm && hm.kind === 'minion' && hm.id === 5 && hm.d < 11, 'a nearer minion is hit before the boss');
  // 피해: 소총은 쿨다운이 짧아 0.1 s 간격 연타가 들어가고, 같은 무기 키의 더 빠른 연타는 막힌다
  const hp0 = sp.view.hp;
  ok(sp.damage('boss', 0, 6, 'p|rifle', 70) === true && sp.damage('boss', 0, 6, 'p|rifle', 70) === false, 'the same weapon key is rate limited');
  ok(sp.damage('boss', 0, 14, 'p|sword', 150) === true && sp.view.hp === hp0 - 6 - 14, 'another weapon key of the same player is its own bucket');
  ok(sp.damage('boss', 0, 28, 'q|shotgun', 450) === true && sp.view.hp === hp0 - 6 - 14 - 28, 'a shotgun blast of 28 lands in one hit');
  ok(sp.damage('boss', 0, 999, 'r|x', 100) === true && sp.view.hp === hp0 - 6 - 14 - 28 - 300, 'a single hit is still capped (300)');
  ok(sp.damage('minion', 5, 10, 'p|rifle', 70) === true && dbg.B.minions[0].hp === 10, 'minion takes weapon damage');
  ok(sp.damage('minion', 5, 10, 'p|rifle', 70) === true && dbg.B.minions.every((m) => m.id !== 5 ? true : m.hp <= 0), 'and dies');
  dbg.B.hp = 3; dbg.O.hitAt.clear();
  ok(sp.damage('boss', 0, 6, 's|rifle', 70) === true && sp.view.dying && sp.view.hp === 0, 'a rifle round can finish it');
  ok(sp.hitRay(0, 1.5, 0, 0, 0, -1, 200, 0.05) === null, 'a dying boss cannot be hit');
}

// 10) 예비탄 무제한 · 탄창 단위 장전 · 자동 장전
{
  ok(C.WEAPONS[3].reserve === Infinity && C.WEAPONS[4].reserve === Infinity, 'reserve is unlimited for the rifle and the shotgun');
  ok(C.WEAPONS[3].mag === 30 && C.WEAPONS[4].mag === 6, 'magazine units: rifle 30, shotgun keeps its 6');
  const g = C.newGun(3); let t = 0;
  for (let cycle = 0; cycle < 6; cycle++) {   // 30 shots, then a reload, six times over: the reserve never runs out
    let shots = 0; while (C.fireOnce(g, t)) { shots++; t += C.WEAPONS[3].interval; }
    ok(shots === 30 && g.mag === 0, `cycle ${cycle}: 30 shots empty the magazine`);
    ok(C.needsAutoReload(g, t + 0.01), `cycle ${cycle}: an empty magazine asks for an automatic reload`);
    C.startReload(g, t); t += C.WEAPONS[3].reloadEmptyT + 0.01; C.tickReload(g, t);
    ok(g.mag === 30 && g.reserve === Infinity, `cycle ${cycle}: refilled to 30, reserve still unlimited`);
  }
  ok(C.ammoText(g) === '30 / ∞' && C.ammoText(C.newGun(4)) === '6 / ∞', 'HUD text is 30 / ∞ (rifle) and 6 / ∞ (shotgun)');
  const e = C.newGun(3); e.mag = 0; e.nextAt = 5;
  ok(!C.needsAutoReload(e, 4.9) && C.needsAutoReload(e, 5), 'auto reload waits for the fire interval');
  e.reload = { t0: 0, until: 9, need: 30 }; ok(!C.needsAutoReload(e, 6), 'no second reload while one is running');
  const f = C.newGun(3); f.mag = 3; ok(!C.needsAutoReload(f, 9), 'no auto reload while rounds are left (R reloads by hand)');
  const z = C.newGun(3); z.mag = 0; z.reserve = 0; ok(!C.needsAutoReload(z, 9) && !C.needsAutoReload(null, 9), 'nothing to load, no gun');
  const sg = C.newGun(4); for (let i = 0; i < 6; i++) C.fireOnce(sg, i);
  ok(sg.mag === 0 && C.needsAutoReload(sg, 9), 'an empty shotgun also reloads by itself');
  C.startReload(sg, 9); C.tickReload(sg, 9 + C.WEAPONS[4].reloadT + C.WEAPONS[4].shellT * 7);
  ok(sg.mag === 6 && sg.reserve === Infinity, 'the shotgun refills to its 6-shell magazine');
}

// 11) 날아가는 탄: 총구에서 출발 · 탄두+짧은 궤적 · 닿으면 끝
{
  const L = 40, a0 = C.bulletPos(0, L);
  ok(a0.tail === 0 && a0.head > 0 && a0.head < 1 && !a0.arrived && !a0.done, 'the bullet starts at the muzzle (trail anchored at 0, head just ahead)');
  const a1 = C.bulletPos(0.02, L), a2 = C.bulletPos(0.1, L);
  ok(a1.head > a0.head && a2.head > a1.head && a2.tail > 0, 'it flies forward and the trail lets go of the muzzle');
  ok(a2.head - a2.tail <= C.BULLET.trail + 1e-9, 'the trail stays short');
  const flight = C.impactDelay(L); ok(flight > 0.2 && flight < 0.4, `a 40 m shot lands in ${flight.toFixed(2)} s`);
  const b = C.bulletPos(flight + 0.001, L); ok(b.arrived && b.head === L && !b.done, 'at the target the head is gone and the trail catches up');
  ok(C.bulletPos(flight + C.BULLET.trail / C.BULLET.speed + 0.01, L).done, 'then it ends');
  ok(C.bulletPos(0, 0.2).head === 0.2 && C.bulletPos(0, 0.2).arrived, 'a point-blank hit never draws past the target');
  ok(C.impactDelay(0) === 0 && C.SWITCH_T > 0.1 && C.SWITCH_T <= 0.2, 'a weapon switch takes about 0.15 s');
}

// 12) 키 처리: 무기 키는 capture 단계에서 삼키고, 1~4·R 모두 한 곳(onGameKey)에서 처리한다
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/window\.addEventListener\('keydown', onGameKey, true\)/.test(html), 'the game key handler runs in the capture phase');
  const fn = html.match(/function onGameKey\(e\) \{([\s\S]*?)\n\}\nwindow\.addEventListener\('keydown', onGameKey, true\)/);
  ok(!!fn && /weaponKey\(e\)\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\);/.test(fn[1]), 'weapon keys get preventDefault + stopImmediatePropagation');
  ok(/const weaponKey = \(e\) => \(SLOT_KEYS\[e\.code\] \|\| e\.code === 'KeyR'\) && !e\.ctrlKey && !e\.metaKey && !e\.altKey/.test(html), 'weapon keys = 1~8 and R without Ctrl/Meta/Alt (Ctrl+R still reloads the browser)');
  ok(/if \(e\.button === 2\) \{ e\.preventDefault\(\); rightDown\(\); \}/.test(html) && /rightDown\(\)/.test(html) && /\$\('altBtn'\)/.test(html), 'right mouse button / mobile button: aim, ultimate');
  ok(/9 춤 · 0 환호 · - 끄덕 · 1~8 무기/.test(html), 'help text names the new keys');
  ok(/if \(!text \|\| !netLive\(\)\) \{ chatInput\.blur\(\);/.test(html), 'an empty chat Enter gives the keyboard back to the game');
  ok(/textContent = Number\.isFinite\(g\.reserve\) \? g\.reserve : '∞'/.test(html), 'HUD shows ∞ for the reserve');
}

// 13) 총구: 모든 총 모델에 muzzle 노드가 있고, 탄·섬광은 그 프레임 자세가 끝난 뒤(poseUpdate → flushShots) 총구에서 나온다
{
  const nodes = (f) => { const b = fs.readFileSync(new URL('../bf/' + f, import.meta.url)); const len = b.readUInt32LE(12); return JSON.parse(b.slice(20, 20 + len).toString('utf8')).nodes.map((q) => q.name); };
  for (const [f, need] of [['m4a1.glb', ['muzzle', 'grip_r', 'mag']], ['shotgun.glb', ['muzzle', 'grip_r']], ['pistol.glb', ['muzzle', 'grip_r', 'slide', 'mag']], ['sniper.glb', ['muzzle', 'grip_r', 'bolt', 'mag']]]) {
    const ns = nodes(f); ok(need.every((k) => ns.includes(k)), `${f} has ${need.join(', ')}`);
  }
  const js = fs.readFileSync(new URL('../bf/weapons.js', import.meta.url), 'utf8');
  ok(/function afterUpdate\(rec, dt, now\) \{\s*footsteps\(rec, dt\);\s*if \(!rec\.wp\) return;\s*poseUpdate\(rec, dt, now\);\s*flushShots\(rec\);/.test(js), 'shots are drawn after this frame\'s pose');
  ok(/function flushShots[\s\S]*?muzzleWorld\(rec, s\.slot, o\)/.test(js) && /queueShot\(rec, m\.w, ends, sent, false\)/.test(js), 'mine and remote shots start at the muzzle seen on this screen');
}

// 14) v4: RPG · 수류탄 포물선 · 반동 · 상하 조준 · 산탄 무늬 · 캐릭터 체력
{
  const w = C.WEAPONS[8];
  ok(w.gun && w.rocket && w.mag === 1 && !Number.isFinite(w.reserve), 'RPG: one rocket a load, unlimited reserve');
  const g = C.newGun(8); ok(C.fireOnce(g, 0) && g.mag === 0 && C.needsAutoReload(g, 1), 'RPG fires once then reloads');
  ok(C.startReload(g, 1) && C.tickReload(g, 1 + w.reloadEmptyT + 0.01) && g.mag === 1, 'RPG reload puts a rocket back');
  ok(C.rocketDmg(0) === C.ROCKET.dmg && C.rocketDmg(C.ROCKET.r + 0.1) === 0 && C.rocketDmg(3) < C.rocketDmg(1), 'rocket splash falls off with distance');
  ok(C.dmgFor(8, 'm', 0, 2).key === 'rocket' && C.dmgFor(8, 'm', 0, 2).amount === C.rocketDmg(2), 'damage table knows the rocket');
  const k = C.sanitizeWpn(C.wpnMsg.rocket([1, 2, 3], [0, 0.6, -0.8]));
  ok(k && k.k === 'k' && Math.abs(Math.hypot(...k.d) - 1) < 1e-6, 'rocket message survives the guard');
  ok(C.sanitizeWpn({ k: 'k', o: [0, 0, 0], d: [0, 0, 0] }) === null, 'a rocket without a direction is dropped');
  ok(C.sanitizeWpn(C.wpnMsg.hit(8, 0, 0, ['b', 0], 3.2)).n === 3.2, 'rocket hit report keeps the blast distance');
  const p = [0, 2, 0], v = [0, 0, -C.ROCKET.speed]; C.rocketStep(p, v, 0.5); ok(p[2] < -20 && p[1] < 2 && p[1] > 1, 'rocket flies straight with a slight drop');
  // 수류탄: 위를 볼수록 높이·멀리
  const flat = () => 0, far = (pitch) => { const r = C.grenadeArc([0, 1.5, 0], C.throwVel(0, pitch), flat); let top = 0; for (const q of r.pts) top = Math.max(top, q[1]); return { d: Math.hypot(r.land[0], r.land[2]), top }; };
  const down = far(0.4), lvl = far(0), up = far(-0.4);
  ok(up.d > lvl.d && lvl.d > down.d, `looking up throws farther (${down.d.toFixed(1)} < ${lvl.d.toFixed(1)} < ${up.d.toFixed(1)} m)`);
  ok(up.top > lvl.top && lvl.top > down.top, 'looking up throws higher');
  ok(Math.hypot(...C.throwVel(0, -0.5)) <= C.GREN.speed * 1.6, 'the strongest throw still passes the message guard');
  ok(C.sanitizeWpn(C.wpnMsg.grenade([0, 1, 0], C.throwVel(1, -0.5))) !== null, 'an upward throw is accepted by others');
  // 반동: 모든 총에서 0 — 연사·조준·무작위 좌우 어느 쪽도 시점을 움직이지 않는다
  ok(C.GUN_SLOTS.every((s) => [0, 3, 9, 12, 40].every((n) => [0, 1].every((a) => [-1, 0, 1].every((r) => { const [u, d] = C.recoilKick(s, n, a, r); return u === 0 && d === 0; })))), 'no gun kicks the view up or sideways, however long the burst');
  ok(C.recoilRecover(0, 1 / 60, true) === 0, 'nothing to recover when no recoil builds up');
  ok(C.GUN_SLOTS.every((s) => C.RECOIL[s] && C.RECOIL[s][0] === 0 && C.RECOIL[s][1] === 0), 'every gun has a recoil entry, and it is zero');
  ok([3, 4, 5, 7].every((s) => C.CASING[s]) && C.CASING[4].shell, 'every cartridge gun ejects a casing (shotgun: a shell)');
  // 상하 조준: 위를 보면 위로, 아래를 보면 아래로(땅에 붙지 않음)
  ok(C.aimDir(0, -0.6)[1] > 0.5 && C.aimDir(0, 0.6)[1] < -0.3 && Math.abs(Math.hypot(...C.aimDir(1, 0.3)) - 1) < 1e-9, 'aim direction follows the camera pitch');
  const sw = C.sanitizeWpn(C.wpnMsg.swing(1, [0, 0, 0], 0.5, 0.7)); ok(sw && sw.p === 0.7, 'a swing carries its elevation');
  ok(C.sanitizeWpn({ k: 's', c: 0, o: [0, 0, 0], a: 0 }).p === 0, 'old clients: a level swing');
  ok(C.sanitizeWpn(C.wpnMsg.ult([0, 0, 0], 0, -0.4)).p === -0.4, 'the ultimate carries its elevation');
  // 산탄: 같은 seed = 같은 무늬, 알갱이 7개가 퍼짐 안에
  const mk = (seed) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
  const A = C.pelletDirs([0, 0, -1], 0.06, 7, mk(42)), B = C.pelletDirs([0, 0, -1], 0.06, 7, mk(42));
  ok(A.length === 7 && A.every((d, i) => d.every((q, j) => q === B[i][j])), 'shotgun pattern is the same on both screens');
  ok(A.slice(1).every((d) => { const ang = Math.acos(-d[2]); return ang > 0.005 && ang < 0.07; }), 'pellets spread around the centre within the cone');
  // 체력: 옛 100 의 4배, 5 초 뒤 자동 부활, 「즉시 리스폰」 은 0.6 초 뒤부터
  ok(C.HP.max === 1000 && C.HP.respawnT === 5 && C.HP.btnDelay > 0 && C.HP.btnDelay < 1, 'HP 1000 (10x the old 100), auto respawn after 5 s');
  ok(C.HURT.swipe === 165 && C.HURT.spit === 90 && C.HURT.bite === 52, 'spider damage scaled with the new HP (2.5x of the HP 400 values)');
  const h = C.newHp(); ok(C.hpHit(h, 30, 0) === 'hit' && h.hp === C.HP.max - 30, 'a hit takes HP');
  ok(C.hpHit(h, C.HP.max, 1) === 'dead' && h.dead && h.hp === 0, 'HP 0 = down');
  ok(C.hpHit(h, 10, 1.5) === null, 'no damage while down');
  ok(near(C.respawnLeft(h, 1), C.HP.respawnT) && near(C.respawnLeft(h, 1 + 2), C.HP.respawnT - 2) && C.respawnLeft(h, 1 + C.HP.respawnT + 1) === 0 && C.respawnLeft(C.newHp(), 5) === 0, 'respawn countdown: 5 -> 0, nothing when alive');
  ok(!C.canInstantRespawn(h, 1 + C.HP.btnDelay - 0.05) && C.canInstantRespawn(h, 1 + C.HP.btnDelay + 0.01) && !C.canInstantRespawn(C.newHp(), 9), 'instant respawn button: not at once, never when alive');
  ok(C.hpTick(h, 1 + C.HP.respawnT - 0.1, 0.016) === null && C.hpTick(h, 1 + C.HP.respawnT + 0.01, 0.016) === 'respawn' && h.hp === C.HP.max && !h.dead, 'no button press: auto respawn with full HP after 5 s');
  ok(C.hpHit(h, 10, 1 + C.HP.respawnT + 0.5) === null, 'a short shield after respawn');
  const ib = C.newHp(); C.hpHit(ib, C.HP.max, 10);
  ok(C.hpRespawn(ib, 10.7) && !ib.dead && ib.hp === C.HP.max && C.hpHit(ib, 50, 11) === null && C.hpHit(ib, 50, 10.7 + C.HP.inv + 0.1) === 'hit' && !C.hpRespawn(ib, 20), 'instant respawn: full HP + shield, only from the down state');
  ok(C.hpTick(ib, 100, 0.016) === null, 'a revived player is not revived twice');
  const r = C.newHp(); C.hpHit(r, 50, 0); const r0 = r.hp; C.hpTick(r, C.HP.regenDelay + 1, 1); ok(r.hp > r0, 'HP regenerates when out of combat');
  ok(C.hpPct({ hp: C.HP.max }) === 100 && C.hpPct({ hp: 0 }) === 0 && C.hpPct({ hp: 0.4 }) === 1 && C.hpPct({ hp: C.HP.max / 2 }) === 50, 'presence hp is a percent (old clients read the same bar)');
  ok(C.sanitizeHp(250, 0).pct === 100 && C.sanitizeHp(undefined).hp === C.HP.max && C.sanitizeHp(12.4, 1).dead && C.sanitizeHp('x').hp === C.HP.max && C.sanitizeHp(50, 0).hp === C.HP.max / 2, 'remote hp field is a clamped percent');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/hp: hpPct\(MYHP\)/.test(html) && /rec\.hpNet = sanitizeHp\(d\.hp, d\.dd\)/.test(html), 'HP rides presence both ways');
  ok(/SENS = \{ v: [^\n]*: 0\.5; \}\)\(\) \}/.test(html) && /0\.0035 \* SENS\.v/.test(html) && /store\.set\('bonfire\.sens'/.test(html), 'mouse sensitivity: saved, default half of the old one');
  ok((html.match(/^  [1-8]: '<(path|rect)/gm) || []).length === 8, 'eight weapon silhouettes');
}

// 16) v5: 조준 감도(줌 배율 반비례) · 1인칭 가늠쇠 · 수류탄 궤적은 몸 밖에서 시작 · 무기별 데미지 차등 · HP 1,000
{
  ok(C.adsSens(7, 1) < 0.2 && C.adsSens(7, 0) === 1 && C.adsSens(3, 1) === 1 / C.ADS[3].zoom && C.adsSens(2, 1) === 1, 'aim sensitivity falls with the zoom (sniper 1/6)');
  ok(C.adsFp(3, 1) === 1 && C.adsFp(4, 1) === 1 && C.adsFp(5, 0.5) === 0.5 && C.adsFp(7, 1) === 0 && C.adsFp(8, 1) === 0, 'rifle / shotgun / pistol aim from the iron sights');
  ok(C.ADS[3].zoom >= 1.8 && C.ADS[4].zoom > 1.25 && C.ADS[5].zoom > 1.35, 'closer zoom than before');
  const arc = C.grenadeArc([0.3, 1.2, 0], C.throwVel(0, 0), () => 0), i0 = C.arcStart(arc.pts, 0, 0, 0);
  ok(i0 > 0 && arc.pts.slice(i0).every((q) => C.distToBody(q[0], q[1], q[2], 0, 0, 0) > 0.25), 'grenade arc starts outside my body');
  const D = (w, c, n, x) => C.dmgFor(w, 'm', c, n).amount;
  ok(D(7, 0, 1) > D(4, 0, 7) && D(4, 0, 7) > D(5, 0, 1) && D(5, 0, 1) > D(3, 0, 1) && D(2, 2, 1) > D(2, 0, 1) && D(2, 0, 1) > D(1, 0, 1), 'boss damage differs by weapon');
  ok(C.HP.max === 1000, 'player HP 1,000');
}

// 15) PvP: 모든 무기가 다른 접속자의 HP 를 깎는다(공격자 판정 → 맞은 쪽이 표로 피해 결정) · 몸 판정 · 메시지 · 거리·간격 검증
{
  const HPM = C.HP.max;
  // 피해 표(배율 전, HP 1,000 기준 처치 횟수 설계): 무기 12가지(맨손·검 베기·검기·난무·死·소총·산탄·권총·저격·수류탄·RPG)가 모두 0 보다 크다
  const rows = [['punch', C.pvpBaseDmgFor(1, 'm', 0, 1)], ['sword', C.pvpBaseDmgFor(2, 'm', 0, 1)], ['sword3', C.pvpBaseDmgFor(2, 'm', 2, 1)], ['slash', C.pvpBaseDmgFor(2, 'sl', 0, 1)], ['rush', C.pvpBaseDmgFor(2, 'm', 0, 1, 'r')], ['death', C.pvpBaseDmgFor(2, 'm', 0, 1, 'u')],
    ['rifle', C.pvpBaseDmgFor(3, 'm', 0, 1)], ['shotgun', C.pvpBaseDmgFor(4, 'm', 0, 7)], ['pistol', C.pvpBaseDmgFor(5, 'm', 0, 1)], ['sniper', C.pvpBaseDmgFor(7, 'm', 0, 1)], ['grenade', C.pvpBaseDmgFor(6, 'm', 0, 0)], ['rocket', C.pvpBaseDmgFor(8, 'm', 0, 0)]];
  ok(rows.every(([, d]) => d && d.amount > 0 && d.cd > 0), 'every weapon hurts players');
  const by = Object.fromEntries(rows.map(([k, d]) => [k, d.amount]));
  ok(by.punch === C.HURT.punch, 'fist: the punch event and the table agree');
  ok(rows.every(([, d]) => d.amount < HPM), 'no weapon one-shots a full-HP player');
  const hits = (amt) => Math.ceil(HPM / amt);
  ok(hits(by.rifle) >= 20 && hits(by.rifle) <= 40 && hits(by.pistol) >= 15 && hits(by.pistol) <= 30, 'rifle / pistol: dozens of hits (about 4-5 s of fire)');
  ok(hits(by.sniper) === 3 && hits(by.rocket) === 2 && hits(by.death) === 2 && hits(by.grenade) === 3, 'sniper 3 shots · RPG 2 · 死 2 · gift grenade 3');
  ok(hits(by.shotgun) >= 5 && hits(by.shotgun) <= 8 && hits(by.sword3) <= 12 && hits(by.slash) <= 25, 'shotgun a handful of blasts · sword a dozen swings');
  ok(by.sniper > by.shotgun && by.rocket > by.sniper && by.rifle < by.pistol && by.punch < by.sword, 'heavier weapons hit harder');
  // PvP 배율: 플레이어 → 플레이어 피해에만 PVP_SCALE(약 0.35) 을 곱한다. 보스·몬스터 피해는 그대로
  ok(C.PVP_SCALE > 0.3 && C.PVP_SCALE < 0.4, 'PvP scale is about 0.35');
  const scaled = [['punch', [1, 'm', 0, 1]], ['sword', [2, 'm', 0, 1]], ['slash', [2, 'sl', 0, 1]], ['rush', [2, 'm', 0, 1, 'r']], ['death', [2, 'm', 0, 1, 'u']], ['rifle', [3, 'm', 0, 1]], ['shotgun', [4, 'm', 0, 7]], ['pistol', [5, 'm', 0, 1]], ['sniper', [7, 'm', 0, 1]], ['grenade', [6, 'm', 0, 0]], ['rocket', [8, 'm', 0, 0]]];
  ok(scaled.every(([, a]) => C.pvpDmgFor(...a).amount === Math.round(C.pvpBaseDmgFor(...a).amount * C.PVP_SCALE) && C.pvpDmgFor(...a).amount < C.pvpBaseDmgFor(...a).amount), 'every PvP hit = table x PVP_SCALE (and smaller than the table)');
  ok(C.pvpDmgFor(3, 'm', 0, 1).amount === Math.round(12 * C.PVP_MULT.rifle * C.PVP_SCALE) && C.pvpDmgFor(3, 'm', 0, 1).amount < by.rifle, 'M4A1: one bullet hits a player for 36 x 0.35');
  ok(C.pvpScaled(C.HURT.punch) === C.pvpDmgFor(1, 'm', 0, 1).amount, 'fist: the punch event path and the PvP table agree after scaling');
  ok(Math.ceil(HPM / C.pvpDmgFor(3, 'm', 0, 1).amount) > Math.ceil(HPM / by.rifle) * 2, 'M4A1 magazine (30 rounds) no longer comes close to a kill');
  // 보스·몬스터 피해는 PvP 배율의 영향을 받지 않는다: 플레이어가 보스에게 주는 피해(dmgFor) 와 보스가 플레이어에게 주는 값(HURT)
  ok(C.dmgFor(3, 'm', 0, 1).amount === C.WEAPONS[3].dmg && C.dmgFor(7, 'm', 0, 1).amount === C.WEAPONS[7].dmg && C.dmgFor(5, 'm', 0, 1).amount === C.WEAPONS[5].dmg, 'damage dealt to bosses is unscaled');
  ok(C.HURT.swipe === 165 && C.HURT.spit === 90 && C.HURT.bite === 52 && C.HURT.punch === 45, 'damage dealt by bosses / monsters is unscaled');
  ok(/hurtMe\(pvpScaled\(HURT\.punch\), who\)/.test(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')), 'player punch event applies the PvP scale');
  ok(/h\.dmg \* BOSS_DMG_K : HURT\[/.test(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')) && !/BOSS_DMG_K[^\n]*pvpScaled|pvpScaled[^\n]*BOSS_DMG_K/.test(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')), 'boss hits to the player do not use the PvP scale');
  // 거리 감쇠: 폭발은 가까울수록 센 피해, 반경 밖은 0
  ok(C.pvpDmgFor(8, 'm', 0, 0).amount > C.pvpDmgFor(8, 'm', 0, C.ROCKET.r / 2).amount && C.pvpDmgFor(8, 'm', 0, C.ROCKET.r) .amount < C.pvpDmgFor(8, 'm', 0, 1).amount && C.pvpDmgFor(6, 'm', 0, 0).amount > C.pvpDmgFor(6, 'm', 0, 4).amount, 'explosions: closer = more damage');
  ok(C.pvpDmgFor(0, 'm', 0, 1) === null && C.pvpDmgFor(9, 'm', 0, 1) === null, 'unknown weapon: no damage');
  ok(C.pvpDmgFor(4, 'm', 0, 99).amount === C.pvpDmgFor(4, 'm', 0, 7).amount, 'pellet count is clamped to the gun');
  ok(Object.keys(C.PVP_MULT).every((k) => C.DMG_CD[k] > 0) && Object.keys(C.PVP_KNOCK).every((k) => k in C.PVP_MULT), 'tables share the same weapon keys');

  // 몸 판정: 발 (0,0,-10) 에 선 사람. 가슴 높이 1.3 m 에서 정면으로 쏘면 맞고, 옆으로 2 m 비키거나 머리 위로 쏘면 빗나간다
  const hit = C.rayBody(0, 1.3, 0, 0, 0, -1, 0, 0, -10, 100), miss1 = C.rayBody(0, 1.3, 0, 0, 0, -1, 2, 0, -10, 100), miss2 = C.rayBody(0, 2.6, 0, 0, 0, -1, 0, 0, -10, 100), feet = C.rayBody(0, 0.3, 0, 0, 0, -1, 0, 0, -10, 100), tooShort = C.rayBody(0, 1.3, 0, 0, 0, -1, 0, 0, -10, 5);
  ok(near(hit, 9.5, 0.1) && miss1 === -1 && miss2 === -1 && feet > 9 && tooShort === -1, 'bullet vs body capsule: chest/feet hit, side/over-the-head/out-of-range miss');
  ok(C.distToBody(0, 1.0, -1.0, 0, 0, 0) < 0.55 && C.distToBody(0, 1.0, 0.3, 0, 0, 0) === 0 && near(C.distToBody(3, 1.0, 0, 0, 0, 0), 3 - C.BODY.r, 1e-9) && C.distToBody(0, 6, 0, 0, 0, 0) > 3.5, 'blast / blade distance is measured to the body surface');

  // 메시지: 발사에 맞은 접속자 목록(v) · 접속자 피해 보고(p). 옛 형식과 섞여도 안전
  const f = C.sanitizeWpn(JSON.parse(JSON.stringify(C.wpnMsg.fire(4, [1, 2, 3], [0, 0, -1], 30, 0, 7, null, 0.5, [['abc123', 3], ['xyz9', 1]]))));
  ok(f && f.v.length === 2 && f.v[0][0] === 'abc123' && f.v[0][1] === 3, 'a shot carries the players it hit');
  ok(C.sanitizeWpn(C.wpnMsg.fire(3, [1, 2, 3], [0, 0, -1], 30, 0, 7)).v === undefined && C.sanitizeWpn(C.wpnMsg.fire(3, [1, 2, 3], [0, 0, -1], 30, 0, 7, null, 0, [])).v === undefined, 'no victims: no field (old format)');
  ok(C.sanitizeWpn({ k: 'f', w: 3, o: [0, 0, 0], d: [0, 0, -1], v: [['a b', 1]] }) === null && C.sanitizeWpn({ k: 'f', w: 3, o: [0, 0, 0], d: [0, 0, -1], v: 'x' }) === null && C.sanitizeWpn({ k: 'f', w: 3, o: [0, 0, 0], d: [0, 0, -1], v: [['a', 1], ['b', 1], ['c', 1], ['d', 1]] }) === null && C.sanitizeWpn({ k: 'f', w: 3, o: [0, 0, 0], d: [0, 0, -1], v: [['a', 'x']] }) === null, 'bad victim lists are refused');
  const pm = C.sanitizeWpn(JSON.parse(JSON.stringify(C.wpnMsg.pvp('victim01', 2, 1, true, 1))));
  ok(pm && pm.k === 'p' && pm.t === 'victim01' && pm.w === 2 && pm.c === 1 && pm.sl === 1, 'sword slash report ok');
  const um2 = C.sanitizeWpn(C.wpnMsg.pvp('v1', 2, 0, false, 1, 'u')), rm = C.sanitizeWpn(C.wpnMsg.pvp('v1', 8, 0, false, 3.456)), gm = C.sanitizeWpn(C.wpnMsg.pvp('v1', 6, 0, false, 99));
  ok(um2.x === 'u' && rm.n === 3.46 && gm.n === C.GREN.r, 'ultimate kind kept · rocket / grenade distance clamped');
  ok(C.sanitizeWpn({ k: 'p', w: 3, n: 1 }) === null && C.sanitizeWpn({ k: 'p', t: '', w: 3 }) === null && C.sanitizeWpn({ k: 'p', t: 'a/b', w: 3 }) === null && C.sanitizeWpn({ k: 'p', t: 'ok', w: 99 }).w === 8 && C.sanitizeWpn({ k: 'p', t: 'ok', w: 3, x: 'u' }).x === undefined, 'player report: needs a clean target id, weapon range clamped, only the sword claims 死/난무');
  ok(JSON.stringify(C.wpnMsg.fire(4, [1.1, 2.2, 3.3], [0.1, 0.2, -0.97], 30, 3, 4294967295, ['b', 0], 1, [['abcdefghij0123', 7], ['abcdefghij0124', 7], ['abcdefghij0125', 7]])).length < 500, 'a shot message stays small');

  // 맞은 쪽 검증: 닿는 거리(무기별) · 간격은 index/weapons.js 가 이 표로 한다
  ok(C.pvpReachOk(3, 'm', 100) && !C.pvpReachOk(3, 'm', 400) && C.pvpReachOk(7, 'm', 230) && !C.pvpReachOk(5, 'm', 300), 'guns: range + lag slack');
  ok(C.pvpReachOk(2, 'm', 6) && !C.pvpReachOk(2, 'm', 30) && C.pvpReachOk(2, 'sl', 35) && !C.pvpReachOk(2, 'sl', 80) && C.pvpReachOk(2, 'u', 50) && !C.pvpReachOk(2, 'u', 120) && !C.pvpReachOk(2, 'r', 30), 'sword: melee / slash / 死 / rush reach');
  ok(C.pvpReachOk(6, 'm', 40) && !C.pvpReachOk(6, 'm', 100) && C.pvpReachOk(8, 'm', 120) && !C.pvpReachOk(8, 'm', 200) && C.pvpReachOk(1, 'm', 5) && !C.pvpReachOk(1, 'm', 30), 'grenade / RPG / fist reach');

  // 죽은 사람 · 무적은 맞지 않는다 (hpHit)
  const sn = C.pvpDmgFor(7, 'm', 0, 1).amount, need = Math.ceil(HPM / sn), v = C.newHp(); for (let i = 0; i < need - 1; i++) C.hpHit(v, sn, i + 1);
  ok(!v.dead && C.hpHit(v, sn, need) === 'dead' && v.deaths === 1 && C.hpHit(v, 100, need + 2) === null, 'enough scaled sniper shots drop a full-HP player; the body takes no more');
}

// 16) 띠용·유령 연출 곡선, 사망 화면·부활 버튼·설정 패널 (정적 확인)
{
  const e = boing(0), pk = Math.max(...Array.from({ length: 140 }, (_, i) => boing(i * 0.01).y));
  ok(e.y === 0 && e.sx === 1 && e.sy === 1 && pk > 1.0 && pk < 1.3, 'boing: starts level, hops about 1.15 m');
  const eps = 1e-6, edges = [0.1, 0.62, 0.86, 1.2, BOING_T];
  ok(edges.every((t) => { const a = boing(t - eps), b = boing(t + eps); return Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.sx - b.sx) < 1e-3 && Math.abs(a.sy - b.sy) < 1e-3; }), 'boing is continuous (no snaps between phases)');
  ok(boing(0.095).sy < 0.8 && boing(0.36).sy > 1.08 && boing(0.74).sy < 0.8 && boing(BOING_T).sy === 1 && boing(5).y === 0 && boing(-1).y === 0 && boing(NaN).sx === 1, 'boing: squash -> stretch -> landing squash -> level');
  let over = 0; for (let t = 0; t < 0.4; t += 0.005) over = Math.max(over, pop(t));
  ok(pop(0) === 0 && over > 1.15 && Math.abs(pop(0.9) - 1) < 0.01, 'ghost pop: springs past full size and settles');
  ok(wobble(0) === 0 && Math.abs(wobble(0.05)) > 0.1 && Math.abs(wobble(1.2)) < 0.01, 'ghost squash-and-stretch dies out');
  ok(alphaAt(-1) === 0 && alphaAt(0) === 0 && near(alphaAt(0.5), GHOST.alpha) && alphaAt(GHOST.life - 0.01) < 0.05 && alphaAt(GHOST.life) === 0 && alphaAt(2.2) < alphaAt(1.9) && alphaAt(0.5) < 1, 'ghost: translucent, fades out by 2.8 s');
  ok(riseAt(0) === 0 && riseAt(1) > 1 && riseAt(GHOST.life) === GHOST.rise && riseAt(2) > riseAt(1), 'ghost keeps rising');
  const ghostSrc = fs.readFileSync(new URL('../bf/ghost.js', import.meta.url), 'utf8'), wsrc = fs.readFileSync(new URL('../bf/weapons.js', import.meta.url), 'utf8');
  ok(/function rocketFrame[\s\S]*playerRay\(\{ x: px, y: py, z: pz \}/.test(wsrc) && /owner: rec && rec\.rid/.test(wsrc), 'a rocket also explodes on touching a player (not only ground / boss)');
  ok(/warm\(renderer\)/.test(ghostSrc) && /GHOSTS\.warm\(renderer\)/.test(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')), 'ghost shaders are compiled on entering (no hitch at the first death)');
  ok(/MeshBasicMaterial\(\{ color: 0xeaf5ff, transparent: true, opacity: 0/.test(ghostSrc) && /DoubleSide/.test(ghostSrc), 'ghost is a translucent shell');
  ok(/kind === 'boing'/.test(wsrc) && /kind === 'ghost'/.test(wsrc) && /createOscillator/.test(wsrc) && !/\.(mp3|ogg|wav)/.test(wsrc + ghostSrc), 'sound effects are synthesised (no audio files)');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/<button id="respawnBtn"[^>]*>즉시 리스폰/.test(html) && /id="downArc"/.test(html) && /<b id="downT">5<\/b>/.test(html) && /자동 부활/.test(html), 'down card: instant-respawn button, countdown number, ring, auto-respawn text');
  ok(/stroke-dashoffset/.test(html) && /respawnLeft\(MYHP, now\)/.test(html) && /canInstantRespawn\(MYHP, now\)/.test(html), 'ring and button follow the respawn timer');
  ok(/hpTick\(MYHP, now, dt\) === 'respawn'\) afterRespawn\(\)/.test(html) && /function respawnMe\(auto\)/.test(html) && /hpRespawn\(MYHP, now\); afterRespawn\(\)/.test(html), 'the timer and the button share one respawn path');
  ok(/e\.key === 'Enter' && MYHP\.dead/.test(html) && /document\.exitPointerLock\(\)/.test(html.slice(html.indexOf('function hurtMe'), html.indexOf('function hurtByPlayer'))), 'Enter respawns while down; the cursor is released for the button');
  ok(/deathFx\(rec, q\.dead, false\)/.test(html) && /deathFx\(meRec, MYHP\.dead, true\)/.test(html) && /GHOSTS\.spawn\(/.test(html) && /WP\.sfx\('boing'/.test(html) && /WP\.sfx\('ghost'/.test(html), 'ghost + sounds fire for me and for everyone else (from presence)');
  ok(/players: pvpPlayers, canBeHit:[^\n]*hurtPlayer: hurtByPlayer/.test(html) && /rec\.mq \|\| !rec\.rid \|\| \(rec\.hpNet && rec\.hpNet\.dead\)/.test(html), 'weapons see only live, real players');
  const css = (id) => (html.match(new RegExp('\\n#' + id + ' \\{([^}]*)\\}')) || [])[1] || '';
  ok(/top:/.test(css('setPanel')) && /top:/.test(css('tools')) && !/top:/.test(css('acts')), 'settings / options sit top right, away from the bottom-right combat buttons');
  ok(/bottom:/.test(css('fun')) && /left:/.test(css('fun')) && ['lanternBtn', 'fwBtn', 'bossBtn'].every((id) => html.indexOf('id="' + id + '"') > html.indexOf('<div id="fun"') && html.indexOf('id="' + id + '"') < html.indexOf('<div id="tools"')), 'lanterns / fireworks / boss buttons sit above the chat');
  const actsHtml = html.slice(html.indexOf('<div id="acts"'), html.indexOf('</div>', html.indexOf('<div id="acts"')));
  ok(!/emoteBtn|lanternBtn|setBtn/.test(actsHtml), 'bottom right holds combat buttons only');
}
console.log(`${n - fails}/${n} weapon checks passed`);
if (fails) process.exit(1);
