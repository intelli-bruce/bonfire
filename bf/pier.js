// bf/pier.js — a wooden harbour pier for "밤바다 모닥불": a boardwalk that ramps up off the sand and runs straight out to sea, a T-shaped
// pier head, a side deck of fishing planks with two folding fishing chairs, mooring posts with warm lamps, rope rails and ladders;
// plus the fishing tackle (rod in the angler's hands, a line, a glowing float that rides the swell).
//
// API: buildPier(THREE, scene, { groundAt(x, z), quality }) -> {
//   deckTop(x, z) /* height of the planks there, or null */, blocks /* collision circles (posts, chairs, crates) with top (y of the upper face) and base (the deck they stand on) */,
//   seats /* fishing chairs, same shape as beach.json seats + fish:true */, ladders /* [{ x, z, tx, tz, ty, ry }] swim spot -> deck landing */,
//   update(dt, t), dispose() }
//   createAngler(THREE, scene, root, { waterY(x, z), onLand(x, z), onRing(x, z) }) -> { show(on), cast(tx, tz), reel(), update(dt, t), state, floatPos, dispose() }
//     root: the avatar's root group (faces -Z); the rod is parented to it so it follows the seated pose.
//
// Everything is self-lit (vertex colours, MeshBasicMaterial, display-referred like the baked glb: toneMapped = false); one draw call for all
// the static wood, a few small meshes for lamps and halos. Reads scene.fog.

const TAU = Math.PI * 2;

export const PIER = {
  x: -1.2,                      // centre line of the main walkway
  half: 1.3,                    // half width (2.6 m)
  zStart: -8.5, zRamp: -12.5,   // the walkway starts on the sand, rises to deckY by zRamp
  zEnd: -41.4,                  // main walkway ends where the T head begins
  deckY: 0.62,                  // plank top above the still water
  head: { x0: -5.6, x1: 3.2, z0: -45.0, z1: -41.4 },
  fish: { x0: -1.2 + 1.3, x1: 6.9, z0: -29.4, z1: -25.0 },
};
const RAMP_Y0 = 0.16;

export function deckTop(x, z) {
  const P = PIER;
  if (x >= P.x - P.half && x <= P.x + P.half && z <= P.zStart && z >= P.zEnd) {
    if (z > P.zRamp) return RAMP_Y0 + (P.deckY - RAMP_Y0) * ((P.zStart - z) / (P.zStart - P.zRamp));
    return P.deckY;
  }
  const h = P.head, f = P.fish;
  if (x >= h.x0 && x <= h.x1 && z <= h.z1 && z >= h.z0) return P.deckY;
  if (x >= f.x0 && x <= f.x1 && z <= f.z1 && z >= f.z0) return P.deckY;
  return null;
}

