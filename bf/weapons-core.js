// bf/weapons-core.js — 무기 로직(순수 함수, THREE·DOM 없음: node 로 테스트한다).
//   슬롯 표·탄약 상태기계(발사·장전·자동 장전)·검 콤보·피해 표(받는 쪽 검증)·광선/캡슐 교차 수학·네트워크 메시지 검증.
// 화면·모델·소리는 bf/weapons.js, 피해 반영은 bf/spider.js 의 damage()/hitRay() 가 맡는다.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const fin = (v, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : null);
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- 슬롯 표 (1 맨손 · 2 검 · 3 M4A1 · 4 산탄총 · 5 권총 · 6 수류탄 · 7 저격총) ----------
export const SLOT_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Digit6: 6, Digit7: 7 };   // 감정 표현은 8·9·0 으로 옮겼다
export const WEAPONS = {
  1: { id: 1, key: 'fist', name: '맨손', hint: '내려찍기', gun: false },
  2: { id: 2, key: 'sword', name: '검', hint: '3연 베기 + 검기', gun: false },
  3: { id: 3, key: 'rifle', name: 'M4A1', hint: '연사', gun: true, mag: 30, reserve: Infinity, interval: 0.095, auto: true, dmg: 6, pellets: 1, spread: 0.010, range: 160, reloadT: 1.9, reloadEmptyT: 2.5, kick: 0.012 },
  4: { id: 4, key: 'shotgun', name: '산탄총', hint: '산탄 7발', gun: true, mag: 6, reserve: Infinity, interval: 0.85, auto: false, dmg: 4, pellets: 7, spread: 0.060, range: 55, shellT: 0.42, reloadT: 0.6, kick: 0.05 },
  5: { id: 5, key: 'pistol', name: '권총', hint: '반자동 12발', gun: true, mag: 12, reserve: Infinity, interval: 0.15, auto: false, dmg: 9, pellets: 1, spread: 0.014, range: 110, reloadT: 1.25, reloadEmptyT: 1.55, kick: 0.02 },
  6: { id: 6, key: 'grenade', name: '수류탄', hint: '던지기 · 범위 폭발', gun: false, throwable: true },
  7: { id: 7, key: 'sniper', name: '저격총', hint: '볼트액션 5발', gun: true, mag: 5, reserve: Infinity, interval: 1.25, auto: false, dmg: 70, pellets: 1, spread: 0.050, range: 240, reloadT: 2.6, reloadEmptyT: 2.9, kick: 0.09, bolt: 0.95 },
};
export const SLOT_COUNT = 7;
export const GUN_SLOTS = [3, 4, 5, 7];
export const isGun = (s) => s === 3 || s === 4 || s === 5 || s === 7;

// ---------- 조준(우클릭 누르는 동안): 확대 배율 · 퍼짐 배율 · 이동 속도 ----------
// 소총·산탄총·권총은 약 1.3~1.5배 줌, 저격총은 스코프(6배). 조준하면 탄이 덜 퍼지고(명중률 상승) 저격총은 정확히 한 점으로 간다
export const ADS = {
  3: { zoom: 1.5, spread: 0.3, move: 0.55 },
  4: { zoom: 1.25, spread: 0.65, move: 0.6 },
  5: { zoom: 1.35, spread: 0.35, move: 0.65 },
  7: { zoom: 6, spread: 0, move: 0.35, scope: true },
};
// 조준 정도 a(0..1)에서 퍼짐: 서서 쏘기 1 → 조준 ADS.spread. 움직이면 1.5배(조준 중엔 1.15배)
export function spreadFor(slot, a, moving) {
  const w = WEAPONS[slot]; if (!w || !w.gun) return 0;
  const z = ADS[slot], k = 1 + ((z ? z.spread : 1) - 1) * clamp(a, 0, 1);
  return w.spread * k * (moving ? lerp(1.5, 1.15, clamp(a, 0, 1)) : 1);
}
// 기본 시야 base(도)에서 조준 a 만큼 확대한 시야(도)
export const adsFov = (base, slot, a) => { const z = ADS[slot]; if (!z || !(a > 0)) return base; const k = lerp(1, z.zoom, clamp(a, 0, 1)); return 2 * Math.atan(Math.tan(base * Math.PI / 360) / k) * 180 / Math.PI; };
function lerp(a, b, t) { return a + (b - a) * t; }
export const SWITCH_T = 0.15;   // 무기를 바꿀 때 팔이 올라오는 시간(s). 바꾸자마자 쏠 수 있다(애니메이션을 기다리지 않는다)
export const wrapSlot = (s, dir) => ((s - 1 + (dir > 0 ? 1 : -1) + SLOT_COUNT) % SLOT_COUNT) + 1;
export const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= SLOT_COUNT;

