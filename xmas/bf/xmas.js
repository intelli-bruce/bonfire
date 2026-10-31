// bf/xmas.js — Christmas dressing for "밤바다 모닥불": a ~4 m decorated pine just outside the seat ring (twinkling
// multicolour bulbs + soft halos, tinsel and ribbon garlands, baubles, a glowing star), wrapped gifts under it,
// a warm fairy-light string on driftwood posts behind the ring, a small snowman by the path, soft snow patches on
// the upper sand and dunes, gentle snowfall around the camera, and Santa hats for avatars (makeHat).
//
// API: buildXmas(THREE, scene, { groundAt(x, z), fire: {x, y, z}, seats, woodPile, bounds, waterlineZ, quality, renderer }) -> {
//   update(dt, t, camera), blocks /* beach.json collision shapes */, makeHat(), tree /* {x, z, r} */, dispose() }
//
// Everything is self-lit (cool moon fill + warm fire falloff + tree glow, computed in the shader), so it reads the
// same in the baked world (scene lights off) and in the unbaked fallback. Solid props are display-referred like the
// baked glb (toneMapped = false); bulbs, star and halos are linear HDR through ACES like the other effects modules.
// One real light at most: a weak warm PointLight at the tree, high quality only (low: the ground-glow decal alone).
// Draw calls: props 1 (one merged mesh: tree, garlands, baubles, gifts, bows, posts, wire, snowman), bulbs 1 (instanced),
// halos 1 (points), star 1, star halo 1, tree ground glow 1, snow patches 1, snowfall 1 — plus one per hat.
// Render order: patches 1, ground glow 2, snowfall 4, halos 6 (all depthWrite off, depth-tested). Reads scene.fog.
// No per-frame allocation: twinkle, snowfall and sparkle are all in shaders driven by a few uniforms.

const TAU = Math.PI * 2;

function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function slopeY(x, z) { // SPEC fallback: ≈0 at z=-14, 0.4 at z=0, 1.5 at z=25
  if (z <= -14) return (z + 14) * 0.08;
  if (z <= 0) return (z + 14) / 14 * 0.4;
  return 0.4 + Math.min(z, 25) / 25 * 1.1 + Math.max(0, z - 25) * 0.18;
}