function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function buildPier(THREE, scene, opts = {}) {
  const low = opts.quality === 'low';
  const groundAt = typeof opts.groundAt === 'function' ? opts.groundAt : () => -3;
  const P = PIER, DY = P.deckY, rnd = mulberry(0x91e4_2026);
  const group = new THREE.Group(); group.name = 'pier'; scene.add(group);
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  // ---------------- merged static wood ----------------
  const L = new THREE.Vector3(0.2, 0.8, -0.55).normalize();
  const pos = [], col = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), eu = new THREE.Euler(), cc = new THREE.Color(), nv = new THREE.Vector3();
  const geoCache = {};
  const unitBox = () => geoCache.box || (geoCache.box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed());
  const unitCyl = () => geoCache.cyl || (geoCache.cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 8).toNonIndexed());
  function add(g, hex, tint, matrix) {
    cc.set(hex);
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pv.fromBufferAttribute(p, i).applyMatrix4(matrix);
      nv.fromBufferAttribute(n, i).transformDirection(matrix);
      const s = (0.5 + 0.5 * Math.max(0, nv.dot(L))) * tint;
      pos.push(pv.x, pv.y, pv.z); col.push(cc.r * s, cc.g * s, cc.b * s);
    }
  }
  // box centred at (x, y, z), size (w, h, d), optional rotation (rx, ry, rz)
  function box(x, y, z, w, h, d, hex, tint = 1, rx = 0, ry = 0, rz = 0) {
    q.setFromEuler(eu.set(rx, ry, rz)); m4.compose(pv.set(x, y, z), q, sv.set(w, h, d)); add(unitBox(), hex, tint, m4);
  }
  function post(x, z, top, hex = '#4b3a2e', r = 0.13, bottom = null) {   // a round piling from the seabed (or `bottom`) up to `top`
    const b = bottom === null ? groundAt(x, z) - 0.25 : bottom, h = top - b;
    q.identity(); m4.compose(pv.set(x, b + h / 2, z), q, sv.set(r * 2, h, r * 2)); add(unitCyl(), hex, 0.85 + rnd() * 0.2, m4);
  }

  const blocks = [], lamps = [], ladders = [];
  const WOOD = '#6c5846', WOOD_D = '#4a3b30', BEAM = '#33281f';

  // main walkway planks (run across the walk, 0.27 wide, 0.03 gaps), with the ramp following deckTop
  function planks(x0, x1, z0, z1, ramp) {   // z0 > z1 (north to south)
    const w = x1 - x0, cx = (x0 + x1) / 2;
    for (let z = z0 - 0.15; z > z1; z -= 0.3) {
      const top = deckTop(cx, Math.max(Math.min(z, z0), z1 + 0.001)) ?? DY, len = w - (rnd() < 0.25 ? 0.02 + rnd() * 0.05 : 0);
      box(cx, top - 0.045, z, len, 0.09, 0.27, WOOD, 0.88 + rnd() * 0.22);
    }
  }
  planks(P.x - P.half, P.x + P.half, P.zStart, P.zEnd);
  planks(P.head.x0, P.head.x1, P.head.z1, P.head.z0);
  planks(P.fish.x0, P.fish.x1, P.fish.z1, P.fish.z0);
  // stringers under the planks (long beams) and cross beams
  for (const dx of [-1.0, 0, 1.0]) {
    const x = P.x + dx;
    for (let z = P.zStart; z > P.zEnd; z -= 3) {   // piecewise so the ramp beam follows the slope
      const z2 = Math.max(z - 3, P.zEnd), top = deckTop(x, (z + z2) / 2) ?? DY;
      const dz = z - z2, tilt = z > P.zRamp ? Math.atan2(deckTop(x, z) - deckTop(x, z2), dz) : 0;
      box(x, top - 0.16, (z + z2) / 2, 0.14, 0.14, dz + 0.02, BEAM, 0.9, -tilt);
    }
  }
  for (const dz of [0.4, 1.2]) { /* head and side deck beams */
    for (const x of [-4.8, -2.6, -0.4, 1.8]) box(x, DY - 0.16, P.head.z1 - dz * 2, 0.14, 0.14, 3.6, BEAM, 0.9);
  }
  for (const z of [-26.0, -28.2]) box((P.fish.x0 + P.fish.x1) / 2, DY - 0.16, z, P.fish.x1 - P.fish.x0, 0.14, 0.14, BEAM, 0.9);
  for (let z = -13; z > P.zEnd; z -= 3) box(P.x, DY - 0.2, z, P.half * 2 + 0.2, 0.12, 0.16, BEAM, 0.85);

  // pilings: both sides every 3 m; the ramp ones stand on the sand; every other main one is a lamp post
  const lampAt = (x, z, top) => { lamps.push({ x, y: top + 0.14, z }); };
  const side = [P.x - P.half - 0.02, P.x + P.half + 0.02];
  const postZ = [];
  for (let z = -10.5; z > P.zEnd + 0.1; z -= 3) postZ.push(z);
  postZ.forEach((z, i) => {
    for (const [k, x] of side.entries()) {
      if (k === 1 && z <= PIER.fish.z1 + 0.2 && z >= PIER.fish.z0 - 0.2) continue;   // the walkway opens onto the fishing deck here
      const top = (deckTop(P.x, z) ?? DY) + (i % 2 === k ? 0.95 : 0.52);
      post(x, z, top);
      if (z <= P.zRamp + 0.1) blocks.push({ type: 'circle', x, z, r: 0.12, top, base: DY });
      if (i % 2 === k && z < -14) { box(x, top + 0.05, z, 0.22, 0.05, 0.22, WOOD_D, 1); lampAt(x, z, top + 0.07); }
    }
  });
  // rope between neighbouring posts (a shallow sag), at about knee height
  postZ.forEach((z, i) => {
    if (i === 0) return;
    const za = postZ[i - 1];
    for (const x of side) {
      if (x > P.x && za > PIER.fish.z0 - 0.2 && z < PIER.fish.z1 + 0.2) continue;   // no rope across the opening onto the fishing deck
      const N = 5;
      for (let s = 0; s < N; s++) {
        const u0 = s / N, u1 = (s + 1) / N, za0 = za + (z - za) * u0, za1 = za + (z - za) * u1;
        const y = (u) => (deckTop(P.x, za + (z - za) * u) ?? DY) + 0.42 - 0.07 * Math.sin(Math.PI * u);
        const y0 = y(u0), y1 = y(u1), len = Math.hypot(za1 - za0, y1 - y0);
        box(x, (y0 + y1) / 2, (za0 + za1) / 2, 0.035, 0.035, len, '#b99f78', 0.95, Math.atan2(y1 - y0, za0 - za1));
      }
    }
  });

  // T head: posts at the corners and along the outer edge, mooring bollards, a stack of crates
  const H = P.head;
  const headPosts = [[H.x0 + 0.1, H.z0 + 0.1], [H.x1 - 0.1, H.z0 + 0.1], [H.x0 + 0.1, H.z1 - 0.1], [H.x1 - 0.1, H.z1 - 0.1], [(H.x0 + H.x1) / 2 - 2.2, H.z0 + 0.1], [(H.x0 + H.x1) / 2 + 2.2, H.z0 + 0.1], [P.x - 2.2, H.z0 + 0.1], [P.x + 2.2, H.z0 + 0.1]];
  headPosts.forEach(([x, z], i) => {
    const top = DY + (i % 3 === 0 ? 1.0 : 0.55);
    post(x, z, top); blocks.push({ type: 'circle', x, z, r: 0.12, top, base: DY });
    if (i % 3 === 0) { box(x, top + 0.05, z, 0.22, 0.05, 0.22, WOOD_D, 1); lampAt(x, z, top + 0.07); }
  });
  for (const x of [-3.6, 1.2]) {   // bollards
    const z = H.z0 + 0.45; post(x, z, DY + 0.34, '#2c2a2e', 0.15, DY - 0.2); box(x, DY + 0.36, z, 0.4, 0.06, 0.18, '#2c2a2e', 1);
    blocks.push({ type: 'circle', x, z, r: 0.16, top: DY + 0.39, base: DY });
  }
  for (const [x, z, s] of [[H.x0 + 0.7, H.z1 - 0.8, 0.6], [H.x0 + 0.7, H.z1 - 1.5, 0.5], [H.x0 + 1.35, H.z1 - 0.8, 0.55]]) {
    box(x, DY + s / 2, z, s, s, s, '#8a6a46', 0.9 + rnd() * 0.2, 0, rnd() * 0.5); blocks.push({ type: 'circle', x, z, r: s * 0.55, top: DY + s + 0.02, base: DY });
  }

  // fishing deck: edge posts, two folding chairs facing the open sea (-Z), a cooler and a tackle box between them, a lantern
  const F = P.fish;
  for (const [x, z] of [[F.x1 - 0.1, F.z0 + 0.1], [F.x1 - 0.1, F.z1 - 0.1], [F.x1 - 0.1, (F.z0 + F.z1) / 2], [(F.x0 + F.x1) / 2 + 1.0, F.z0 + 0.1], [F.x0 + 1.1, F.z0 + 0.1], [F.x1 - 2.2, F.z0 + 0.1]]) {
    post(x, z, DY + 0.55); blocks.push({ type: 'circle', x, z, r: 0.12, top: DY + 0.55, base: DY });
  }
  const seats = [];
  const chairs = [[3.2, -26.5], [5.3, -26.5]];
  chairs.forEach(([cx, cz], i) => {
    const sy = DY + 0.43;
    // seat cloth, back rest (tilted), armrests, X-shaped legs (as four slanted bars) and feet
    box(cx, sy, cz, 0.52, 0.05, 0.46, '#2f6394', 1.0);
    box(cx, sy + 0.28, cz + 0.22, 0.52, 0.42, 0.04, '#2f6394', 0.95, 0.18, 0, 0);
    for (const sx of [-0.27, 0.27]) {
      box(cx + sx, sy + 0.2, cz + 0.05, 0.035, 0.035, 0.42, '#a8b1bb', 1);   // armrest
      box(cx + sx, sy + 0.1, cz - 0.2, 0.035, 0.22, 0.035, '#a8b1bb', 1);    // armrest front support
      box(cx + sx, sy - 0.22, cz - 0.17, 0.035, 0.46, 0.035, '#a8b1bb', 1, 0.0, 0, 0);   // front leg
      box(cx + sx, sy - 0.2, cz + 0.2, 0.035, 0.5, 0.035, '#a8b1bb', 1, 0.0, 0, 0);      // rear leg
    }
    box(cx, sy - 0.2, cz, 0.5, 0.03, 0.03, '#a8b1bb', 0.9);   // cross bar
    blocks.push({ type: 'circle', x: cx, z: cz + 0.05, r: 0.2, top: sy + 0.03, base: DY });   // the seat cloth
    seats.push({ id: 'f' + (i + 1), x: cx, z: cz, ry: 0, y: sy + 0.025, fish: true });
  });
  // cooler + tackle box + bucket on the pier head side of the chairs
  box(4.25, DY + 0.17, -25.75, 0.6, 0.34, 0.4, '#d9e6ee', 0.95); box(4.25, DY + 0.35, -25.75, 0.62, 0.05, 0.42, '#2b7fbf', 1);
  box(4.25, DY + 0.46, -25.75, 0.18, 0.06, 0.06, '#2c2a2e', 1); blocks.push({ type: 'circle', x: 4.25, z: -25.75, r: 0.36, top: DY + 0.38, base: DY });
  box(6.35, DY + 0.1, -25.6, 0.42, 0.2, 0.26, '#b8452e', 0.95); box(6.35, DY + 0.21, -25.6, 0.44, 0.03, 0.28, '#7a2b1d', 1); blocks.push({ type: 'circle', x: 6.35, z: -25.6, r: 0.26, top: DY + 0.23, base: DY });
  lampAt(0.7, -25.2, DY + 0.32); box(0.7, DY + 0.16, -25.2, 0.1, 0.32, 0.1, WOOD_D, 1);   // a stake lantern at the junction

  // ladders (a swimmer can climb them): rails + rungs down to 1.7 m under the water, fixed to the deck edge
  function ladder(x, z, dirX, dirZ) {   // (x, z) on the deck edge; dir = outward (into the water)
    const ox = dirX * 0.06, oz = dirZ * 0.06, px = -dirZ, pz = dirX;   // across the ladder
    for (const s of [-0.22, 0.22]) box(x + ox + px * s, DY - 0.75, z + oz + pz * s, 0.05, 2.3, 0.05, '#7d6a58', 0.95, 0, 0, 0);   // rails: 0.4 above the deck, 1.9 below it
    for (let k = 0; k < 5; k++) box(x + ox, DY - 1.45 + k * 0.33, z + oz, Math.abs(px) > 0.5 ? 0.46 : 0.05, 0.04, Math.abs(pz) > 0.5 ? 0.46 : 0.05, '#7d6a58', 0.95);
    ladders.push({ x: x + dirX * 0.75, z: z + dirZ * 0.75, tx: x - dirX * 0.7, tz: z - dirZ * 0.7, ty: DY, ry: Math.atan2(dirX, dirZ) });
  }
  ladder(P.x - P.half, -33.0, -1, 0);        // west side of the walkway
  ladder(F.x1, -27.4, 1, 0);                  // east end of the fishing deck
  ladder(H.x1, (H.z0 + H.z1) / 2, 1, 0);     // east end of the T head

  const wood = new THREE.BufferGeometry();
  wood.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); wood.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  wood.computeBoundingSphere();
  const woodMat = keep(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide }));
  const woodMesh = new THREE.Mesh(keep(wood), woodMat); woodMesh.frustumCulled = false; woodMesh.name = 'pier-wood'; group.add(woodMesh);

  // ---------------- lamps: a warm glass cube + an additive halo each ----------------
  const halo = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,236,190,1)'); gr.addColorStop(0.22, 'rgba(255,190,110,0.7)'); gr.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return keep(t);
  })();
  const glassGeo = keep(new THREE.BoxGeometry(0.15, 0.2, 0.15)), glassMat = keep(new THREE.MeshBasicMaterial({ color: '#f6c47e', toneMapped: false }));
  const haloMat = keep(new THREE.SpriteMaterial({ map: halo, color: '#ffb468', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  const lampSprites = [];
  for (const l of lamps) {
    const g = new THREE.Mesh(glassGeo, glassMat); g.position.set(l.x, l.y + 0.1, l.z); group.add(g);
    const s = new THREE.Sprite(haloMat); s.position.set(l.x, l.y + 0.1, l.z); s.scale.setScalar(1.35); s.renderOrder = 5; group.add(s); lampSprites.push({ s, ph: rnd() * TAU });
  }
  // a soft glow on the planks under each lamp (flat additive disc), so the walkway reads as lit
  const glowGeo = keep(new THREE.CircleGeometry(1.7, 20).rotateX(-Math.PI / 2));
  const glowMat = keep(new THREE.MeshBasicMaterial({ map: halo, color: '#ff9a50', blending: THREE.AdditiveBlending, transparent: true, opacity: 0.32, depthWrite: false, fog: false }));
  for (const l of lamps) {
    if (low && rnd() < 0.5) continue;
    const onMain = Math.abs(l.x - P.x) < 1.6 && l.z > P.zEnd, gx = onMain ? Math.min(Math.max(l.x, P.x - 1.0), P.x + 1.0) : l.x;
    const gl = new THREE.Mesh(glowGeo, glowMat); gl.position.set(gx, (deckTop(gx, l.z) ?? DY) + 0.02, l.z); gl.renderOrder = 4; group.add(gl);
  }

  function update(dt, t) {
    for (const o of lampSprites) o.s.scale.setScalar(1.35 + 0.07 * Math.sin(t * 5.3 + o.ph) + 0.04 * Math.sin(t * 11 + o.ph * 2));
  }
  function dispose() {
    scene.remove(group);
    for (const d of disposables) d.dispose && d.dispose();
    for (const k in geoCache) geoCache[k].dispose();
  }
  return { deckTop, blocks, seats, ladders, update, dispose, group };
}

// ---------------------------------------------------------------- fishing tackle ----------------------------------------------------------------
// Rod: parented to the angler's root (faces -Z): handle at the hands, tilted up and out. Line + float live in world space: the float flies
// in an arc to the target (cast), then rides the swell (and tilts with the surface slope), sending a small ring every few seconds;
// reeling slides it back along the water and hides it.
export function createAngler(THREE, scene, root, io = {}) {
  const waterY = io.waterY || (() => 0);
  const rod = new THREE.Group(); rod.name = 'rod';
  // seat-relative: hands at about (0, 0.64, -0.38) in root space; the rod tilts 38 deg up, 8 deg out
  const R = { len: 2.3, tilt: 0.66, base: new THREE.Vector3(0.02, 0.62, -0.34) };
  const rodMat = new THREE.MeshBasicMaterial({ color: '#2a2320', toneMapped: false }), corkMat = new THREE.MeshBasicMaterial({ color: '#b98a54', toneMapped: false });
  const reelMat = new THREE.MeshBasicMaterial({ color: '#9aa4ae', toneMapped: false });
  const rodGeo = new THREE.CylinderGeometry(0.008, 0.022, R.len, 6).translate(0, R.len / 2, 0);
  const rodMesh = new THREE.Mesh(rodGeo, rodMat); rod.add(rodMesh);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 8).translate(0, 0.14, 0), corkMat); rod.add(grip);
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 10).rotateZ(Math.PI / 2).translate(0.06, 0.34, 0), reelMat); rod.add(reel);
  rod.position.copy(R.base); rod.rotation.set(-R.tilt, 0, -0.14);   // -Z is forward: a negative X turn leans the tip forward
  rod.visible = false; root.add(rod);
  const tip = new THREE.Object3D(); tip.position.set(0, R.len, 0); rod.add(tip);

  // float: red/white stick with an orange glowing cap + a halo, so it reads far away at night
  const fl = new THREE.Group(); fl.visible = false; scene.add(fl);
  const stickGeo = new THREE.CylinderGeometry(0.035, 0.03, 0.26, 8);
  const capMat = new THREE.MeshBasicMaterial({ color: '#ff6a3a', toneMapped: false, fog: false }), bodyMat = new THREE.MeshBasicMaterial({ color: '#f4f0e8', toneMapped: false });
  const stick = new THREE.Mesh(stickGeo, bodyMat); stick.position.y = 0.05; fl.add(stick);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.1, 8), capMat); cap.position.y = 0.23; fl.add(cap);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), bodyMat); bulb.position.y = -0.1; fl.add(bulb);
  const hc = document.createElement('canvas'); hc.width = hc.height = 64; const hg = hc.getContext('2d');
  const gr = hg.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,240,200,1)'); gr.addColorStop(0.25, 'rgba(255,120,60,0.8)'); gr.addColorStop(1, 'rgba(255,60,20,0)');
  hg.fillStyle = gr; hg.fillRect(0, 0, 64, 64);
  const haloTex = new THREE.CanvasTexture(hc); haloTex.colorSpace = THREE.SRGBColorSpace;
  const haloSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  haloSp.position.y = 0.26; haloSp.scale.setScalar(0.62); haloSp.renderOrder = 6; fl.add(haloSp);

  // line: a polyline from the rod tip to the float, sagging a little
  const N = 28, lp = new Float32Array(N * 3), lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: '#e6eefc', transparent: true, opacity: 0.85, toneMapped: false, fog: false }));
  line.frustumCulled = false; line.visible = false; scene.add(line);

  const st = { state: 'none', t: 0, T: 1, sx: 0, sy: 0, sz: 0, tx: 0, tz: 0, ph: Math.random() * TAU, ringT: 2, drift: Math.random() * TAU, swing: -1 };
  const WHIP = 0.5;   // seconds into the cast when the line leaves the tip (matches the avatar's 'fishCast' clip)
  const floatPos = new THREE.Vector3(), tipW = new THREE.Vector3(), tmp = new THREE.Vector3();
  function drawLine(sag) {
    root.updateWorldMatrix(true, true); tip.getWorldPosition(tipW);
    const ex = floatPos.x, ey = floatPos.y + 0.28, ez = floatPos.z;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1), x = tipW.x + (ex - tipW.x) * u, z = tipW.z + (ez - tipW.z) * u;
      let y = tipW.y + (ey - tipW.y) * u - sag * 4 * u * (1 - u);
      if (u > 0.9) y = Math.max(y, waterY(x, z) + 0.02);
      lp[i * 3] = x; lp[i * 3 + 1] = y; lp[i * 3 + 2] = z;
    }
    lg.attributes.position.needsUpdate = true;
  }
  function setFloat(x, y, z) { floatPos.set(x, y, z); fl.position.copy(floatPos); }
  function bob(t) {
    const x = st.tx + Math.cos(t * 0.31 + st.drift) * 0.18, z = st.tz + Math.sin(t * 0.27 + st.drift) * 0.18;
    const y = waterY(x, z) + 0.04 + 0.035 * Math.sin(t * 2.3 + st.ph);
    const dx = waterY(x + 0.35, z) - waterY(x - 0.35, z), dz = waterY(x, z + 0.35) - waterY(x, z - 0.35);   // slope -> tilt with the swell
    fl.rotation.set(dz * 0.9, 0, -dx * 0.9);
    setFloat(x, y, z);
  }
  function show(on) { rod.visible = !!on; if (!on) hideFloat(); }
  function hideFloat() { st.state = 'none'; fl.visible = false; line.visible = false; }
  function cast(tx, tz) {   // wind up (the rod swings back), then the float leaves the tip at WHIP
    st.tx = tx; st.tz = tz; st.state = 'wind'; st.t = 0; st.swing = 0; fl.visible = false; line.visible = false;
  }
  function launch() {
    root.updateWorldMatrix(true, true); tip.getWorldPosition(tipW);
    st.sx = tipW.x; st.sy = tipW.y; st.sz = tipW.z;
    st.state = 'fly'; st.t = 0; st.T = 0.7 + Math.hypot(st.tx - tipW.x, st.tz - tipW.z) * 0.022; st.ringT = 1.8 + Math.random() * 1.6;
    fl.visible = true; line.visible = true; fl.rotation.set(0, 0, 0); setFloat(st.sx, st.sy, st.sz);
  }
  function place(tx, tz) {   // the float is already out (a late joiner sees it floating, no cast)
    st.tx = tx; st.tz = tz; st.state = 'float'; st.t = 0; st.swing = -1; st.ringT = 1 + Math.random() * 2;
    fl.visible = true; line.visible = true; bob(performance.now() / 1000);
  }
  function reelIn() { if (st.state === 'wind') { hideFloat(); return; } if (st.state === 'fly' || st.state === 'float') { st.state = 'reel'; st.t = 0; st.T = 1.1; tmp.copy(floatPos); st.sx = tmp.x; st.sz = tmp.z; } }
  function update(dt, t) {
    if (st.swing >= 0) {   // rod swing: back over the shoulder, then a whip forward, then settle
      st.swing += dt; const w = st.swing;
      const tilt = w < 0.22 ? R.tilt + (-0.55 - R.tilt) * (w / 0.22) : w < WHIP ? -0.55 : w < WHIP + 0.18 ? -0.55 + (1.15 - -0.55) * ((w - WHIP) / 0.18) : R.tilt + (1.15 - R.tilt) * Math.max(0, 1 - (w - WHIP - 0.18) / 0.4);
      rod.rotation.x = -tilt; if (w > WHIP + 0.6) { st.swing = -1; rod.rotation.x = -R.tilt; }
    }
    if (st.state === 'none') return;
    if (st.state === 'wind') { st.t += dt; if (st.t >= WHIP) launch(); return; }
    if (st.state === 'fly') {
      st.t += dt; const u = Math.min(1, st.t / st.T), h = 4.2 + Math.hypot(st.tx - st.sx, st.tz - st.sz) * 0.06;
      const x = st.sx + (st.tx - st.sx) * u, z = st.sz + (st.tz - st.sz) * u, wy = waterY(st.tx, st.tz);
      setFloat(x, st.sy + (wy - st.sy) * u + h * 4 * u * (1 - u), z);
      fl.rotation.set(0.5 * Math.sin(u * 9), 0, 0.3 * Math.cos(u * 7));
      drawLine(1.6 * (1 - u) + 0.3);
      if (u >= 1) { st.state = 'float'; st.t = 0; io.onLand && io.onLand(st.tx, st.tz); }
    } else if (st.state === 'float') {
      bob(t); drawLine(0.32 + 0.05 * Math.sin(t * 1.7));
      st.ringT -= dt; if (st.ringT <= 0) { st.ringT = 2.2 + Math.random() * 1.8; io.onRing && io.onRing(floatPos.x, floatPos.z); }
    } else if (st.state === 'reel') {
      st.t += dt; const u = Math.min(1, st.t / st.T), k = u * u * (3 - 2 * u);
      tipW.setFromMatrixPosition(root.matrixWorld);
      const x = st.sx + (tipW.x - st.sx) * k, z = st.sz + (tipW.z - st.sz) * k;
      setFloat(x, waterY(x, z) + 0.04 + (u > 0.85 ? (u - 0.85) / 0.15 * 0.8 : 0), z); fl.rotation.set(0, 0, 0);
      drawLine(0.15);
      if (u >= 1) hideFloat();
    }
  }
  function dispose() {
    root.remove(rod); scene.remove(fl); scene.remove(line);
    for (const o of [rodGeo, stickGeo, lg, rodMat, corkMat, reelMat, capMat, bodyMat, haloTex, line.material, haloSp.material, bulb.geometry, cap.geometry, grip.geometry, reel.geometry]) o.dispose && o.dispose();
  }
  return { show, cast, place, reel: reelIn, update, dispose, get state() { return st.state; }, floatPos, get rodVisible() { return rod.visible; }, rod, st };
}
