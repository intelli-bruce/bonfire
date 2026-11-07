// bf/kit/appearance.js — the customisable look: catalogue, compact code, legacy mapping and the pure (THREE-free) mesh
// classification that turns the Kenney "Mini Characters" (CC0) meshes into recolourable roles. Runs in the page and in node tests.
//
// An appearance is { g: 'm'|'f', h, t, b, s, c: [skin, hair, top, bottom, shoes] } — indices into the lists below.
// Its network / storage form is a 12-char code "a1" + g + h t b s + 5 colours (each index one base-36 char). The presence message
// still carries the legacy { ch, color } (a nearest match) so older clients keep drawing something sensible.

// ---------------------------------------------------------------- roles: which part of the body a vertex is
// TRIM / ACCENT: fixed colours of outfit details (white fur and shirt fronts / gold buckles), marked by their palette cell in parts.glb
export const ROLE = { NONE: 0, SKIN: 1, HAIR: 2, TOP: 3, SLEEVE: 4, BOTTOM: 5, UPLEG: 6, LEGLOW: 7, SHOE: 8, SOLE: 9, TRIM: 10, ACCENT: 11 };
export const ROLE_COUNT = 12;
export const TRIM_CELL = '3,1', ACCENT_CELL = '3,2', DARK_CELL = '3,0';   // parts.glb detail cells (row,col): white, gold, dark (unchanged)

// ---------------------------------------------------------------- catalogue (order is part of the code: only ever append)
export const GENDERS = [{ id: 'm', name: '남' }, { id: 'f', name: '여' }];
// src: where the hair mesh comes from — a Kenney model's own hair (transplanted onto the shared bald head) or a Blender part in parts.glb
export const HAIRS = [
  { id: 'bun',    name: '똥머리',      g: 'f',  src: { model: 'bun' },       legacy: 'bun' },
  { id: 'curly',  name: '곱슬머리',    g: 'f',  src: { model: 'curly' },     legacy: 'curly' },
  { id: 'bob',    name: '단발',        g: 'f',  src: { part: 'hair_bob' },   legacy: 'bun' },
  { id: 'long',   name: '긴 생머리',   g: 'f',  src: { part: 'hair_long' },  legacy: 'bun' },
  { id: 'pony',   name: '포니테일',    g: 'f',  src: { part: 'hair_pony' },  legacy: 'bun' },
  { id: 'twin',   name: '양갈래',      g: 'f',  src: { part: 'hair_twin' },  legacy: 'curly' },
  { id: 'short',  name: '단정한 머리', g: 'm',  src: { model: 'glasses' },   legacy: 'glasses' },
  { id: 'beard',  name: '수염',        g: 'm',  src: { model: 'beard' },     legacy: 'beard' },
  { id: 'shaggy', name: '덥수룩',      g: 'm',  src: { model: 'overalls' },  legacy: 'overalls' },
  { id: 'crop',   name: '짧게 깎은',   g: 'mf', src: { part: 'hair_crop' },  legacy: 'glasses' },
  { id: 'spiky',  name: '뾰족 머리',   g: 'mf', src: { part: 'hair_spiky' }, legacy: 'overalls' },
  { id: 'afro',   name: '아프로',      g: 'mf', src: { part: 'hair_afro' },  legacy: 'curly' },
  { id: 'mohawk', name: '모히칸',      g: 'm',  src: { part: 'hair_mohawk' }, legacy: 'beard' },
  { id: 'bald',   name: '민머리',      g: 'm',  src: null,                   legacy: 'beard' },
  { id: 'twoblock', name: '투블럭',   g: 'm',  src: { part: 'hair_twoblock' }, legacy: 'glasses' },
  { id: 'wave',   name: '웨이브',      g: 'f',  src: { part: 'hair_wave' },  legacy: 'curly' },
];
// g: which genders may wear it. dress: a one-piece (the top colour runs down into its own skirt, the bottom choice is unused)
export const TOPS = [
  { id: 'tee',    name: '티셔츠', g: 'mf', parts: [] },
  { id: 'tank',   name: '민소매', g: 'mf', parts: [] },
  { id: 'hood',   name: '후드티', g: 'mf', parts: ['top_hood', 'top_pocket'] },
  { id: 'coat',   name: '코트',   g: 'mf', parts: ['top_coat'] },
  { id: 'shirt',  name: '셔츠',   g: 'm',  parts: ['top_shirt'] },
  { id: 'suit',   name: '정장',   g: 'm',  parts: ['top_suit'] },
  { id: 'puffer', name: '패딩',   g: 'mf', parts: ['top_puffer'] },
  { id: 'santa',  name: '산타 옷', g: 'mf', parts: ['top_santa'] },
  { id: 'knit',   name: '니트',   g: 'f',  parts: ['top_knit'] },
  { id: 'dress',  name: '원피스', g: 'f',  parts: ['dress_skirt'], dress: true },
];
// alt: what a gender that may not wear it gets instead (old saved looks: a man in a skirt -> trousers)
export const BOTTOMS = [
  { id: 'pants',  name: '긴바지', g: 'mf', parts: [] },
  { id: 'shorts', name: '반바지', g: 'mf', parts: [] },
  { id: 'skirt',  name: '치마',   g: 'f',  parts: ['bottom_skirt'], alt: 0 },
];
export const SHOES = [
  { id: 'sneaker', name: '운동화', parts: [] },
  { id: 'boot',    name: '부츠',   parts: ['shoe_boot_L', 'shoe_boot_R'] },
  { id: 'bare',    name: '맨발',   parts: [] },
];
// where each Blender part rides: the bone it is parented to
export const PART_BONE = (name) => (name.startsWith('hair_') ? 'head' : name.endsWith('_L') ? 'leg-left' : name.endsWith('_R') ? 'leg-right' : 'torso');
export const PART_ROLE = (name) => (name.startsWith('hair_') ? ROLE.HAIR : name.startsWith('top_') || name.startsWith('dress_') ? ROLE.TOP : name.startsWith('bottom_') ? ROLE.BOTTOM : ROLE.SHOE);

