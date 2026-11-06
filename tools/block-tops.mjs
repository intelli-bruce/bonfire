// tools/block-tops.mjs — measures how tall each beach.json collision shape is from the baked glb and writes bf/solids.json.
// Usage: node tools/block-tops.mjs   (from the repo root; no dependencies)
// For every block it samples the props / rocks / vegetation triangles over the footprint (the terrain mesh is not read), takes the
// 85th-percentile surface height above the terrain at the block centre (a spiky rock or a leaning log is not measured by its tip),
// and stores it as h (metres above the local ground). Shapes with no geometry under them, or taller than 3 m (trees, cliffs), are left out:
// the page treats a shape with no entry as a wall. FIRE_MAX: the campfire is measured at its highest log, not at the stone ring.
import fs from 'node:fs';
const root = process.cwd();
const GLB_NODES = new Set(['props_core', 'props_shore', 'rocks', 'veg_near']);
const PCT = 0.85, MAX_H = 3, FIRE_MAX = new Set(['c0,0,0.98']);

const glb = fs.readFileSync(root + '/bf/beach.glb');
const jl = glb.readUInt32LE(12), J = JSON.parse(glb.subarray(20, 20 + jl).toString()), BIN = glb.subarray(20 + jl + 8);
function read(ai) {
  const a = J.accessors[ai], bv = J.bufferViews[a.bufferView], off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const comp = { 5126: 4, 5123: 2, 5125: 4, 5121: 1 }[a.componentType], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], stride = bv.byteStride || comp * n;
  const out = new Array(a.count * n);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) {
    const p = off + i * stride + k * comp;
    out[i * n + k] = a.componentType === 5126 ? BIN.readFloatLE(p) : a.componentType === 5123 ? BIN.readUInt16LE(p) : a.componentType === 5125 ? BIN.readUInt32LE(p) : BIN.readUInt8(p);
  }
  return out;
}
const tris = [];
for (const node of J.nodes) {
  if (!GLB_NODES.has(node.name) || node.mesh === undefined) continue;
  for (const p of J.meshes[node.mesh].primitives) {
    const P = read(p.attributes.POSITION), I = p.indices !== undefined ? read(p.indices) : [...Array(P.length / 3).keys()];
    for (let i = 0; i < I.length; i += 3) { const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3; tris.push([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]); }
  }
}
const grid = new Map(), key = (i, j) => i * 100003 + j;
tris.forEach((T, t) => {
  for (let i = Math.floor(Math.min(T[0], T[3], T[6])); i <= Math.floor(Math.max(T[0], T[3], T[6])); i++)
    for (let j = Math.floor(Math.min(T[2], T[5], T[8])); j <= Math.floor(Math.max(T[2], T[5], T[8])); j++) { const k = key(i, j); (grid.get(k) || grid.set(k, []).get(k)).push(t); }
});
function surfaceAt(x, z) {   // highest triangle surface over (x, z)
  const l = grid.get(key(Math.floor(x), Math.floor(z))); let best = -Infinity;
  for (const t of l || []) {
    const T = tris[t], d = (T[5] - T[8]) * (T[0] - T[6]) + (T[6] - T[3]) * (T[2] - T[8]); if (Math.abs(d) < 1e-9) continue;
    const a = ((T[5] - T[8]) * (x - T[6]) + (T[6] - T[3]) * (z - T[8])) / d, b = ((T[8] - T[2]) * (x - T[6]) + (T[0] - T[6]) * (z - T[8])) / d, c = 1 - a - b;
    if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
    const y = a * T[1] + b * T[4] + c * T[7]; if (y > best) best = y;
  }
  return best;
}
const bj = JSON.parse(fs.readFileSync(root + '/bf/beach.json')), H = bj.height, dz = H.dz || H.dx;
function heightAt(x, z) {
  const fx = Math.min(Math.max((x - H.x0) / H.dx, 0), H.nx - 1), fz = Math.min(Math.max((z - H.z0) / dz, 0), H.nz - 1);
  const ix = Math.min(Math.floor(fx), H.nx - 2), iz = Math.min(Math.floor(fz), H.nz - 2), tx = fx - ix, tz = fz - iz, d = H.data, n = H.nx;
  return (d[iz * n + ix] * (1 - tx) + d[iz * n + ix + 1] * tx) * (1 - tz) + (d[(iz + 1) * n + ix] * (1 - tx) + d[(iz + 1) * n + ix + 1] * tx) * tz;
}
const blockKey = (b) => (b.type === 'circle' ? `c${b.x},${b.z},${b.r}` : `b${b.x0},${b.x1},${b.z0},${b.z1}`);
const out = [];
for (const b of bj.blocks) {
  const pts = [], cx = b.type === 'circle' ? b.x : (b.x0 + b.x1) / 2, cz = b.type === 'circle' ? b.z : (b.z0 + b.z1) / 2;
  if (b.type === 'circle') { const st = Math.max(0.05, b.r / 8); for (let x = -b.r; x <= b.r; x += st) for (let z = -b.r; z <= b.r; z += st) if (x * x + z * z <= b.r * b.r) pts.push([b.x + x, b.z + z]); }
  else for (let x = b.x0; x <= b.x1; x += 0.1) for (let z = b.z0; z <= b.z1; z += 0.1) pts.push([x, z]);
  const ys = pts.map(([x, z]) => surfaceAt(x, z)).filter(Number.isFinite).sort((p, q) => p - q);
  if (!ys.length) continue;
  const top = FIRE_MAX.has(blockKey(b)) ? ys[ys.length - 1] : ys[Math.min(ys.length - 1, Math.floor(ys.length * PCT))];
  const h = Math.max(0, top - heightAt(cx, cz));
  if (h > MAX_H) continue;
  out.push({ ...b, h: Math.round(h * 100) / 100 });
}
fs.writeFileSync(root + '/bf/solids.json', JSON.stringify({ version: 1, blocks: out }) + '\n');
console.log(`wrote bf/solids.json: ${out.length} of ${bj.blocks.length} shapes measured (the rest are walls)`);
