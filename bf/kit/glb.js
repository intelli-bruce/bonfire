// bf/kit/glb.js — tiny GLB reader shared by the avatar kit and its node tests (no THREE, no DOM).
// Handles the simple files used here: float attributes, uint8/16/32 joints/indices, interleaved or tight buffer views.
const CT = { 5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array, 5125: Uint32Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
// buf: ArrayBuffer -> { j: gltf json, bin: ArrayBuffer }
export function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
    else if (type === 0x004e4942) bin = buf.slice(off + 8, off + 8 + len);
    off += 8 + len;
  }
  return { j: json, bin };
}
export function accessor(g, i) {
  const a = g.j.accessors[i], bv = g.j.bufferViews[a.bufferView], Arr = CT[a.componentType], n = NC[a.type];
  const es = Arr.BYTES_PER_ELEMENT, stride = bv.byteStride || es * n, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  if (stride === es * n) return { arr: new Arr(g.bin.slice(base, base + a.count * n * es)), n };
  const out = new Arr(a.count * n), src = new DataView(g.bin);
  const get = { 5126: 'getFloat32', 5123: 'getUint16', 5121: 'getUint8', 5125: 'getUint32' }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = src[get](base + k * stride + c * es, true);
  return { arr: out, n };
}
export const cleanName = (s) => String(s || '').replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