export const PALETTES = {
  skin: [
    { name: '우윳빛', hex: '#fbe3cf' }, { name: '살구', hex: '#f3c6a2' }, { name: '구릿빛', hex: '#dba075' },
    { name: '갈색', hex: '#aa7656' }, { name: '짙은 갈색', hex: '#7d5640' }, { name: '흑단', hex: '#58392b' },
  ],
  hair: [
    { name: '검정', hex: '#1f1d24' }, { name: '짙은 밤색', hex: '#46291c' }, { name: '밤색', hex: '#7b4b27' }, { name: '금발', hex: '#e0b04a' },
    { name: '주황', hex: '#d2622c' }, { name: '빨강', hex: '#a82c2c' }, { name: '분홍', hex: '#ec86b6' }, { name: '파랑', hex: '#3d70d6' },
    { name: '은회색', hex: '#bcc0d0' }, { name: '보라', hex: '#7c48c8' },
  ],
  top: [
    { name: '크림', hex: '#ece4d2' }, { name: '노랑', hex: '#ffc83d' }, { name: '주황', hex: '#e8803a' }, { name: '빨강', hex: '#c8452d' },
    { name: '분홍', hex: '#e8789c' }, { name: '보라', hex: '#7a4cc0' }, { name: '파랑', hex: '#3f6fd0' }, { name: '하늘', hex: '#7fc0e8' },
    { name: '초록', hex: '#3f9a5d' }, { name: '올리브', hex: '#6f7a3a' }, { name: '검정', hex: '#2c2d35' }, { name: '흰색', hex: '#f6f6f2' },
  ],
  bottom: [
    { name: '청색', hex: '#3d5f9a' }, { name: '짙은 청색', hex: '#27375e' }, { name: '검정', hex: '#2c2d35' }, { name: '회색', hex: '#7a7f8c' },
    { name: '카키', hex: '#8a7a4a' }, { name: '갈색', hex: '#6a4528' }, { name: '베이지', hex: '#cdb58a' }, { name: '붉은색', hex: '#a8332f' },
  ],
  shoe: [
    { name: '흰색', hex: '#f4f4f0' }, { name: '검정', hex: '#2a2b32' }, { name: '갈색', hex: '#7a4a26' }, { name: '빨강', hex: '#cf3b30' },
    { name: '파랑', hex: '#3f6fd0' }, { name: '노랑', hex: '#f3c53d' }, { name: '초록', hex: '#3f9a5d' }, { name: '회색', hex: '#8a8f9c' },
  ],
};
export const PALETTE_KEYS = ['skin', 'hair', 'top', 'bottom', 'shoe'];   // order of ap.c

