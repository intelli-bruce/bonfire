// node tools/weapons.test.mjs — bf/weapons-core.js(슬롯·탄약·콤보·피해 표·광선 수학·메시지 검증) 와 bf/spider.js 의 hitRay / 무기별 피해 쿨다운을 THREE 없이 확인한다.
import fs from 'node:fs';
import * as C from '../bf/weapons-core.js';
import { createSpiderBoss, BOSS } from '../bf/spider.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
console.warn = () => {};

// 1) 슬롯 · 키 배정: 1~7 은 무기(1 맨손 2 검 3 M4A1 4 산탄총 5 권총 6 수류탄 7 저격총), 감정은 8·9·0 으로 옮겼다(컨트롤러 키맵에서 확인)
{
  ok(Object.keys(C.SLOT_KEYS).join() === 'Digit1,Digit2,Digit3,Digit4,Digit5,Digit6,Digit7', 'weapon keys are 1-7');
  ok(['fist', 'sword', 'rifle', 'shotgun', 'pistol', 'grenade', 'sniper'].every((k, i) => C.WEAPONS[i + 1].key === k), 'slot table 1..7');
  ok(C.wrapSlot(1, -1) === 7 && C.wrapSlot(7, 1) === 1 && C.wrapSlot(2, 1) === 3 && C.wrapSlot(3, -1) === 2, 'wheel wraps 1..7');
  ok(C.GUN_SLOTS.join() === '3,4,5,7' && !C.isGun(6) && !C.isGun(2), 'guns are 3 4 5 7');
  ok(C.WEAPONS[5].mag === 12 && !Number.isFinite(C.WEAPONS[5].reserve) && C.WEAPONS[7].mag === 5 && !Number.isFinite(C.WEAPONS[7].reserve), 'pistol 12/∞, sniper 5/∞');
  ok(C.WEAPONS[7].dmg >= 5 * C.WEAPONS[5].dmg && C.WEAPONS[7].bolt > 0 && C.WEAPONS[7].interval >= C.WEAPONS[7].bolt, 'sniper: heavy damage, bolt action paces the shots');
  const ctl = fs.readFileSync(new URL('../bf/kit/controller.js', import.meta.url), 'utf8');
  const km = ctl.match(/const KEYMAP = \{([^}]*)\}/)[1];
  ok(/Digit8: 'dance'/.test(km) && /Digit9: 'cheer'/.test(km) && /Digit0: 'nod'/.test(km), 'emotes moved to 8 9 0');
  ok(!/Digit[1-7]\b/.test(km), 'controller no longer takes 1-7');
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
  ok(C.dmgFor(1, 'm', 0, 1).amount === 10, 'punch 10');
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
  ok(sp.damage('boss', 0, 999, 'r|x', 100) === true && sp.view.hp === hp0 - 6 - 14 - 28 - 40, 'a single hit is still capped (40)');
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
  ok(/const weaponKey = \(e\) => \(SLOT_KEYS\[e\.code\] \|\| e\.code === 'KeyR'\) && !e\.ctrlKey && !e\.metaKey && !e\.altKey/.test(html), 'weapon keys = 1~7 and R without Ctrl/Meta/Alt (Ctrl+R still reloads the browser)');
  ok(/window\.addEventListener\('mousedown', \(e\) => \{ if \(e\.button === 2/.test(html) && /rightDown\(\)/.test(html) && /\$\('altBtn'\)/.test(html), 'right mouse button / mobile button: aim, ultimate');
  ok(/8 춤 · 9 환호 · 0 끄덕 · 1~7 무기/.test(html), 'help text names the new keys');
  ok(/if \(!text \|\| !netLive\(\)\) \{ chatInput\.blur\(\);/.test(html), 'an empty chat Enter gives the keyboard back to the game');
  ok(/textContent = Number\.isFinite\(g\.reserve\) \? g\.reserve : '∞'/.test(html), 'HUD shows ∞ for the reserve');
}

// 13) 총구: 모든 총 모델에 muzzle 노드가 있고, 탄·섬광은 그 프레임 자세가 끝난 뒤(poseUpdate → flushShots) 총구에서 나온다
{
  const nodes = (f) => { const b = fs.readFileSync(new URL('../bf/' + f, import.meta.url)); const len = b.readUInt32LE(12); return JSON.parse(b.slice(20, 20 + len).toString('utf8')).nodes.map((q) => q.name); };
  for (const [f, need] of [['m4a1.glb', ['muzzle', 'grip_r', 'mag']], ['shotgun.glb', ['muzzle', 'grip_r']], ['pistol.glb', ['muzzle', 'grip_r', 'slide', 'mag']], ['sniper.glb', ['muzzle', 'grip_r', 'bolt', 'mag']], ['grenade.glb', ['grip']]]) {
    const ns = nodes(f); ok(need.every((k) => ns.includes(k)), `${f} has ${need.join(', ')}`);
  }
  const js = fs.readFileSync(new URL('../bf/weapons.js', import.meta.url), 'utf8');
  ok(/function afterUpdate\(rec, dt, now\) \{\s*if \(!rec\.wp\) return;\s*poseUpdate\(rec, dt, now\);\s*flushShots\(rec\);/.test(js), 'shots are drawn after this frame\'s pose');
  ok(/function flushShots[\s\S]*?muzzleWorld\(rec, s\.slot, o\)/.test(js) && /queueShot\(rec, m\.w, ends, sent, false\)/.test(js), 'mine and remote shots start at the muzzle seen on this screen');
}

console.log(`${n - fails}/${n} weapon checks passed`);
process.exit(fails ? 1 : 0);