export function buildXmas(THREE, scene, opts = {}) {
  const low = opts.quality === 'low';
  const groundAt = typeof opts.groundAt === 'function' ? opts.groundAt : slopeY;
  const gAt = (x, z) => { const y = groundAt(x, z); return Number.isFinite(y) ? y : slopeY(x, z); };
  const F = opts.fire || {};
  const fireP = new THREE.Vector3(F.x ?? 0, 0, F.z ?? 0);
  fireP.y = Number.isFinite(F.y) ? F.y : gAt(fireP.x, fireP.z);
  const seats = Array.isArray(opts.seats) ? opts.seats.filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.z)) : [];
  const wood = opts.woodPile && Number.isFinite(opts.woodPile.x) ? opts.woodPile : null;
  const waterZ = Number.isFinite(opts.waterlineZ) ? opts.waterlineZ : -14;
  const group = new THREE.Group(); group.name = 'xmas';
  scene.add(group);
  const disposables = [];
  const keep = (...xs) => { disposables.push(...xs); return xs[0]; };
  const blocks = [];
  const rnd = mulberry(0x25122512);
  const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };   // sRGB hex → linear working colour
  const TONE = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  `;

  // ---------------- placement ----------------
  const TREE_R = 1.55;   // block radius: lowest tier (1.36) and every gift sit inside it
  const clearOf = (x, z, r) => seats.every((s) => Math.hypot(s.x - x, s.z - z) > r + 0.55)
    && (!wood || Math.hypot(wood.x - x, wood.z - z) > r + 1.0)
    && Math.hypot(x - fireP.x, z - fireP.z) > 4.6 + r * 0.3
    && !(Math.abs(x - fireP.x) < 2.2 + r && z > fireP.z)          // walk from spawn (0, 9) to the fire
    && z > waterZ + 6;
  const SITES = [[-5.4, -4.2], [5.6, -3.8], [-6.0, 1.6], [6.0, 3.0], [-6.8, -6.0], [7.5, -6.0]];
  let site = SITES.find(([x, z]) => clearOf(fireP.x + x, fireP.z + z, TREE_R)) || SITES[0];
  const TX = fireP.x + site[0], TZ = fireP.z + site[1];
  const TY = Math.min(gAt(TX, TZ), gAt(TX + 0.4, TZ), gAt(TX - 0.4, TZ), gAt(TX, TZ + 0.4), gAt(TX, TZ - 0.4)) - 0.04;
  blocks.push({ type: 'circle', x: +TX.toFixed(2), z: +TZ.toFixed(2), r: TREE_R });
  const toCam = new THREE.Vector2(fireP.x - TX + 2, fireP.z + 11 - TZ).normalize();  // roughly toward arriving players

  // ---------------- shared self-lit prop material ----------------
  const fogU = { uFogCol: { value: new THREE.Color(0.17, 0.19, 0.44) }, uFogDensity: { value: 0.0085 } };
  const U = {
    uTime: { value: 0 }, uFlick: { value: 0.5 }, uTw: { value: 1 },
    uFire: { value: fireP.clone().add(new THREE.Vector3(0, 0.6, 0)) },
    uTree: { value: new THREE.Vector3(TX, TY + 1.7, TZ) },
    uMoon: { value: new THREE.Vector3(0.25, 0.32, -1).normalize() },
    ...fogU,
  };
  const NOISE = /* glsl */`
    float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
  `;
  // moon fill + warm fire falloff + tree glow; returns the light reaching a surface (display-referred)
  const LIGHT = /* glsl */`
    uniform float uFlick, uTw; uniform vec3 uFire, uTree, uMoon;
    vec3 lightAt(vec3 W, vec3 N){
      vec3 L = vec3(0.34, 0.36, 0.56) * (0.62 + 0.38 * (0.5 + 0.5 * N.y)) + vec3(0.42, 0.46, 0.68) * max(dot(N, uMoon), 0.0) * 0.55;
      vec3 tf = uFire - W; float df = length(tf);
      L += vec3(1.0, 0.50, 0.20) * (2.4 * (0.85 + 0.3 * uFlick) / (1.0 + 0.32 * df * df)) * (0.3 + 0.7 * max(dot(N, tf / df), 0.0));
      vec3 tt = uTree - W; float d2 = dot(tt, tt);
      L += vec3(1.0, 0.74, 0.46) * uTw * 0.55 / (1.0 + 0.55 * d2) * (0.55 + 0.45 * max(dot(N, tt * inversesqrt(d2 + 1e-4)), 0.0));
      return L;
    }
  `;
  const propMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec4 aMat; attribute vec3 aLoc; attribute vec3 aRib;
      varying vec3 vCol; varying vec4 vMat; varying vec3 vLoc; varying vec3 vRib; varying vec3 vN; varying vec3 vW;
      void main(){
        vCol = aCol; vMat = aMat; vLoc = aLoc; vRib = aRib;
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = m * instanceMatrix;
        #endif
        vN = normalize(mat3(m) * normal);
        vec4 w = m * vec4(position, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity; uniform vec3 uFogCol;
      varying vec3 vCol; varying vec4 vMat; varying vec3 vLoc; varying vec3 vRib; varying vec3 vN; varying vec3 vW;
      ${NOISE}
      ${LIGHT}
      void main(){
        vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 V = normalize(cameraPosition - vW);
        vec3 alb = vCol;
        // gift ribbons: a cross band in box-local coords (vLoc in [-1, 1]; non-gifts carry 9)
        float band = min(abs(vLoc.x), abs(vLoc.z));
        if (band < 0.2 && vLoc.y > -0.97) alb = mix(vRib, vRib * 0.6, smoothstep(0.13, 0.2, band));
        // snow caught on upward-facing needles
        if (vMat.x > 0.5) {
          float s = smoothstep(0.52, 0.78, vn(vW.xz * 4.2 + vW.y * 3.1) * 0.7 + vn(vW.xz * 11.0 - vW.y * 5.0) * 0.3) * smoothstep(0.25, 0.75, N.y);
          alb = mix(alb, vec3(0.80, 0.86, 1.0), s * 0.9);
        }
        vec3 L = lightAt(vW, N);
        vec3 col = alb * (L + vMat.w);
        // gloss (baubles, satin ribbon): fire and moon highlights
        if (vMat.z > 0.0) {
          vec3 R = reflect(-V, N);
          vec3 tf = normalize(uFire - vW);
          col += vMat.z * (vec3(1.0, 0.62, 0.32) * pow(max(dot(R, tf), 0.0), 24.0) * 0.9 + vec3(0.7, 0.75, 1.0) * pow(max(dot(R, uMoon), 0.0), 40.0) * 0.6
               + vec3(1.0, 0.85, 0.6) * pow(max(dot(R, normalize(uTree - vW)), 0.0), 10.0) * 0.25 * uTw);
          col *= 0.85 + 0.3 * pow(1.0 - abs(dot(N, V)), 2.0);
        }
        // tinsel glints
        if (vMat.y > 0.5) {
          vec3 c = floor(vW * 34.0); float h = h21(c.xz + c.y * 7.13);
          float g = pow(0.5 + 0.5 * sin(uTime * (1.5 + h * 3.0) + h * 40.0), 14.0) * step(0.55, h);
          col += vec3(1.0, 0.86, 0.55) * g * 1.4;
        }
        float d = length(cameraPosition - vW) * uFogDensity;
        col = mix(col, uFogCol, 1.0 - exp(-d * d));
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
    toneMapped: false,
  }));

  // merged-geometry builder: every static part becomes vertices of one mesh with per-vertex material data
  function Builder() {
    const P = [], Nn = [], C = [], M = [], Lc = [], R = [], I = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    return {
      add(geo, mat4, col, mat = [0, 0, 0, 0], loc = null, rib = [0, 0, 0]) {
        const pos = geo.attributes.position, nor = geo.attributes.normal, base = P.length / 3;
        nm.getNormalMatrix(mat4);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          const c = typeof col === 'function' ? col(v, i) : col;
          if (loc) Lc.push(v.x / loc[0], v.y / loc[1], v.z / loc[2]); else Lc.push(9, 9, 9);
          v.applyMatrix4(mat4); P.push(v.x, v.y, v.z);
          n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); Nn.push(n.x, n.y, n.z);
          C.push(c[0], c[1], c[2]); M.push(mat[0], mat[1], mat[2], mat[3]); R.push(rib[0], rib[1], rib[2]);
        }
        if (geo.index) for (let i = 0; i < geo.index.count; i++) I.push(base + geo.index.getX(i));
        else for (let i = 0; i < pos.count; i++) I.push(base + i);
        geo.dispose();
      },
      build() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
        g.setAttribute('aCol', new THREE.Float32BufferAttribute(C, 3));
        g.setAttribute('aMat', new THREE.Float32BufferAttribute(M, 4));
        g.setAttribute('aLoc', new THREE.Float32BufferAttribute(Lc, 3));
        g.setAttribute('aRib', new THREE.Float32BufferAttribute(R, 3));
        g.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
        g.computeBoundingSphere();
        return g;
      },
    };
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S3 = new THREE.Vector3(), T3 = new THREE.Vector3();
  const mat4 = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) =>
    new THREE.Matrix4().compose(T3.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S3.set(sx, sy, sz));

  // ---------------- Santa hat geometry (shared by makeHat and the snowman) ----------------
  function hatParts(b, m) {
    const segs = low ? 12 : 18;
    // floppy cone: lathe, then the upper part bends back (−Z: the back of a Kenney head, whose face is +Z) and droops
    const prof = [];
    for (let i = 0; i <= 10; i++) { const s = i / 10; prof.push(new THREE.Vector2(0.9 * Math.pow(1 - s, 0.85) + 0.02 * (1 - s), 0.06 + s * 1.75)); }
    const cone = new THREE.LatheGeometry(prof, segs);
    const cp = cone.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const y = cp.getY(i), s = Math.max(0, (y - 0.06) / 1.75);
      cp.setXYZ(i, cp.getX(i), y - 0.42 * s * s * s, cp.getZ(i) - 0.95 * Math.pow(s, 2.4));
    }
    cone.computeVertexNormals();
    const red = lin('#d0262f'), redD = lin('#8e1820');
    b.add(cone, m, (p) => { const k = Math.min(1, Math.max(0, (p.y - 0.1) / 1.2)); return [redD[0] + (red[0] - redD[0]) * k, redD[1] + (red[1] - redD[1]) * k, redD[2] + (red[2] - redD[2]) * k]; }, [0, 0, 0.15, 0.12]);
    // fur brim: lumpy torus in the XZ plane, radius 1.0, centred on the origin
    const brim = new THREE.TorusGeometry(1.0, 0.23, low ? 6 : 8, low ? 20 : 28);
    brim.rotateX(Math.PI / 2);
    const bp = brim.attributes.position, r2 = mulberry(77);
    const bumps = Array.from({ length: 9 }, () => r2() * TAU);
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i), a = Math.atan2(z, x);
      const k = 1 + 0.045 * Math.sin(a * 9 + bumps[0]) + 0.03 * Math.sin(a * 17 + bumps[1]) + 0.04 * Math.sin(y * 20 + a * 5);
      const rr = Math.hypot(x, z), cx = x / rr, cz = z / rr, tx = x - cx, tz = z - cz;   // offset from the tube centre line
      bp.setXYZ(i, cx + tx * k, y * k, cz + tz * k);
    }
    brim.computeVertexNormals();
    b.add(brim, m, lin('#f4f0e8'), [0, 0, 0, 0.22]);
    const pom = new THREE.IcosahedronGeometry(0.27, 1);
    b.add(pom, new THREE.Matrix4().multiplyMatrices(m, mat4(0, 0.06 + 1.75 - 0.42 + 0.05, -0.95 - 0.06, 0, 0, 0)), lin('#ffffff'), [0, 0, 0, 0.22]);
  }
  let hatGeo = null;
  function makeHat() {
    if (!hatGeo) { const b = Builder(); hatParts(b, new THREE.Matrix4()); hatGeo = keep(b.build()); }
    const h = new THREE.Mesh(hatGeo, propMat);
    h.name = 'xmas-hat';
    return h;
  }

  // ---------------- tree, garlands, baubles, gifts, posts, snowman: one merged mesh ----------------
  const B = Builder();
  const SEG = low ? 10 : 14;           // even: odd vertices are branch tips
  const TIERS = [];
  for (let k = 0; k < 5; k++) TIERS.push({ yb: 0.72 + k * 0.6, h: 1.22 - k * 0.06, r: 1.36 - k * 0.23, rot: rnd() * TAU });
  const TOP = TIERS[4].yb + TIERS[4].h;
  const envR = (y) => { let r = 0; for (const t of TIERS) { const s = (y - t.yb) / t.h; if (s >= -0.05 && s <= 1) r = Math.max(r, t.r * Math.min(1, 1 - s)); } return r; };
  // trunk
  B.add(new THREE.CylinderGeometry(0.12, 0.17, 1.0, 8), mat4(TX, TY + 0.45, TZ), lin('#5a3b28'));
  // tiers: apex, mid ring, jagged rim (alternating tips), underside ring
  const gTop = lin('#3f7f4b'), gBot = lin('#16402c'), gIn = lin('#123324');
  for (const t of TIERS) {
    const pos = [], idx = [];
    pos.push(0, t.h, 0);
    for (let i = 0; i < SEG; i++) { const a = t.rot + i / SEG * TAU, tip = i % 2 === 1; const r = t.r * 0.5 * (tip ? 1.04 : 0.94);
      pos.push(Math.cos(a) * r, t.h * 0.5 + (tip ? 0 : 0.03), Math.sin(a) * r); }
    for (let i = 0; i < SEG; i++) { const a = t.rot + i / SEG * TAU, tip = i % 2 === 1; const r = t.r * (tip ? 1.0 : 0.8);
      pos.push(Math.cos(a) * r, tip ? -0.1 : 0.05, Math.sin(a) * r); }
    for (let i = 0; i < SEG; i++) { const a = t.rot + i / SEG * TAU; pos.push(Math.cos(a) * t.r * 0.45, t.h * 0.18, Math.sin(a) * t.r * 0.45); }
    const ring = (k, i) => 1 + k * SEG + ((i % SEG) + SEG) % SEG;
    for (let i = 0; i < SEG; i++) {
      idx.push(0, ring(0, i + 1), ring(0, i));
      idx.push(ring(0, i), ring(0, i + 1), ring(1, i + 1), ring(0, i), ring(1, i + 1), ring(1, i));
      idx.push(ring(1, i), ring(1, i + 1), ring(2, i + 1), ring(1, i), ring(2, i + 1), ring(2, i));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    B.add(g, mat4(TX, TY + t.yb, TZ), (p, i) => {
      if (i > 1 + 2 * SEG - 1) return gIn;                         // underside
      const k = Math.min(1, Math.max(0, 1 - p.y / t.h));               // 0 apex → 1 rim
      const c = 0.35 + 0.65 * k * (i > SEG && i % 2 === 0 ? 1.0 : 0.75);
      return [gBot[0] + (gTop[0] - gBot[0]) * c, gBot[1] + (gTop[1] - gBot[1]) * c, gBot[2] + (gTop[2] - gBot[2]) * c];
    }, [1, 0, 0, 0.02]);
  }
  // garlands: gold tinsel + deep red satin ribbon spiralling down
  const helix = (ph, turns, y0, y1, off) => {
    const pts = [];
    for (let i = 0; i <= 80; i++) { const s = i / 80, y = y1 + (y0 - y1) * s, a = ph + s * turns * TAU, r = envR(y) * 0.9 + off;
      pts.push(new THREE.Vector3(TX + Math.cos(a) * r, TY + y - 0.06 * Math.sin(s * turns * TAU * 2), TZ + Math.sin(a) * r)); }
    return new THREE.CatmullRomCurve3(pts);
  };
  const ident = new THREE.Matrix4();
  B.add(new THREE.TubeGeometry(helix(0.4, 2.6, 0.8, TOP - 0.45, 0.06), low ? 110 : 200, 0.036, low ? 4 : 5), ident, lin('#e0b040'), [0, 1, 0.5, 0.1]);
  B.add(new THREE.TubeGeometry(helix(0.4 + Math.PI, 2.2, 1.0, TOP - 0.8, 0.05), low ? 90 : 160, 0.026, 4), ident, lin('#a3122a'), [0, 0, 0.6, 0.05]);
  // baubles
  const BAUBLE = ['#c8202c', '#e8b23a', '#d9dce8', '#2f62c8', '#c8202c', '#e8b23a'].map(lin);
  const nBaub = low ? 10 : 18;
  for (let i = 0; i < nBaub; i++) {
    const y = 0.75 + (TOP - 1.3) * ((i + rnd() * 0.6) / nBaub), a = i * 2.4 + rnd() * 0.6, r = envR(y) * 0.86;
    const s = 0.065 + 0.03 * rnd();
    B.add(new THREE.IcosahedronGeometry(1, 1), mat4(TX + Math.cos(a) * r, TY + y - 0.05, TZ + Math.sin(a) * r, 0, 0, 0, s), BAUBLE[i % BAUBLE.length], [0, 0, 1.0, 0.08]);
  }
  // gifts: mostly on the side facing arriving players; one stacked
  const GIFT = [['#b3262e', '#f0c84a'], ['#2e7d4f', '#f4efe2'], ['#2f4fa8', '#f0c84a'], ['#efe3c8', '#b3262e'], ['#d9a62e', '#7a1424'],
    ['#7b3a8c', '#f4efe2'], ['#2a8a8a', '#f0c84a'], ['#c0303a', '#f4efe2']].map(([c, r]) => [lin(c), lin(r)]);
  const nGift = low ? 5 : 8, camA = Math.atan2(toCam.y, toCam.x);
  const gifts = [];
  for (let i = 0; i < nGift; i++) {
    const a = camA + (i / (nGift - 1) - 0.5) * 3.4 + (rnd() - 0.5) * 0.3, rr = 0.8 + rnd() * 0.42;
    const w = 0.28 + rnd() * 0.24, d = 0.26 + rnd() * 0.22, h = 0.2 + rnd() * 0.22;
    gifts.push({ x: TX + Math.cos(a) * rr, z: TZ + Math.sin(a) * rr, w, d, h, y: 0, ry: rnd() * TAU });
  }
  gifts.sort((p, q) => q.w * q.d - p.w * p.d);
  if (!low) { const g0 = gifts[0]; gifts.push({ x: g0.x + 0.02, z: g0.z - 0.01, w: g0.w * 0.6, d: g0.d * 0.6, h: 0.16, y: g0.h, ry: g0.ry + 0.5 }); }
  gifts.forEach((g, i) => {
    const [col, rib] = GIFT[i % GIFT.length];
    const gy = Math.min(gAt(g.x, g.z), gAt(g.x + 0.2, g.z), gAt(g.x, g.z + 0.2)) - 0.01 + g.y;
    const m = mat4(g.x, gy + g.h / 2, g.z, 0, g.ry, 0);
    B.add(new THREE.BoxGeometry(g.w, g.h, g.d), m, col, [0, 0, 0.12, 0.04], [g.w / 2, g.h / 2, g.d / 2], rib);
    for (const s of [-1, 1]) {   // bow: two standing loops
      const bm = new THREE.Matrix4().multiplyMatrices(m, mat4(s * 0.045, g.h / 2 + 0.04, 0, 0, 0, s * 0.6));
      B.add(new THREE.TorusGeometry(0.05, 0.016, 4, 10), bm, rib, [0, 0, 0.5, 0.06]);
    }
  });
  // fairy-light posts: an arc behind the seat ring on the side away from the tree, string starts at the tree
  const thT = Math.atan2(TX - fireP.x, -(TZ - fireP.z)), side = thT < 0 ? 1 : -1;
  const posts = [];
  for (const deg of [-12, 20, 52, 84]) {
    const th = side * deg * Math.PI / 180;
    let R = 5.6, x, z;
    for (let k = 0; k < 4; k++) { x = fireP.x + Math.sin(th) * R; z = fireP.z - Math.cos(th) * R;
      if (seats.every((s) => Math.hypot(s.x - x, s.z - z) > 1.0) && (!wood || Math.hypot(wood.x - x, wood.z - z) > 1.3)) break; R += 0.6; }
    posts.push({ x, z, y: gAt(x, z) });
  }
  const postH = 2.1, postCol = lin('#6e5e50');
  for (const p of posts) {
    const lx = (rnd() - 0.5) * 0.08, lz = (rnd() - 0.5) * 0.08;
    B.add(new THREE.CylinderGeometry(0.045, 0.07, postH + 0.3, 6), mat4(p.x, p.y + postH / 2 - 0.15, p.z, lx, rnd() * TAU, lz), postCol);
    p.top = new THREE.Vector3(p.x - lz * postH * 0.5, p.y + postH - 0.08, p.z + lx * postH * 0.5);
    blocks.push({ type: 'circle', x: +p.x.toFixed(2), z: +p.z.toFixed(2), r: 0.12 });
  }
  const d0 = new THREE.Vector2(posts[0].x - TX, posts[0].z - TZ).normalize();
  const anchors = [new THREE.Vector3(TX + d0.x * 0.95, TY + 2.05, TZ + d0.y * 0.95), ...posts.map((p) => p.top)];
  const fairy = [], wirePts = [];
  for (let s = 0; s < anchors.length - 1; s++) {
    const A = anchors[s], C = anchors[s + 1], span = A.distanceTo(C), sag = 0.1 + span * 0.07;
    const nb = Math.max(4, Math.round(span / (low ? 0.45 : 0.3)));
    const at = (u) => new THREE.Vector3().lerpVectors(A, C, u).add(new THREE.Vector3(0, -sag * 4 * u * (1 - u), 0));
    for (let i = 0; i <= 16; i++) if (s === 0 || i > 0) wirePts.push(at(i / 16));
    for (let i = 0; i < nb; i++) fairy.push(at((i + 0.5) / nb).add(new THREE.Vector3(0, -0.035, 0)));
  }
  B.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wirePts), low ? 60 : 120, 0.009, 3), ident, lin('#2a2420'));
  // snowman, beside the path where people arrive
  const SM = [fireP.x - 4.4, fireP.z + 7.0];
  const smOk = seats.every((s) => Math.hypot(s.x - SM[0], s.z - SM[1]) > 1.2) && (!wood || Math.hypot(wood.x - SM[0], wood.z - SM[1]) > 1.5);
  if (smOk) {
    const [sx, sz] = SM, sy = gAt(sx, sz) - 0.06, face = Math.atan2(fireP.x + 1 - sx, fireP.z + 11 - sz);
    const sm = mat4(sx, sy, sz, 0, face, 0);
    const at = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1, sy2 = s, sz2 = s) => new THREE.Matrix4().multiplyMatrices(sm, mat4(x, y, z, rx, ry, rz, s, sy2, sz2));
    const snow = lin('#eef2fb'), coal = lin('#1d1b22'), stick = lin('#5d4030');
    B.add(new THREE.IcosahedronGeometry(1, 2), at(0, 0.3, 0, 0, 0, 0, 0.36, 0.33, 0.36), snow, [0, 0, 0, 0.1]);
    B.add(new THREE.IcosahedronGeometry(1, 2), at(0, 0.76, 0, 0, 0, 0, 0.26), snow, [0, 0, 0, 0.1]);
    B.add(new THREE.IcosahedronGeometry(1, 2), at(0, 1.12, 0, 0, 0, 0, 0.18), snow, [0, 0, 0, 0.1]);
    for (const e of [-1, 1]) B.add(new THREE.IcosahedronGeometry(0.026, 0), at(e * 0.065, 1.16, 0.16), coal);
    for (const y of [0.68, 0.8, 0.92]) B.add(new THREE.IcosahedronGeometry(0.025, 0), at(0, y, Math.sqrt(Math.max(0, 0.0676 - (y - 0.76) ** 2)) + 0.005), coal);
    const nose = new THREE.ConeGeometry(0.028, 0.15, 6); nose.rotateX(Math.PI / 2);
    B.add(nose, at(0, 1.11, 0.24), lin('#f08a2a'), [0, 0, 0, 0.1]);
    B.add(new THREE.TorusGeometry(0.17, 0.045, 5, 16), at(0, 0.96, 0, Math.PI / 2 - 0.08), lin('#c42a34'));
    B.add(new THREE.BoxGeometry(0.08, 0.26, 0.035), at(0.08, 0.84, 0.17, 0.25, 0, 0.12), lin('#c42a34'));
    for (const s of [-1, 1]) B.add(new THREE.CylinderGeometry(0.012, 0.018, 0.5, 4), at(s * 0.4, 0.88, 0, 0, 0, s * (1.0 + 0.2 * s)), stick);
    hatParts(B, at(0.0, 1.22, -0.01, -0.12, 0, 0.1, 0.15));
    blocks.push({ type: 'circle', x: +sx.toFixed(2), z: +sz.toFixed(2), r: 0.42 });
  }
  const propGeo = keep(B.build());
  const props = new THREE.Mesh(propGeo, propMat);
  props.name = 'xmas-props';
  group.add(props);

  // ---------------- bulbs (instanced spheres) + halos (points) ----------------
  const TREE_COL = ['#ff3b30', '#ffb02e', '#ffe9b8', '#3f7bff', '#ff5fa2', '#4fe08a'].map(lin);
  const FAIRY_COL = [lin('#ffcf85'), lin('#ffb867'), lin('#ffe2b0')];
  const bulbs = [];   // { p, c, tw:[phase, rate, depth], s, halo }
  for (const t of TIERS) for (let i = 1; i < SEG; i += 2) {
    const a = t.rot + i / SEG * TAU, r = t.r + 0.02;
    bulbs.push({ p: new THREE.Vector3(TX + Math.cos(a) * r, TY + t.yb - 0.12, TZ + Math.sin(a) * r) });
  }
  const nSpiral = low ? 12 : 30;
  for (let i = 0; i < nSpiral; i++) {
    const s = (i + 0.5) / nSpiral, y = 0.8 + (TOP - 1.0) * s, a = i * 2.39996 + 1.0, r = envR(y) * 0.88 + 0.04;
    bulbs.push({ p: new THREE.Vector3(TX + Math.cos(a) * r, TY + y, TZ + Math.sin(a) * r) });
  }
  bulbs.forEach((b, i) => { b.c = TREE_COL[i % TREE_COL.length]; b.tw = [rnd() * TAU, 0.6 + rnd() * 1.1, 0.8]; b.s = 0.05; b.halo = 0.55; b.gain = 1; });
  for (const p of fairy) bulbs.push({ p, c: FAIRY_COL[Math.floor(rnd() * 3)], tw: [rnd() * TAU, 0.5 + rnd() * 0.8, 0.4], s: 0.034, halo: 0.42, gain: 0.85 });
  const NB = bulbs.length;
  const bCol = new Float32Array(NB * 3), bTw = new Float32Array(NB * 3), bPos = new Float32Array(NB * 3), bSize = new Float32Array(NB);
  const bulbGeo = keep(new THREE.IcosahedronGeometry(1, 1));
  const bulbMesh = new THREE.InstancedMesh(bulbGeo, null, NB);
  bulbs.forEach((b, i) => {
    bCol.set([b.c[0] * b.gain, b.c[1] * b.gain, b.c[2] * b.gain], i * 3); bTw.set(b.tw, i * 3); bPos.set([b.p.x, b.p.y, b.p.z], i * 3); bSize[i] = b.halo;
    bulbMesh.setMatrixAt(i, mat4(b.p.x, b.p.y, b.p.z, 0, 0, 0, b.s, b.s * 1.25, b.s));
  });
  bulbGeo.setAttribute('aCol', new THREE.InstancedBufferAttribute(bCol, 3));
  bulbGeo.setAttribute('aTw', new THREE.InstancedBufferAttribute(bTw, 3));
  const TWINKLE = /* glsl */`
    float twinkle(vec3 tw, float t){   // tw = (phase, rate, depth): slow, irregular breathing
      float a = 0.5 + 0.5 * sin(t * tw.y + tw.x), b = 0.5 + 0.5 * sin(t * tw.y * 0.41 + tw.x * 1.7);
      return 1.0 - tw.z * (1.0 - smoothstep(0.05, 0.6, a * b + 0.15 * a));
    }
  `;
  const bulbMat = keep(new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, ...fogU },
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec3 aTw; uniform float uTime;
      varying vec3 vC; varying vec3 vN; varying vec3 vW;
      ${TWINKLE}
      void main(){
        mat4 m = modelMatrix * instanceMatrix;
        vC = aCol * (0.35 + 2.6 * twinkle(aTw, uTime));
        vN = normalize(mat3(m) * normal);
        vec4 w = m * vec4(position, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uFogCol; uniform float uFogDensity;
      varying vec3 vC; varying vec3 vN; varying vec3 vW;
      void main(){
        float f = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
        vec3 col = vC * (0.55 + 0.75 * f) + vec3(1.0, 0.9, 0.75) * pow(f, 6.0) * length(vC) * 0.25;
        float d = length(cameraPosition - vW) * uFogDensity;
        col = mix(col, uFogCol, 1.0 - exp(-d * d * 0.6));
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
  }));
  bulbMesh.material = bulbMat;
  bulbMesh.name = 'xmas-bulbs';
  bulbMesh.computeBoundingSphere();
  group.add(bulbMesh);

  const pxScale = { value: 500 };
  const drawSize = new THREE.Vector2();
  const setPx = (renderer, s, camera) => { renderer.getDrawingBufferSize(drawSize); pxScale.value = drawSize.y * 0.5 * camera.projectionMatrix.elements[5]; };
  const haloGeo = keep(new THREE.BufferGeometry());
  haloGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
  haloGeo.setAttribute('aCol', new THREE.BufferAttribute(bCol, 3));
  haloGeo.setAttribute('aTw', new THREE.BufferAttribute(bTw, 3));
  haloGeo.setAttribute('aSize', new THREE.BufferAttribute(bSize, 1));
  const haloMat = keep(new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uPxScale: pxScale, ...fogU },
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec3 aTw; attribute float aSize; uniform float uTime, uPxScale, uFogDensity;
      varying vec3 vC;
      ${TWINKLE}
      void main(){
        vec4 mv = viewMatrix * vec4(position, 1.0);
        mv.z += 0.12;   // nudge toward the camera so needles do not clip the glow
        float d = -mv.z * uFogDensity * 0.5;
        vC = aCol * twinkle(aTw, uTime) * exp(-d * d) * 0.32;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPxScale / max(-mv.z, 0.1), 2.0, 96.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vC;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q);
        float g = exp(-r2 * 6.0) * (1.0 - smoothstep(0.6, 1.0, r2)) + exp(-r2 * 40.0) * 0.6;
        gl_FragColor = vec4(vC * g, 1.0);
        ${TONE}
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const halos = new THREE.Points(haloGeo, haloMat);
  halos.renderOrder = 6; halos.frustumCulled = false; halos.onBeforeRender = setPx; halos.name = 'xmas-halos';
  group.add(halos);

  // ---------------- star + star halo ----------------
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const a = Math.PI / 2 + i / 10 * TAU, r = i % 2 ? 0.105 : 0.25;
    if (i === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  const starGeo = keep(new THREE.ExtrudeGeometry(starShape, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 1 }));
  starGeo.center();
  const starMat = keep(new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, ...fogU },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vW;
      void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime; varying vec3 vN; varying vec3 vW;
      void main(){
        float f = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
        float pulse = 0.9 + 0.1 * sin(uTime * 1.3);
        vec3 col = vec3(1.0, 0.66, 0.22) * (0.75 + 0.85 * f) * pulse + vec3(1.0, 0.9, 0.7) * pow(f, 8.0) * 0.45;
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
  }));
  const star = new THREE.Mesh(starGeo, starMat);
  star.position.set(TX, TY + TOP + 0.16, TZ); star.name = 'xmas-star';
  group.add(star);
  const quad = keep(new THREE.PlaneGeometry(1, 1));
  const starHaloMat = keep(new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, ...fogU },
    vertexShader: /* glsl */`
      uniform float uFogDensity; varying vec2 vUv; varying float vFog;
      void main(){
        vec4 mv = viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * 1.35; mv.z += 0.3;
        vUv = position.xy * 2.0;
        float d = -mv.z * uFogDensity * 0.45; vFog = exp(-d * d);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime; varying vec2 vUv; varying float vFog;
      void main(){
        float r2 = dot(vUv, vUv), r = sqrt(r2), a = atan(vUv.y, vUv.x);
        float g = exp(-r2 * 10.0) * 0.3 + exp(-r2 * 3.0) * 0.1;
        float rays = pow(abs(cos(a * 2.5 + uTime * 0.15)), 18.0) * 0.35 + pow(abs(cos(a * 4.0 - uTime * 0.1)), 30.0) * 0.18;
        g += rays * exp(-r * 4.0) * (1.0 - smoothstep(0.5, 1.0, r));
        g *= 1.0 - smoothstep(0.75, 1.0, r);
        gl_FragColor = vec4(vec3(1.0, 0.72, 0.32) * g * (0.92 + 0.08 * sin(uTime * 1.3)) * vFog, 1.0);
        ${TONE}
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const starHalo = new THREE.Mesh(quad, starHaloMat);
  starHalo.position.copy(star.position); starHalo.renderOrder = 6; starHalo.frustumCulled = false;
  group.add(starHalo);

  // ---------------- ground-conforming discs: snow patches + tree glow ----------------
  function disc(out, cx, cz, rx, rz, rot, lift, seed) {
    const rings = Math.max(3, Math.ceil(Math.max(rx, rz) / 0.45)), segs = Math.max(14, Math.min(28, Math.round(Math.max(rx, rz) * 7)));
    const base = out.pos.length / 3, c = Math.cos(rot), s = Math.sin(rot);
    const push = (u, v) => { const x = cx + (u * rx) * c - (v * rz) * s, z = cz + (u * rx) * s + (v * rz) * c;
      out.pos.push(x, gAt(x, z) + lift, z); out.uv.push(u, v, seed); };
    push(0, 0);
    for (let k = 1; k <= rings; k++) for (let i = 0; i < segs; i++) { const a = i / segs * TAU, r = k / rings; push(Math.cos(a) * r, Math.sin(a) * r); }
    for (let i = 0; i < segs; i++) out.idx.push(base, base + 1 + (i + 1) % segs, base + 1 + i);
    for (let k = 1; k < rings; k++) for (let i = 0; i < segs; i++) {
      const a = base + 1 + (k - 1) * segs, b = a + segs, i1 = (i + 1) % segs;
      out.idx.push(a + i, a + i1, b + i1, a + i, b + i1, b + i);
    }
  }
  const discGeo = (out) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(out.uv, 3));
    g.setIndex(out.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(out.idx, 1) : new THREE.Uint16BufferAttribute(out.idx, 1));
    g.computeBoundingSphere();
    return g;
  };
  // patch sites: upper sand and dunes; clear of the waterline band, the fire ring, the stepping-stone path and the seats
  const pd = { pos: [], uv: [], idx: [] };
  const nPatch = low ? 65 : 120;
  const pathX = (z) => fireP.x + 1.3 * Math.sin((z - fireP.z) / 5.0);
  let placed = 0, tries = 0;
  disc(pd, TX + toCam.x * 0.3, TZ + toCam.y * 0.3, 2.1, 1.8, rnd() * TAU, 0.05, 0.37);   // skirt under the tree
  if (smOk) disc(pd, SM[0], SM[1], 1.1, 0.9, 0.4, 0.05, 0.71);
  while (placed < nPatch && tries++ < 4000) {
    const x = -44 + rnd() * 88, z = waterZ + 5 + rnd() * 58;
    const w = Math.min(1, Math.max(0, (z - (waterZ + 5)) / 26)) * 0.85 + 0.15;
    if (rnd() > w) continue;
    const r = (0.6 + rnd() * 1.4) * (z > 24 ? 1.6 : 1.0), rz = r * (0.55 + rnd() * 0.4);
    if (Math.hypot(x - fireP.x, z - fireP.z) < 6.8 + r) continue;
    if (z > fireP.z + 3 && z < fireP.z + 27 && Math.abs(x - pathX(z)) < 0.9 + r) continue;
    if (seats.some((s) => Math.hypot(s.x - x, s.z - z) < r + 0.6)) continue;
    if (Math.hypot(x - TX, z - TZ) < r + 2.0) continue;
    disc(pd, x, z, r, rz, rnd() * TAU, 0.045, rnd());
    placed++;
  }
  const patchGeo = keep(discGeo(pd));
  const patchMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      attribute vec3 aUv; varying vec3 vUv; varying vec3 vW;
      void main(){ vUv = aUv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogDensity; uniform vec3 uFogCol;
      varying vec3 vUv; varying vec3 vW;
      ${NOISE}
      ${LIGHT}
      void main(){
        float r = length(vUv.xy);
        vec2 q = vW.xz + vUv.z * 37.0;
        float n = vn(q * 0.8) * 0.6 + vn(q * 2.6) * 0.3 + vn(q * 7.0) * 0.1;
        float core = smoothstep(0.98, 0.4, r + (n - 0.5) * 0.8);        // wobbly outline
        float grain = vn(q * 9.0) * 0.55 + vn(q * 23.0) * 0.45;          // powdery speckle where it thins out
        float m = clamp((core * 1.35 - grain * 0.85) * 3.0, 0.0, 1.0);
        m *= (0.62 + 0.3 * n) * (1.0 - smoothstep(0.82, 0.97, r));       // never reaches the polygon rim
        if (m < 0.01) discard;
        vec3 col = vec3(0.90, 0.91, 0.95) * lightAt(vW, vec3(0.0, 1.0, 0.0)) * vec3(0.95, 0.93, 0.84) * (0.9 + 0.12 * n);
        // tiny ice glints: a round dot in a few cells, twinkling with time and view
        vec2 gq = vW.xz * 22.0, c = floor(gq); float h = h21(c + vUv.z);
        float dot1 = 1.0 - smoothstep(0.05, 0.16, length(fract(gq) - 0.5 - (vec2(h21(c + 3.1), h21(c + 7.7)) - 0.5) * 0.6));
        col += vec3(0.9, 0.95, 1.0) * step(0.975, h) * dot1 * pow(0.5 + 0.5 * sin(uTime * (2.0 + h * 4.0) + h * 70.0 + dot(cameraPosition.xz, vec2(0.6, 0.4))), 8.0) * 1.1 * m;
        float d = length(cameraPosition - vW) * uFogDensity;
        col = mix(col, uFogCol, 1.0 - exp(-d * d));
        gl_FragColor = vec4(col, m);
        ${TONE}
      }
    `,
    transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
  }));
  const patches = new THREE.Mesh(patchGeo, patchMat);
  patches.renderOrder = 1; patches.name = 'xmas-snow-patches';
  group.add(patches);

  const gd = { pos: [], uv: [], idx: [] };
  disc(gd, TX, TZ, 3.0, 3.0, 0, 0.07, 0);
  const glowGeo = keep(discGeo(gd));
  const glowMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      attribute vec3 aUv; varying vec2 vP;
      void main(){ vP = aUv.xy; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uTw, uTime; varying vec2 vP;
      void main(){
        float r = length(vP), a = atan(vP.y, vP.x);
        float g = exp(-r * r * 3.2) * (1.0 - smoothstep(0.55, 1.0, r));
        vec3 tint = mix(vec3(1.0, 0.62, 0.30), vec3(1.0, 0.48, 0.42), 0.3 + 0.3 * sin(a * 3.0 + uTime * 0.2));
        tint = mix(tint, vec3(0.5, 0.65, 1.0), 0.18 * (0.5 + 0.5 * sin(a * 2.0 - uTime * 0.15 + 2.0)));
        gl_FragColor = vec4(tint * g * 0.06 * uTw, 1.0);
        ${TONE}
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  }));
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.renderOrder = 2; glow.name = 'xmas-tree-glow';
  group.add(glow);

  let treeLight = null;
  if (!low) {
    treeLight = new THREE.PointLight(0xffbf7a, 2.2, 7.5, 2);
    treeLight.position.set(TX + toCam.x * 1.2, TY + 1.5, TZ + toCam.y * 1.2);
    treeLight.name = 'xmas-tree-light';
    group.add(treeLight);
  }

  // ---------------- snowfall: one points volume that wraps around the camera ----------------
  const HN = 128, HX0 = -80, HZ0 = -60, HW = 160;
  const hData = new Uint8Array(HN * HN);
  for (let iz = 0; iz < HN; iz++) for (let ix = 0; ix < HN; ix++) {
    const y = Math.max(0, gAt(HX0 + (ix + 0.5) / HN * HW, HZ0 + (iz + 0.5) / HN * HW));
    hData[iz * HN + ix] = Math.max(0, Math.min(255, Math.round((y + 1) / 16 * 255)));
  }
  const hTex = keep(new THREE.DataTexture(hData, HN, HN, THREE.RedFormat, THREE.UnsignedByteType));
  hTex.minFilter = hTex.magFilter = THREE.LinearFilter; hTex.wrapS = hTex.wrapT = THREE.ClampToEdgeWrapping; hTex.needsUpdate = true;
  const NS = low ? 1500 : 4000;
  const VOL = low ? new THREE.Vector3(30, 14, 30) : new THREE.Vector3(40, 16, 40);
  const sPos = new Float32Array(NS * 3), sRnd = new Float32Array(NS * 4);
  for (let i = 0; i < NS; i++) {
    sPos[i * 3] = rnd() * VOL.x; sPos[i * 3 + 1] = rnd() * VOL.y; sPos[i * 3 + 2] = rnd() * VOL.z;
    sRnd[i * 4] = rnd(); sRnd[i * 4 + 1] = rnd(); sRnd[i * 4 + 2] = rnd(); sRnd[i * 4 + 3] = rnd();
  }
  const snowGeo = keep(new THREE.BufferGeometry());
  snowGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  snowGeo.setAttribute('aR', new THREE.BufferAttribute(sRnd, 4));
  const camPos = new THREE.Vector3(0, 3, 12);
  const snowMat = keep(new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uPxScale: pxScale, uCam: { value: camPos }, uSize: { value: VOL }, uH: { value: hTex },
      uHRect: { value: new THREE.Vector4(HX0, HZ0, 1 / HW, 1 / HW) }, uFireXZ: { value: new THREE.Vector3(fireP.x, fireP.y, fireP.z) }, ...fogU,
    },
    vertexShader: /* glsl */`
      uniform float uTime, uPxScale, uFogDensity; uniform vec3 uCam, uSize, uFireXZ; uniform vec4 uHRect; uniform sampler2D uH;
      attribute vec4 aR; varying float vA; varying float vF;
      void main(){
        vec3 p = position;
        p.y -= uTime * mix(0.5, 1.0, aR.x);
        p.x += sin(uTime * (0.45 + aR.y * 0.7) + aR.z * 6.283) * 0.32 + uTime * 0.16;
        p.z += cos(uTime * (0.35 + aR.w * 0.6) + aR.y * 6.283) * 0.26 + uTime * 0.04;
        vec3 base = uCam + vec3(0.0, 3.0, 0.0);
        vec3 w = base + mod(p - base + 0.5 * uSize, uSize) - 0.5 * uSize;
        float gy = texture2D(uH, (w.xz - uHRect.xy) * uHRect.zw).r * 16.0 - 1.0;
        float a = smoothstep(gy + 0.02, gy + 0.3, w.y);                 // gone at the sand and at the sea surface
        vec3 rel = (w - base) / uSize;
        a *= 1.0 - smoothstep(0.36, 0.5, max(abs(rel.x), abs(rel.z)));
        a *= 1.0 - smoothstep(0.38, 0.5, abs(rel.y));
        vec2 fd = w.xz - uFireXZ.xz;
        a *= mix(smoothstep(0.9, 1.9, length(fd)), 1.0, smoothstep(uFireXZ.y + 2.5, uFireXZ.y + 4.5, w.y));   // melts over the fire
        vec4 mv = viewMatrix * vec4(w, 1.0);
        float d = -mv.z;
        a *= smoothstep(0.35, 1.1, d);
        float fg = d * uFogDensity; vF = 1.0 - exp(-fg * fg);
        vA = a * mix(0.55, 0.95, aR.z);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = a > 0.002 ? clamp(mix(0.035, 0.07, aR.w) * uPxScale / max(d, 0.1), 1.6, 9.0) : 0.0;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uFogCol; varying float vA; varying float vF;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q);
        float m = (1.0 - smoothstep(0.25, 1.0, r2)) * vA;
        if (m < 0.01) discard;
        gl_FragColor = vec4(mix(vec3(0.88, 0.91, 1.0), uFogCol, vF * 0.8), m);
        ${TONE}
      }
    `,
    transparent: true, depthWrite: false, toneMapped: false,
  }));
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.renderOrder = 4; snow.frustumCulled = false; snow.name = 'xmas-snowfall';
  snow.onBeforeRender = setPx;
  group.add(snow);

  // ---------------- update ----------------
  let twAvg = 1;
  function update(dt, t, camera) {
    U.uTime.value = t;
    const f = scene.fog;
    if (f) { fogU.uFogCol.value.copy(f.color); fogU.uFogDensity.value = f.isFogExp2 ? f.density : 0.0085; }
    U.uFlick.value = 0.5 + 0.22 * Math.sin(t * 7.3) + 0.15 * Math.sin(t * 12.9 + 1.3) + 0.13 * Math.sin(t * 3.1 + 0.4);
    twAvg = 0.86 + 0.08 * Math.sin(t * 0.9) + 0.06 * Math.sin(t * 1.7 + 2.0);
    U.uTw.value = twAvg;
    if (treeLight) treeLight.intensity = 2.2 * twAvg;
    star.rotation.y = t * 0.35;
    if (camera) camPos.setFromMatrixPosition(camera.matrixWorld);
  }

  function dispose() {
    scene.remove(group);
    for (const o of disposables) o.dispose();
    bulbMesh.dispose();
    hatGeo = null;
  }

  return { update, blocks, makeHat, tree: { x: TX, z: TZ, r: TREE_R }, dispose };
}
