// bf/kit/custom-avatar.js — the customisable avatar built from the Kenney "Mini Characters" (CC0) rig + a few procedural parts.
//
//  * body  = female-b's body mesh with a ROLE per vertex (skin / top / sleeves / bottom / thighs / shins / shoe / sole), see appearance.js
//  * head  = a bald head (face + ears of female-b, eyes+mouth of a female or male model)
//  * hair  = a Kenney model's own hair shells (transplanted onto the bald head) or a Blender part of parts.glb, parented to the head bone
//  * extras= hood / coat / skirt / boots (Blender parts of parts.glb) parented to the torso / leg bones
//  * look  = ONE material whose fragment shader swaps each role's palette cell for the chosen colour (keeping the cell's shading
//            gradient), so changing colours is a uniform write and every part (hair, hood, boots ...) shares the avatar's material.
// Parts are rigid children of bones (the bone-local geometry is cached once and shared by every avatar).
import { parseGLB, accessor } from './glb.js';
import { ROLE, ROLE_COUNT, HAIRS, PART_BONE, PART_ROLE, partNames, roleColors, sanitizeAppearance, analyseMesh, classifyHead, classifyBody, cellKey } from './appearance.js';

let T = null;
const lumOfKey = (lum, key) => { const [cy, cx] = key.split(',').map(Number); return lum(cx, cy); };
const arraysOf = (geo) => ({ P: geo.attributes.position.array, uv: geo.attributes.uv.array, idx: geo.index.array });