// ---------- 검 콤보: 3연 베기. 마지막 한 방이 크고 검기도 커진다 ----------
export const COMBO = [
  { dur: 0.42, hit: 0.18, melee: 12, slash: 8, scale: 1.0, reach: 2.6 },
  { dur: 0.42, hit: 0.18, melee: 12, slash: 8, scale: 1.0, reach: 2.6 },
  { dur: 0.62, hit: 0.28, melee: 18, slash: 14, scale: 1.55, reach: 3.2 },
];
export const COMBO_WINDOW = 0.55;     // 앞 동작이 끝난 뒤 이 안에 다시 누르면 다음 단계
export const SLASH = { speed: 24, life: 1.25, r: 2.0, h: 1.0, range: 30 };   // 검기: 초속 24 m, 약 30 m 날아감
// 좌클릭 한 번 = 베기 한 번 = 검기 한 발. 클릭이 빠르면 그만큼 빨리 나간다: 최소 간격 SWORD_MIN 만 두고, 앞 동작은 끊고 다음 동작을 시작한다.
// 검기는 클릭 뒤 SWORD_LAUNCH 초에 나간다(동작 길이와 상관없이).
export const SWORD_MIN = 0.14, SWORD_LAUNCH = 0.07;

export function newSword() { return { step: -1, startAt: -1e9, endAt: -1e9, ultAt: -1e9 }; }
// 지금 누르면 몇 번째 베기인가? 최소 간격 안이면 -1. 앞 동작 중이거나 끝난 뒤 COMBO_WINDOW 안이면 다음 단계(3타 뒤는 1타로)
export function swordNext(st, now) {
  if (now < st.startAt + SWORD_MIN) return -1;
  if (now < (st.ultUntil || -1e9)) return -1;                                    // 궁극기 난무 중엔 일반 베기 없음
  const prev = st.step >= 0 ? COMBO[st.step] : null;
  if (prev && now <= st.endAt + COMBO_WINDOW) return (st.step + 1) % 3;
  return 0;
}

// ---------- 검 궁극기(우클릭): 아주 빠른 난무 → 「死」 모양 거대 검기. 쿨타임 15 s ----------
export const ULT = { cd: 15, rushT: 0.9, rushHits: 9, rushDmg: 5, rushReach: 3.6, deathDmg: 80, speed: 30, life: 1.6, r: 4.2, range: 48, size: 5.2 };
export const ultLeft = (st, now) => Math.max(0, (st.ultAt + ULT.cd) - now);
export const ultReady = (st, now) => ultLeft(st, now) <= 0 && now >= (st.ultUntil || -1e9);
export function ultStart(st, now) {
  if (!ultReady(st, now)) return false;
  st.ultAt = now; st.ultUntil = now + ULT.rushT + 0.25; st.step = -1; st.startAt = now; st.endAt = now;
  return true;
}
// 난무의 i 번째 타격 시각(시작 기준 s): 앞은 빠르게, 끝으로 갈수록 더 빠르게
export const ultHitT = (i) => ULT.rushT * Math.pow((i + 1) / ULT.rushHits, 0.85) * 0.92;

