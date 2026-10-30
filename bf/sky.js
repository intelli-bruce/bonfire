// bf/sky.js — cosy stylized night sky for "밤바다 모닥불": navy→indigo gradient dome, big cute twinkling stars
// (bright ones get 4-point sparkles), soft pastel milky way, soft round moon with halo, rare shooting star,
// and scene.fog / scene.background.
//
// API: buildSky(THREE, scene, { moonDir, quality:'high'|'low', fogDensity }) -> { update(dt, t), moonDir, dispose() }
//
// Assumes renderer.toneMapping = THREE.ACESFilmicToneMapping, outputColorSpace = SRGBColorSpace, exposure ≈ 1.
// Colours are linear; shaders include tonemapping + colorspace chunks.
// Everything is drawn "at infinity" (view rotation only, depth pushed to the far plane): it follows the camera,
// needs no particular camera.far, frustumCulled = false. Dome: renderOrder -1000, no depth test/write (draw first).
// Stars / shooting star: additive, depth-tested, so terrain/ocean hide them.
// scene.fog = FogExp2(colour == sky colour at the horizon) so far headlands melt into the sky.

const MOON_RADIUS = 0.055; // radians (~3.2°): big, soft, storybook moon

export function buildSky(THREE, scene, opts = {}) {
  const low = opts.quality === 'low';
  const moonDir = new THREE.Vector3().copy(opts.moonDir || new THREE.Vector3(0.25, 0.32, -1)).normalize();
  const moonRight = new THREE.Vector3().crossVectors(moonDir, new THREE.Vector3(0, 1, 0)).normalize();
  const moonUp = new THREE.Vector3().crossVectors(moonRight, moonDir).normalize();

  // Linear palette (indigo night, readable)
  const HOR = new THREE.Color().setRGB(0.050, 0.070, 0.200);   // horizon == fog colour
  const MID = new THREE.Color().setRGB(0.020, 0.030, 0.115);
  const ZEN = new THREE.Color().setRGB(0.008, 0.011, 0.058);
  const MOONC = new THREE.Color().setRGB(1.0, 0.93, 0.74);

  const prevFog = scene.fog, prevBg = scene.background;
  scene.fog = new THREE.FogExp2(HOR.clone(), opts.fogDensity ?? 0.012);
  scene.background = HOR.clone();

  const mwA = new THREE.Vector3(-0.85, 0.05, -0.5).normalize();
  const mwB = new THREE.Vector3(0.35, 0.88, -0.3).normalize();
  const mwN = new THREE.Vector3().crossVectors(mwA, mwB).normalize();

  const objects = [];
  const pxScale = { value: 1 };
  const drawSize = new THREE.Vector2();
  const time = { value: 0 };

  const NOISE_GLSL = /* glsl */`
    float hash3(vec3 p){ p = fract(p*vec3(443.897,441.423,437.195)); p += dot(p, p.yzx+19.19); return fract((p.x+p.y)*p.z); }
    float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y), f.z); }
  `;
  const INF_VERT = /* glsl */`
    vec4 infProject(vec3 d){ vec4 c = projectionMatrix * vec4(mat3(viewMatrix) * d * 10.0, 1.0); c.z = c.w * 0.99999; return c; }
  `;

  // ---------- Dome ----------
  const domeGeo = new THREE.SphereGeometry(1, low ? 32 : 48, low ? 16 : 24);
  const domeMat = new THREE.ShaderMaterial({
    defines: { MILKY: low ? 0 : 1 },
    uniforms: {
      uMoonDir: { value: moonDir }, uMoonR: { value: moonRight }, uMoonU: { value: moonUp },
      uHor: { value: HOR }, uMid: { value: MID }, uZen: { value: ZEN }, uMoonCol: { value: MOONC }, uMWN: { value: mwN },
      uTime: time,
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      ${INF_VERT}
      void main(){ vDir = position; gl_Position = infProject(position); }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uMoonDir, uMoonR, uMoonU, uHor, uMid, uZen, uMoonCol, uMWN;
      uniform float uTime;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(uHor, uMid, smoothstep(0.0, 0.28, h));
        col = mix(col, uZen, smoothstep(0.22, 0.95, h));
        // lavender glow hugging the horizon
        col += vec3(0.060, 0.040, 0.110) * exp(-h * 14.0) * 0.6;
        float cm = dot(d, uMoonDir);
        float ang = acos(clamp(cm, -1.0, 1.0));
        // soft round halo: a gentle plateau ring + wide glow
        float halo = 0.10 * exp(-pow(max(ang - ${MOON_RADIUS.toFixed(3)}, 0.0) / 0.07, 1.4)) + 0.035 * exp(-ang * 3.0);
        col += uMoonCol * halo;
        vec2 dh = normalize(vec2(d.x, d.z) + 1e-5); vec2 mh = normalize(uMoonDir.xz);
        col += uMoonCol * 0.02 * pow(max(dot(dh, mh), 0.0), 4.0) * exp(-h * 6.0);
        #if MILKY == 1
          float bd = dot(d, uMWN);
          float band = exp(-bd * bd / 0.03);
          if (band > 0.01) {
            float n = vnoise(d * 3.0) * 0.6 + vnoise(d * 7.0 + 3.0) * 0.4;
            float mw = band * smoothstep(0.25, 0.75, n);
            vec3 tint = mix(vec3(0.55, 0.45, 0.85), vec3(0.85, 0.55, 0.75), vnoise(d * 2.0 + 9.0));
            col += tint * mw * 0.035 * smoothstep(0.03, 0.35, d.y) * smoothstep(0.08, 0.5, ang);
          }
        #endif
        // moon: soft-edged creamy disc with a few round darker spots
        if (cm > 0.99) {
          vec2 mp = vec2(dot(d, uMoonR), dot(d, uMoonU)) / ${MOON_RADIUS.toFixed(3)};
          float r = length(mp);
          float disc = 1.0 - smoothstep(0.94, 1.0, r);
          float spots = 0.0;
          spots += 1.0 - smoothstep(0.20, 0.26, length(mp - vec2(-0.30, 0.25)));
          spots += 1.0 - smoothstep(0.13, 0.18, length(mp - vec2(0.32, 0.38)));
          spots += 1.0 - smoothstep(0.16, 0.22, length(mp - vec2(0.12, -0.38)));
          spots += 1.0 - smoothstep(0.08, 0.12, length(mp - vec2(-0.45, -0.25)));
          float shade = 1.0 - 0.10 * clamp(spots, 0.0, 1.0) - 0.08 * smoothstep(0.4, 1.0, r);
          vec3 mc = uMoonCol * 3.2 * shade;
          col = mix(col, mc, disc);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.frustumCulled = false; dome.renderOrder = -1000; dome.name = 'sky-dome';
  scene.add(dome); objects.push(dome);

  // ---------- Stars ----------
  const N = low ? 650 : 1500;
  let seed = 1337;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pos = new Float32Array(N * 3), mag = new Float32Array(N), phase = new Float32Array(N), col = new Float32Array(N * 3);
  const tmp = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3();
  tA.crossVectors(mwN, new THREE.Vector3(0, 1, 0)).normalize(); tB.crossVectors(mwN, tA).normalize();
  const PASTEL = [[1.0, 1.0, 1.0], [1.0, 0.93, 0.72], [1.0, 0.80, 0.88], [0.78, 0.88, 1.0], [0.90, 0.85, 1.0]];
  for (let i = 0; i < N; i++) {
    if (rnd() < 0.3) {
      const a = rnd() * Math.PI * 2, off = (rnd() - 0.5) * (rnd() * 0.45);
      tmp.copy(tA).multiplyScalar(Math.cos(a)).addScaledVector(tB, Math.sin(a)).addScaledVector(mwN, off).normalize();
      if (tmp.y < 0) tmp.y = -tmp.y;
    } else {
      const u = rnd() * 1.02 - 0.02, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      tmp.set(r * Math.cos(a), u, r * Math.sin(a));
    }
    pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
    mag[i] = 0.12 + 0.88 * Math.pow(rnd(), 5.0);
    phase[i] = rnd();
    const c = PASTEL[Math.floor(rnd() * PASTEL.length)];
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  starGeo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uTime: time, uPx: pxScale, uMoonDir: { value: moonDir } },
    vertexShader: /* glsl */`
      attribute float aMag; attribute float aPhase; attribute vec3 aCol;
      uniform float uTime, uPx; uniform vec3 uMoonDir;
      varying vec3 vCol; varying float vB; varying float vSpark; varying float vRot;
      ${INF_VERT}
      void main(){
        vec3 d = position;
        gl_Position = infProject(d);
        float tw = 0.5 + 0.5 * sin(uTime * (0.8 + aPhase * 2.2) + aPhase * 40.0);
        tw = mix(0.55, 1.15, tw * tw);
        float hz = smoothstep(-0.01, 0.2, d.y);
        float moonFade = smoothstep(0.07, 0.35, acos(clamp(dot(d, uMoonDir), -1.0, 1.0)));
        vB = aMag * tw * mix(0.25, 1.0, hz) * moonFade;
        vCol = aCol;
        vSpark = smoothstep(0.42, 0.62, aMag);
        vRot = aPhase * 0.6 + uTime * 0.05 * (aPhase - 0.5);
        gl_PointSize = (2.2 + 5.0 * aMag + 9.0 * vSpark) * (0.85 + 0.25 * tw) * uPx;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vB; varying float vSpark; varying float vRot;
      void main(){
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        float c = cos(vRot), s = sin(vRot); q = mat2(c, -s, s, c) * q;
        float r = length(q);
        float dotS = 1.0 - smoothstep(0.25, 0.65, r);                  // round soft star
        vec2 a = abs(q);
        float arms = (1.0 - smoothstep(0.0, 0.11, min(a.x, a.y) * (1.0 + 2.0 * max(a.x, a.y)))) * (1.0 - smoothstep(0.5, 1.0, max(a.x, a.y)));
        float core = 1.0 - smoothstep(0.0, 0.22, r);
        float shape = mix(dotS, max(arms * 0.85, core), vSpark);
        gl_FragColor = vec4(vCol * vB * shape * 1.6, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false; stars.renderOrder = -900; stars.name = 'sky-stars';
  stars.onBeforeRender = (renderer) => { pxScale.value = renderer.getPixelRatio(); };
  scene.add(stars); objects.push(stars);

  // ---------- Shooting star ----------
  const SEG = 12;
  const ssT = new Float32Array((SEG + 1) * 2), ssS = new Float32Array((SEG + 1) * 2), ssP = new Float32Array((SEG + 1) * 2 * 3);
  const ssIdx = [];
  for (let i = 0; i <= SEG; i++) {
    ssT[i * 2] = ssT[i * 2 + 1] = i / SEG; ssS[i * 2] = -1; ssS[i * 2 + 1] = 1;
    if (i < SEG) { const a = i * 2; ssIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const ssGeo = new THREE.BufferGeometry();
  ssGeo.setAttribute('position', new THREE.BufferAttribute(ssP, 3));
  ssGeo.setAttribute('aT', new THREE.BufferAttribute(ssT, 1));
  ssGeo.setAttribute('aSide', new THREE.BufferAttribute(ssS, 1));
  ssGeo.setIndex(ssIdx);
  const ssU = {
    uA: { value: new THREE.Vector3(0, 1, 0) }, uB: { value: new THREE.Vector3(0, 1, 0) },
    uP: { value: 0 }, uLen: { value: 0.3 }, uBright: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uPx: pxScale,
  };
  const ssMat = new THREE.ShaderMaterial({
    uniforms: ssU,
    vertexShader: /* glsl */`
      attribute float aT; attribute float aSide;
      uniform vec3 uA, uB; uniform float uP, uLen, uPx; uniform vec2 uRes;
      varying float vT; varying float vSide;
      ${INF_VERT}
      void main(){
        float tp = max(uP - uLen, 0.0);
        vec3 d = normalize(mix(uA, uB, mix(tp, uP, aT)));
        vec4 c = infProject(d), ca = infProject(uA), cb = infProject(uB);
        if (ca.w <= 0.0 || cb.w <= 0.0 || c.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vT = 0.0; vSide = 0.0; return; }
        vec2 sd = normalize((cb.xy / cb.w - ca.xy / ca.w) * uRes + 1e-6);
        vec2 nrm = vec2(-sd.y, sd.x);
        c.xy += nrm * aSide * (0.5 + 2.5 * aT) * uPx / uRes * 2.0 * c.w;
        gl_Position = c; vT = aT; vSide = aSide;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uBright; varying float vT; varying float vSide;
      void main(){
        vec3 col = mix(vec3(0.75, 0.70, 1.0), vec3(1.0, 0.97, 0.85), vT);
        float edge = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
        gl_FragColor = vec4(col * pow(vT, 1.8) * edge * uBright * 2.2, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
  });
  const shooting = new THREE.Mesh(ssGeo, ssMat);
  shooting.frustumCulled = false; shooting.renderOrder = -890; shooting.visible = false; shooting.name = 'sky-shooting-star';
  shooting.onBeforeRender = (renderer) => { renderer.getDrawingBufferSize(drawSize); ssU.uRes.value.copy(drawSize); };
  scene.add(shooting); objects.push(shooting);

  let nextShoot = 5 + Math.random() * 8, ssAge = -1, ssDur = 0.8;
  const axis = new THREE.Vector3();
  function spawnShootingStar() {
    const el = 0.35 + Math.random() * 0.7, az = -Math.PI / 2 + (Math.random() - 0.5) * 2.4; // mostly over the sea (-Z)
    const A = ssU.uA.value, B = ssU.uB.value;
    A.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    axis.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    B.copy(A).addScaledVector(axis, 0.22 + Math.random() * 0.15); B.y -= 0.12 + Math.random() * 0.1; B.normalize();
    ssDur = 0.7 + Math.random() * 0.6; ssAge = 0; shooting.visible = true;
  }

  function update(dt, t) {
    time.value = t;
    if (ssAge < 0) {
      nextShoot -= dt;
      if (nextShoot <= 0) { spawnShootingStar(); nextShoot = (low ? 16 : 9) + Math.random() * (low ? 20 : 16); }
    } else {
      ssAge += dt;
      const p = ssAge / ssDur;
      ssU.uP.value = Math.min(p, 1);
      ssU.uBright.value = p < 1 ? Math.sin(p * Math.PI) : 0;
      if (p >= 1) { ssAge = -1; shooting.visible = false; }
    }
  }

  function dispose() {
    for (const o of objects) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    scene.fog = prevFog || null;
    scene.background = prevBg || null;
  }

  // test hook: force a shooting star now
  function shootNow() { spawnShootingStar(); }

  return { update, moonDir, dispose, shootNow };
}
