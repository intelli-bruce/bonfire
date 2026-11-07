// bf/weapons-core.js — 무기 로직(순수 함수, THREE·DOM 없음: node 로 테스트한다).
//   슬롯 표·탄약 상태기계(발사·장전·자동 장전)·검 콤보·피해 표(받는 쪽 검증)·광선/캡슐 교차 수학·네트워크 메시지 검증.
// 화면·모델·소리는 bf/weapons.js, 피해 반영은 bf/spider.js 의 damage()/hitRay() 가 맡는다.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const fin = (v, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : null);
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- 슬롯 표 (1 맨손 · 2 검 · 3 M4A1 · 4 산탄총) ----------
export const SLOT_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 };   // 감정 표현은 7·8·9 로 옮겼다
export const WEAPONS = {
  1: { id: 1, key: 'fist', name: '맨손', hint: '내려찍기', gun: false },
  2: { id: 2, key: 'sword', name: '검', hint: '3연 베기 + 검기', gun: false },
  3: { id: 3, key: 'rifle', name: 'M4A1', hint: '연사', gun: true, mag: 30, reserve: 90, interval: 0.095, auto: true, dmg: 6, pellets: 1, spread: 0.010, range: 160, reloadT: 1.9, reloadEmptyT: 2.5, kick: 0.012 },
  4: { id: 4, key: 'shotgun', name: '산탄총', hint: '산탄 7발', gun: true, mag: 6, reserve: 24, interval: 0.85, auto: false, dmg: 4, pellets: 7, spread: 0.060, range: 55, shellT: 0.42, reloadT: 0.6, kick: 0.05 },
};
export const SLOT_COUNT = 4;
export const wrapSlot = (s, dir) => ((s - 1 + (dir > 0 ? 1 : -1) + SLOT_COUNT) % SLOT_COUNT) + 1;

// ---------- 검 콤보: 3연 베기. 마지막 한 방이 크고 검기도 커진다 ----------
export const COMBO = [
  { dur: 0.42, hit: 0.18, melee: 12, slash: 8, scale: 1.0, reach: 2.6 },
  { dur: 0.42, hit: 0.18, melee: 12, slash: 8, scale: 1.0, reach: 2.6 },
  { dur: 0.62, hit: 0.28, melee: 18, slash: 14, scale: 1.55, reach: 3.2 },
];
export const COMBO_WINDOW = 0.55;     // 앞 동작이 끝난 뒤 이 안에 다시 누르면 다음 단계
export const SLASH = { speed: 24, life: 1.25, r: 2.0, h: 1.0, range: 30 };   // 검기: 초속 24 m, 약 30 m 날아감

export function newSword() { return { step: -1, startAt: -1e9, endAt: -1e9 }; }
// 지금 누르면 몇 번째 베기인가? 아직 바쁘면 -1. 앞 베기의 80 % 가 지나면 이어 칠 수 있다(미리 눌러 두기 허용).
export function swordNext(st, now) {
  const prev = st.step >= 0 ? COMBO[st.step] : null;
  if (prev && now < st.startAt + prev.dur * 0.8) return -1;
  if (prev && st.step === 2 && now < st.endAt + 0.2) return -1;                 // 마지막 한 방 뒤 짧은 후딜
  if (prev && st.step < 2 && now <= st.endAt + COMBO_WINDOW) return st.step + 1;
  return 0;
}
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
export const ammoText = (g) => (g ? `${g.mag} / ${g.reserve}` : '');

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
export const DMG_CD = { punch: 220, sword: 150, slash: 90, rifle: 70, shotgun: 450 };   // 공격자별 최소 간격(ms)
export function dmgFor(w, how, c, n) {
  if (w === 1) return { amount: 10, cd: DMG_CD.punch, key: 'punch' };
  if (w === 2) {
    const s = COMBO[clamp(Math.round(c) || 0, 0, 2)];
    return how === 'sl' ? { amount: s.slash, cd: DMG_CD.slash, key: 'slash' } : { amount: s.melee, cd: DMG_CD.sword, key: 'sword' };
  }
  if (w === 3) return { amount: WEAPONS[3].dmg, cd: DMG_CD.rifle, key: 'rifle' };
  if (w === 4) { const k = clamp(Math.round(n) || 1, 1, WEAPONS[4].pellets); return { amount: WEAPONS[4].dmg * k, cd: DMG_CD.shotgun, key: 'shotgun' }; }
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
// f(발사) {k:'f', w:3|4, o:[x,y,z], d:[dx,dy,dz], l: 길이, n: 맞힌 알갱이 수, h:[종류 'b'|'m', id]}
// s(검 휘두름) {k:'s', c:0..2, o:[x,y,z], a: 방향각}
// h(피해 보고) {k:'h', w:1..4, c, sl:0|1, h:[종류, id]}   r(장전 시작) {k:'r', w, e:0|1}
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
    const w = d.w === 3 || d.w === 4 ? d.w : null, o = arr3(d.o, POS_LIM), dir = arr3(d.d, [1.01, 1.01, 1.01]);
    if (!w || !o || !dir || o.includes(null) || dir.includes(null)) return null;
    const dl = Math.hypot(dir[0], dir[1], dir[2]); if (dl < 0.5 || dl > 1.5) return null;
    const out = { k, w, o, d: dir.map((q) => q / dl), l: fin(d.l, 0, WEAPONS[w].range + 5) ?? WEAPONS[w].range, n: Math.round(fin(d.n, 0, 8) ?? 0), seed: Math.round(fin(d.seed, 0, 1e9) ?? 0) };
    if (d.h !== undefined) { const h = hit(d.h); if (!h) return null; out.h = h; }
    return out;
  }
  if (k === 's') {
    const c = fin(d.c, 0, 2), o = arr3(d.o, POS_LIM), a = fin(d.a, -7, 7);
    if (c === null || !o || o.includes(null) || a === null) return null;
    return { k, c: Math.round(c), o, a };
  }
  if (k === 'h') {
    const w = fin(d.w, 1, 4), c = fin(d.c, 0, 2), h = hit(d.h);
    if (w === null || !h) return null;
    return { k, w: Math.round(w), c: Math.round(c ?? 0), sl: d.sl ? 1 : 0, n: Math.round(fin(d.n, 1, 8) ?? 1), h };
  }
  if (k === 'r') { const w = d.w === 3 || d.w === 4 ? d.w : null; return w ? { k, w, e: d.e ? 1 : 0 } : null; }
  return null;
}
export const wpnMsg = {   // 보내는 쪽 모양(위 검증과 짝)
  fire: (w, o, d, l, n, seed, h) => { const m = { k: 'f', w, o: o.map(r2), d: d.map((v) => Math.round(v * 1000) / 1000), l: r2(l), n, seed }; if (h) m.h = h; return m; },
  swing: (c, o, a) => ({ k: 's', c, o: o.map(r2), a: r2(a) }),
  hit: (w, c, sl, h, n) => ({ k: 'h', w, c, sl: sl ? 1 : 0, n: n || 1, h }),
  reload: (w, empty) => ({ k: 'r', w, e: empty ? 1 : 0 }),
};
// 받은 피해 보고가 믿을 만한가(공격자와 보스의 거리): 무기별 닿는 거리 + 지연 여유
export function reachOk(w, how, dist, bossReach) {
  const lim = w === 2 ? (how === 'sl' ? SLASH.range + bossReach : 6 + bossReach) : w === 1 ? bossReach + 4 : WEAPONS[w].range + 12;
  return dist <= lim;
}