// ---------- 수류탄: 던지기 · 포물선 · 튕김 · 지연 폭발 · 범위 피해 ----------
export const GREN = { speed: 17, up: 0.32, g: 15, fuse: 2.2, cd: 1.1, bounce: 0.42, friction: 0.62, r: 6.5, dmg: 55, minDmg: 8, radius: 0.08 };
// 던지는 속도: 카메라 방향(yaw, pitch)으로 앞·위. pitch 는 카메라 기준(위를 보면 음수)
export function throwVel(yaw, pitch, power = 1) {
  const up = clamp(-pitch + GREN.up, -0.3, 1.2), c = Math.cos(up), s = GREN.speed * power;
  return [-Math.sin(yaw) * c * s, Math.sin(up) * s, -Math.cos(yaw) * c * s];
}
// 한 단계 적분(지면에서 튕김). p, v 는 [x,y,z] 배열(제자리 수정). ground(x, z, y) → 지면 높이. 반환: 이번에 튕겼으면 true
export function grenadeStep(p, v, dt, ground) {
  v[1] -= GREN.g * dt;
  p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
  const g = ground(p[0], p[2], p[1] + 0.4) + GREN.radius;
  if (p[1] < g) {
    p[1] = g;
    const hit = v[1] < -1.2;
    v[1] = hit ? -v[1] * GREN.bounce : 0; v[0] *= GREN.friction; v[2] *= GREN.friction;
    if (!hit) { v[0] *= 0.9; v[2] *= 0.9; }
    return hit;
  }
  return false;
}
// 궤적 미리보기: 점 목록(첫 착지까지 + 튕김 한 번) — 화면 표시와 테스트가 같은 적분을 쓴다
export function grenadeArc(o, v0, ground, maxT = GREN.fuse, dt = 1 / 30) {
  const p = o.slice(), v = v0.slice(), pts = [p.slice()]; let bounces = 0, land = null;
  for (let t = 0; t < maxT; t += dt) {
    if (grenadeStep(p, v, dt, ground)) { bounces++; if (!land) land = p.slice(); }
    pts.push(p.slice());
    if (bounces >= 1 && pts.length > 2 && Math.hypot(v[0], v[1], v[2]) < 0.5) break;
  }
  return { pts, land: land || p.slice() };
}
// 폭발 피해: 중심에서 거리 d 에 따라 dmg → minDmg 로 줄고 r 밖은 0
export const grenadeDmg = (d) => (d > GREN.r ? 0 : Math.round(GREN.minDmg + (GREN.dmg - GREN.minDmg) * (1 - clamp(d / GREN.r, 0, 1)) ** 1.3));
export function swordSwing(st, now) {
  const n = swordNext(st, now); if (n < 0) return -1;
  st.step = n; st.startAt = now; st.endAt = now + COMBO[n].dur;
  return n;
}

