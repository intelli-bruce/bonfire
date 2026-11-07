// bf/kit/avatar.js — rigged CC0 characters (Kenney "Mini Characters", CC0) + shared animation set + crossfading animator.
// THREE is passed in (loadAvatarKit(THREE, ...)) so the page keeps a single THREE instance; no addon imports needed
// (a tiny GLB reader below handles these simple skinned files: float attributes, uint16 joints/indices, LINEAR samplers).
//
// Conventions: avatar.root origin at the feet; rotation.y = ry faces (-sin ry, -cos ry) (ry = 0 faces -Z).
// Call controller.update() each frame (it drives avatar.update()); without a controller use avatar.play(name) + avatar.update(dt).

import { parseGLB, accessor, cleanName } from './glb.js';
import { buildCustomKit } from './custom-avatar.js';

let T = null;               // THREE
let KIT = null;             // { scale, base, chars: Map<id, template>, clips: Map<name, AnimationClip>, shadowGeo, shadowMat, custom }

export const CHARACTERS = [
  { id: 'bun',      name: '주황 똥머리', file: 'character-female-b.glb', accent: '#ffb53d' },
  { id: 'glasses',  name: '안경 친구',   file: 'character-male-a.glb',   accent: '#4fc48a' },
  { id: 'curly',    name: '곱슬 머리',   file: 'character-female-f.glb', accent: '#a46cf0' },
  { id: 'overalls', name: '노랑 멜빵',   file: 'character-male-e.glb',   accent: '#ffcf4a' },
  { id: 'beard',    name: '수염 아저씨', file: 'character-male-b.glb',   accent: '#ff7a45' },
];
const MODEL_DIR = 'assets/kenney-mini-characters/';
const DEFAULT_SCALE = 2.2;  // model is ~0.67 m tall → ~1.5 m chunky avatar
export const SIT_HIP = 0.026; // model units: bottom of the torso above the root origin in the sit poses (× scale = metres)

// ---------------------------------------------------------------- tiny GLB reader: bf/kit/glb.js (shared with the node tests)
// Parses once into a reusable template; instantiate() builds a fresh node graph sharing geometry.
function buildTemplate(g) {
  const { j } = g;
  const geos = j.meshes.map((m) => {
    const p = m.primitives[0], geo = new T.BufferGeometry(), at = p.attributes;
    const add = (key, name, Attr) => { if (at[key] === undefined) return; const { arr, n } = accessor(g, at[key]); geo.setAttribute(name, new Attr(arr, n)); };
    add('POSITION', 'position', T.BufferAttribute); add('NORMAL', 'normal', T.BufferAttribute); add('TEXCOORD_0', 'uv', T.BufferAttribute);
    add('JOINTS_0', 'skinIndex', T.BufferAttribute); add('WEIGHTS_0', 'skinWeight', T.BufferAttribute);
    if (p.indices !== undefined) geo.setIndex(new T.BufferAttribute(accessor(g, p.indices).arr, 1));
    geo.computeBoundingSphere();
    return geo;
  });
  const skins = (j.skins || []).map((s) => {
    const inv = accessor(g, s.inverseBindMatrices).arr;
    return { joints: s.joints, inv: s.joints.map((_, k) => new T.Matrix4().fromArray(inv, k * 16)) };
  });
  const jointSet = new Set(skins.flatMap((s) => s.joints));
  // accent cell: palette cell (64×128 px of the 512² colormap) that dominates the clothes (arms + torso);
  // skin tones and the near-black cell (eyes, brows) are excluded
  const accentCell = (() => {
    const s = skins[0], names = s.joints.map((k) => j.nodes[k].name), hist = new Map();
    for (const mi of [0]) {
      const p = j.meshes[mi].primitives[0];
      const uv = accessor(g, p.attributes.TEXCOORD_0).arr, J = accessor(g, p.attributes.JOINTS_0).arr, W = accessor(g, p.attributes.WEIGHTS_0).arr;
      for (let v = 0; v < uv.length / 2; v++) {
        let best = 0; for (let q = 1; q < 4; q++) if (W[v * 4 + q] > W[v * 4 + best]) best = q;
        if (!/^(arm|torso)/.test(names[J[v * 4 + best]])) continue;
        const cx = Math.min(7, Math.floor(uv[v * 2] * 8)), cy = Math.min(3, Math.floor(uv[v * 2 + 1] * 4));
        if (cy === 3 && (cx >= 5 || cx === 0)) continue;   // skin tones, near-black
        const key = cy * 8 + cx; hist.set(key, (hist.get(key) || 0) + 1);
      }
    }
    let key = -1, cnt = 0; for (const [k, c] of hist) if (c > cnt) { cnt = c; key = k; }
    return key < 0 ? null : { cx: key % 8, cy: Math.floor(key / 8) };
  })();
  // head extent in the head bone's own space (model units), from vertices weighted mostly to 'head': where hats sit
  const headBox = (() => {
    const mn = new T.Vector3(1e9, 1e9, 1e9), mx = new T.Vector3(-1e9, -1e9, -1e9), v = new T.Vector3();
    j.nodes.forEach((n) => {
      if (n.mesh === undefined || n.skin === undefined) return;
      const sk = skins[n.skin], hi = sk.joints.findIndex((k) => cleanName(j.nodes[k].name) === 'head'); if (hi < 0) return;
      const p = j.meshes[n.mesh].primitives[0], P = accessor(g, p.attributes.POSITION).arr, J = accessor(g, p.attributes.JOINTS_0).arr, W = accessor(g, p.attributes.WEIGHTS_0).arr;
      for (let i = 0; i < P.length / 3; i++) {
        let best = 0; for (let q = 1; q < 4; q++) if (W[i * 4 + q] > W[i * 4 + best]) best = q;
        if (J[i * 4 + best] !== hi) continue;
        v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(sk.inv[hi]); mn.min(v); mx.max(v);
      }
    });
    return mn.x < mx.x ? { min: mn, max: mx } : null;
  })();
  // head top in model units (for labels)
  let top = 0;
  for (const geo of geos) { const pa = geo.attributes.position; for (let i = 0; i < pa.count; i++) top = Math.max(top, pa.getY(i)); }
  const clips = (j.animations || []).map((a) => {
    const tracks = [];
    for (const ch of a.channels) {
      const s = a.samplers[ch.sampler], node = j.nodes[ch.target.node]; if (!node) continue;
      const times = accessor(g, s.input).arr, vals = accessor(g, s.output).arr, nm = cleanName(node.name);
      const P = ch.target.path;
      if (P === 'rotation') tracks.push(new T.QuaternionKeyframeTrack(nm + '.quaternion', times, vals));
      else if (P === 'translation') tracks.push(new T.VectorKeyframeTrack(nm + '.position', times, vals));
      else if (P === 'scale') tracks.push(new T.VectorKeyframeTrack(nm + '.scale', times, vals));
    }
    return new T.AnimationClip(a.name, -1, tracks);
  });
  function instantiate(material) {
    const objs = j.nodes.map((n, i) => {
      let o;
      if (jointSet.has(i)) o = new T.Bone();
      else if (n.mesh !== undefined) { o = new T.SkinnedMesh(geos[n.mesh], material); o.frustumCulled = false; o.castShadow = true; }
      else o = new T.Group();
      o.name = cleanName(n.name);
      if (n.matrix) new T.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
      return o;
    });
    j.nodes.forEach((n, i) => (n.children || []).forEach((c) => objs[i].add(objs[c])));
    const scene = new T.Group();
    for (const r of j.scenes[j.scene || 0].nodes) scene.add(objs[r]);
    scene.updateMatrixWorld(true);
    j.nodes.forEach((n, i) => {
      if (n.mesh === undefined || n.skin === undefined) return;
      const sk = skins[n.skin];
      objs[i].bind(new T.Skeleton(sk.joints.map((k) => objs[k]), sk.inv.map((m) => m.clone())), objs[i].matrixWorld);
    });
    return scene;
  }
  const jointNames = skins.map((sk) => sk.joints.map((k) => cleanName(j.nodes[k].name)));   // per skin: bone names in joint order (the custom builder maps by name)
  return { instantiate, clips, accentCell, top, headBox, imageUri: j.images && j.images[0] && j.images[0].uri, geos, skins, jointNames };
}

