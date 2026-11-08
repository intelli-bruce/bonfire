// tools/bosses/detail_pack.mjs — 보스 GLB 디테일 베이크 + KTX2 압축.
//
//   cd tools && npm i            # @gltf-transform/* · draco3dgltf (개발 도구만, 게임은 쓰지 않는다)
//   brew install basis_universal # basisu (KTX2 인코더)
//   node tools/bosses/detail_pack.mjs [spider shark golem seraph demon commander hydra] [--work <dir>] [--skip-bake]
//
// 하는 일(보스 하나마다):
//   1) bf/<boss>.glb 의 텍스처를 꺼내 묶음(노멀 맵 하나 = 묶음)을 만들고 tools/bosses/sculpt_bake.py(Blender)로
//      고해상 스컬프트 → 노멀 · AO · 곡률 베이크, 색 · ORM 합성. 기존 numpy 노멀 맵을 대체한다.
//   2) 새 텍스처를 넣어 bf/<boss>.glb(JPEG 대체판)를 다시 쓰고(occlusionTexture = ORM 의 R, 러프니스 맵이 있던 재질은 같은 ORM 의 G),
//   3) 같은 내용을 KTX2(Basis ETC1S, 노멀은 normal_map 모드)로 바꾼 bf/<boss>.ktx2.glb 를 쓴다(KHR_texture_basisu 필수 확장).
//   지오메트리 · 뼈 · UV 는 그대로(삼각형 수 불변). 두 번 굽지 않도록 asset.extras.detailBake 표시를 남긴다(다시 하려면 build_* 로 새로 만든 뒤).
//   마지막에 다운로드 크기 · VRAM 추정 표를 찍는다(work/report.md).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BF = path.resolve(HERE, '../../bf');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WORK = path.resolve(opt('--work', path.join(HERE, '.detail-work')));
const SKIP_BAKE = args.includes('--skip-bake');
const ALL = ['spider', 'spider_mini', 'shark', 'golem', 'seraph', 'demon', 'commander', 'hydra'];
let bosses = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--work')));
if (!bosses.length) bosses = ALL;
if (bosses.includes('spider') && !bosses.includes('spider_mini')) bosses.push('spider_mini');   // 새끼 거미는 같은 키틴 텍스처

// 노멀 맵 이름 → 스컬프트 무늬(tools/bosses/sculpt_bake.py 의 recipe)
const RECIPE = {
  sp_chitin_normal: 'chitin', sp_fur_normal: 'strand',
  shark_normal: 'scale', shark_tooth_normal: 'bone', shark_flesh_normal: 'membrane',
  golem_normal: 'rock', golem_moss_normal: 'moss',
  seraph_normal: 'muscle', scale_normal: 'scale', armor_normal: 'metal', feather_normal: 'strand',
  demon_skin_n: 'muscle', demon_horn_n: 'horn', demon_mane_n: 'strand',
  cmd_armor_normal: 'metal', cmd_skin_normal: 'muscle', cmd_tooth_normal: 'bone', cmd_gold_normal: 'metal', cmd_cape_normal: 'cloth',
  hydra_scale_normal: 'scale', hydra_bone_normal: 'bone', hydra_skin_normal: 'membrane', hydra_membrane_normal: 'membrane',
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule() });
const DRACO_OPT = { method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER, encodeSpeed: 5, decodeSpeed: 5,
  quantizationBits: { POSITION: 14, NORMAL: 10, COLOR: 10, TEX_COORD: 12, GENERIC: 12 } };   // build_bosses.export 와 같은 양자화

const texName = (t) => t.getName() || path.basename(t.getURI() || 'tex', path.extname(t.getURI() || ''));
const ext = (t) => (t.getMimeType() === 'image/png' ? '.png' : '.jpg');
const vram = (w, h, bpp) => w * h * bpp * 4 / 3;          // 밉맵 포함
const MB = (b) => (b / 1048576).toFixed(2);

function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) { console.error(r.stdout?.slice(-4000), r.stderr?.slice(-4000)); throw new Error(`${cmd} 실패 (${r.status})`); }
  return r.stdout;
}