// ---------- 탄약 상태기계 ----------
export function newGun(slot) {
  const w = WEAPONS[slot]; if (!w || !w.gun) return null;
  return { slot, mag: w.mag, reserve: w.reserve, nextAt: 0, reload: null };   // reload: { t0, until, need, shell }
}
export const fireState = (g, now) => {
  if (!g) return 'none';
  if (g.reload && !(WEAPONS[g.slot].shellT && g.mag > 0)) return 'reloading';   // 산탄총은 한 발이라도 들어 있으면 장전 중에도 쏠 수 있다(장전 끊김)
  if (now < g.nextAt) return 'cooldown';
  if (g.mag <= 0) return 'empty';
  return 'ok';
};
export function fireOnce(g, now) {
  if (fireState(g, now) !== 'ok') return false;
  const w = WEAPONS[g.slot];
  if (g.reload) g.reload = null;
  g.mag--; g.nextAt = now + w.interval;
  return true;
}
export function startReload(g, now) {
  if (!g || g.reload) return false;
  const w = WEAPONS[g.slot], need = w.mag - g.mag;
  if (need <= 0 || g.reserve <= 0) return false;
  if (w.shellT) g.reload = { t0: now, until: now + w.reloadT + w.shellT, need: Math.min(need, g.reserve), shell: 0, empty: g.mag === 0 };
  else g.reload = { t0: now, until: now + (g.mag === 0 ? w.reloadEmptyT : w.reloadT), need: Math.min(need, g.reserve), shell: 0, empty: g.mag === 0 };
  return true;
}
export function tickReload(g, now) {   // 완료되면 true
  const r = g && g.reload; if (!r) return false;
  const w = WEAPONS[g.slot];
  if (w.shellT) {
    while (r.shell < r.need && now >= r.until) { g.mag++; g.reserve--; r.shell++; r.until += w.shellT; }
    if (r.shell >= r.need) { g.reload = null; return true; }
    return false;
  }
  if (now >= r.until) { const take = Math.min(w.mag - g.mag, g.reserve); g.mag += take; g.reserve -= take; g.reload = null; return true; }
  return false;
}
export const reloadT01 = (g, now) => { const r = g && g.reload; if (!r) return 0; return clamp((now - r.t0) / Math.max(0.01, r.until - r.t0), 0, 1); };
export const reserveText = (g) => (Number.isFinite(g.reserve) ? String(g.reserve) : '∞');   // 예비탄은 무제한(Infinity): 탄창 단위로만 장전한다
export const ammoText = (g) => (g ? `${g.mag} / ${reserveText(g)}` : '');
// 탄창이 비었고 예비탄이 있으면 자동 장전(쏜 뒤 연사 간격이 지나면). 장전 중이거나 총이 아니면 false
export const needsAutoReload = (g, now) => !!g && !g.reload && g.mag <= 0 && g.reserve > 0 && now >= g.nextAt;

// ---------- 날아가는 탄(눈에 보이는 탄두 + 짧은 궤적) ----------
// 총구에서 출발해 speed 로 날아간다. head: 탄두 끝까지의 거리, tail: 궤적 꼬리까지의 거리(0 = 총구에 붙어 있음). 맞는 지점(L)에 닿으면 탄두는 사라지고 꼬리가 따라잡아 끝난다.
export const BULLET = { speed: 150, trail: 4.5, start: 0.45 };
export function bulletPos(age, L, speed = BULLET.speed) {
  const raw = BULLET.start + Math.max(0, age) * speed;
  const head = Math.min(L, raw), tail = clamp(raw - BULLET.trail, 0, L);
  return { head, tail, arrived: raw >= L, done: raw - BULLET.trail >= L };
}
export const impactDelay = (L, speed = BULLET.speed) => Math.max(0, (L - BULLET.start) / speed);   // 맞는 효과(불꽃·먼지)는 탄이 닿을 때 보인다

// ---------- 소총 장전 애니메이션 단계(0..1 위에서): 탄창 빼기 → 새 탄창 끼우기 → 장전 손잡이 당기기(빈 탄창일 때만) ----------
// 반환: { magOut: 0..1 (탄창이 빠진 정도), magIn: 0..1, handle: 0..1 (손잡이 당긴 정도), tilt: 총 기울기 0..1 }
export function rifleReloadPose(u, empty) {
  const seg = (a, b, x) => clamp((x - a) / (b - a), 0, 1), sm = (t) => t * t * (3 - 2 * t);
  const tEnd = empty ? 0.76 : 1.0;                              // 빈 탄창은 끝 24 % 에 장전 손잡이를 당긴다
  const x = clamp(u / tEnd, 0, 1);
  const out = sm(seg(0.06, 0.28, x)), inn = sm(seg(0.5, 0.78, x));
  const mag = x < 0.28 ? out : (x < 0.5 ? 1 : 1 - inn);        // 0 끼워짐 → 1 완전히 뺌 → (옛 탄창은 떨어짐) → 새 탄창을 올려 끼움
  const hu = empty ? seg(0.76, 1.0, u) : 0;
  const handle = empty ? (hu < 0.4 ? sm(hu / 0.4) : 1 - sm((hu - 0.4) / 0.6)) : 0;
  const tilt = (x < 0.82 ? sm(seg(0.0, 0.14, x)) : 1 - sm(seg(0.82, 1.0, x)));
  return { mag: clamp(mag, 0, 1), magGone: x >= 0.28 && x < 0.5, handle, tilt };
}

