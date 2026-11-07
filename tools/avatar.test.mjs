// node tools/avatar.test.mjs — bf/kit/appearance.js(목록·코드·옛 클라이언트 매핑·난수) 와 실제 Kenney GLB/부품 GLB 에 대한 메시 분류(THREE 없이), 입장 화면 미리보기(bf/kit/preview.js)의 정면 고정·드래그 회전(가짜 THREE)을 확인한다.
import fs from 'node:fs';
import * as A from '../bf/kit/appearance.js';
import { parseGLB, accessor } from '../bf/kit/glb.js';
import { createPreview } from '../bf/kit/preview.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const url = (p) => new URL('../' + p, import.meta.url);
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

// 1) 목록: 성별마다 머리 여러 종, 옷·신발 여러 종, 색 팔레트
{
  const hm = A.hairsFor('m'), hf = A.hairsFor('f');
  ok(hm.length >= 6 && hf.length >= 6, `hair styles per gender (m ${hm.length}, f ${hf.length})`);
  ok(A.TOPS.length >= 4 && A.BOTTOMS.length >= 3 && A.SHOES.length >= 3, 'tops / bottoms / shoes lists');
  ok(Object.values(A.PALETTES).every((l) => l.length >= 6 && l.every((c) => /^#[0-9a-f]{6}$/.test(c.hex))), 'palettes: >= 6 valid colours each');
  ok(A.HAIRS.length <= 36 && A.TOPS.length <= 36 && A.BOTTOMS.length <= 36 && A.SHOES.length <= 36 && Object.values(A.PALETTES).every((l) => l.length <= 36), 'every index fits one base-36 char');
  ok(new Set(A.HAIRS.map((h) => h.id)).size === A.HAIRS.length, 'hair ids are unique');
  ok(A.HAIRS.every((h) => A.LEGACY_ROBES.length && ['bun', 'glasses', 'curly', 'overalls', 'beard'].includes(h.legacy)), 'every hair maps to an old character id');
}

// 2) 코드: 왕복, 거부(정규식·범위·성별과 안 맞는 머리), 방어적 정리
{
  for (const g of ['m', 'f']) { const d = A.defaultAppearance(g); eq(A.decodeAppearance(A.encodeAppearance(d)), d, `default ${g} round-trips`); }
  const r = rng(7); let all = true, valid = true, len = true;
  for (let i = 0; i < 300; i++) {
    const a = A.randomAppearance(r), code = A.encodeAppearance(a), back = A.decodeAppearance(code);
    all = all && !!back && A.sameAppearance(a, back); valid = valid && !!A.sanitizeAppearance(a) && A.hairAllowed(a.h, a.g); len = len && code.length === 12;
  }
  ok(all && valid && len, '300 random appearances: valid, 12-char code, round-trip');
  ok(A.randomAppearance(rng(3), 'f').g === 'f' && A.randomAppearance(rng(3), 'm').g === 'm', 'random can keep the gender');
  for (const bad of [null, undefined, 5, {}, '', 'a1', 'a2f000000000', 'a1x000000000', 'a1f00000000', 'a1f0000000000', 'a1f00000000!', 'A1F000000000', 'a1f' + 'z'.repeat(9), 'a1m' + '0' + '0000000z0', 'a1f6' + '00000000']) {
    ok(A.decodeAppearance(bad) === null, `rejects ${JSON.stringify(bad)}`);
  }
  ok(A.decodeAppearance('a1f' + '6' + '00000000') === null, 'a male hair on a female code is rejected');
  const s = A.sanitizeAppearance({ g: 'f', h: 99, t: -1, b: 1.5, s: 'x', c: [999, 'a', null] });
  eq(s, A.defaultAppearance('f'), 'garbage fields fall back to the gender default');
  ok(A.sanitizeAppearance({ g: 'm', h: 0 }).h === A.defaultAppearance('m').h, 'a hair of the other gender falls back');
  ok(A.sanitizeAppearance('x') === null && A.sanitizeAppearance({ g: 'q' }) === null, 'non-appearances are null');
}

// 3) 옛 클라이언트: 보내는 {ch, color} 는 옛 목록 안의 값, 옛 저장값에서 모습 복원
{
  const ids = new Set(['bun', 'glasses', 'curly', 'overalls', 'beard']), robes = new Set(A.LEGACY_ROBES);
  const r = rng(11); let good = true;
  for (let i = 0; i < 200; i++) { const l = A.legacyOf(A.randomAppearance(r)); good = good && ids.has(l.ch) && robes.has(l.color); }
  ok(good, 'legacyOf always yields an old character id and an old robe colour');
  eq(A.legacyOf({ ...A.defaultAppearance('f'), c: [1, 4, 5, 0, 0] }).color, '#5a2f80', 'a purple top is sent as 밤보라');
  for (const [ch, g] of [['bun', 'f'], ['curly', 'f'], ['glasses', 'm'], ['overalls', 'm'], ['beard', 'm']]) {
    const a = A.fromLegacy(ch, '#2c4f9e'); ok(a.g === g && A.hairAllowed(a.h, g) && A.legacyOf(a).ch === ch, `fromLegacy(${ch}) -> ${g}, and back`);
  }
  ok(A.PALETTES.top[A.fromLegacy('bun', '#2c4f9e').c[2]].hex === '#3f6fd0', 'old robe colour -> nearest top colour');
  ok(A.fromLegacy('nope', 'zzz').g === 'f', 'unknown old values give a valid default');
}

// 4) 역할 색: 민소매는 소매가 살색, 반바지·치마·맨발의 살색 규칙
{
  const d = A.defaultAppearance('f'), R = A.ROLE;
  let rc = A.roleColors(d);
  ok(rc.length === A.ROLE_COUNT && rc[R.SLEEVE] === rc[R.TOP] && rc[R.LEGLOW] === rc[R.BOTTOM] && rc[R.SHOE] !== rc[R.SKIN], 'tee + pants + sneakers');
  rc = A.roleColors({ ...d, t: 1 }); ok(rc[R.SLEEVE] === rc[R.SKIN] && rc[R.TOP] !== rc[R.SKIN], 'tank top: bare arms');
  rc = A.roleColors({ ...d, b: 1 }); ok(rc[R.LEGLOW] === rc[R.SKIN] && rc[R.UPLEG] === rc[R.BOTTOM], 'shorts: bare shins');
  rc = A.roleColors({ ...d, b: 2 }); ok(rc[R.LEGLOW] === rc[R.SKIN] && rc[R.UPLEG] === rc[R.SKIN], 'skirt: bare legs');
  rc = A.roleColors({ ...d, s: 2 }); ok(rc[R.SHOE] === rc[R.SKIN] && rc[R.SOLE] === rc[R.SKIN], 'barefoot');
  eq(A.partNames({ ...d, t: 2, b: 2, s: 1 }), ['top_hood', 'top_pocket', 'bottom_skirt', 'shoe_boot_L', 'shoe_boot_R'], 'part names of hood + skirt + boots')
  ok(A.partNames({ ...d, h: 2 })[0] === 'hair_bob' && A.partNames(d).length === 0, 'Blender hair is a part, a Kenney hair is not');
}

// 4b) 성별별 옷 목록: 남자는 치마·원피스·니트 없음, 여자는 셔츠·정장 없음, 옛 저장값(남자+치마)은 긴바지로 대체
{
  const ids = (l) => l.map((t) => t.id);
  const tm = ids(A.topsFor('m')), tf = ids(A.topsFor('f')), bm = ids(A.bottomsFor('m')), bf = ids(A.bottomsFor('f'));
  for (const id of ['tee', 'hood', 'coat', 'shirt', 'suit', 'puffer', 'santa']) ok(tm.includes(id), `male tops include ${id}`);
  for (const id of ['tee', 'coat', 'knit', 'dress', 'puffer', 'santa']) ok(tf.includes(id), `female tops include ${id}`);
  ok(!tm.includes('dress') && !tm.includes('knit') && !bm.includes('skirt'), 'no skirt / dress / knit for men');
  ok(!tf.includes('suit') && !tf.includes('shirt') && bf.includes('skirt'), 'no suit / shirt for women, skirts are');
  const old = A.decodeAppearance('a1m6020' + '11611');   // an old saved code: male, short hair, tee, skirt, sneakers
  ok(old && old.b === 0 && old.g === 'm', `old male+skirt code decodes to trousers (got ${JSON.stringify(old)})`);
  ok(A.sanitizeAppearance({ g: 'f', h: 0, t: 5, b: 0, s: 0, c: [0, 0, 0, 0, 0] }).t === 0, 'a suit on a woman falls back to a tee');
  const r = rng(5); let fit = true;
  for (let i = 0; i < 300; i++) { const a = A.randomAppearance(r); fit = fit && A.topAllowed(a.t, a.g) && A.bottomAllowed(a.b, a.g); }
  ok(fit, 'random looks always fit the gender');
  const dress = A.sanitizeAppearance({ g: 'f', h: 0, t: 9, b: 0, s: 0, c: [1, 1, 3, 2, 0] }), rc = A.roleColors(dress), R = A.ROLE;
  ok(rc[R.BOTTOM] === rc[R.TOP] && rc[R.UPLEG] === rc[R.SKIN] && A.partNames(dress).includes('dress_skirt') && !A.partNames({ ...dress, b: 2 }).includes('bottom_skirt'), 'a dress: one colour, its own skirt, no second skirt');
  ok(rc[R.TRIM] === '#f4f1ea' && rc[R.ACCENT] !== rc[R.TOP], 'trim / accent are fixed colours');
}

// 5) 실제 Kenney 모델: 머리(얼굴·귀·눈·머리카락) 와 몸(역할) 분류
const DIR = 'bf/kit/assets/kenney-mini-characters/';
const FILES = { bun: 'character-female-b.glb', glasses: 'character-male-a.glb', curly: 'character-female-f.glb', overalls: 'character-male-e.glb', beard: 'character-male-b.glb' };
const load = (f) => { const b = fs.readFileSync(url(f)); return parseGLB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const meshOf = (g, mi) => { const p = g.j.meshes[mi].primitives[0]; return { P: accessor(g, p.attributes.POSITION).arr, uv: accessor(g, p.attributes.TEXCOORD_0).arr, idx: accessor(g, p.indices).arr }; };
{
  const want = { bun: { hair: 4 }, curly: { hair: 3 }, glasses: { hair: 1 }, overalls: { hair: 1 }, beard: { hair: 2 } };   // hair shells expected per model (verified from the GLB shells)
  for (const [id, f] of Object.entries(FILES)) {
    const g = load(DIR + f), hm = meshOf(g, 1), an = A.analyseMesh(hm), h = A.classifyHead(an);
    ok(/^3,[567]$/.test(h.skinCell || ''), `${id}: skin cell is one of the three skin cells (got ${h.skinCell})`)
    ok(h.face >= 0, `${id}: face shell found`);
    ok(h.ears.length === 2, `${id}: two ears (got ${h.ears.length})`);
    ok(h.eyes.length === 3, `${id}: two eyes + a mouth (got ${h.eyes.length})`);
    ok(h.hair.length >= want[id].hair, `${id}: has hair shells (got ${h.hair.length}, want >= ${want[id].hair})`);
    const total = an.comps.length; ok(1 + h.ears.length + h.eyes.length + h.hair.length + h.extras.length === total, `${id}: every head shell is classed once`);
  }
  ok(A.classifyHead(A.analyseMesh(meshOf(load(DIR + FILES.glasses), 1))).extras.length === 1, 'male-a: glasses are an extra (dropped), not hair');
  // the shared body (female-b rig): which vertex gets which role
  const g = load(DIR + FILES.bun), bm = meshOf(g, 0), an = A.analyseMesh(bm), skin = A.classifyHead(A.analyseMesh(meshOf(g, 1))).skinCell;
  const roles = A.classifyBody(an, bm, skin), cnt = {}; for (const r of roles) cnt[r] = (cnt[r] || 0) + 1;
  const R = A.ROLE;
  ok(skin === '3,7', `female-b skin cell is 3,7 (got ${skin})`);
  ok(cnt[R.NONE] === undefined, `female-b body: every vertex has a role (none: ${cnt[R.NONE]})`);
  for (const [name, r] of Object.entries(R)) if (r) ok(["HAIR", "TRIM", "ACCENT"].includes(name) || cnt[r] > 0, `female-b body has ${name} vertices (${cnt[r] || 0})`);
  // symmetry: left and right are classed alike
  const side = (s) => { let c = 0; for (let v = 0; v < roles.length; v++) if (Math.sign(bm.P[v * 3]) === s && roles[v] === R.SHOE) c++; return c; };
  ok(side(1) === side(-1) && side(1) > 0, 'both shoes are shoes');
  const sleeveMaxY = Math.max(...[...roles].map((r, v) => (r === R.SLEEVE ? bm.P[v * 3 + 1] : -1))), sleeveMinAbsX = Math.min(...[...roles].map((r, v) => (r === R.SLEEVE ? Math.abs(bm.P[v * 3]) : 9)));
  ok(sleeveMinAbsX > 0.09 && sleeveMaxY < 0.4, `sleeves sit out at the arms (min |x| ${sleeveMinAbsX.toFixed(3)})`);
  // the base model wears a crop top: its midriff must be the top, not skin (no bare belly under a coat / tee)
  let belly = 0; for (let v = 0; v < roles.length; v++) { const y = bm.P[v * 3 + 1], x = bm.P[v * 3]; if (Math.abs(x) < 0.12 && y > 0.17 && y < 0.26 && roles[v] === R.SKIN) belly++; }
  ok(belly === 0, `no bare midriff (skin vertices on the belly: ${belly})`);
  const soles = [...roles].filter((r) => r === R.SOLE).length, shoes = [...roles].filter((r) => r === R.SHOE).length;
  ok(soles > 0 && shoes > 0, `a shoe has a dark sole (${soles}) and a coloured upper (${shoes})`);
}

// 6) 부품 GLB (Blender): 있어야 할 이름, 메시 크기, 머리 경계 안/밖
{
  const f = 'bf/kit/assets/custom/parts.glb';
  ok(fs.existsSync(url(f)), 'parts.glb exists');
  if (fs.existsSync(url(f))) {
    const g = load(f), names = new Set(g.j.nodes.filter((nd) => nd.mesh !== undefined).map((nd) => nd.name));
    const need = new Set(); for (const h of A.HAIRS) if (h.src && h.src.part) need.add(h.src.part);
    for (const l of [A.TOPS, A.BOTTOMS, A.SHOES]) for (const e of l) for (const p of e.parts) need.add(p);
    for (const nm of need) ok(names.has(nm), `parts.glb has ${nm}`);
    let tris = 0;
    for (const nd of g.j.nodes) {
      if (nd.mesh === undefined) continue;
      const p = g.j.meshes[nd.mesh].primitives[0], P = accessor(g, p.attributes.POSITION).arr, uv = accessor(g, p.attributes.TEXCOORD_0).arr, idx = accessor(g, p.indices).arr;
      tris += idx.length / 3;
      ok(p.attributes.NORMAL !== undefined && P.every(Number.isFinite) && uv.every((v) => v >= 0 && v <= 1), `${nd.name}: normals, finite positions, uv in 0..1`);
      let mn = [9, 9, 9], mx = [-9, -9, -9]; for (let v = 0; v < P.length / 3; v++) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[v * 3 + a]); mx[a] = Math.max(mx[a], P[v * 3 + a]); }
      const cell = A.cellKey(uv[0], uv[1]);
      ok(cell[0] === '2' || cell[0] === '3', `${nd.name}: uv lands in the palette rows (cell ${cell})`);
      if (nd.name.startsWith('hair_')) ok(mx[1] > 0.6 && mn[1] > 0.1 && Math.abs(mx[0]) < 0.4 && mx[1] < 0.9, `${nd.name}: sits on the head (y ${mn[1].toFixed(2)}..${mx[1].toFixed(2)})`);
      if (nd.name.startsWith('shoe_boot')) ok(mn[1] < 0.02 && mx[1] < 0.2, `${nd.name}: at the feet`);
    }
    ok(tris < 6000, `parts.glb stays small (${tris} triangles)`);
  }
}

// 4) 입장 화면 미리보기: 정면(yaw 0)으로 서서 방치해도 돌지 않고, 드래그·화살표 키로만 돈다(가짜 THREE·캔버스)
{
  const Obj = class { constructor() { this.position = { set() {} }; this.rotation = { y: 0 }; this.children = []; } add(c) { this.children.push(c); } lookAt() {} updateProjectionMatrix() {} };
  const T = { SRGBColorSpace: 's', ACESFilmicToneMapping: 1, Scene: Obj, Group: Obj, HemisphereLight: Obj, DirectionalLight: Obj, PointLight: Obj, PerspectiveCamera: Obj,
    WebGLRenderer: class { constructor() { this.domElement = { width: 0, height: 0 }; } setClearColor() {} setPixelRatio() {} setSize() {} render() {} dispose() {} forceContextLoss() {} } };
  const L = {}, canvas = { clientWidth: 300, clientHeight: 400, addEventListener: (t, f) => { L[t] = f; }, removeEventListener() {}, setPointerCapture() {} };
  let frameCb = null;
  globalThis.window = { devicePixelRatio: 1 }; globalThis.document = { hidden: false };
  globalThis.requestAnimationFrame = (f) => { frameCb = f; return 1; }; globalThis.cancelAnimationFrame = () => {};
  const mkAv = () => ({ root: new Obj(), headY: 1.6, play() {}, update() {}, setAppearance() {}, dispose() {} });
  const pv = createPreview(T, canvas, { createAvatar: mkAv });
  pv.setAppearance(A.defaultAppearance('m'));
  ok(pv.yaw === 0, `preview starts facing the front (yaw ${pv.yaw})`);
  pv.start();
  let t = 1000; frameCb(t);
  for (let i = 0; i < 700; i++) { t += 16; frameCb(t); }   // ~11 s left alone
  ok(pv.yaw === 0, `no auto-rotation after ~11 s idle (yaw ${pv.yaw})`);
  L.pointerdown({ clientX: 100, pointerId: 1 }); L.pointermove({ clientX: 150 }); L.pointerup();
  ok(Math.abs(pv.yaw - 50 * 0.012) < 1e-9, `drag turns it (yaw ${pv.yaw})`);
  const y0 = pv.yaw; for (let i = 0; i < 700; i++) { t += 16; frameCb(t); }
  ok(pv.yaw === y0, `stays where it was dropped, no drift after release (yaw ${pv.yaw})`);
  L.keydown({ key: 'ArrowRight', preventDefault() {} });
  ok(Math.abs(pv.yaw - (y0 + 0.25)) < 1e-9, `arrow key turns it (yaw ${pv.yaw})`);
  pv.dispose();
}

console.log(`${n - fails}/${n} avatar checks passed`);
process.exit(fails ? 1 : 0);