// ---------------------------------------------------------------- validation, defaults, code
const gOk = (g) => (g === 'm' || g === 'f' ? g : null);
export const hairAllowed = (hi, g) => !!HAIRS[hi] && HAIRS[hi].g.includes(g);
export const hairsFor = (g) => HAIRS.map((h, i) => ({ ...h, i })).filter((h) => h.g.includes(g));
export const topAllowed = (ti, g) => !!TOPS[ti] && TOPS[ti].g.includes(g);
export const bottomAllowed = (bi, g) => !!BOTTOMS[bi] && BOTTOMS[bi].g.includes(g);
export const topsFor = (g) => TOPS.map((t, i) => ({ ...t, i })).filter((t) => t.g.includes(g));
export const bottomsFor = (g) => BOTTOMS.map((t, i) => ({ ...t, i })).filter((t) => t.g.includes(g));
// a top / bottom the gender may not wear -> its stand-in (tops: a tee; bottoms: their alt, else trousers)
const fitTop = (ti, g) => (topAllowed(ti, g) ? ti : 0);
const fitBottom = (bi, g) => (bottomAllowed(bi, g) ? bi : BOTTOMS[bi] && Number.isInteger(BOTTOMS[bi].alt) ? BOTTOMS[bi].alt : 0);
export function defaultAppearance(g = 'f') {
  g = gOk(g) || 'f';
  return g === 'f'
    ? { g, h: 0, t: 0, b: 0, s: 0, c: [1, 4, 1, 0, 0] }    // 똥머리, 티셔츠, 긴바지, 운동화; 살구 · 주황 머리 · 노랑 상의
    : { g, h: 6, t: 0, b: 0, s: 0, c: [1, 1, 6, 1, 1] };    // 단정한 머리 …
}
const idx = (v, n, d) => (Number.isInteger(v) && v >= 0 && v < n ? v : d);
export function sanitizeAppearance(x) {
  if (!x || typeof x !== 'object') return null;
  const g = gOk(x.g); if (!g) return null;
  const d = defaultAppearance(g), c = Array.isArray(x.c) ? x.c : [];
  const h = idx(x.h, HAIRS.length, d.h);
  return {
    g, h: hairAllowed(h, g) ? h : d.h, t: fitTop(idx(x.t, TOPS.length, d.t), g), b: fitBottom(idx(x.b, BOTTOMS.length, d.b), g), s: idx(x.s, SHOES.length, d.s),
    c: PALETTE_KEYS.map((k, i) => idx(c[i], PALETTES[k].length, d.c[i])),
  };
}
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function encodeAppearance(ap) {
  const a = sanitizeAppearance(ap); if (!a) return '';
  return 'a1' + a.g + [a.h, a.t, a.b, a.s, ...a.c].map((n) => B36[n]).join('');
}
const CODE_RE = /^a1[mf][0-9a-z]{9}$/;
export function decodeAppearance(str) {
  if (typeof str !== 'string' || !CODE_RE.test(str)) return null;
  const n = [...str.slice(3)].map((ch) => B36.indexOf(ch));
  const a = { g: str[2], h: n[0], t: n[1], b: n[2], s: n[3], c: n.slice(4, 9) };
  // an out-of-range index means a newer / hostile client: reject instead of guessing
  if (!hairAllowed(a.h, a.g) || a.t >= TOPS.length || a.b >= BOTTOMS.length || a.s >= SHOES.length) return null;
  if (!PALETTE_KEYS.every((k, i) => a.c[i] < PALETTES[k].length)) return null;
  a.t = fitTop(a.t, a.g); a.b = fitBottom(a.b, a.g);   // saved before the gendered lists (e.g. a man in a skirt): map, don't reject
  return a;
}
export function randomAppearance(rand = Math.random, keepG) {
  const pick = (n) => Math.min(n - 1, Math.floor(rand() * n));
  const g = gOk(keepG) || (rand() < 0.5 ? 'm' : 'f'), hs = hairsFor(g);
  return {
    g, h: hs[pick(hs.length)].i, t: (() => { const l = topsFor(g); return l[pick(l.length)].i; })(), b: (() => { const l = bottomsFor(g); return l[pick(l.length)].i; })(), s: pick(SHOES.length),
    c: PALETTE_KEYS.map((k) => pick(PALETTES[k].length)),
  };
}
export const sameAppearance = (a, b) => encodeAppearance(a) === encodeAppearance(b);

