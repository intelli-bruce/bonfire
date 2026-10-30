// bf/fire.js — cosy stylized campfire for "밤바다 모닥불": chunky layered flame (metaball tongues with soft colour
// bands + break-away blobs), teepee of low-poly logs with glowing ends, round glowing coals, round ember sparks
// (pooled, GPU-animated), soft round smoke puffs (high only), warm halo + ground glow, one flickering PointLight.
//
// API: buildFire(THREE, scene, { x, y, z, quality:'high'|'low' }) -> {
//   update(dt, t), setFuel(f /* 0.3..1.6 */), fuel(), light, addLog(), playCrackle(ctx, dest) -> { setLevel, stop }, dispose() }
//
// Assumes renderer.toneMapping = ACESFilmicToneMapping, outputColorSpace = SRGB (colours authored as linear HDR).
// light: PointLight (decay 2, physically based intensity, no shadows) — the page may enable castShadow itself.
// Render order: ground glow 0, smoke 1, halo 2, flame 3, sparks 5 (all depthWrite off, depth-tested).
// No per-frame allocation: all animation is in shaders driven by a few uniforms; flicker is a sum of smooth 1D noises.

export function buildFire(THREE, scene, opts = {}) {
  const low = opts.quality === 'low';
  const origin = new THREE.Vector3(opts.x ?? 0, opts.y ?? 0, opts.z ?? 0);
  const group = new THREE.Group(); group.name = 'campfire';
  group.position.copy(origin);
  scene.add(group);

  const U = {
    uTime: { value: 0 }, uFuel: { value: 1 }, uFlare: { value: 0 }, uFlick: { value: 0.5 },
    uBurstT: { value: -100 }, uPxScale: { value: 500 }, uOrigin: { value: origin },
  };
  const drawSize = new THREE.Vector2();
  const setPx = (renderer, scene_, camera) => {
    renderer.getDrawingBufferSize(drawSize);
    U.uPxScale.value = drawSize.y * 0.5 * camera.projectionMatrix.elements[5];
  };
  const disposables = [];
  const keep = (...xs) => { disposables.push(...xs); return xs[0]; };
  const TONE = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  `;

  // ---------------- flame: one cylindrical billboard, field of metaball tongues ----------------
  const flameGeo = keep(new THREE.PlaneGeometry(1, 1, 1, 1));
  flameGeo.translate(0, 0.5, 0);
  const flameMat = keep(new THREE.ShaderMaterial({
    defines: { TONGUES: low ? 4 : 5, BLOBS: low ? 2 : 3 },
    uniforms: U,
    vertexShader: /* glsl */`
      uniform float uFuel, uFlare;
      varying vec2 vUv;
      void main(){
        vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = cameraPosition - base; toCam.y = 0.0;
        float l = length(toCam); toCam = l > 1e-4 ? toCam / l : vec3(0.0, 0.0, 1.0);
        vec3 right = vec3(toCam.z, 0.0, -toCam.x);
        float fs = 0.55 + 0.45 * uFuel, hs = (0.45 + 0.55 * uFuel) * (1.0 + 0.35 * uFlare);
        vec3 wp = base + right * position.x * 1.6 * fs + vec3(0.0, position.y * 1.9 * hs - 0.05, 0.0) + toCam * 0.05;
        vUv = vec2(position.x * 2.0, position.y);   // u in [-1,1], v in [0,1]
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uFlick, uFlare;
      varying vec2 vUv;
      float tongue(vec2 p, float x0, float h, float w, float ph, float t){
        float y = p.y / h;
        if (y >= 1.0) return 0.0;
        float sway = sin(p.y * 5.0 - t * 5.5 + ph) * 0.07 * clamp(y, 0.0, 1.2) + sin(t * 1.7 + ph) * 0.03 * y;
        float x = (p.x - x0 - sway) / w;
        float r = y < 0.0 ? sqrt(max(1.0 - (y / 0.32) * (y / 0.32), 0.0)) : pow(max(1.0 - y, 0.0), 0.5) * (1.0 + 0.6 * y * (1.0 - y));
        float g = 1.0 - abs(x) / max(r, 0.03);
        return clamp(g, 0.0, 1.0) * (1.0 - 0.6 * clamp(y, 0.0, 1.0));
      }
      void main(){
        vec2 p = vUv; float t = uTime;
        float inv = 1.0, mx = 0.0;   // max-union with a little overlap bonus
        for (int i = 0; i < TONGUES; i++) {
          float fi = float(i);
          float x0 = (fi / float(TONGUES - 1) - 0.5) * 0.78 + sin(fi * 7.3) * 0.04;
          float c = 1.0 - abs(x0) * 1.6;
          float h = (0.40 + 0.45 * c) * (0.86 + 0.12 * sin(t * (2.1 + fi * 0.37) + fi * 2.4) + 0.07 * sin(t * (4.3 + fi * 0.5) + fi)) * (0.92 + 0.16 * uFlick);
          float w = 0.30 + 0.26 * c;
          float g = tongue(p, x0, h, w, fi * 1.9, t); mx = max(mx, g); inv *= 1.0 - g;
        }
        for (int j = 0; j < BLOBS; j++) {
          float fj = float(j);
          float per = 0.9 + fj * 0.31;
          float a = fract(t / per + fj * 0.37);
          float cyc = floor(t / per + fj * 0.37);
          float bx = sin(cyc * 12.9898 + fj * 4.1) * 0.22 + sin(a * 4.0 + fj) * 0.05;
          float by = mix(0.55, 0.92, a) * (0.85 + 0.15 * uFlick);
          float br = mix(0.10, 0.0, a) * (1.0 + 0.4 * uFlare);
          vec2 q = (p - vec2(bx, by)) / vec2(1.0, 1.35);
          float g = clamp(1.0 - dot(q, q) / max(br * br, 1e-4), 0.0, 1.0) * 0.55;
          mx = max(mx, g); inv *= 1.0 - g;
        }
        float F = mx + 0.22 * ((1.0 - inv) - mx);
        F += sin(p.x * 9.0 + t * 3.0) * sin(p.y * 11.0 - t * 6.0) * 0.025;
        F *= 1.0 + 0.25 * uFlare;
        float e = 0.022;
        vec3 c0 = vec3(0.70, 0.08, 0.05) * 0.8;   // thin ruby outline
        vec3 c1 = vec3(0.95, 0.20, 0.04) * 0.9;  // red-orange
        vec3 c2 = vec3(1.00, 0.40, 0.05) * 1.0;  // orange
        vec3 c3 = vec3(1.00, 0.64, 0.12) * 1.1;   // gold
        vec3 c4 = vec3(1.00, 0.86, 0.45) * 1.35;  // cream core
        vec3 col = mix(c0, c1 * (0.9 + 0.2 * smoothstep(0.17, 0.32, F)), smoothstep(0.165 - e, 0.165 + e, F));
        col = mix(col, c2 * (0.9 + 0.2 * smoothstep(0.40, 0.6, F)), smoothstep(0.40 - e, 0.40 + e, F));
        col = mix(col, c3, smoothstep(0.62 - e, 0.62 + e, F));
        col = mix(col, c4, smoothstep(0.84 - e, 0.84 + e, F));
        col *= 0.9 + 0.2 * uFlick;
        float alpha = smoothstep(0.11, 0.145, F) * smoothstep(0.0, 0.05, p.y + 0.02);
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(col, alpha);
        ${TONE}
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.renderOrder = 3; flame.frustumCulled = false;
  group.add(flame);

  // ---------------- halo (additive, spherical billboard) ----------------
  const quadGeo = keep(new THREE.PlaneGeometry(1, 1));
  const haloMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      uniform float uFuel, uFlare;
      varying vec2 vUv;
      void main(){
        vec4 c = viewMatrix * modelMatrix * vec4(0.0, 0.75 * (0.45 + 0.55 * uFuel), 0.0, 1.0);
        float sz = 3.4 * (0.55 + 0.45 * uFuel) * (1.0 + 0.3 * uFlare);
        c.xy += position.xy * sz;
        c.z -= 0.5;   // sit just behind the flame so logs/stones stay crisp in front of the glow
        vUv = position.xy * 2.0;
        gl_Position = projectionMatrix * c;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uFlick, uFlare, uFuel;
      varying vec2 vUv;
      void main(){
        float r2 = dot(vUv, vUv);
        float g = exp(-r2 * 3.2) * (1.0 - smoothstep(0.7, 1.0, r2));
        g *= smoothstep(-0.65, -0.1, vUv.y);   // lower half would clip into the sand; the ground glow covers it
        vec3 col = vec3(1.0, 0.45, 0.14) * g * (0.13 + 0.07 * uFlick) * (0.7 + 0.3 * uFuel) * (1.0 + uFlare);
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const halo = new THREE.Mesh(quadGeo, haloMat);
  halo.renderOrder = 2; halo.frustumCulled = false;
  group.add(halo);

  // ---------------- ground glow (additive decal, follows SPEC slope) ----------------
  const glowGeo = keep(new THREE.CircleGeometry(1, 40));
  const glowMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      uniform float uFuel; varying vec2 vP;
      void main(){ vP = position.xy; float r = 3.6 * (0.6 + 0.4 * uFuel);
        // shallow bowl: edges lifted so the decal stays above gently curving sand
        float lift = 0.03 + 0.14 * dot(vP, vP);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position.xy * r, lift, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uFlick, uFlare, uFuel; varying vec2 vP;
      void main(){
        float r = length(vP);
        float g = exp(-r * r * 4.5) * (1.0 - smoothstep(0.4, 1.0, r));
        vec3 col = vec3(1.0, 0.45, 0.15) * g * (0.09 + 0.05 * uFlick) * (0.6 + 0.4 * uFuel) * (1.0 + 0.7 * uFlare);
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  const ground = new THREE.Mesh(glowGeo, glowMat);
  ground.rotation.x = -Math.PI / 2 - Math.atan(0.4 / 14); // sand rises toward +Z
  ground.position.y = 0.0; ground.renderOrder = 0; ground.frustumCulled = false;
  group.add(ground);

  // ---------------- logs (instanced teepee) ----------------
  const logGeo = keep(new THREE.CylinderGeometry(0.075, 0.095, 1.0, 7, 1));
  logGeo.translate(0, 0.5, 0);
  const logMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vW; varying float vH;
      void main(){
        mat4 m = modelMatrix * instanceMatrix;
        vN = normalize(mat3(m) * normal);
        vec4 w = m * vec4(position, 1.0); vW = w.xyz; vH = position.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uFlick, uFuel, uFlare; uniform vec3 uOrigin;
      varying vec3 vN; varying vec3 vW; varying float vH;
      void main(){
        vec3 N = normalize(vN);
        vec3 toC = normalize(uOrigin + vec3(0.0, 0.35, 0.0) - vW);
        float fireSide = smoothstep(0.0, 0.25, dot(N, toC));
        float top = smoothstep(0.3, 0.6, N.y);
        vec3 bark = vec3(0.075, 0.035, 0.018);
        vec3 col = bark + vec3(0.04, 0.045, 0.09) * top;                       // moonlit top band
        col += vec3(0.85, 0.30, 0.07) * 0.12 * fireSide * (0.8 + 0.4 * uFlick);   // firelit inner faces
        // glowing charred ends near the centre (top of each leaning log)
        float ember = smoothstep(0.7, 0.92, vH);
        float crack = 0.5 + 0.5 * sin(vH * 38.0 + sin(vW.x * 20.0 + vW.z * 17.0) * 2.0 + uTime * 0.7);
        col = mix(col, vec3(1.0, 0.32, 0.05) * (0.8 + 0.6 * crack) * (0.8 + 0.3 * uFlick), ember * (0.55 + 0.45 * crack) * (0.7 + 0.3 * uFuel));
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
  }));
  const LOGS = 6;
  const logs = new THREE.InstancedMesh(logGeo, logMat, LOGS);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < LOGS; i++) {
    const a = (i / LOGS) * Math.PI * 2 + 0.3;
    const r = 0.5;
    dummy.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
    dummy.rotation.set(0, 0, 0);
    // lean toward the centre: rotate the +Y axis toward -radial
    dummy.lookAt(0, 0.02, 0);
    dummy.rotateX(Math.PI / 2 - 0.95);
    dummy.scale.set(1, 0.78 + 0.12 * Math.sin(i * 3.7), 1);
    dummy.updateMatrix(); logs.setMatrixAt(i, dummy.matrix);
  }
  logs.instanceMatrix.needsUpdate = true;
  logs.frustumCulled = false;
  group.add(logs);

  // ---------------- coals (instanced low-poly gems) ----------------
  const COALS = low ? 12 : 22;
  const coalGeo = keep(new THREE.IcosahedronGeometry(0.075, 0));
  const coalSeed = new Float32Array(COALS);
  const coalMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      attribute float aSeed; varying float vS; varying vec3 vN;
      void main(){ vS = aSeed; mat4 m = modelMatrix * instanceMatrix; vN = normalize(mat3(m) * normal);
        gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uFlick, uFuel; varying float vS; varying vec3 vN;
      void main(){
        float pulse = 0.5 + 0.5 * sin(uTime * (0.8 + vS * 1.7) + vS * 30.0);
        float facet = 0.6 + 0.4 * max(normalize(vN).y, 0.0);
        vec3 hot = vec3(1.0, 0.38, 0.07) * (1.1 + 1.2 * pulse) * (0.7 + 0.3 * uFuel);
        vec3 dark = vec3(0.16, 0.03, 0.01);
        vec3 col = mix(dark, hot, 0.45 + 0.55 * smoothstep(0.2, 0.8, pulse * 0.6 + vS * 0.5)) * facet * (0.9 + 0.2 * uFlick);
        gl_FragColor = vec4(col, 1.0);
        ${TONE}
      }
    `,
  }));
  const coals = new THREE.InstancedMesh(coalGeo, coalMat, COALS);
  let cs = 77;
  const crnd = () => { cs = (cs * 16807) % 2147483647; return cs / 2147483647; };
  for (let i = 0; i < COALS; i++) {
    const a = crnd() * Math.PI * 2, r = Math.sqrt(crnd()) * 0.32;
    dummy.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
    dummy.rotation.set(crnd() * 3, crnd() * 3, crnd() * 3);
    const s = 0.7 + crnd() * 0.7; dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix(); coals.setMatrixAt(i, dummy.matrix); coalSeed[i] = crnd();
  }
  coalGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(coalSeed, 1));
  coals.instanceMatrix.needsUpdate = true; coals.frustumCulled = false;
  group.add(coals);

  // ---------------- sparks: round embers, stateless GPU particles ----------------
  const NS = low ? 60 : 150, NB = low ? 40 : 90;
  const NT = NS + NB;
  const sPos = new Float32Array(NT * 3), sRnd = new Float32Array(NT * 4), sBurst = new Float32Array(NT);
  let ss = 4242;
  const srnd = () => { ss = (ss * 16807) % 2147483647; return ss / 2147483647; };
  for (let i = 0; i < NT; i++) {
    sRnd[i * 4] = srnd(); sRnd[i * 4 + 1] = srnd(); sRnd[i * 4 + 2] = srnd(); sRnd[i * 4 + 3] = srnd();
    sBurst[i] = i >= NS ? 1 : 0;
  }
  const sparkGeo = keep(new THREE.BufferGeometry());
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  sparkGeo.setAttribute('aRnd', new THREE.BufferAttribute(sRnd, 4));
  sparkGeo.setAttribute('aBurst', new THREE.BufferAttribute(sBurst, 1));
  const sparkMat = keep(new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */`
      attribute vec4 aRnd; attribute float aBurst;
      uniform float uTime, uFuel, uBurstT, uPxScale, uFlare;
      varying float vFade; varying float vHeat;
      void main(){
        float life = mix(1.3, 3.0, aRnd.x);
        float age, alive;
        if (aBurst < 0.5) {
          float tt = uTime + aRnd.y * 37.0;
          age = mod(tt, life);
          float cyc = floor(tt / life);
          float h = fract(sin(cyc * 12.9898 + aRnd.z * 78.233) * 43758.5453);
          float rate = clamp(0.10 + 0.32 * uFuel + 0.5 * uFlare, 0.0, 1.0);
          alive = step(h, rate);
        } else {
          age = uTime - uBurstT - aRnd.y * 0.35;
          alive = step(0.0, age) * step(age, life);
          age = max(age, 0.0);
        }
        float burst = aBurst;
        float vy = mix(1.1, 2.6, aRnd.w) * (1.0 + 0.5 * burst) * (0.7 + 0.3 * uFuel);
        float k = 0.8;
        vec3 p = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        p.y += 0.35 + 0.4 * uFuel * aRnd.x + vy * (1.0 - exp(-k * age)) / k;
        float ang = aRnd.z * 6.2831853;
        vec2 start = vec2(cos(ang), sin(ang)) * aRnd.x * 0.3;
        vec2 vel = vec2(cos(ang * 1.7 + 1.0), sin(ang * 1.3 + 2.0)) * mix(0.08, 0.35, aRnd.y) * (1.0 + 1.6 * burst);
        float sw = age * (2.0 + aRnd.w * 2.0) + aRnd.x * 20.0;
        vec2 swirl = vec2(sin(sw), cos(sw)) * 0.12 * min(age, 1.5);
        p.xz += start + vel * age + swirl + vec2(0.12, -0.06) * age * age * 0.25;
        float u = age / life;
        vFade = alive * (1.0 - u * u);
        vHeat = 1.0 - u;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float worldSize = mix(0.03, 0.05, aRnd.w) * (1.0 - 0.6 * u);
        gl_PointSize = alive * clamp(worldSize * uPxScale / max(-mv.z, 0.1), 2.0, 24.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying float vFade; varying float vHeat;
      void main(){
        vec2 q = gl_PointCoord - 0.5; float r = length(q) * 2.0;
        float disc = 1.0 - smoothstep(0.55, 1.0, r);
        float core = 1.0 - smoothstep(0.0, 0.5, r);
        vec3 col = mix(vec3(1.0, 0.26, 0.04), vec3(1.0, 0.50, 0.08), vHeat * 0.75 + core * 0.25) * 0.75;
        gl_FragColor = vec4(col * disc * vFade, 1.0);
        ${TONE}
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.renderOrder = 5; sparks.frustumCulled = false;
  sparks.onBeforeRender = setPx;
  group.add(sparks);

  // ---------------- smoke puffs (high only) ----------------
  let smoke = null;
  if (!low) {
    const NP = 9;
    const pg = keep(new THREE.InstancedBufferGeometry());
    pg.index = quadGeo.index; pg.setAttribute('position', quadGeo.getAttribute('position'));
    const pr = new Float32Array(NP * 2);
    for (let i = 0; i < NP; i++) { pr[i * 2] = i / NP; pr[i * 2 + 1] = srnd(); }
    pg.setAttribute('aP', new THREE.InstancedBufferAttribute(pr, 2));
    pg.instanceCount = NP;
    const smokeMat = keep(new THREE.ShaderMaterial({
      uniforms: U,
      vertexShader: /* glsl */`
        attribute vec2 aP; uniform float uTime, uFuel;
        varying vec2 vUv; varying float vA; varying float vAge;
        void main(){
          float life = 7.0;
          float age = fract(uTime / life + aP.x);
          vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float hs = 0.45 + 0.55 * uFuel;
          vec3 c = base + vec3(0.0, 1.5 * hs + age * 4.2, 0.0);
          c.x += sin(age * 5.0 + aP.y * 6.28) * 0.25 * age + age * age * 1.2;
          c.z += cos(age * 4.0 + aP.y * 9.0) * 0.2 * age - age * age * 0.6;
          float sz = mix(0.35, 1.6, sqrt(age)) * (0.8 + 0.4 * aP.y);
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * sz;
          vUv = position.xy * 2.0;
          vA = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.45, 1.0, age)) * 0.13;
          vAge = age;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec2 vUv; varying float vA; varying float vAge;
        void main(){
          float r = length(vUv);
          float a = (1.0 - smoothstep(0.55, 1.0, r)) * vA;
          if (a < 0.003) discard;
          vec3 col = mix(vec3(0.20, 0.17, 0.24), vec3(0.10, 0.10, 0.16), smoothstep(-0.6, 0.6, -vUv.y));
          col = mix(vec3(0.45, 0.22, 0.10), col, smoothstep(0.0, 0.35, vAge)); // warm when fresh
          gl_FragColor = vec4(col, a);
          ${TONE}
        }
      `,
      transparent: true, depthWrite: false,
    }));
    smoke = new THREE.Mesh(pg, smokeMat);
    smoke.renderOrder = 1; smoke.frustumCulled = false;
    group.add(smoke);
  }

  // ---------------- light ----------------
  const light = new THREE.PointLight(new THREE.Color(1.0, 0.58, 0.28), 20, 0, 2);
  light.position.set(origin.x, origin.y + 0.7, origin.z);
  light.name = 'campfire-light';
  scene.add(light);

  // ---------------- state ----------------
  let fuelTarget = 1, fuelVis = 1, lastT = 0, flareT = -100;
  const hashI = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  const n1 = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); const a = hashI(i), b = hashI(i + 1); return a + (b - a) * u; };

  function update(dt, t) {
    lastT = t;
    fuelVis += (fuelTarget - fuelVis) * Math.min(1, dt * 1.5);
    const flick = 0.5 * n1(t * 7.3) + 0.3 * n1(t * 13.7 + 5.1) + 0.2 * n1(t * 2.3 + 11.0);
    const flare = Math.exp(-Math.max(0, t - flareT) * 1.3) * (t >= flareT ? 1 : 0);
    U.uTime.value = t; U.uFuel.value = fuelVis; U.uFlick.value = flick; U.uFlare.value = flare;
    const fs = 0.55 + 0.45 * fuelVis;
    light.intensity = 12 * fs * fs * (0.72 + 0.56 * flick) * (1 + 0.8 * flare);
    light.distance = 0;
    light.position.set(origin.x + (n1(t * 3.1) - 0.5) * 0.08, origin.y + 0.55 + 0.35 * fs + (n1(t * 4.7 + 3) - 0.5) * 0.06, origin.z + (n1(t * 2.9 + 7) - 0.5) * 0.08);
  }

  function setFuel(f) { fuelTarget = Math.min(1.6, Math.max(0.3, +f || 0)); }
  function fuel() { return fuelTarget; }
  function addLog() { flareT = lastT; U.uBurstT.value = lastT; }

  function dispose() {
    scene.remove(group); scene.remove(light);
    for (const d of disposables) d.dispose && d.dispose();
    logs.dispose(); coals.dispose();
  }

  return { update, setFuel, fuel, light, addLog, playCrackle, dispose };
}

// ---------------- procedural crackle (WebAudio) ----------------
const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

export function playCrackle(ctx, dest) {
  const out = ctx.createGain(); out.gain.value = 0;
  out.connect(dest || ctx.destination);
  const buf = noiseBuffer(ctx);
  // soft low roar of the flames
  const roar = ctx.createBufferSource(); roar.buffer = buf; roar.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.4;
  const rg = ctx.createGain(); rg.gain.value = 0.18;
  roar.connect(lp); lp.connect(rg); rg.connect(out); roar.start();
  let level = 0.8, stopped = false, nextT = ctx.currentTime + 0.05;

  function crack(time, amp, pop) {
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = pop ? 500 + Math.random() * 900 : 1800 + Math.random() * 4200;
    bp.Q.value = pop ? 1.5 : 0.7 + Math.random() * 2.5;
    const g = ctx.createGain();
    const dur = pop ? 0.03 + Math.random() * 0.05 : 0.004 + Math.random() * 0.018;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(amp, time + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(time, Math.random() * 1.8, dur + 0.02);
  }
  function schedule() {
    if (stopped) return;
    const horizon = ctx.currentTime + 0.15;
    while (nextT < horizon) {
      const r = Math.random();
      if (r < 0.06) { // pop: a little cluster of louder low clicks
        const n = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) crack(nextT + i * (0.008 + Math.random() * 0.02), 0.5 + Math.random() * 0.4, true);
      } else {
        crack(nextT, 0.08 + Math.random() * Math.random() * 0.35, false);
      }
      const rate = 5 + 22 * level;              // events per second
      nextT += -Math.log(1 - Math.random()) / rate * (Math.random() < 0.15 ? 3 : 1);
    }
  }
  const timer = setInterval(schedule, 50);
  schedule();
  return {
    setLevel(v) {
      level = Math.max(0, Math.min(1, v));
      out.gain.setTargetAtTime(level * 0.9, ctx.currentTime, 0.12);
    },
    stop() {
      if (stopped) return; stopped = true; clearInterval(timer);
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      setTimeout(() => { try { roar.stop(); } catch (e) { /* already stopped */ } out.disconnect(); }, 400);
    },
  };
}