// ---------------------------------------------------------------- authored clips (same 7-bone rig as the Kenney set)
// Euler degrees, order XYZ (Z applied first: for arms, Z lowers/raises from the T-pose, X then swings fore/aft).
// Model faces +Z; arm-left at +X, arm-right at -X. leg X<0 = forward. torso X>0 = lean forward. root X>0 = pitch forward.
const BONES = ['root', 'torso', 'head', 'arm-left', 'arm-right', 'leg-left', 'leg-right'];
const BASE = { root: [0, 0, 0], torso: [0, 0, 0], head: [0, 0, 0], 'arm-left': [0, 0, -45], 'arm-right': [0, 0, 45], 'leg-left': [0, 0, 0], 'leg-right': [0, 0, 0] };
function makeClip(name, dur, keys, pivot = [0, 0.3, 0]) {
  // keys: [{ t (0..1 of dur), root, torso, ..., rp: [x,y,z] extra root offset, rs: [sx,sy,sz] }]; unspecified bones inherit the previous key
  const times = keys.map((k) => k.t * dur);
  const q = new T.Quaternion(), e = new T.Euler(), c = new T.Vector3(...pivot), v = new T.Vector3();
  const tracks = [];
  let prev = { ...BASE, rp: [0, 0, 0], rs: [1, 1, 1] };
  const full = keys.map((k) => (prev = { ...prev, ...k }));
  let lastQ = {};
  for (const b of BONES) {
    const vals = [];
    full.forEach((k) => {
      const d = k[b]; e.set(d[0] * Math.PI / 180, d[1] * Math.PI / 180, d[2] * Math.PI / 180, 'XYZ'); q.setFromEuler(e);
      const lq = lastQ[b]; if (lq && lq.dot(q) < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }
      lastQ[b] = q.clone();
      vals.push(q.x, q.y, q.z, q.w);
    });
    tracks.push(new T.QuaternionKeyframeTrack(b + '.quaternion', times, vals));
  }
  // root position: user offset + pivot compensation so root rotations turn about `pivot` (belly), not the feet
  const pv = [], sv = [];
  full.forEach((k) => {
    const d = k.root; e.set(d[0] * Math.PI / 180, d[1] * Math.PI / 180, d[2] * Math.PI / 180, 'XYZ'); q.setFromEuler(e);
    v.copy(c).applyQuaternion(q); pv.push(c.x - v.x + k.rp[0], c.y - v.y + k.rp[1], c.z - v.z + k.rp[2]);
    sv.push(...k.rs);
  });
  tracks.push(new T.VectorKeyframeTrack('root.position', times, pv));
  tracks.push(new T.VectorKeyframeTrack('root.scale', times, sv));
  return new T.AnimationClip(name, dur, tracks);
}
function authoredClips() {
  const C = [];
  C.push(makeClip('dash', 0.25, [
    { t: 0, root: [8, 0, 0], torso: [18, 0, 0], 'arm-left': [40, 0, -70], 'arm-right': [40, 0, 70], 'leg-left': [-35, 0, 0], 'leg-right': [40, 0, 0], rs: [0.94, 0.94, 1.12] },
    { t: 0.3, root: [16, 0, 0], torso: [24, 0, 0], head: [-14, 0, 0], 'arm-left': [75, 0, -62], 'arm-right': [75, 0, 62], 'leg-left': [-50, 0, 0], 'leg-right': [55, 0, 0], rs: [0.9, 0.9, 1.2] },
    { t: 1, root: [12, 0, 0], torso: [20, 0, 0], head: [-10, 0, 0], 'arm-left': [65, 0, -66], 'arm-right': [65, 0, 66], 'leg-left': [-40, 0, 0], 'leg-right': [45, 0, 0], rs: [1, 1, 1] },
  ]));
  C.push(makeClip('leap', 0.6, [
    { t: 0, root: [25, 0, 0], torso: [15, 0, 0], head: [-25, 0, 0], 'arm-left': [-140, 0, -75], 'arm-right': [-140, 0, 75], 'leg-left': [20, 0, 0], 'leg-right': [50, 0, 0], rs: [0.92, 0.92, 1.15] },
    { t: 0.45, root: [40, 0, 0], torso: [12, 0, 0], head: [-35, 0, 0], 'arm-left': [-165, 0, -80], 'arm-right': [-165, 0, 80], 'leg-left': [35, 0, 6], 'leg-right': [45, 0, -6], rs: [1, 1, 1.05] },
    { t: 1, root: [18, 0, 0], torso: [8, 0, 0], head: [-15, 0, 0], 'arm-left': [-100, 0, -70], 'arm-right': [-100, 0, 70], 'leg-left': [-25, 0, 0], 'leg-right': [10, 0, 0], rs: [1, 1, 1] },
  ]));
  const tuck = { torso: [30, 0, 0], head: [25, 0, 0], 'arm-left': [-75, 0, -60], 'arm-right': [-75, 0, 60], 'leg-left': [-85, 0, 0], 'leg-right': [-85, 0, 0] };
  C.push(makeClip('roll', 0.55, [
    { t: 0, root: [0, 0, 0], torso: [18, 0, 0], head: [10, 0, 0], 'arm-left': [-45, 0, -60], 'arm-right': [-45, 0, 60], 'leg-left': [-25, 0, 0], 'leg-right': [-5, 0, 0], rs: [1.04, 0.9, 1.04] },
    { t: 0.12, root: [45, 0, 0], ...tuck, rs: [0.96, 0.86, 0.96] },
    { t: 0.24, root: [90, 0, 0] }, { t: 0.36, root: [135, 0, 0] }, { t: 0.48, root: [180, 0, 0] },
    { t: 0.6, root: [225, 0, 0] }, { t: 0.72, root: [270, 0, 0] },
    { t: 0.84, root: [315, 0, 0], torso: [20, 0, 0], head: [12, 0, 0], 'arm-left': [-40, 0, -55], 'arm-right': [-40, 0, 55], 'leg-left': [-45, 0, 0], 'leg-right': [-30, 0, 0], rs: [1, 0.92, 1] },
    { t: 0.93, root: [350, 0, 0], torso: [10, 0, 0], head: [4, 0, 0], 'arm-left': [-10, 0, -50], 'arm-right': [-10, 0, 50], 'leg-left': [-15, 0, 0], 'leg-right': [5, 0, 0], rs: [1.04, 0.94, 1.04] },
    { t: 1, root: [360, 0, 0], torso: [4, 0, 0], head: [0, 0, 0], 'arm-left': [0, 0, -48], 'arm-right': [0, 0, 48], 'leg-left': [-8, 0, 0], 'leg-right': [8, 0, 0], rs: [1, 1, 1] },
  ], [0, 0.28, 0]));
  C.push(makeClip('sitGround', 2.4, [
    { t: 0, rp: [0, -0.06, 0], torso: [-8, 0, 0], head: [4, 0, 0], 'arm-left': [28, 0, -62], 'arm-right': [28, 0, 62], 'leg-left': [-90, 0, 7], 'leg-right': [-90, 0, -7] },
    { t: 0.5, torso: [-6, 0, 0], head: [0, 0, 5] },
    { t: 1, torso: [-8, 0, 0], head: [4, 0, 0] },
  ]));
  // prone: body pitched 90° about its middle so the belly faces down; root kept centred on the avatar origin
  const proneBase = { root: [90, 0, 0], rp: [0, -0.21, 0], torso: [0, 0, 0], head: [-48, 0, 0], 'arm-left': [10, 0, 62], 'arm-right': [10, 0, -62], 'leg-left': [0, 0, 10], 'leg-right': [0, 0, -10] };
  C.push(makeClip('prone', 2.0, [
    { t: 0, ...proneBase },
    { t: 0.5, head: [-42, 0, 3], rs: [1.02, 1, 1.03] },
    { t: 1, head: [-48, 0, 0], rs: [1, 1, 1] },
  ], [0, 0.33, 0]));
  C.push(makeClip('crawl', 0.9, [
    { t: 0, ...proneBase, root: [90, 0, 6], 'arm-left': [10, 0, 105], 'arm-right': [10, 0, -45], 'leg-left': [0, 0, 2], 'leg-right': [0, 0, -28] },
    { t: 0.5, root: [90, 0, -6], 'arm-left': [10, 0, 45], 'arm-right': [10, 0, -105], 'leg-left': [0, 0, 28], 'leg-right': [0, 0, -2] },
    { t: 1, root: [90, 0, 6], 'arm-left': [10, 0, 105], 'arm-right': [10, 0, -45], 'leg-left': [0, 0, 2], 'leg-right': [0, 0, -28] },
  ], [0, 0.33, 0]));
  C.push(makeClip('wave', 1.6, [
    { t: 0 },
    { t: 0.12, 'arm-right': [-22, 0, -68], head: [0, 0, -7], torso: [0, 0, -3] },
    { t: 0.25, 'arm-right': [-22, 12, -40] },
    { t: 0.38, 'arm-right': [-22, -8, -70] },
    { t: 0.51, 'arm-right': [-22, 12, -40] },
    { t: 0.64, 'arm-right': [-22, -8, -70] },
    { t: 0.77, 'arm-right': [-22, 0, -48], head: [0, 0, -7] },
    { t: 1, 'arm-right': [0, 0, 45], head: [0, 0, 0], torso: [0, 0, 0] },
  ]));
  C.push(makeClip('cheer', 1.2, [
    { t: 0 },
    { t: 0.12, 'arm-left': [0, 0, 72], 'arm-right': [0, 0, -72], head: [-12, 0, 0], rs: [1.06, 0.9, 1.06] },
    { t: 0.28, rp: [0, 0.07, 0], 'arm-left': [0, 0, 82], 'arm-right': [0, 0, -82], rs: [0.96, 1.06, 0.96] },
    { t: 0.42, rp: [0, 0, 0], 'arm-left': [0, 0, 66], 'arm-right': [0, 0, -66], rs: [1.06, 0.9, 1.06] },
    { t: 0.58, rp: [0, 0.07, 0], 'arm-left': [0, 0, 84], 'arm-right': [0, 0, -84], rs: [0.96, 1.06, 0.96] },
    { t: 0.74, rp: [0, 0, 0], 'arm-left': [0, 0, 70], 'arm-right': [0, 0, -70], rs: [1.04, 0.94, 1.04] },
    { t: 1, 'arm-left': [0, 0, -45], 'arm-right': [0, 0, 45], head: [0, 0, 0], rs: [1, 1, 1] },
  ]));
  C.push(makeClip('dance', 1.0, [
    { t: 0, torso: [0, 16, 6], head: [0, -10, 8], 'arm-left': [-20, 0, 40], 'arm-right': [-20, 0, 15], 'leg-left': [-15, 0, 4], 'leg-right': [5, 0, 0], rp: [0.02, 0, 0] },
    { t: 0.25, torso: [0, 0, 0], head: [6, 0, 0], 'arm-left': [-30, 0, -20], 'arm-right': [-30, 0, 20], 'leg-left': [0, 0, 0], 'leg-right': [0, 0, 0], rp: [0, -0.025, 0], rs: [1.05, 0.92, 1.05] },
    { t: 0.5, torso: [0, -16, -6], head: [0, 10, -8], 'arm-left': [-20, 0, -15], 'arm-right': [-20, 0, -40], 'leg-left': [-5, 0, 0], 'leg-right': [15, 0, -4], rp: [-0.02, 0, 0], rs: [1, 1, 1] },
    { t: 0.75, torso: [0, 0, 0], head: [6, 0, 0], 'arm-left': [-30, 0, -20], 'arm-right': [-30, 0, 20], 'leg-left': [0, 0, 0], 'leg-right': [0, 0, 0], rp: [0, -0.025, 0], rs: [1.05, 0.92, 1.05] },
    { t: 1, torso: [0, 16, 6], head: [0, -10, 8], 'arm-left': [-20, 0, 40], 'arm-right': [-20, 0, 15], 'leg-left': [-15, 0, 4], 'leg-right': [5, 0, 0], rp: [0.02, 0, 0], rs: [1, 1, 1] },
  ]));
  // punch ('punch' right / 'punchL' left): an overhead chop. The arm hangs (Z ~ 84), X swings it in the vertical plane in front of the body:
  // X 0 down, -90 forward, -180 straight up, -210 up and slightly back. It winds up over the head (leaning back, the other arm out for balance),
  // pauses, then comes down over the top in a big arc (X -205 -> -75, leaning in, a step forward): the contact frame is the arm pointing forward-down (t 0.5 of 0.46 s).
  const punchClip = (name, right) => {
    const z = right ? 1 : -1, A = right ? 'arm-right' : 'arm-left', G = right ? 'arm-left' : 'arm-right', LF = right ? 'leg-left' : 'leg-right', LB = right ? 'leg-right' : 'leg-left';
    return makeClip(name, 0.46, [
      { t: 0, root: [0, 0, 0], torso: [0, 0, 0], head: [0, 0, 0], [A]: [0, 0, 45 * z], [G]: [0, 0, -45 * z], [LF]: [0, 0, 0], [LB]: [0, 0, 0], rs: [1, 1, 1] },
      { t: 0.2, root: [-3, 0, 0], torso: [-9, -16 * z, 0], head: [-8, 8 * z, 0], [A]: [-170, 0, 80 * z], [G]: [-35, 0, -58 * z], [LF]: [-16, 0, 0], [LB]: [14, 0, 0], rs: [1, 1.04, 1] },
      { t: 0.36, root: [-6, 0, 0], torso: [-13, -8 * z, 0], head: [-12, 4 * z, 0], [A]: [-196, 0, 84 * z], [G]: [-40, 0, -62 * z], [LF]: [-18, 0, 0], [LB]: [16, 0, 0], rs: [1, 1.05, 1] },
      { t: 0.5, root: [10, 0, 0], torso: [24, 12 * z, 0], head: [8, -6 * z, 0], [A]: [-78, 0, 80 * z], [G]: [-30, 0, -60 * z], [LF]: [-34, 0, 0], [LB]: [26, 0, 0], rs: [1, 0.94, 1.04] },
      { t: 0.64, root: [13, 0, 0], torso: [30, 14 * z, 0], head: [10, 0, 0], [A]: [-42, 0, 74 * z], [LF]: [-30, 0, 0], [LB]: [22, 0, 0], rs: [1, 0.97, 1.02] },
      { t: 1, root: [0, 0, 0], torso: [0, 0, 0], head: [0, 0, 0], [A]: [0, 0, 45 * z], [G]: [0, 0, -45 * z], [LF]: [0, 0, 0], [LB]: [0, 0, 0], rs: [1, 1, 1] },
    ]);
  };
  C.push(punchClip('punch', true), punchClip('punchL', false));
  // swimming (not ground-fitted: the controller floats the root at the water line minus TUNING.swimSink).
  // swim: front crawl, body pitched forward about the belly, arms windmill half a cycle apart, flutter kick at twice the rate
  const sw = (t, al, ar, ll, lr, roll) => ({ t, root: [62, roll, 0], 'arm-left': [al, 0, -78], 'arm-right': [ar, 0, 78], 'leg-left': [ll, 0, 4], 'leg-right': [lr, 0, -4] });
  C.push(makeClip('swim', 1.1, [
    { ...sw(0, 0, -180, -18, 14, 8), rp: [0, -0.03, 0], torso: [4, 0, 0], head: [-40, 0, 0] },
    { ...sw(0.25, -90, -270, 14, -18, 0), head: [-40, 14, 0] },
    { ...sw(0.5, -180, -360, -18, 14, -8), head: [-40, 0, 0] },
    { ...sw(0.75, -270, -450, 14, -18, 0), head: [-40, -14, 0] },
    { ...sw(1, -360, -540, -18, 14, 8), head: [-40, 0, 0] },
  ], [0, 0.3, 0]));
  // tread: nearly upright, hands sculling out and in, legs cycling, a small bob
  C.push(makeClip('tread', 1.6, [
    { t: 0, root: [14, 0, 0], torso: [0, 0, 0], head: [-10, 0, 0], 'arm-left': [-20, -25, -72], 'arm-right': [-20, 25, 72], 'leg-left': [-35, 0, 6], 'leg-right': [5, 0, -6], rp: [0, 0, 0] },
    { t: 0.5, root: [12, 0, 2], head: [-8, 0, -3], 'arm-left': [-20, 25, -64], 'arm-right': [-20, -25, 64], 'leg-left': [5, 0, 6], 'leg-right': [-35, 0, -6], rp: [0, 0.012, 0] },
    { t: 1, root: [14, 0, 0], head: [-10, 0, 0], 'arm-left': [-20, -25, -72], 'arm-right': [-20, 25, 72], 'leg-left': [-35, 0, 6], 'leg-right': [5, 0, -6], rp: [0, 0, 0] },
  ], [0, 0.3, 0]));
  // dive: a jump into the sea from the pier — body stretched out and pitched head down past horizontal, arms straight ahead (overhead relative to the body), legs together
  C.push(makeClip('diveJump', 0.8, [
    { t: 0, root: [118, 0, 0], torso: [4, 0, 0], head: [-72, 0, 0], 'arm-left': [0, 0, 86], 'arm-right': [0, 0, -86], 'leg-left': [8, 0, 3], 'leg-right': [12, 0, -3] },
    { t: 0.5, root: [126, 0, 0], head: [-76, 0, 0], 'leg-left': [14, 0, 2], 'leg-right': [8, 0, -2] },
    { t: 1, root: [118, 0, 0], head: [-72, 0, 0], 'leg-left': [8, 0, 3], 'leg-right': [12, 0, -3] },
  ], [0, 0.3, 0]));
  // sinking head first: pitched steeply down, arms pull back in breaststroke sweeps, a flutter kick
  C.push(makeClip('diveDown', 1.2, [
    { t: 0, root: [150, 0, 0], torso: [0, 0, 0], head: [-50, 0, 0], 'arm-left': [0, 0, 84], 'arm-right': [0, 0, -84], 'leg-left': [10, 0, 3], 'leg-right': [-14, 0, -3] },
    { t: 0.3, 'arm-left': [-6, 0, 38], 'arm-right': [-6, 0, -38], 'leg-left': [-14, 0, 3], 'leg-right': [10, 0, -3] },
    { t: 0.6, 'arm-left': [0, 0, 64], 'arm-right': [0, 0, -64], 'leg-left': [10, 0, 3], 'leg-right': [-14, 0, -3] },
    { t: 1, 'arm-left': [0, 0, 84], 'arm-right': [0, 0, -84], 'leg-left': [10, 0, 3], 'leg-right': [-14, 0, -3] },
  ], [0, 0.3, 0]));
  // fishing chair: the kit's sit (legs forward, body lowered 0.15) with both hands forward on the rod; a slow breathing sway
  const fs = { rp: [0, -0.15, 0], 'leg-left': [-75, 0, 0], 'leg-right': [-75, 0, 0] };
  C.push(makeClip('fishSit', 3.0, [
    { t: 0, ...fs, torso: [7, 0, 0], head: [4, 0, 0], 'arm-right': [-50, 0, 68], 'arm-left': [-44, 0, -62] },
    { t: 0.5, torso: [5, 0, 0], head: [2, 0, 3], 'arm-right': [-53, 0, 66], 'arm-left': [-47, 0, -60] },
    { t: 1, torso: [7, 0, 0], head: [4, 0, 0], 'arm-right': [-50, 0, 68], 'arm-left': [-44, 0, -62] },
  ]));
  // casting: rod over the shoulder (both arms up and back), then a quick whip forward and a settle into the sit pose
  C.push(makeClip('fishCast', 1.1, [
    { t: 0, ...fs, torso: [7, 0, 0], head: [4, 0, 0], 'arm-right': [-50, 0, 68], 'arm-left': [-44, 0, -62] },
    { t: 0.22, torso: [-14, 0, 0], head: [-10, 0, 0], 'arm-right': [-208, 0, 72], 'arm-left': [-196, 0, -66] },
    { t: 0.3, torso: [-16, 0, 0], head: [-12, 0, 0], 'arm-right': [-212, 0, 74], 'arm-left': [-200, 0, -68] },
    { t: 0.46, torso: [18, 0, 0], head: [8, 0, 0], 'arm-right': [-84, 0, 66], 'arm-left': [-78, 0, -60] },
    { t: 0.64, torso: [10, 0, 0], head: [4, 0, 0], 'arm-right': [-62, 0, 68], 'arm-left': [-56, 0, -62] },
    { t: 1, torso: [7, 0, 0], head: [4, 0, 0], 'arm-right': [-50, 0, 68], 'arm-left': [-44, 0, -62] },
  ]));
  return C;
}
// Ground fit: lift/lower the root per key so the lowest skinned vertex touches y = 0 (roll: every key; postures: one offset)
const FIT = { roll: 'each', prone: 'min', crawl: 'min', sitGround: 'min' };
function groundFit(tmpl, clips) {
  const model = tmpl.instantiate(new T.MeshBasicMaterial()), mixer = new T.AnimationMixer(model), v = new T.Vector3();
  const meshes = []; model.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  const minY = (clip, t) => {
    const a = mixer.clipAction(clip); a.play(); a.time = t; a.setEffectiveWeight(1); mixer.update(0); model.updateMatrixWorld(true);
    let m = 1e9; for (const o of meshes) { const n = o.geometry.attributes.position.count; for (let i = 0; i < n; i++) m = Math.min(m, o.getVertexPosition(i, v).y); }
    a.stop(); return m;
  };
  for (const [name, mode] of Object.entries(FIT)) {
    const clip = clips.get(name); if (!clip) continue;
    const tr = clip.tracks.find((t) => t.name === 'root.position'); if (!tr) continue;
    const ys = Array.from(tr.times, (t) => minY(clip, Math.min(t, clip.duration - 1e-4)));
    const lo = Math.min(...ys);
    for (let k = 0; k < tr.times.length; k++) tr.values[k * 3 + 1] -= (mode === 'each' ? ys[k] : lo) - 0.004;
  }
  mixer.uncacheRoot(model);
}