// ---------------------------------------------------------------- role -> colour for an appearance
export function roleColors(ap) {
  const a = sanitizeAppearance(ap) || defaultAppearance('f');
  const [sk, hr, tp, bt, sh] = PALETTE_KEYS.map((k, i) => PALETTES[k][a.c[i]].hex);
  const top = TOPS[a.t].id, dress = !!TOPS[a.t].dress, bot = dress ? 'dress' : BOTTOMS[a.b].id, shoe = SHOES[a.s].id;
  const rc = new Array(ROLE_COUNT).fill('#ffffff');
  rc[ROLE.SKIN] = sk; rc[ROLE.HAIR] = hr; rc[ROLE.TOP] = tp; rc[ROLE.SLEEVE] = top === 'tank' ? sk : tp;
  rc[ROLE.BOTTOM] = dress ? tp : bt; rc[ROLE.UPLEG] = bot === 'skirt' || dress ? sk : bt; rc[ROLE.LEGLOW] = bot === 'pants' ? bt : sk;
  rc[ROLE.SHOE] = shoe === 'bare' ? sk : sh; rc[ROLE.SOLE] = shoe === 'bare' ? sk : '#34353b';
  rc[ROLE.TRIM] = '#f4f1ea'; rc[ROLE.ACCENT] = '#e2b23c';
  return rc;
}
// every Blender part an appearance needs (hair first)
export function partNames(ap) {
  const a = sanitizeAppearance(ap) || defaultAppearance('f'), hs = HAIRS[a.h].src;
  return [...(hs && hs.part ? [hs.part] : []), ...TOPS[a.t].parts, ...(TOPS[a.t].dress ? [] : BOTTOMS[a.b].parts), ...SHOES[a.s].parts];
}

// ---------------------------------------------------------------- legacy { ch, color } <-> appearance
export const LEGACY_ROBES = ['#e9e2d0', '#c8552d', '#2f6e45', '#5a2f80', '#2c4f9e', '#c4952f'];   // the six old "옷 색" values
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function nearestHex(hex, list) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return -1;
  const c = hexRgb(hex); let best = -1, bd = 1e9;
  list.forEach((l, i) => { const d = hexRgb(l).reduce((s, v, k) => s + (v - c[k]) ** 2, 0); if (d < bd) { bd = d; best = i; } });
  return best;
}
export function legacyOf(ap) {
  const a = sanitizeAppearance(ap) || defaultAppearance('f');
  return { ch: HAIRS[a.h].legacy, color: LEGACY_ROBES[nearestHex(PALETTES.top[a.c[2]].hex, LEGACY_ROBES)] };
}
const LEGACY_LOOK = { bun: ['f', 0], curly: ['f', 1], glasses: ['m', 6], overalls: ['m', 8], beard: ['m', 7] };
export function fromLegacy(ch, color) {
  const [g, h] = LEGACY_LOOK[ch] || LEGACY_LOOK.bun, a = defaultAppearance(g); a.h = h;
  const i = nearestHex(color, PALETTES.top.map((p) => p.hex)); if (i >= 0) a.c[2] = i;
  return a;
}