// the triangles of some welded shells -> compact attribute arrays
function pick(geo, an, set) {
  const A = geo.attributes, idx = geo.index.array, map = new Map(), vs = [], tris = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (!set.has(an.vertComp[idx[t]])) continue;
    for (let q = 0; q < 3; q++) { const v = idx[t + q]; let n = map.get(v); if (n === undefined) { n = vs.length; map.set(v, n); vs.push(v); } tris.push(n); }
  }
  const take = (name, k, Arr) => { const a = A[name]; if (!a) return null; const out = new Arr(vs.length * k); vs.forEach((v, i) => { for (let c = 0; c < k; c++) out[i * k + c] = a.array[v * k + c]; }); return out; };
  return { n: vs.length, position: take('position', 3, Float32Array), normal: take('normal', 3, Float32Array), uv: take('uv', 2, Float32Array),
    skinIndex: take('skinIndex', 4, Uint16Array), skinWeight: take('skinWeight', 4, Float32Array), index: tris };
}
const idxArr = (a, n) => (n > 65535 ? new Uint32Array(a) : new Uint16Array(a));
// role attribute: vec2 (role, reference luminance of the vertex's own palette cell)
function roleAttr(n, uv, roleOf, lum, refOf) {
  const out = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) { const key = cellKey(uv[v * 2], uv[v * 2 + 1]); out[v * 2] = roleOf(v, key); out[v * 2 + 1] = Math.max(0.02, refOf ? refOf(key) : lumOfKey(lum, key)); }
  return new T.BufferAttribute(out, 2);
}
function geoFrom(parts) {   // parts: [{ pk, role (fixed) | roleOf(v,key), ref? }] merged into one BufferGeometry
  let n = 0, tri = 0; for (const p of parts) { n += p.pk.n; tri += p.pk.index.length; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), sI = new Uint16Array(n * 4), sW = new Float32Array(n * 4), role = new Float32Array(n * 2), index = [];
  let o = 0, skinned = parts.every((p) => p.pk.skinIndex);
  for (const p of parts) {
    const k = p.pk; pos.set(k.position, o * 3); nor.set(k.normal, o * 3); uv.set(k.uv, o * 2);
    if (skinned) { sI.set(k.skinIndex, o * 4); sW.set(k.skinWeight, o * 4); }
    role.set(p.roleArr.array, o * 2);
    for (const i of k.index) index.push(i + o);
    o += k.n;
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  if (skinned) { g.setAttribute('skinIndex', new T.BufferAttribute(sI, 4)); g.setAttribute('skinWeight', new T.BufferAttribute(sW, 4)); }
  g.setAttribute('aRole', new T.BufferAttribute(role, 2)); g.setIndex(new T.BufferAttribute(idxArr(index, n), 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}
const jointOf = (names, name) => names.indexOf(name);

export async function buildCustomKit(THREE, { partsUrl, temps, lum }) {
  T = THREE;
  const base = temps.get('bun');   // female-b: the rig, the body and the bald head all of the custom avatars share
  if (!base || !base.geos || !base.jointNames) throw new Error('custom avatar: base template missing');
  const names0 = base.jointNames[0], names1 = base.jointNames[1];

  // --- body: roles per vertex
  const bodyGeo = base.geos[0].clone(), bAn = analyseMesh(arraysOf(bodyGeo));
  const headSrc = base.geos[1], hAn = analyseMesh(arraysOf(headSrc)), hc = classifyHead(hAn);
  if (hc.face < 0) throw new Error('custom avatar: face shell not found');
  const roles = classifyBody(bAn, arraysOf(bodyGeo), hc.skinCell), nB = bodyGeo.attributes.position.count;
  bodyGeo.setAttribute('aRole', roleAttr(nB, bodyGeo.attributes.uv.array, (v) => roles[v], lum));

  // --- heads (one per gender): face + ears from the base, eyes + mouth from a female / male model
  const headFor = (eyeId) => {
    const es = temps.get(eyeId) || base, eAn = es === base ? hAn : analyseMesh(arraysOf(es.geos[1])), ec = es === base ? hc : classifyHead(eAn);
    const faceEars = pick(headSrc, hAn, new Set([hc.face, ...hc.ears])), eyes = pick(es.geos[1], eAn, new Set(ec.eyes));
    const jm = es.jointNames[1].map((nm) => Math.max(0, jointOf(names1, nm)));   // the eye model's joints -> the base skin's joint indices
    if (eyes.skinIndex) for (let i = 0; i < eyes.skinIndex.length; i++) eyes.skinIndex[i] = jm[eyes.skinIndex[i]];
    return geoFrom([
      { pk: faceEars, roleArr: roleAttr(faceEars.n, faceEars.uv, () => ROLE.SKIN, lum) },
      { pk: eyes, roleArr: roleAttr(eyes.n, eyes.uv, () => ROLE.NONE, lum) },
    ]);
  };
  const heads = { f: headFor('curly'), m: headFor('beard') };

  // --- bone-local rigid parts (cached, shared)
  const headIbm = base.skins[0].inv[jointOf(names0, 'head')];
  const toBone = (geo, boneName) => { geo.applyMatrix4(base.skins[0].inv[Math.max(0, jointOf(names0, boneName))]); geo.computeBoundingSphere(); geo.computeBoundingBox(); return geo; };
  const faceBox = (() => {   // the bald head's extent in head-bone space (the hat sits on it)
    const fp = pick(headSrc, hAn, new Set([hc.face])), b = new T.Box3(), v = new T.Vector3();
    for (let i = 0; i < fp.n; i++) b.expandByPoint(v.set(fp.position[i * 3], fp.position[i * 3 + 1], fp.position[i * 3 + 2]).applyMatrix4(headIbm));
    return b;
  })();
  const entryOf = (geo, bone, topY) => ({ geo: toBone(geo, bone), bone, box: geo.boundingBox.clone(), topY });
  const topOf = (pk) => { let y = 0; for (let i = 0; i < pk.n; i++) y = Math.max(y, pk.position[i * 3 + 1]); return y; };
  const hairModels = new Map();   // Kenney id -> entry (lazy)
  const modelHair = (id) => {
    if (hairModels.has(id)) return hairModels.get(id);
    const t = temps.get(id); let e = null;
    if (t) {
      const an = analyseMesh(arraysOf(t.geos[1])), c = classifyHead(an), pk = pick(t.geos[1], an, new Set(c.hair));
      if (pk.n) {
        const cnt = new Map(); for (let v = 0; v < pk.n; v++) { const k = cellKey(pk.uv[v * 2], pk.uv[v * 2 + 1]); cnt.set(k, (cnt.get(k) || 0) + 1); }
        const dom = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0], ref = lumOfKey(lum, dom);   // one reference for the whole hair: its lighter locks stay lighter
        e = entryOf(geoFrom([{ pk, roleArr: roleAttr(pk.n, pk.uv, () => ROLE.HAIR, lum, () => ref) }]), 'head', topOf(pk));
      }
    }
    hairModels.set(id, e); return e;
  };
  const parts = new Map();   // Blender part name -> entry
  let partsOk = false;
  try {
    const r = await fetch(partsUrl); if (!r.ok) throw new Error('parts.glb ' + r.status);
    const g = parseGLB(await r.arrayBuffer());
    for (const nd of g.j.nodes) {
      if (nd.mesh === undefined || !nd.name) continue;
      const p = g.j.meshes[nd.mesh].primitives[0], at = p.attributes;
      const pk = { position: accessor(g, at.POSITION).arr, normal: at.NORMAL !== undefined ? accessor(g, at.NORMAL).arr : null, uv: accessor(g, at.TEXCOORD_0).arr, index: Array.from(accessor(g, p.indices).arr), skinIndex: null, skinWeight: null };
      pk.n = pk.position.length / 3;
      const m4 = new T.Matrix4();   // the node's own transform (identity for our export, honoured anyway)
      if (nd.matrix) m4.fromArray(nd.matrix); else m4.compose(new T.Vector3(...(nd.translation || [0, 0, 0])), new T.Quaternion(...(nd.rotation || [0, 0, 0, 1])), new T.Vector3(...(nd.scale || [1, 1, 1])));
      const role = PART_ROLE(nd.name);
      const geo = geoFrom([{ pk: { ...pk, normal: pk.normal || new Float32Array(pk.n * 3) }, roleArr: roleAttr(pk.n, pk.uv, (v, key) => (key === '3,0' ? ROLE.NONE : role), lum) }]);
      if (!pk.normal) geo.computeVertexNormals();
      geo.applyMatrix4(m4);
      parts.set(nd.name, entryOf(geo, PART_BONE(nd.name), topOf({ n: pk.n, position: geo.attributes.position.array })));
    }
    partsOk = parts.size > 0;
  } catch (e) { console.warn('[bonfire] avatar parts not loaded (hair/clothes extras off):', e && e.message); }

  // --- the material: palette-cell recolour by role
  function makeMaterial(baseMat) {
    const m = baseMat.clone(), uRC = { value: Array.from({ length: ROLE_COUNT }, () => new T.Color('#ffffff')) };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRC = uRC;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aRole;\nvarying vec2 vRole;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRole = aRole;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform vec3 uRC[${ROLE_COUNT}];\nvarying vec2 vRole;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  { int role = int(vRole.x + 0.5);
    if (role > 0) { float l = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)); diffuseColor.rgb = diffuse * uRC[role] * clamp(l / max(vRole.y, 0.02), 0.45, 1.6); } }
#endif`);
    };
    m.customProgramCacheKey = () => 'kit-custom-v1';
    m.userData.uRC = uRC;
    return m;
  }

  // --- a rig: applies an appearance to one instantiated model (swap head, hang parts, write colours)
  function createRig(model, mat) {
    const headMesh = model.getObjectByName('head-mesh'), bodyMesh = model.getObjectByName('body-mesh'), meshes = [];
    if (bodyMesh) bodyMesh.geometry = bodyGeo;
    const rig = { top: 0.66, headBox: null, ap: null };
    rig.set = (apIn) => {
      const ap = sanitizeAppearance(apIn) || sanitizeAppearance({ g: 'f' });
      const rc = roleColors(ap); for (let i = 0; i < ROLE_COUNT; i++) mat.userData.uRC.value[i].set(rc[i]);
      if (headMesh) headMesh.geometry = heads[ap.g];
      for (const m of meshes) m.parent && m.parent.remove(m);
      meshes.length = 0;
      const es = [], hs = HAIRS[ap.h].src;
      if (hs && hs.model) { const e = modelHair(hs.model); if (e) es.push(e); }
      for (const nm of partNames(ap)) { const e = parts.get(nm); if (e) es.push(e); }
      let top = 0.66; const hb = faceBox.clone();
      for (const e of es) {
        const bone = model.getObjectByName(e.bone); if (!bone) continue;
        const mesh = new T.Mesh(e.geo, mat); mesh.castShadow = true; mesh.frustumCulled = false; mesh.name = 'part';
        bone.add(mesh); meshes.push(mesh);
        if (e.bone === 'head') { hb.union(e.box); top = Math.max(top, e.topY); }
      }
      rig.top = top; rig.headBox = { min: hb.min.clone(), max: hb.max.clone() }; rig.ap = ap;
    };
    return rig;
  }

  return { heads, bodyGeo, parts, partsOk, faceBox, makeMaterial, createRig, base };
}
