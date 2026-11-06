// bf/solids.js — one collision list for every prop in the world (rocks, logs, the fire, posts, signs, crates, chairs, ...).
// No THREE import: plain numbers, so the page and a node test run the same code.
//
// A shape is { type: 'circle', x, z, r } or { type: 'box', x0, x1, z0, z1 } plus its height, either
//   top  (absolute y of the upper face) or h (metres above its base; base = shape.base ?? baseAt(centre), i.e. the terrain).
// No height (or taller than `reach` above its base) = a wall: it always blocks and nobody stands on it.
// Lower than minH above its base = ignored (a flat stone, a snow patch).
//
// One rule for the top and the sides, judged by the body's feet height y:
//   - the upper face is ground for a body whose feet are at most `step` below it (walk up a low step, or land on it from a jump);
//   - the sides block a body whose feet are lower than that, so anything taller than a step is climbed by a jump (a second jump in the air
//     reaches about 2 m; `reach` keeps the list to what a jump can reach, the rest is wall).
// The footprint is the shape grown by `margin` for both (the kit tests the avatar centre only), so there is no band that blocks without carrying.
// y omitted: topAt = highest standable face there; blockedAt = everything blocks (a spawn / teleport check).

export function createSolids({ margin = 0.2, step = 0.4, reach = 2.0, minH = 0.08, baseAt = () => 0, cell = 4 } = {}) {
  const sources = new Map();   // name -> shapes handed in
  let items = [];              // normalised: { k: 0 circle | 1 box, cx, cz, r | x0, x1, z0, z1 (grown by margin), top, wall }
  let grid = new Map();
  const EPS = 1e-6;
  const key = (i, j) => i * 73856093 ^ j * 19349663;

  function normalise(s) {
    if (!s || (s.type !== 'circle' && s.type !== 'box')) return null;
    let it;
    if (s.type === 'circle') {
      if (![s.x, s.z, s.r].every(Number.isFinite)) return null;
      it = { k: 0, cx: s.x, cz: s.z, r: s.r + margin, r2: (s.r + margin) ** 2, x0: s.x - s.r - margin, x1: s.x + s.r + margin, z0: s.z - s.r - margin, z1: s.z + s.r + margin };
    } else {
      if (![s.x0, s.x1, s.z0, s.z1].every(Number.isFinite)) return null;
      const a = Math.min(s.x0, s.x1), b = Math.max(s.x0, s.x1), c = Math.min(s.z0, s.z1), d = Math.max(s.z0, s.z1);
      it = { k: 1, cx: (a + b) / 2, cz: (c + d) / 2, r: 0, r2: 0, x0: a - margin, x1: b + margin, z0: c - margin, z1: d + margin };
    }
    const base = Number.isFinite(s.base) ? s.base : baseAt(it.cx, it.cz);
    let top = Number.isFinite(s.top) ? s.top : (Number.isFinite(s.h) ? base + s.h : Infinity);
    if (top - base > reach) top = Infinity;       // too tall for any jump: a wall
    if (top - base < minH) return null;           // too low to matter
    it.top = top;
    return it;
  }
  function rebuild() {
    items = []; grid = new Map();
    for (const list of sources.values()) for (const s of list) { const it = normalise(s); if (it) items.push(it); }
    for (const it of items) {
      for (let i = Math.floor(it.x0 / cell); i <= Math.floor(it.x1 / cell); i++) for (let j = Math.floor(it.z0 / cell); j <= Math.floor(it.z1 / cell); j++) {
        const k = key(i, j); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(it);
      }
    }
  }
  const inside = (it, x, z) => (it.k === 0 ? (x - it.cx) * (x - it.cx) + (z - it.cz) * (z - it.cz) < it.r2 : x > it.x0 && x < it.x1 && z > it.z0 && z < it.z1);
  const near = (x, z) => grid.get(key(Math.floor(x / cell), Math.floor(z / cell)));

  return {
    // replace everything one source handed in ('world', 'xmas', 'pier', ...)
    set(name, list) { sources.set(name, Array.isArray(list) ? list : []); rebuild(); },
    get count() { return items.length; },
    get walls() { let n = 0; for (const it of items) if (it.top === Infinity) n++; return n; },
    // highest face the body can stand on at (x, z): finite tops at most `step` above its feet; -Infinity when none
    topAt(x, z, y) {
      const l = near(x, z); if (!l) return -Infinity;
      const lim = y === undefined ? Infinity : y + step + EPS; let best = -Infinity;
      for (const it of l) if (it.top <= lim && it.top > best && it.top !== Infinity && inside(it, x, z)) best = it.top;
      return best;
    },
    // does something at (x, z) stop a body with its feet at y (sides taller than a step)?
    blockedAt(x, z, y) {
      const l = near(x, z); if (!l) return false;
      const lim = y === undefined ? -Infinity : y + step + EPS;
      for (const it of l) if (it.top > lim && inside(it, x, z)) return true;
      return false;
    },
    // a point that is blocked for a body at y -> the nearest point outside every blocking footprint (a few passes); null when free
    pushOut(x, z, y) {
      let moved = false;
      for (let pass = 0; pass < 8; pass++) {
        const l = near(x, z); let hit = null;
        if (l) { const lim = y === undefined ? -Infinity : y + step + EPS; for (const it of l) if (it.top > lim && inside(it, x, z)) { hit = it; break; } }
        if (!hit) break;
        moved = true;
        if (hit.k === 0) {
          let dx = x - hit.cx, dz = z - hit.cz, d = Math.hypot(dx, dz);
          if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
          x = hit.cx + dx / d * (hit.r + 0.01); z = hit.cz + dz / d * (hit.r + 0.01);
        } else {
          const dl = x - hit.x0, dr = hit.x1 - x, dn = z - hit.z0, ds = hit.z1 - z, m = Math.min(dl, dr, dn, ds);
          if (m === dl) x = hit.x0 - 0.01; else if (m === dr) x = hit.x1 + 0.01; else if (m === dn) z = hit.z0 - 0.01; else z = hit.z1 + 0.01;
        }
      }
      return moved ? { x, z } : null;
    },
    // for tests and the debug hook: every normalised footprint
    list() { return items.map((it) => ({ k: it.k, cx: it.cx, cz: it.cz, r: it.r, x0: it.x0, x1: it.x1, z0: it.z0, z1: it.z1, top: it.top })); },
    margin, step, reach,
  };
}