// how each animator state maps onto clips
const MAP = {
  idle: { clip: 'idle', loop: true }, walk: { clip: 'walk', loop: true }, run: { clip: 'sprint', loop: true },
  jump: { clip: 'jump', loop: false }, fall: { clip: 'fall', loop: true }, land: { clip: 'crouch', loop: false },
  dash: { clip: 'dash', loop: false }, leap: { clip: 'leap', loop: false }, roll: { clip: 'roll', loop: false },
  sit: { clip: 'sit', loop: true }, sitGround: { clip: 'sitGround', loop: true },
  prone: { clip: 'prone', loop: true }, crawl: { clip: 'crawl', loop: true },
  wave: { clip: 'wave', loop: false }, cheer: { clip: 'cheer', loop: false }, dance: { clip: 'dance', loop: true },
  nod: { clip: 'emote-yes', loop: true },
  punch: { clip: 'punch', loop: false }, punchL: { clip: 'punchL', loop: false }, dashRun: { clip: 'dashRun', loop: true },
  swim: { clip: 'swim', loop: true }, tread: { clip: 'tread', loop: true },
  diveJump: { clip: 'diveJump', loop: true }, diveDown: { clip: 'diveDown', loop: true },
  fishSit: { clip: 'fishSit', loop: true }, fishCast: { clip: 'fishCast', loop: false },
};
const LOCO = new Set(['walk', 'run', 'crawl']);   // phase-synchronised loops