// ---------------------------------------------------------------- mesh analysis (typed arrays only)
// mesh = { P: Float32Array xyz, uv: Float32Array uv, idx: index array }. The Kenney characters are made of separate box-like
// shells (hands, sleeves, hair locks, eyes, ...), each filled from one palette cell: welding by position finds those shells.
export const cellKey = (u, v) => Math.min(3, Math.floor(v * 4)) + ',' + Math.min(7, Math.floor(u * 8));   // palette cell "row,col" of the 8x4 colormap
export function analyseMesh(m) {
  const { P, uv, idx } = m, n = P.length / 3, par = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const weld = new Map();
  for (let v = 0; v < n; v++) {
    const k = Math.round(P[v * 3] * 1e4) + ',' + Math.round(P[v * 3 + 1] * 1e4) + ',' + Math.round(P[v * 3 + 2] * 1e4);
    const o = weld.get(k); if (o === undefined) weld.set(k, v); else par[find(v)] = find(o);
  }
  for (let t = 0; t < idx.length; t += 3) { const r = find(idx[t]); par[find(idx[t + 1])] = r; par[find(idx[t + 2])] = find(r); }
  const ids = new Map(), comps = [], vertComp = new Int32Array(n).fill(-1);
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]); let ci = ids.get(r);
    if (ci === undefined) { ci = comps.length; ids.set(r, ci); comps.push({ id: ci, tris: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9], cells: {} }); }
    const c = comps[ci]; c.tris++;
    for (let q = 0; q < 3; q++) {
      const v = idx[t + q]; vertComp[v] = ci;
      const k = cellKey(uv[v * 2], uv[v * 2 + 1]); c.cells[k] = (c.cells[k] || 0) + 1;
      for (let a = 0; a < 3; a++) { c.mn[a] = Math.min(c.mn[a], P[v * 3 + a]); c.mx[a] = Math.max(c.mx[a], P[v * 3 + a]); }
    }
  }
  for (const c of comps) c.cell = Object.entries(c.cells).sort((a, b) => b[1] - a[1])[0][0];
  return { comps, vertComp };
}
const near = (a, b, t = 0.006) => a.every((v, i) => Math.abs(v - b[i]) <= t);
// head mesh -> which shells are the face, ears, eyes/mouth, the model's own hair, and accessories (glasses) to drop
export function classifyHead(an) {
  const { comps } = an, out = { face: -1, skinCell: null, ears: [], eyes: [], hair: [], extras: [] };
  const face = comps.find((c) => near(c.mn, [-0.16, 0.34, -0.16]) && near(c.mx, [0.16, 0.66, 0.16]));
  if (!face) return out;
  out.face = face.id; out.skinCell = face.cell;
  for (const c of comps) {
    if (c.id === face.id) continue;
    if (c.cell === face.cell && Object.keys(c.cells).length === 1) out.ears.push(c.id);
    else if (c.tris <= 8 && c.mn[2] >= 0.15) out.eyes.push(c.id);
    else if ('3,3' in c.cells) out.extras.push(c.id);
    else out.hair.push(c.id);
  }
  return out;
}
// body mesh (the rig is shared by every Kenney character) -> a ROLE per vertex
export function classifyBody(an, mesh, skinCell) {
  const { comps, vertComp } = an, n = mesh.P.length / 3, roles = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    const c = comps[vertComp[v]]; if (!c) continue;
    const cell = cellKey(mesh.uv[v * 2], mesh.uv[v * 2 + 1]), cx = (c.mn[0] + c.mx[0]) / 2;
    if (cell === skinCell) roles[v] = Math.abs(cx) < 0.12 && c.mn[1] >= 0.15 && mesh.P[v * 3 + 1] < 0.26 ? ROLE.TOP : ROLE.SKIN;   // hands, neck (the base's bare midriff is covered by the top)
    else if (c.mx[1] <= 0.105 && c.mn[1] <= 0.012) roles[v] = cell === '3,0' ? ROLE.SOLE : ROLE.SHOE;   // feet: dark sole + coloured upper
    else if (c.mn[1] >= 0.17 && c.mx[1] <= 0.225 && c.mx[0] - c.mn[0] > 0.25) roles[v] = ROLE.BOTTOM;  // hip band
    else if (Math.abs(cx) < 0.12 && c.mx[1] <= 0.19) roles[v] = c.mn[1] >= 0.065 ? ROLE.UPLEG : ROLE.LEGLOW;  // thigh / shin boxes
    else if (Math.abs(cx) >= 0.12) roles[v] = ROLE.SLEEVE;
    else roles[v] = ROLE.TOP;                                                                   // torso
  }
  return roles;
}