// ---------- 피해 표 (받는 쪽 소유자가 이 표로 피해를 정한다: 보낸 사람이 말한 값은 믿지 않는다) ----------
export const DMG_CD = { punch: 220, sword: 120, slash: 80, rifle: 70, shotgun: 450, pistol: 120, sniper: 900, grenade: 300, rush: 70, death: 600 };   // 공격자별 최소 간격(ms)
export function dmgFor(w, how, c, n) {
  if (w === 1) return { amount: 10, cd: DMG_CD.punch, key: 'punch' };
  if (w === 2) {
    const s = COMBO[clamp(Math.round(c) || 0, 0, 2)];
    return how === 'sl' ? { amount: s.slash, cd: DMG_CD.slash, key: 'slash' } : { amount: s.melee, cd: DMG_CD.sword, key: 'sword' };
  }
  if (w === 3) return { amount: WEAPONS[3].dmg, cd: DMG_CD.rifle, key: 'rifle' };
  if (w === 4) { const k = clamp(Math.round(n) || 1, 1, WEAPONS[4].pellets); return { amount: WEAPONS[4].dmg * k, cd: DMG_CD.shotgun, key: 'shotgun' }; }
  if (w === 5) return { amount: WEAPONS[5].dmg, cd: DMG_CD.pistol, key: 'pistol' };
  if (w === 7) return { amount: WEAPONS[7].dmg, cd: DMG_CD.sniper, key: 'sniper' };
  if (w === 6) { const d = clamp(Number(n) || 0, 0, GREN.r); return { amount: grenadeDmg(d), cd: DMG_CD.grenade, key: 'grenade' }; }   // n = 폭발 중심에서의 거리(m)
  return null;
}
// 검 궁극기 피해: how 'r' 난무 한 타 · 'u' 死 검기
export function ultDmg(how) {
  if (how === 'r') return { amount: ULT.rushDmg, cd: DMG_CD.rush, key: 'rush' };
  if (how === 'u') return { amount: ULT.deathDmg, cd: DMG_CD.death, key: 'death' };
  return null;
}