// ---------------------------------------------------------------- kit loading
export async function loadAvatarKit(THREE, { baseUrl = new URL('./', import.meta.url).href, scale = DEFAULT_SCALE, chars } = {}) {
  if (KIT) return KIT;
  T = THREE;
  const dir = new URL(MODEL_DIR, new URL(baseUrl, location.href)).href;
  const list = chars ? CHARACTERS.filter((c) => chars.includes(c.id)) : CHARACTERS;
  const temps = await Promise.all(list.map(async (c) => {
    const r = await fetch(dir + c.file); if (!r.ok) throw new Error('avatar kit: ' + c.file + ' ' + r.status);
    return [c.id, buildTemplate(parseGLB(await r.arrayBuffer()))];
  }));
  const first = temps[0][1];
  const imgUrl = dir + (first.imageUri || 'Textures/colormap.png');
  const img = await new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = imgUrl; });
  const tex = new T.Texture(img); tex.flipY = false; tex.colorSpace = T.SRGBColorSpace;
  tex.magFilter = T.NearestFilter; tex.minFilter = T.NearestMipmapNearestFilter; tex.needsUpdate = true;
  // mean linear luminance per palette cell, so a tinted cell keeps its shading gradient
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, 64, 64);
  const px = cx.getImageData(0, 0, 64, 64).data, lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const cellLum = (cx8, cy4) => {
    let s = 0, n = 0;
    for (let y = cy4 * 16; y < cy4 * 16 + 16; y++) for (let x = cx8 * 8; x < cx8 * 8 + 8; x++) { const i = (y * 64 + x) * 4; s += 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]); n++; }
    return s / n;
  };
  const base = new T.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
  const clips = new Map();
  for (const c of first.clips) clips.set(c.name, c);
  // calmer sprint: the stock clip hops the root 0.2 model units (≈0.44 m); halve the bounce for a cosy look
  const spr = clips.get('sprint'), tr = spr && spr.tracks.find((t) => t.name === 'root.position');
  if (tr) for (let i = 1; i < tr.values.length; i += 3) tr.values[i] *= 0.5;
  if (spr) { const dr = spr.clone(); dr.name = 'dashRun'; clips.set('dashRun', dr); }   // dash = the sprint cycle, played fast and leaned in by the controller
  for (const c of authoredClips()) clips.set(c.name, c);
  groundFit(first, clips);
  // blob shadow (shared)
  const sc = document.createElement('canvas'); sc.width = sc.height = 64; const sx = sc.getContext('2d');
  const gr = sx.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  sx.fillStyle = gr; sx.fillRect(0, 0, 64, 64);
  const shadowMat = new T.MeshBasicMaterial({ map: new T.CanvasTexture(sc), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadowGeo = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const charMap = new Map();
  for (const [id, t] of temps) { if (t.accentCell) t.refLum = Math.max(0.02, cellLum(t.accentCell.cx, t.accentCell.cy)); charMap.set(id, t); }
  KIT = { scale, base, chars: charMap, clips, shadowGeo, shadowMat, custom: null };
  // the customisable avatar (bf/kit/custom-avatar.js): shares the rig, the colormap and the clips; a failure only turns it off (legacy characters still work)
  try { KIT.custom = await buildCustomKit(T, { partsUrl: new URL('assets/custom/parts.glb', new URL(baseUrl, location.href)).href, temps: charMap, lum: cellLum }); }
  catch (e) { console.warn('[bonfire] customisable avatar unavailable:', e && e.message); }
  return KIT;
}

// ---------------------------------------------------------------- avatar
function accentMaterial(tmpl, hex) {
  const m = KIT.base.clone();
  const cell = tmpl.accentCell;
  const u = {
    uAccent: { value: new T.Color(hex || '#ffffff') },
    uRect: { value: cell ? new T.Vector4(cell.cx / 8, cell.cy / 4, (cell.cx + 1) / 8, (cell.cy + 1) / 4) : new T.Vector4(2, 2, 2, 2) },
    uRefLum: { value: tmpl.refLum || 1 },
    uOn: { value: hex ? 1 : 0 },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAccent; uniform vec4 uRect; uniform float uRefLum; uniform float uOn;')
      .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
      if (uOn > 0.5 && vMapUv.x >= uRect.x && vMapUv.x < uRect.z && vMapUv.y >= uRect.y && vMapUv.y < uRect.w) {
        float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = uAccent * clamp(l / uRefLum, 0.45, 1.6);
      }
#endif`);
  };
  m.customProgramCacheKey = () => 'kit-accent-v1';
  m.userData.u = u;
  return m;
}

export const customReady = () => !!(KIT && KIT.custom);
// createAvatar(charId, accentHex)       -> one of the five stock characters with its clothes tinted (legacy / old peers)
// createAvatar(null, null, appearance)  -> the customisable avatar (bf/kit/appearance.js); av.setAppearance(ap) changes it live
export function createAvatar(charId, accentHex, ap) {
  if (!KIT) throw new Error('call loadAvatarKit first');
  const cu = ap && KIT.custom ? KIT.custom : null;
  const tmpl = cu ? cu.base : (KIT.chars.get(charId) || KIT.chars.values().next().value);
  const id = cu ? 'custom' : (KIT.chars.has(charId) ? charId : [...KIT.chars.keys()][0]);
  const mat = cu ? cu.makeMaterial(KIT.base) : accentMaterial(tmpl, accentHex);
  const model = tmpl.instantiate(mat);
  const rig = cu ? cu.createRig(model, mat) : null;
  model.scale.setScalar(KIT.scale); model.rotation.y = Math.PI;   // Kenney models face +Z
  const root = new T.Group(); root.name = 'avatar-' + id; root.add(model);
  const shadow = new T.Mesh(KIT.shadowGeo, KIT.shadowMat); shadow.scale.set(0.95, 1, 0.95); shadow.renderOrder = 1; root.add(shadow);
  const mixer = new T.AnimationMixer(model);
  const acts = new Map();       // state name -> AnimationAction
  const live = new Map();       // AnimationAction -> weight (actions currently contributing)
  let cur = null, curName = '', curKey = null, fade = 0.12, curW = 1;
  const action = (name) => {
    let a = acts.get(name); if (a) return a;
    const m = MAP[name] || { clip: name, loop: true }, clip = KIT.clips.get(m.clip); if (!clip) return null;
    a = mixer.clipAction(clip);
    a.setLoop(m.loop ? T.LoopRepeat : T.LoopOnce, Infinity); a.clampWhenFinished = !m.loop;
    acts.set(name, a); return a;
  };
  // play(state, { fade, timeScale, key }): crossfades to `state`. A new `key` restarts a one-shot even if the state is unchanged.
  function play(name, opt = {}) {
    const a = action(name); if (!a) return;
    if (opt.timeScale !== undefined) a.timeScale = opt.timeScale;
    if (name === curName && (opt.key === undefined || opt.key === curKey)) return;
    const prevName = curName, prev = cur;
    fade = Math.max(0.001, opt.fade ?? 0.12);
    if (a !== prev) {
      if (!live.has(a)) { a.reset(); a.enabled = true; a.setEffectiveWeight(0); a.play(); live.set(a, 0); }
      else if (!(MAP[name] || {}).loop) { a.reset(); a.play(); }
      if (prev && LOCO.has(name) && LOCO.has(prevName)) a.time = (prev.time / prev.getClip().duration % 1) * a.getClip().duration;
    } else { a.reset(); a.play(); }
    curW = live.get(a) || 0;
    cur = a; curName = name; curKey = opt.key;
    if (!prev) { curW = 1; }
  }
  function update(dt) {
    if (cur) {
      curW = Math.min(1, curW + dt / fade);
      let others = 0; for (const [a, w] of live) if (a !== cur) others += w;
      const k = others > 0 ? (1 - curW) / others : 0;
      for (const [a, w] of live) {
        const nw = a === cur ? curW : w * k;
        if (a !== cur && nw < 0.002) { a.stop(); live.delete(a); continue; }
        live.set(a, nw); a.setEffectiveWeight(nw);
      }
    }
    mixer.update(dt);
  }
  const av = {
    root, model, mixer, shadow, charId: id, scale: KIT.scale,
    headY: tmpl.top * KIT.scale,
    head: model.getObjectByName('head') || null, headBox: tmpl.headBox,   // head bone + its vertex extent (bone space), for hats
    play, update,
    get state() { return curName; },
    weightOf: (name) => { const a = acts.get(name); return a ? (live.get(a) || 0) : 0; },
    setAccent(hex) { if (!rig) { mat.userData.u.uAccent.value.set(hex); mat.userData.u.uOn.value = 1; } },   // custom avatars colour by appearance instead
    appearance: null,
    setAppearance(a) {
      if (!rig) return;
      rig.set(a); av.appearance = rig.ap; av.headY = rig.top * KIT.scale; av.headBox = rig.headBox;
    },
    dispose() {
      mixer.stopAllAction(); mixer.uncacheRoot(model);
      root.parent && root.parent.remove(root);
      mat.dispose();   // geometry, texture and clips are shared by the kit
    },
  };
  if (rig) av.setAppearance(ap);
  return av;
}