// KTX2: 전부 ETC1S(노멀은 -normal_map 최고 품질). UASTC 노멀은 1 MB/장이 넘어 다운로드가 JPEG 보다 커져 쓰지 않는다.
// GPU 바이트/픽셀은 보수적으로 1(데스크톱 BC7 으로 풀림. 모바일 ETC2 RGB 면 0.5) — RGBA8 4 바이트 대비.
function toKtx2(src, out, kind) {
  const a = ['-ktx2', '-mipmap', '-output_file', out];   // glTF 이미지는 위→아래 그대로(flipY=false) → 뒤집지 않는다
  if (kind === 'normal') a.push('-q', '255', '-linear', '-normal_map');
  else if (kind === 'data') a.push('-q', '128', '-linear');
  else a.push('-q', '128');
  a.push(src);
  run('basisu', a);
  return { bytes: fs.statSync(out).size, bpp: 1 };
}

fs.mkdirSync(WORK, { recursive: true });
const report = [];

for (const boss of bosses) {
  const file = path.join(BF, boss + '.glb');
  const doc = await io.read(file);
  const root = doc.getRoot();
  const asset = root.getAsset();
  const W = path.join(WORK, boss); fs.mkdirSync(W, { recursive: true });
  const before = fs.statSync(file).size;
  const beforeTex = root.listTextures().map((t) => ({ n: texName(t), s: t.getSize(), b: t.getImage().byteLength }));
  const already = asset.extras && asset.extras.detailBake;
  if (already) console.log(`[${boss}] 이미 베이크됨(${already}) — 텍스처는 그대로, KTX2 판만 다시 만든다`);

  // ---- 1) 묶음 모으기
  const sets = new Map();     // 노멀 텍스처 → { name, normal, albedo, rough, mats: [] }
  for (const m of root.listMaterials()) {
    const n = m.getNormalTexture(); if (!n) continue;
    const key = texName(n);
    if (!sets.has(key)) sets.set(key, { name: key, normal: n, albedo: null, rough: null, mats: [] });
    const s = sets.get(key); s.mats.push(m);
    if (!s.albedo && m.getBaseColorTexture()) s.albedo = m.getBaseColorTexture();
    if (!s.rough && m.getMetallicRoughnessTexture()) s.rough = m.getMetallicRoughnessTexture();
  }
  const usedAlb = new Set();
  const spec = [];
  for (const s of sets.values()) {
    if (!RECIPE[s.name]) { console.warn(`[${boss}] 무늬 없음: ${s.name} — 건너뜀`); continue; }
    if (s.albedo && usedAlb.has(s.albedo)) s.albedo = null; else if (s.albedo) usedAlb.add(s.albedo);
    const put = (t) => { const p = path.join(W, 'src_' + texName(t) + ext(t)); fs.writeFileSync(p, t.getImage()); return p; };
    const nres = s.normal.getSize()[0], ares = s.albedo ? s.albedo.getSize()[0] : 0;
    spec.push({ name: s.name, recipe: RECIPE[s.name], res: Math.min(2048, Math.max(nres, ares)), albedoRes: ares || undefined,
      albedo: s.albedo ? put(s.albedo) : undefined, rough: s.rough ? put(s.rough) : undefined, seed: spec.length + 1 + boss.length * 7 });
  }

  if (!already) {
    // ---- 2) Blender 스컬프트 · 베이크 (새끼 거미는 거미 결과를 그대로 쓴다)
    const shared = boss === 'spider_mini' ? path.join(WORK, 'spider') : null;
    if (!shared && !SKIP_BAKE) {
      fs.writeFileSync(path.join(W, 'spec.json'), JSON.stringify(spec, null, 1));
      const t0 = Date.now();
      const out = run('blender', ['-b', '--factory-startup', '--python', path.join(HERE, 'sculpt_bake.py'), '--', '--spec', path.join(W, 'spec.json')]);
      fs.writeFileSync(path.join(W, 'blender.log'), out);
      console.log(`[${boss}] Blender 베이크 ${((Date.now() - t0) / 1000) | 0}s`);
    }
    const SW = shared || W;
    // ---- 3) 새 텍스처 넣기
    for (const sp of spec) {
      const s = sets.get(sp.name);
      const rd = (suf) => fs.readFileSync(path.join(SW, sp.name + suf));
      s.normal.setImage(rd('_n.jpg')).setMimeType('image/jpeg');
      if (sp.albedo) s.albedo.setImage(rd('_alb.jpg')).setMimeType('image/jpeg');
      const orm = doc.createTexture(sp.name + '_orm').setImage(rd('_orm.jpg')).setMimeType('image/jpeg').setURI(sp.name + '_orm.jpg');
      for (const m of s.mats) {
        if (m.getMetallicRoughnessTexture()) m.setMetallicRoughnessTexture(orm);   // G = 기존 러프니스 그대로
        m.setOcclusionTexture(orm).setOcclusionStrength(1.0);
        const oi = m.getOcclusionTextureInfo(); if (oi) oi.setTexCoord(0);
      }
    }
    asset.extras = { ...(asset.extras || {}), detailBake: 'sculpt_bake.py v1 ' + new Date().toISOString().slice(0, 10) };
    await prune()(doc);   // 안 쓰게 된 옛 러프니스 맵 정리
    doc.getRoot().listExtensionsUsed().filter((e) => e.extensionName === 'KHR_draco_mesh_compression').forEach((e) => e.setRequired(true).setEncoderOptions(DRACO_OPT));
    await io.write(file, doc);
  }
  const jpgDoc = await io.read(file);
  const jpgSize = fs.statSync(file).size;

  // ---- 4) KTX2 판
  const kdoc = jpgDoc; const kroot = kdoc.getRoot();
  kdoc.createExtension(KHRTextureBasisu).setRequired(true);
  const kind = new Map();
  for (const m of kroot.listMaterials()) {
    if (m.getNormalTexture()) kind.set(m.getNormalTexture(), 'normal');
    for (const t of [m.getOcclusionTexture(), m.getMetallicRoughnessTexture()]) if (t) kind.set(t, 'data');
  }
  let vJ = 0, vK = 0; const rows = [];
  for (const t of kroot.listTextures()) {
    const nm = texName(t), [w, h] = t.getSize(), k = kind.get(t) || 'color';
    const src = path.join(W, 'k_' + nm + ext(t)); fs.writeFileSync(src, t.getImage());
    const out = path.join(W, 'k_' + nm + '.ktx2');
    const r = toKtx2(src, out, k);
    t.setImage(fs.readFileSync(out)).setMimeType('image/ktx2').setURI(nm + '.ktx2');
    vJ += vram(w, h, 4); vK += vram(w, h, r.bpp);
    rows.push(`${nm} ${w}² ${k} ${(t.getImage().byteLength / 1024) | 0}K`);
  }
  kdoc.getRoot().listExtensionsUsed().filter((e) => e.extensionName === 'KHR_draco_mesh_compression').forEach((e) => e.setRequired(true).setEncoderOptions(DRACO_OPT));
  const kfile = path.join(BF, boss + '.ktx2.glb');
  await io.write(kfile, kdoc);
  const kSize = fs.statSync(kfile).size;
  let tris0 = 0;
  for (const me of kroot.listMeshes()) if (/LOD0|^Spider$/.test(me.getName())) for (const p of me.listPrimitives()) tris0 += p.getIndices().getCount() / 3;
  const vBefore = beforeTex.reduce((a, x) => a + vram(x.s[0], x.s[1], 4), 0);
  report.push({ boss, before, jpgSize, kSize, vBefore, vJ, vK, tris0 });
  console.log(`[${boss}] glb ${MB(before)}MB → JPEG판 ${MB(jpgSize)}MB · KTX2판 ${MB(kSize)}MB | VRAM(텍스처 추정) ${MB(vBefore)} → JPEG ${MB(vJ)} · KTX2 ${MB(vK)} MB | LOD0 tris ${tris0}`);
  fs.writeFileSync(path.join(W, 'ktx2.txt'), rows.join('\n'));
}

const md = ['| 보스 | 원래 glb | JPEG 판 | KTX2 판 | 다운로드 변화 | VRAM 원래 | VRAM KTX2 | VRAM 변화 | LOD0 삼각형 |', '|---|---|---|---|---|---|---|---|---|'];
for (const r of report) md.push(`| ${r.boss} | ${MB(r.before)} MB | ${MB(r.jpgSize)} MB | ${MB(r.kSize)} MB | ${(((r.kSize / r.before) - 1) * 100).toFixed(0)}% | ${MB(r.vBefore)} MB | ${MB(r.vK)} MB | ${(((r.vK / r.vBefore) - 1) * 100).toFixed(0)}% | ${r.tris0} |`);
fs.writeFileSync(path.join(WORK, 'report.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