// ---------- 광선·캡슐 수학 (ray: o + t·d, |d| = 1) ----------
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxD) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz, tc = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tc * tc, r2_ = r * r;
  if (d2 > r2_) return -1;
  const th = Math.sqrt(r2_ - d2), t0 = tc - th, t1 = tc + th;
  const t = t0 >= 0 ? t0 : (t1 >= 0 ? 0 : -1);
  return t >= 0 && t <= maxD ? t : -1;
}
// 광선과 선분 a-b 의 최근접(굵기 r 의 캡슐): 맞으면 광선 위 거리 t, 아니면 -1
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r, maxD) {
  const ex = bx - ax, ey = by - ay, ez = bz - az, wx = ox - ax, wy = oy - ay, wz = oz - az;
  const B = dx * ex + dy * ey + dz * ez, C = ex * ex + ey * ey + ez * ez, D = dx * wx + dy * wy + dz * wz, E = ex * wx + ey * wy + ez * wz;
  const den = C - B * B;
  let u = den > 1e-9 ? (E - D * B) / den : 0.5;
  u = clamp(u, 0, 1);
  let t = clamp(u * B - D, 0, maxD);
  u = C > 1e-9 ? clamp((E + t * B) / C, 0, 1) : 0;
  t = clamp(u * B - D, 0, maxD);
  const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t, qx = ax + ex * u, qy = ay + ey * u, qz = az + ez * u;
  const d2 = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  if (d2 > r * r) return -1;
  return Math.max(0, t - Math.sqrt(r * r - d2));
}
// 세운 원기둥(축 = Y): 중심 (cx, cz), 반지름 r, 높이 y0..y1
export function rayCylY(ox, oy, oz, dx, dy, dz, cx, cz, r, y0, y1, maxD) {
  const px = ox - cx, pz = oz - cz, a = dx * dx + dz * dz;
  let t0, t1;
  if (a < 1e-9) { if (px * px + pz * pz > r * r) return -1; t0 = 0; t1 = maxD; }
  else {
    const b = px * dx + pz * dz, c = px * px + pz * pz - r * r, disc = b * b - a * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc); t0 = (-b - s) / a; t1 = (-b + s) / a;
  }
  if (Math.abs(dy) > 1e-9) { const ta = (y0 - oy) / dy, tb = (y1 - oy) / dy; t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb)); }
  else if (oy < y0 || oy > y1) return -1;
  t0 = Math.max(t0, 0);
  return t0 <= t1 && t0 <= maxD ? t0 : -1;
}
// 탄도 퍼짐: 방향 d 를 원뿔 안에서 살짝 비튼다(r1, r2 는 0..1 난수). 반환 정규화된 방향
export function spreadDir(dx, dy, dz, spread, r1, r2) {
  if (!(spread > 0)) return [dx, dy, dz];
  const a = r1 * Math.PI * 2, m = Math.sqrt(r2) * spread;
  let ux = -dz, uz = dx; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;   // 수평 직교
  const vx = dy * uz, vy = dz * ux - dx * uz, vz = -dy * ux;                         // d × u
  let x = dx + (ux * Math.cos(a) + vx * Math.sin(a)) * m, y = dy + (vy * Math.sin(a)) * m, z = dz + (uz * Math.cos(a) + vz * Math.sin(a)) * m;
  const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l];
}

