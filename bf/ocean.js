// bf/ocean.js — cosy stylized sea for "밤바다 모닥불": clean colour bands (turquoise shallows → teal → indigo deep),
// soft toon foam rings that roll in and swash up/down the beach near waterlineZ, a sparkly moon path made of
// twinkling 4-point glints, gentle swell to the horizon at y = 0, faint warm firelight on near foam.
//
// API: buildOcean(THREE, scene, { renderer, moonDir, waterlineZ = -14, shoreline, quality:'high'|'low', firePos })
//   shoreline (optional): [[x, z], ...] sorted by x, the y = 0 water edge (beach.json); foam/swash follow it,
//   clamped outside its x range. Absent → straight edge at waterlineZ.
//        -> { update(dt, t, camera), waveSoundLevel() /* 0..1, peaks when a breaker crashes */, dispose() }
//
// Assumes renderer.toneMapping = ACESFilmicToneMapping, outputColorSpace = SRGB (linear colours, glints > 1).
// The mesh spans ±1000 m: set camera.far >= 1200. Transparent ShaderMaterial (renderOrder -10, depthWrite on) so the
// swash edge fades softly over the opaque terrain — draw terrain opaque. Reads scene.fog (FogExp2) every frame.
// Shore model assumes sand rising from waterlineZ with slope ≈ 0.4/14 (SPEC); where the real terrain is higher the
// water simply hides under it. Glints are screen-space (view-dependent, like real glitter). No texture fetches:
// the detail/foam map is generated procedurally here.