// ---------- 네트워크 메시지(`wpn`) 검증: 모르는 모양·범위 밖은 버린다 ----------
// f(발사) {k:'f', w:3|4|5|7, z: 조준 0..1, o:[x,y,z], d:[dx,dy,dz], l: 길이, n: 맞힌 알갱이 수, h:[종류 'b'|'m', id]}
// s(검 휘두름) {k:'s', c:0..2, o:[x,y,z], a: 방향각}
// h(피해 보고) {k:'h', w:1..7, c, sl:0|1, x:'r'|'u'(궁극기), n(수류탄 = 거리), h:[종류, id]}   g(수류탄) {k:'g', o, v}   u(궁극기) {k:'u', o, a}
//   r(장전 시작) {k:'r', w, e:0|1}
const arr3 = (v, lim) => (Array.isArray(v) && v.length === 3 ? v.map((q, i) => fin(q, -lim[i], lim[i])) : null);
const POS_LIM = [140, 60, 140];
export function sanitizeWpn(d) {
  if (!d || typeof d !== 'object') return null;
  const k = d.k;
  const hit = (h) => {
    if (!Array.isArray(h) || h.length !== 2) return null;
    const t = h[0] === 'b' ? 'boss' : h[0] === 'm' ? 'minion' : null, i = fin(h[1], 0, 1e9);
    return t && i !== null ? { kind: t, id: Math.round(i) } : null;
  };
  if (k === 'f') {
    const w = isGun(d.w) ? d.w : null, o = arr3(d.o, POS_LIM), dir = arr3(d.d, [1.01, 1.01, 1.01]);
    if (!w || !o || !dir || o.includes(null) || dir.includes(null)) return null;
    const dl = Math.hypot(dir[0], dir[1], dir[2]); if (dl < 0.5 || dl > 1.5) return null;
    const out = { k, w, o, d: dir.map((q) => q / dl), l: fin(d.l, 0, WEAPONS[w].range + 5) ?? WEAPONS[w].range, n: Math.round(fin(d.n, 0, 8) ?? 0), seed: Math.round(fin(d.seed, 0, 1e9) ?? 0), z: fin(d.z, 0, 1) ?? 0 };
    if (d.h !== undefined) { const h = hit(d.h); if (!h) return null; out.h = h; }
    return out;
  }
  if (k === 's') {
    const c = fin(d.c, 0, 2), o = arr3(d.o, POS_LIM), a = fin(d.a, -7, 7);
    if (c === null || !o || o.includes(null) || a === null) return null;
    return { k, c: Math.round(c), o, a };
  }
  if (k === 'h') {
    const w = fin(d.w, 1, SLOT_COUNT), c = fin(d.c, 0, 2), h = hit(d.h);
    if (w === null || !h) return null;
    const out = { k, w: Math.round(w), c: Math.round(c ?? 0), sl: d.sl ? 1 : 0, n: Math.round(fin(d.n, 1, 8) ?? 1), h };
    if (out.w === 6) out.n = r2(fin(d.n, 0, GREN.r) ?? GREN.r);   // 수류탄: n = 폭발 중심까지 거리
    if (out.w === 2 && (d.x === 'r' || d.x === 'u')) out.x = d.x;   // 궁극기 난무 'r' · 死 검기 'u'
    return out;
  }
  if (k === 'r') { const w = isGun(d.w) ? d.w : null; return w ? { k, w, e: d.e ? 1 : 0 } : null; }
  if (k === 'g') {   // 수류탄 던짐: 손 위치 o, 처음 속도 v
    const o = arr3(d.o, POS_LIM), v = arr3(d.v, [40, 40, 40]);
    if (!o || !v || o.includes(null) || v.includes(null) || Math.hypot(v[0], v[1], v[2]) > GREN.speed * 1.6) return null;
    return { k, o, v };
  }
  if (k === 'u') {   // 궁극기 시작: 위치 o, 방향각 a
    const o = arr3(d.o, POS_LIM), a = fin(d.a, -7, 7);
    if (!o || o.includes(null) || a === null) return null;
    return { k, o, a };
  }
  return null;
}
export const wpnMsg = {   // 보내는 쪽 모양(위 검증과 짝)
  fire: (w, o, d, l, n, seed, h, z) => { const m = { k: 'f', w, o: o.map(r2), d: d.map((v) => Math.round(v * 1000) / 1000), l: r2(l), n, seed }; if (h) m.h = h; if (z) m.z = r2(z); return m; },
  swing: (c, o, a) => ({ k: 's', c, o: o.map(r2), a: r2(a) }),
  hit: (w, c, sl, h, n, x) => { const m = { k: 'h', w, c, sl: sl ? 1 : 0, n: w === 6 ? r2(n) : (n || 1), h }; if (x) m.x = x; return m; },
  reload: (w, empty) => ({ k: 'r', w, e: empty ? 1 : 0 }),
  grenade: (o, v) => ({ k: 'g', o: o.map(r2), v: v.map(r2) }),
  ult: (o, a) => ({ k: 'u', o: o.map(r2), a: r2(a) }),
};
// 받은 피해 보고가 믿을 만한가(공격자와 보스의 거리): 무기별 닿는 거리 + 지연 여유
export function reachOk(w, how, dist, bossReach) {
  const lim = w === 2 ? (how === 'u' ? ULT.range + ULT.r + bossReach : how === 'sl' ? SLASH.range + bossReach : 6 + bossReach) : w === 1 ? bossReach + 4 : w === 6 ? 40 + GREN.r + bossReach : WEAPONS[w].range + 12;
  return dist <= lim;
}