export function buildOcean(THREE, scene, opts = {}) {
  const low = opts.quality === 'low';
  const renderer = opts.renderer || null;
  const WL = opts.waterlineZ ?? -14;
  // optional curved shoreline: [[x, z], ...] sorted by x (≈1 m step); baked into a 1D float texture sampled by x
  const shore = Array.isArray(opts.shoreline) && opts.shoreline.length >= 2 ? opts.shoreline : null;
  let shoreTex = null, shoreX0 = 0, shoreDX = 1, shoreN = 1, gridWL = WL;
  if (shore) {
    shoreN = shore.length; shoreX0 = shore[0][0]; shoreDX = (shore[shoreN - 1][0] - shoreX0) / (shoreN - 1) || 1;
    const zs = new Float32Array(shoreN);
    for (let i = 0; i < shoreN; i++) {          // resample onto a uniform x grid (tolerates uneven input spacing)
      const x = shoreX0 + i * shoreDX; let j = 0;
      while (j < shoreN - 2 && shore[j + 1][0] < x) j++;
      const [xa, za] = shore[j], [xb, zb] = shore[j + 1];
      zs[i] = za + (zb - za) * Math.min(1, Math.max(0, (x - xa) / ((xb - xa) || 1)));
    }
    shoreTex = new THREE.DataTexture(zs, shoreN, 1, THREE.RedFormat, THREE.FloatType);
    shoreTex.magFilter = shoreTex.minFilter = THREE.NearestFilter; shoreTex.generateMipmaps = false; shoreTex.needsUpdate = true;
    gridWL = Math.max(...zs);
  }
  const SLOPE = 0.4 / 14;
  const moonDir = new THREE.Vector3().copy(opts.moonDir || new THREE.Vector3(0.25, 0.32, -1)).normalize();
  const firePos = new THREE.Vector3().copy(opts.firePos || new THREE.Vector3(0, 0.9, 0));

  const tex = makeDetailTexture(THREE, low ? 128 : 256);
  if (renderer && !low) tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const geo = makeGrid(THREE, gridWL, low);

  // Wave sets: period, phase offset, amplitude (shared by GLSL and waveSoundLevel)
  const SETS = [[7.3, 0.0, 1.0], [11.9, 0.37, 0.55]];

  const HOR = new THREE.Color().setRGB(0.050, 0.070, 0.200);
  const pxScale = { value: 1 };
  const uniforms = {
    uTime: { value: 0 }, uWL: { value: WL }, uShore: { value: shoreTex }, uShoreP: { value: new THREE.Vector3(shoreX0, shoreDX, shoreN) }, uSlope: { value: SLOPE }, uPx: pxScale,
    uTex: { value: tex },
    uMoonDir: { value: moonDir }, uMoonCol: { value: new THREE.Color().setRGB(1.0, 0.93, 0.74) },
    uFogCol: { value: HOR.clone() }, uFogDensity: { value: 0.012 },
    uFirePos: { value: firePos }, uFireCol: { value: new THREE.Color().setRGB(1.0, 0.5, 0.18) },
    uShallow: { value: new THREE.Color().setRGB(0.030, 0.200, 0.230) },
    uMid: { value: new THREE.Color().setRGB(0.016, 0.070, 0.170) },
    uDeep: { value: new THREE.Color().setRGB(0.010, 0.026, 0.105) },
    uFoam: { value: new THREE.Color().setRGB(0.92, 0.96, 1.12) },
    uSet0: { value: new THREE.Vector3(...SETS[0]) }, uSet1: { value: new THREE.Vector3(...SETS[1]) },
  };

  const SHORE_GLSL = /* glsl */`
    uniform float uTime, uWL, uSlope;
    #if SHORE == 1
      uniform sampler2D uShore; uniform vec3 uShoreP;   // x0, dx, n
      float shoreZ(float x){
        float u = clamp((x - uShoreP.x) / uShoreP.y, 0.0, uShoreP.z - 1.0);
        float i0 = floor(u), i1 = min(i0 + 1.0, uShoreP.z - 1.0);
        float z0 = texture2D(uShore, vec2((i0 + 0.5) / uShoreP.z, 0.5)).r;
        float z1 = texture2D(uShore, vec2((i1 + 0.5) / uShoreP.z, 0.5)).r;
        return mix(z0, z1, u - i0);
      }
    #else
      float shoreZ(float x){ return uWL; }
    #endif
    uniform vec3 uSet0, uSet1;
    float wPhase(float x, vec3 st, float k){
      return fract(uTime / st.x + st.y + 0.05 * sin(x * 0.043 + 1.3 * k) + 0.025 * sin(x * 0.13 + 2.1 * k));
    }
    float bumpAt(float s, float phi, float amp){
      if (phi >= 0.6) return 0.0;
      float sF = 16.0 * (1.0 - phi / 0.6);
      float grow = smoothstep(16.0, 5.0, sF) * (1.0 - smoothstep(4.0, 1.2, sF));
      float w = s < sF ? 0.9 : 2.6;
      float q = (s - sF) / w;
      return amp * 0.10 * grow * exp(-q * q);
    }
    float swashAt(float phi, float amp){
      float u = (phi - 0.55) / 0.45;
      if (u <= 0.0) return 0.0;
      float lv = smoothstep(0.0, 0.2, u) * (1.0 - smoothstep(0.2, 1.0, u));
      float back = smoothstep(0.55, 0.85, u) * (1.0 - smoothstep(0.9, 1.0, u));
      return amp * (0.075 * lv - 0.012 * back);
    }
    float shoreLevel(float s, float x, out float swash){
      float p0 = wPhase(x, uSet0, 0.0), p1 = wPhase(x, uSet1, 1.0);
      swash = swashAt(p0, uSet0.z) + swashAt(p1, uSet1.z);
      float m = 1.0 - smoothstep(2.0, 9.0, s);
      return bumpAt(s, p0, uSet0.z) + bumpAt(s, p1, uSet1.z) + swash * m;
    }
  `;

  const mat = new THREE.ShaderMaterial({
    defines: { HIGH: low ? 0 : 1, SHORE: shoreTex ? 1 : 0 },
    uniforms,
    transparent: true, depthWrite: true, fog: false,
    vertexShader: /* glsl */`
      ${SHORE_GLSL}
      varying vec3 vWorld; varying vec3 vN; varying float vBump;
      void swell(vec2 xz, vec2 D, float L, float A, float ph, float Q, inout vec3 disp, inout vec2 sl){
        float k = 6.2831853 / L; float c = sqrt(9.8 / k);
        float f = k * (dot(D, xz) - c * uTime) + ph;
        float cf = cos(f), sf = sin(f);
        disp += vec3(Q * A * D.x * cf, A * sf, Q * A * D.y * cf);
        sl += A * k * D * cf;
      }
      void main(){
        vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
        float s = shoreZ(p.x) - p.z;
        float m = smoothstep(4.0, 30.0, s) * (1.0 - smoothstep(110.0, 160.0, s)) * (1.0 - smoothstep(120.0, 170.0, abs(p.x)));
        vec3 disp = vec3(0.0); vec2 sl = vec2(0.0);
        swell(p.xz, normalize(vec2(0.10, 1.0)), 26.0, 0.12 * m, 0.0, 0.5, disp, sl);
        swell(p.xz, normalize(vec2(-0.30, 1.0)), 15.0, 0.06 * m, 1.7, 0.5, disp, sl);
        swell(p.xz, normalize(vec2(0.42, 1.0)), 10.0, 0.035 * m, 4.1, 0.4, disp, sl);
        p += disp;
        float sw;
        float h0 = shoreLevel(s, p.x, sw);
        float h1 = shoreLevel(s + 0.25, p.x, sw);
        p.y += h0;
        vBump = h0 - sw * (1.0 - smoothstep(2.0, 9.0, s));
        vN = normalize(vec3(-sl.x, 1.0, -sl.y + (h1 - h0) / 0.25));
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      ${SHORE_GLSL}
      uniform sampler2D uTex;
      uniform vec3 uMoonDir, uMoonCol, uFogCol, uFirePos, uFireCol, uShallow, uMid, uDeep, uFoam;
      uniform float uFogDensity, uPx;
      varying vec3 vWorld; varying vec3 vN; varying float vBump;

      float hash2(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float aastep(float th, float v){ float w = fwidth(v) * 0.75 + 1e-4; return smoothstep(th - w, th + w, v); }

      float foamSet(float s, float phi, float amp, float sEdge){
        float f = 0.0;
        if (phi < 0.6) {
          float sF = 16.0 * (1.0 - phi / 0.6);
          float br = smoothstep(8.0, 3.5, sF);
          float w = mix(0.35, 2.6, smoothstep(5.0, 0.0, sF));
          f += br * smoothstep(sF - 0.25, sF, s) * (1.0 - smoothstep(sF + w * 0.5, sF + w, s));
          // thin crest line before it breaks
          f += 0.75 * smoothstep(13.0, 8.0, sF) * (1.0 - br) * (1.0 - smoothstep(0.0, 0.28, abs(s - sF - 0.3)));
        }
        float u = (phi - 0.55) / 0.45;
        if (u > 0.0) {
          float spread = mix(1.0, 4.0, smoothstep(0.0, 0.35, u));
          f += pow(1.0 - u, 1.2) * (1.0 - smoothstep(sEdge + spread * 0.6, sEdge + spread, s)) * 0.9;
        }
        return f * amp;
      }

      void main(){
        vec3 Vd = cameraPosition - vWorld; float dist = length(Vd); vec3 V = Vd / dist;
        vec2 p = vWorld.xz;
        float s = shoreZ(vWorld.x) - vWorld.z;
        float t = uTime;

        vec4 t1 = texture2D(uTex, p * 0.035 + vec2(0.004, 0.015) * t);
        vec4 t2 = texture2D(uTex, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.09 + vec2(-0.010, 0.026) * t);

        // ---- depth over the assumed beach slope → clean colour bands with soft wobbly edges
        float sw;
        float lvl = shoreLevel(s, vWorld.x, sw);
        float sandY = -s * uSlope;
        float d = vWorld.y - sandY;
        float wob = (t1.b - 0.5) * 0.06;
        float b1 = smoothstep(0.11, 0.135, d + wob);
        float b2 = smoothstep(0.46, 0.52, d + wob * 2.0);
        vec3 col = mix(uShallow, uMid, b1);
        col = mix(col, uDeep, b2);
        // gentle lift toward the horizon (reflected sky), not banded
        col = mix(col, uFogCol * 0.95, smoothstep(30.0, 500.0, dist) * 0.75);

        // soft toon swell shading: crests facing the moon get a lighter band
        float lit = dot(normalize(vN + vec3(t1.r - 0.5, 0.0, t1.g - 0.5) * 0.25), normalize(uMoonDir + vec3(0.0, 1.5, 0.0)));
        col += vec3(0.010, 0.022, 0.040) * smoothstep(0.985, 0.995, lit) * (1.0 - b2 * 0.4);
        col += vec3(0.010, 0.030, 0.030) * clamp(vBump * 12.0, 0.0, 1.0);   // shoaling crest glow

        #if HIGH == 1
          // stylized ripple contour lines (fade with distance to avoid aliasing)
          float rh = t1.b * 0.6 + t2.b * 0.4;
          float rl = 1.0 - aastep(0.022, abs(rh - 0.66));
          col += vec3(0.02, 0.04, 0.07) * rl * (1.0 - smoothstep(12.0, 45.0, dist)) * b1;
        #endif

        // ---- moon path: soft band + twinkling glints
        vec2 toF = normalize(vWorld.xz - cameraPosition.xz + 1e-4);
        vec2 mAz = normalize(uMoonDir.xz);
        float side = toF.x * mAz.y - toF.y * mAz.x;
        float along = dot(toF, mAz);
        float pw = mix(0.10, 0.06, smoothstep(10.0, 200.0, dist));
        float path = exp(-pow(side / pw, 2.0)) * step(0.0, along) * smoothstep(2.0, 10.0, dist);
        float pcore = exp(-pow(side / (pw * 0.28), 2.0)) * step(0.0, along) * smoothstep(2.0, 10.0, dist);
        col += uMoonCol * (0.022 * path + 0.05 * pcore) * (1.0 - b2 * 0.2);

        float CELL = 11.0 * uPx;
        vec2 fc = gl_FragCoord.xy / CELL; vec2 cid = floor(fc); vec2 fq = fract(fc);
        float h1 = hash2(cid);
        float rate = 1.2 + 1.8 * h1;
        float ep = floor(t * rate + h1 * 17.0);
        float life = fract(t * rate + h1 * 17.0);
        vec2 gp = 0.3 + 0.4 * vec2(hash2(cid + ep * 1.73), hash2(cid * 1.31 + ep * 3.17));
        float exists = step(hash2(cid + ep * 7.7 + 3.1), path * path * 0.8 + pcore * 0.2 + 0.01 * step(0.0, along));
        float gsz = mix(1.0, 0.6, smoothstep(10.0, 250.0, dist)) * (0.6 + 0.6 * hash2(cid + ep));
        vec2 q = (fq - gp) * CELL / (6.5 * uPx * gsz);
        vec2 aq = abs(q);
        float arms = (1.0 - smoothstep(0.0, 0.16, min(aq.x, aq.y) * (1.0 + 3.0 * max(aq.x, aq.y)))) * (1.0 - smoothstep(0.4, 1.0, max(aq.x, aq.y)));
        float core = 1.0 - smoothstep(0.0, 0.3, length(q));
        float env = sin(life * 3.14159); env *= env;
        float glint = exists * env * max(arms, core);

        // ---- toon foam: breakers, whitewash, edge line and soft rings that follow the swash
        float sEdge = -sw / uSlope;
        float p0 = wPhase(vWorld.x, uSet0, 0.0), p1 = wPhase(vWorld.x, uSet1, 1.0);
        float fz = foamSet(s, p0, uSet0.z, sEdge) + foamSet(s, p1, uSet1.z, sEdge);
        float de = s - sEdge + (t2.b - 0.5) * 0.5;                // distance from the moving water edge
        fz += 1.0 - smoothstep(0.35, 0.5, de);                     // solid edge band
        fz += 0.8 * (1.0 - smoothstep(0.08, 0.16, abs(de - 1.15)));  // ring 1
        fz += 0.5 * (1.0 - smoothstep(0.06, 0.13, abs(de - 2.3)));   // ring 2
        float lace = t1.a;
        #if HIGH == 1
          lace = lace * 0.6 + texture2D(uTex, p * 0.33 - vec2(0.012, 0.0) * t).a * 0.4;
        #endif
        float field = fz * 1.25 + (lace - 0.55) * 0.7;
        float foam = aastep(0.62, field) * (1.0 - smoothstep(25.0, 45.0, s));

        // warm firelight on the near foam / water
        vec3 toFire = uFirePos - vWorld; float df2 = dot(toFire, toFire);
        vec3 fireLit = uFireCol * (30.0 / (1.0 + df2));
        float mdiff = 0.75 + 0.25 * max(dot(vN, uMoonDir), 0.0);
        vec3 foamCol = uFoam * mdiff + fireLit * 0.08;
        col += fireLit * 0.006;
        col = mix(col, foamCol, foam);
        glint *= 1.0 - foam;

        // ---- fog (slightly darker than the sky so the horizon line stays readable)
        float fd = dist * uFogDensity * 0.7;
        float fog = 1.0 - exp(-fd * fd);
        col = mix(col, uFogCol * 0.82, fog);
        col += uMoonCol * glint * 2.6 * (1.0 - 0.6 * fog);

        float alpha = clamp(smoothstep(0.0, 0.05, d) * 0.85 + smoothstep(0.05, 0.3, d) * 0.15 + foam, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = -10; mesh.name = 'ocean';
  mesh.onBeforeRender = (r) => { pxScale.value = r.getPixelRatio(); };
  scene.add(mesh);

  let lastT = 0, camX = 0;
  function frac(v) { return v - Math.floor(v); }
  function phaseJS(x, t, st, k) {
    return frac(t / st[0] + st[1] + 0.05 * Math.sin(x * 0.043 + 1.3 * k) + 0.025 * Math.sin(x * 0.13 + 2.1 * k));
  }
  function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  function update(dt, t, camera) {
    lastT = t;
    uniforms.uTime.value = t;
    if (camera) camX = camera.position.x;
    const f = scene.fog;
    if (f) { uniforms.uFogCol.value.copy(f.color); uniforms.uFogDensity.value = f.isFogExp2 ? f.density : 0.012; }
  }

  // 0..1 surf loudness: crash when a breaker hits the shore, then the hiss of the swash dying out
  function waveSoundLevel() {
    let v = 0.12;
    for (let k = 0; k < SETS.length; k++) {
      const st = SETS[k];
      const phi = phaseJS(camX, lastT, st, k);
      const crash = phi < 0.5 ? smooth(0.38, 0.5, phi) * 0.6 : Math.exp(-(phi - 0.5) * 6.0);
      v += st[2] * crash * 0.62;
    }
    return Math.min(1, Math.max(0, v));
  }

  function dispose() {
    scene.remove(mesh); geo.dispose(); mat.dispose(); tex.dispose(); if (shoreTex) shoreTex.dispose();
  }

  return { update, waveSoundLevel, dispose, mesh };
}

function makeGrid(THREE, WL, low) {
  const dz0 = low ? 0.7 : 0.35, dx0 = low ? 2.0 : 1.0;
  // z rows from shore side (under the sand) out to sea
  const zs = [];
  let z = WL + 7, step = dz0;
  while (WL - z < 1000) {
    zs.push(z);
    const s = WL - z;
    if (s < 20) step = dz0; else if (s < 120) step = dz0 + (s - 20) * 0.025; else step *= 1.18;
    z -= step;
  }
  zs.push(WL - 1000);
  const xsPos = [0];
  let x = 0; step = dx0;
  while (x < 1000) {
    if (x < 60) step = dx0; else if (x < 200) step = dx0 + (x - 60) * 0.03; else step *= 1.2;
    x = Math.min(1000, x + step); xsPos.push(x);
  }
  const xs = xsPos.slice(1).reverse().map(v => -v).concat(xsPos);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const o = (j * nx + i) * 3; pos[o] = xs[i]; pos[o + 1] = 0; pos[o + 2] = zs[j];
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function makeDetailTexture(THREE, S) {
  let seed = 9001;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // tileable height = sum of sines with integer wave vectors (anisotropic: crests mostly along x)
  const waves = [];
  for (let n = 0; n < 48; n++) {
    let kx, ky, kl;
    do { kx = Math.round((rnd() * 2 - 1) * 14); ky = Math.round((rnd() * 2 - 1) * 18); kl = Math.hypot(kx, ky); } while (kl < 2 || kl > 20);
    const aniso = 0.35 + 0.65 * (ky * ky) / (kl * kl);
    waves.push([kx, ky, Math.pow(kl, -1.6) * aniso, rnd() * Math.PI * 2]);
  }
  const N = S * S;
  const sx = new Float32Array(N), sz = new Float32Array(N), h = new Float32Array(N);
  const TAU = Math.PI * 2;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = i / S, v = j / S; let hh = 0, gx = 0, gz = 0;
    for (const [kx, ky, a, ph] of waves) {
      const f = TAU * (kx * u + ky * v) + ph; const c = Math.cos(f);
      hh += a * Math.sin(f); gx += a * kx * c; gz += a * ky * c;
    }
    const o = j * S + i; h[o] = hh; sx[o] = gx; sz[o] = gz;
  }
  let rms = 0, hmax = 0;
  for (let o = 0; o < N; o++) { rms += sx[o] * sx[o] + sz[o] * sz[o]; hmax = Math.max(hmax, Math.abs(h[o])); }
  rms = Math.sqrt(rms / (2 * N));
  // foam lace: tileable worley (bubbly cells) + fine grain
  const C = 10, pts = [];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) pts.push([(i + rnd()) / C, (j + rnd()) / C]);
  const C2 = 23, pts2 = [];
  for (let j = 0; j < C2; j++) for (let i = 0; i < C2; i++) pts2.push([(i + rnd()) / C2, (j + rnd()) / C2]);
  const worley = (u, v, P, Cn) => {
    const ci = Math.floor(u * Cn), cj = Math.floor(v * Cn); let f1 = 9, f2 = 9;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = (ci + di + Cn) % Cn, jj = (cj + dj + Cn) % Cn; const p = P[jj * Cn + ii];
      let dx = p[0] - u, dy = p[1] - v; dx -= Math.round(dx); dy -= Math.round(dy);
      const dd = Math.hypot(dx, dy) * Cn; if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
    }
    return [f1, f2];
  };
  const data = new Uint8Array(N * 4);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const o = j * S + i, u = i / S, v = j / S;
    const ex = Math.max(-1, Math.min(1, sx[o] / (3 * rms))), ez = Math.max(-1, Math.min(1, sz[o] / (3 * rms)));
    const [a1, a2] = worley(u, v, pts, C), [b1, b2] = worley(u, v, pts2, C2);
    // ridges between cells read as foam strands; holes in the middle of cells
    const r1 = 1 - Math.min(1, (a2 - a1) * 2.2), r2 = 1 - Math.min(1, (b2 - b1) * 2.5);
    const foam = Math.max(0, Math.min(1, 0.62 * r1 + 0.38 * r2 + (h[o] / hmax) * 0.12));
    data[o * 4] = Math.round((ex * 0.5 + 0.5) * 255);
    data[o * 4 + 1] = Math.round((ez * 0.5 + 0.5) * 255);
    data[o * 4 + 2] = Math.round((h[o] / hmax * 0.5 + 0.5) * 255);
    data[o * 4 + 3] = Math.round(foam * 255);
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}
