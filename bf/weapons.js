// bf/weapons.js — 무기 슬롯(1 맨손 · 2 검 · 3 M4A1 · 4 산탄총): 모델 장착, 자세·휘두르기·장전 애니메이션, 총구 섬광·탄 궤적·탄피·검기, 내 전투 로직과 네트워크 반영.
// 로직(탄약·콤보·피해 표·광선 수학·메시지 검증)은 bf/weapons-core.js 에 있다(node 테스트). 모델은 tools/weapons/build_weapons.py (Blender) 로 만든다.
//
//   const W = createWeapons({ THREE, scene, camera, baseUrl, myId, addFill, fx, groundY, heightAt, blocked, waterY, me, camState, others, spider, net, log, audio, canUse, standUp, hud })
//   W.load() · W.equip(slot) · W.cycle(dir) · W.trigger(down) · W.reload() · W.frame(dt, now) · W.afterUpdate(rec, dt, now) · W.onNet(rec, senderId, msg)
//   W.setRemoteSlot(rec, slot) · W.view  (HUD 값) · W.dispose()

import * as C from './weapons-core.js';
const { WEAPONS, COMBO, SLASH } = C;

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = C.clamp;
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// 월드에서 무기의 크기(m 배율)와 손에 쥐는 방식(모델 축 → 팔 뼈 축). 모델: 총구/칼끝 -Z, 위 +Y.
const SCALE = { 2: 1.2, 3: 1.3, 4: 1.15 };
const MODEL_FILE = { 2: 'sword.glb', 3: 'm4a1.glb', 4: 'shotgun.glb' };
// 자세(오일러 도, XYZ — 팔: X -90 = 앞, Z 90 = 아래로 늘어뜨림 기준, 위 바깥쪽은 Z 작게). controller/avatar 의 규약과 같다.
const POSE = {
  2: { r: [-60, -10, 54], l: [-18, 0, -58], torso: [0, 0, 0] },
  3: { r: [-90, 6, 84], l: [-84, -4, -78], torso: [0, -10, 0] },
  4: { r: [-90, 6, 86], l: [-86, -8, -72], torso: [0, -10, 0] },
};
// 쥐는 위치(모델의 grip 빈 노드 이름)와 손끝에서의 추가 이동(m, 무기 좌표)
const GRIP = { 2: { node: 'grip', off: [0, 0, 0] }, 3: { node: 'grip_r', off: [0, 0, 0] }, 4: { node: 'grip_r', off: [0, 0, 0] } };
// 검: 날이 위로 서도록 쥐는 방향. 날 방향(-Z)이 팔 방향(-X) 대신 위(+Z 뼈 축)쪽으로, 앞으로 tilt 도 기울임
const SWORD_TILT = 24;
const BULLET_SCALE = 2.0, HEAD_LEN = 0.285 * BULLET_SCALE;   // 탄두 모델 배율과 길이(m)
const SHOULDER = 0.85;   // m: a gun up slides the view over the right shoulder

export function createWeapons(ctx) {
  const { THREE: T, scene } = ctx;
  const q1 = new T.Quaternion(), q2 = new T.Quaternion(), e1 = new T.Euler(), v1 = new T.Vector3(), v2 = new T.Vector3(), m4 = new T.Matrix4();
  const rnd = Math.random;
  const coarse = !!ctx.coarse;

  // ===================================================================== 모델 불러오기
  let tpl = null, loadP = null, ready = false;
  function load() {
    if (loadP) return loadP;
    loadP = (async () => {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const ld = new GLTFLoader();
      const get = (f) => new Promise((res, rej) => ld.load(new URL(f, ctx.baseUrl).href, res, undefined, rej));
      const slots = [2, 3, 4];
      const gl = await Promise.all(slots.map((s) => get(MODEL_FILE[s])));
      tpl = {};
      slots.forEach((s, i) => {
        const root = gl[i].scene;
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.frustumCulled = false; o.castShadow = false;
          for (const m of [].concat(o.material)) { if (m.isMeshStandardMaterial) { m.metalness = Math.min(m.metalness, 0.3); if (m.emissive && m.emissive.getHex() === 0) m.emissive.copy(m.color).multiplyScalar(0.3); ctx.addFill(m); } }   // 달빛 아래에서도 읽히도록 약한 자체 발광
        });
        tpl[s] = root;
      });
      buildFxAssets();
      ready = true;
      return tpl;
    })().catch((e) => { console.warn('[bonfire] weapon models not loaded:', e && e.message); throw e; });
    return loadP;
  }

  // ===================================================================== 아바타에 붙이기
  const handCache = new Map();   // charId -> { x, y, z } 팔 뼈 좌표계의 손(주먹) 위치
  function handOf(av) {
    if (handCache.has(av.charId)) return handCache.get(av.charId);
    let out = { x: -0.14, y: 0, z: 0 };
    try {
      const bone = av.model.getObjectByName('arm-right');
      let best = null;
      av.model.traverse((o) => { if (o.isSkinnedMesh && !best) best = o; });
      const sk = best.skeleton, bi = sk.bones.indexOf(bone), P = best.geometry.attributes.position, J = best.geometry.attributes.skinIndex, Wt = best.geometry.attributes.skinWeight;
      const inv = sk.boneInverses[bi], pts = [];
      for (let i = 0; i < P.count; i++) {
        let b = 0; for (let k = 1; k < 4; k++) if (Wt.getComponent(i, k) > Wt.getComponent(i, b)) b = k;
        if (J.getComponent(i, b) !== bi) continue;
        v1.set(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(best.bindMatrix).applyMatrix4(inv); pts.push(v1.clone());
      }
      if (pts.length) {
        let minX = 1e9; for (const p of pts) minX = Math.min(minX, p.x);
        const tip = pts.filter((p) => p.x < minX * 0.72 + 0.28 * 0);   // 끝에서 가까운 28 % 정도
        const use = tip.length ? tip : pts;
        let cy = 0, cz = 0; for (const p of use) { cy += p.y; cz += p.z; }
        out = { x: minX * 0.86, y: cy / use.length, z: cz / use.length, minX };
      }
    } catch (e) { console.warn('[bonfire] hand anchor fallback:', e && e.message); }
    handCache.set(av.charId, out);
    return out;
  }
  function makeInst(rec, slot) {
    const av = rec.av, bone = av.model.getObjectByName('arm-right'); if (!bone || !tpl) return null;
    const model = tpl[slot].clone(true), holder = new T.Group();
    holder.name = 'weapon-' + slot; holder.add(model); holder.visible = false;
    const sc = SCALE[slot] / av.scale; holder.scale.setScalar(sc);
    const hand = handOf(av);
    // 모델 축 → 팔 뼈 축 : 총구(-Z)는 팔 방향(-X), 위(+Y)는 뼈 +Z (팔을 앞으로 뻗었을 때 위쪽), 오른쪽(+X)은 뼈 +Y
    if (slot === 2) {   // 검: 날(-Z)이 뼈 +Z(팔을 앞으로 뻗었을 때 위)쪽으로 서고 SWORD_TILT 도 앞(-X)으로 눕는다. 날(벼린 쪽)은 앞을 향한다
      const tl = SWORD_TILT * DEG, sn = Math.sin(tl), cs = Math.cos(tl);
      m4.makeBasis(new T.Vector3(0, 1, 0), new T.Vector3(cs, 0, sn), new T.Vector3(sn, 0, -cs)); holder.quaternion.setFromRotationMatrix(m4);   // 날의 넓은 면이 뒤(카메라)를 보게: 뒤에서 본 3인칭에서 칼날이 얇은 선으로 보이지 않도록
    } else {
      m4.makeBasis(new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1), new T.Vector3(1, 0, 0)); holder.quaternion.setFromRotationMatrix(m4);
    }
    const g = model.getObjectByName(GRIP[slot].node), gp = g ? g.position.clone() : new T.Vector3();
    gp.add(new T.Vector3(...GRIP[slot].off)).multiplyScalar(sc);   // 모델 좌표 → 뼈 단위(배율 반영)
    v1.copy(gp).applyQuaternion(holder.quaternion);
    holder.position.set(hand.x - v1.x, hand.y - v1.y, hand.z - v1.z);
    bone.add(holder);
    const part = (n) => { const o = model.getObjectByName(n); return o ? { o, p0: o.position.clone() } : null; };
    return { slot, holder, model, mag: part('mag'), ch: part('charging_handle'), bolt: part('bolt'), pump: part('pump'), gem: model.getObjectByName('gem'),
      muzzle: model.getObjectByName('muzzle') || null, eject: model.getObjectByName('eject') || null, sc };
  }
  function wpOf(rec) {
    if (rec.wp) return rec.wp;
    rec.wp = { slot: 1, w: 0, inst: {}, swing: null, reload: null, kick: 0, bolt: 0, elev: 0, elevT: 0, flash: 0, lastSlot: 1, tNow: 0 };
    return rec.wp;
  }
  function instOf(rec, slot) {
    const wp = wpOf(rec);
    if (!wp.inst[slot]) { const i = makeInst(rec, slot); if (i) wp.inst[slot] = i; }
    return wp.inst[slot] || null;
  }

  // ===================================================================== 내 상태
  const my = { slot: 1, guns: { 3: C.newGun(3), 4: C.newGun(4) }, sword: C.newSword(), trig: false, noAmmoAt: 0, supply: 0, lastTrigAt: 0, aim: { kind: null, d: 0 }, timeline: [], stat: { fired: 0, hit: 0, sent: 0 } };
  const view = { slot: 1, ammo: '', mag: 0, reserve: 0, reload01: 0, kick: 0, aim: null, combo: -1, reloading: false, shoulder: 0 };
  const now0 = () => performance.now() / 1000;

  function equip(slot, quiet) {
    slot = clamp(Math.round(slot), 1, 4);
    const rec = ctx.me().rec; if (!rec) return false;
    if (slot === my.slot) return true;
    my.slot = slot; my.trig = false;
    const wp = wpOf(rec); wp.slot = slot; wp.draw = slot >= 2 ? 1 : 0; if (slot >= 2) instOf(rec, slot);
    if (slot === 3 || slot === 4) { const g = my.guns[slot]; if (g && g.reload) g.reload.t0 = now0(); }
    refreshHud();
    if (!quiet) sfx('equip', 1);
    ctx.hud.slot(slot);
    return true;
  }
  const cycle = (dir) => equip(C.wrapSlot(my.slot, dir));
  function refreshHud() {
    const g = my.guns[my.slot];
    view.slot = my.slot; view.ammo = C.ammoText(g); view.mag = g ? g.mag : 0; view.reserve = g ? g.reserve : 0; view.reloading = !!(g && g.reload);
    ctx.hud.ammo(my.slot, g);
  }

  // ===================================================================== 소리(합성)
  let noise = null;
  function sfx(kind, level) {
    const a = ctx.audio(); if (!a || !a.ctx || a.ctx.state !== 'running' || level < 0.03) return;
    const ac = a.ctx, t = ac.currentTime;
    if (!noise) { noise = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const burst = (dur, f0, f1, q, gain, type = 'bandpass') => {
      const src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noise; src.playbackRate.value = 0.8 + rnd() * 0.4; flt.type = type; flt.Q.value = q; flt.frequency.setValueAtTime(f0, t); flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain * level, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt); flt.connect(g); g.connect(a.dest); src.start(t); src.stop(t + dur + 0.03);
    };
    const tone = (f0, f1, dur, gain, type = 'sine') => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain * level, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(a.dest); o.start(t); o.stop(t + dur + 0.03);
    };
    if (kind === 'rifle') { burst(0.16, 3200, 500, 0.6, 0.55, 'lowpass'); tone(150, 45, 0.12, 0.5); burst(0.05, 5200, 3000, 1.2, 0.18); }
    else if (kind === 'shotgun') { burst(0.32, 2400, 260, 0.5, 0.8, 'lowpass'); tone(110, 32, 0.28, 0.8); burst(0.09, 4200, 1800, 0.9, 0.25); }
    else if (kind === 'click') { burst(0.025, 3000, 2400, 3, 0.4); }
    else if (kind === 'slide') { burst(0.12, 1800, 800, 2.2, 0.28); tone(900, 500, 0.05, 0.1, 'square'); }
    else if (kind === 'magout') { burst(0.06, 2200, 1200, 2, 0.3); tone(420, 260, 0.06, 0.18, 'triangle'); }
    else if (kind === 'magin') { tone(320, 190, 0.08, 0.35, 'triangle'); burst(0.07, 2600, 1500, 2, 0.28); }
    else if (kind === 'pump') { burst(0.1, 1600, 700, 1.8, 0.3); tone(240, 150, 0.1, 0.2, 'triangle'); }
    else if (kind === 'equip') { burst(0.05, 2400, 1600, 2.4, 0.24); }
    else if (kind === 'slash') { burst(0.28, 900, 3800, 1.2, 0.3); tone(520, 1500, 0.2, 0.08); }
    else if (kind === 'slashHit') { tone(900, 300, 0.12, 0.3, 'triangle'); burst(0.08, 3500, 1500, 1.4, 0.3); }
    else if (kind === 'whoosh') { burst(0.18, 700, 2600, 1.4, 0.26); }
  }
  const dist2me = (x, y, z) => { const m = ctx.me(); return Math.hypot(x - m.x, y - m.y, z - m.z); };
  const lvlAt = (x, y, z, r = 28) => clamp(1 - dist2me(x, y, z) / r, 0, 1);

  // ===================================================================== 효과: 총구 섬광 · 탄 궤적 · 탄피 · 검기 · 떨어진 탄창
  let fxs = null;
  const trs = [], cas = [], drops = [], slashes = [];
  function buildFxAssets() {
    const flashTex = (() => {   // 별 모양 총구 섬광
      const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); g.translate(64, 64);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 60); gr.addColorStop(0, 'rgba(255,255,235,1)'); gr.addColorStop(0.25, 'rgba(255,214,120,0.95)'); gr.addColorStop(1, 'rgba(255,120,30,0)');
      g.fillStyle = gr; g.beginPath(); for (let i = 0; i < 16; i++) { const a = i / 16 * TAU, r = i % 2 ? 22 : (i % 4 === 0 ? 62 : 40); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill();
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    })();
    const flashMat = new T.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false });
    fxs = {
      flashMat,
      // 날아가는 탄: 탄두(둥근 끝의 작은 탄환 모양) + 뒤로 옅어지는 짧은 궤적(십자로 교차한 두 판, 꼬리 쪽 알파 0)
      bulletGeo: new T.LatheGeometry([[0, 0], [0.05, 0], [0.056, 0.1], [0.046, 0.19], [0.022, 0.25], [0, 0.285]].map(([r, y]) => new T.Vector2(r, y)), 10).rotateX(Math.PI / 2).scale(BULLET_SCALE, BULLET_SCALE, BULLET_SCALE),
      glowGeo: new T.SphereGeometry(0.17, 8, 6), glowMat: new T.MeshBasicMaterial({ color: '#ffa63a', transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending, fog: false }),
      bulletMat: new T.MeshBasicMaterial({ color: '#fff1bd', side: T.DoubleSide, fog: false }),
      trailGeo: (() => {
        const w = 0.05, pos = [], col = [], idx = [];
        for (const [ax, ay] of [[1, 0], [0, 1]]) {
          const b = pos.length / 3;
          pos.push(-w * ax, -w * ay, 0, w * ax, w * ay, 0, w * ax, w * ay, 1, -w * ax, -w * ay, 1);
          col.push(1, 0.62, 0.2, 0, 1, 0.62, 0.2, 0, 1, 0.9, 0.55, 0.9, 1, 0.9, 0.55, 0.9);
          idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
        const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 4)); g.setIndex(idx);
        return g;
      })(),
      trailMat: new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false }),
      casingGeo: new T.BoxGeometry(0.014, 0.014, 0.05), shellGeo: new T.CylinderGeometry(0.014, 0.014, 0.065, 8).rotateX(Math.PI / 2),
      brass: new T.MeshBasicMaterial({ color: '#e3b04a' }), red: new T.MeshBasicMaterial({ color: '#c8402e' }),
      light: new T.PointLight('#ffb866', 0, 14, 1.6),
    };
    scene.add(fxs.light);
    // 검기 초승달: 얇은 판(XY 평면, 뒤에서 본 정면). 바깥 호(볼록 +X) → 안쪽 호로 갈수록 투명. 정점 색에 알파. 아래에서 회전으로 기울여 쓴다
    fxs.crescent = (w, so, thick, big) => {
      const Ro = (w * w + so * so) / (2 * so), si = so - thick, Ri = (w * w + si * si) / (2 * si), N = 32, pos = [], col = [], idx = [], sh = so * 0.5;
      for (let i = 0; i <= N; i++) {
        const y = -w + 2 * w * i / N, xo = Math.sqrt(Math.max(0, Ro * Ro - y * y)) - Ro + sh, xi = Math.sqrt(Math.max(0, Ri * Ri - y * y)) - Ri - thick + sh, xm = xo * 0.62 + xi * 0.38;
        pos.push(xo, y, 0, xm, y, 0, xi, y, 0);
        col.push(1, 1, 0.92, 1, big ? 0.62 : 0.55, 0.92, 1, 0.82, 0.2, 0.7, 1, 0.0);   // 가장자리 흰색 → 몸통 하늘색(불투명) → 안쪽 투명
        if (i < N) { const a = i * 3; idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3, a + 1, a + 2, a + 4, a + 2, a + 5, a + 4); }
      }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 4)); g.setIndex(idx);
      return g;
    };
    fxs.crGeo = fxs.crescent(1.5, 1.05, 0.62, false); fxs.crGeoBig = fxs.crescent(1.5, 1.05, 0.62, true);
    fxs.crMat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false });
    fxs.crGlow = new T.MeshBasicMaterial({ color: '#7ee3ff', transparent: true, opacity: 0.32, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false });
    for (let i = 0; i < 40; i++) {
      const g = new T.Group(), head = new T.Mesh(fxs.bulletGeo, fxs.bulletMat), trail = new T.Mesh(fxs.trailGeo, fxs.trailMat), glow = new T.Mesh(fxs.glowGeo, fxs.glowMat);
      glow.position.z = HEAD_LEN * 0.55; glow.scale.z = 1.8; glow.frustumCulled = false; head.add(glow);
      head.frustumCulled = trail.frustumCulled = false; trail.renderOrder = 5; g.add(trail, head); g.visible = false; scene.add(g);
      trs.push({ g, head, trail, on: false, fresh: false, age: 0, o: new T.Vector3(), d: new T.Vector3(), L: 0 });
    }
    for (let i = 0; i < 24; i++) { const m = new T.Mesh(fxs.casingGeo, fxs.brass); m.visible = false; scene.add(m); cas.push({ m, v: new T.Vector3(), life: 0, rot: new T.Vector3(), rest: false }); }
    for (let i = 0; i < 3; i++) { const s = new T.Sprite(fxs.flashMat.clone()); s.visible = false; s.renderOrder = 6; scene.add(s); fxs['fl' + i] = { s, t: 0 }; }
    fxs.flN = 0;
  }
  function flashAt(p, size, lightOn) {
    const f = fxs['fl' + (fxs.flN = (fxs.flN + 1) % 3)];
    f.s.position.copy(p); f.s.scale.setScalar(size); f.s.material.rotation = rnd() * TAU; f.s.material.opacity = 1; f.s.visible = true; f.t = 0.06;
    if (lightOn) { fxs.light.position.copy(p); fxs.light.intensity = 3.2; fxs.lightT = 0.05; }
  }
  let trN = 0, caN = 0;
  function tracer(o, e) {   // 총구 o 에서 e 까지 날아가는 탄 하나. 처음 보이는 프레임에서는 총구에 붙어 있다
    const t = trs[trN = (trN + 1) % trs.length], L = o.distanceTo(e);
    t.o.copy(o); t.d.copy(e).sub(o); if (t.d.lengthSq() < 1e-6) t.d.set(0, 0, -1); t.d.normalize(); t.L = L; t.age = 0; t.on = true; t.fresh = true;
    t.g.position.copy(o); t.g.quaternion.setFromUnitVectors(v2.set(0, 0, 1), t.d); t.g.visible = true; placeBullet(t);
  }
  function placeBullet(t) {
    const p = C.bulletPos(t.age, t.L);
    t.head.visible = !p.arrived; t.head.position.z = p.head - HEAD_LEN;
    t.trail.position.z = p.tail; t.trail.scale.z = Math.max(0.001, p.head - p.tail - 0.02);
    return p;
  }
  const fxq = [];   // 시간표: 탄이 닿는 순간에 맞는 효과를 보인다
  const later = (sec, fn) => { if (sec <= 0.001) fn(); else fxq.push({ at: now0() + sec, fn }); };
  function casing(p, vx, vy, vz, shell) {
    const c = cas[caN = (caN + 1) % cas.length];
    c.m.geometry = shell ? fxs.shellGeo : fxs.casingGeo; c.m.material = shell ? fxs.red : fxs.brass; c.m.scale.setScalar(shell ? 1.3 : 1.6);
    c.m.position.copy(p); c.v.set(vx, vy, vz); c.life = 1.6; c.rot.set(rnd() * 14 - 7, rnd() * 14 - 7, rnd() * 14 - 7); c.rest = false; c.m.visible = true;
  }
  function dropMag(inst) {   // 빠진 탄창이 떨어진다
    if (!inst.mag) return;
    const m = inst.mag.o.clone(true); inst.model.updateWorldMatrix(true, false);
    inst.mag.o.getWorldPosition(v1); inst.mag.o.getWorldQuaternion(q1); inst.mag.o.getWorldScale(v2);
    m.position.copy(v1); m.quaternion.copy(q1); m.scale.copy(v2); m.visible = true; scene.add(m);
    drops.push({ m, v: new T.Vector3((rnd() - 0.5) * 0.8, 0.4, (rnd() - 0.5) * 0.8), life: 1.8 });
  }
  function spawnSlash(o, yaw, c, mine, ownerRec) {
    const sc = COMBO[c].scale, rollZ = [-0.62, 1.5708, 0.18][c];   // 1타 비스듬히 · 2타 가로로 휘어 오른 호 · 3타 크고 곧게
    const g = new T.Group(), core = new T.Mesh(c === 2 ? fxs.crGeoBig : fxs.crGeo, fxs.crMat), glow = new T.Mesh(fxs.crGeo, fxs.crGlow);
    core.scale.setScalar(sc); glow.scale.setScalar(1.22 * sc); glow.position.x = -0.06;
    g.add(core, glow); g.rotation.set(0, 0, rollZ);
    const holder = new T.Group(); holder.add(g);
    // 판의 법선(Z)이 날아가는 방향을 향하고, 볼록한 쪽(+X)이 몸 앞쪽으로 오게 90° 돌려 세운다
    g.rotation.order = 'ZYX'; g.rotation.set(0, 0, rollZ);
    holder.position.copy(o); holder.rotation.y = yaw; scene.add(holder);
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    slashes.push({ holder, g, o: o.clone(), dx, dz, x: o.x, y: o.y, z: o.z, t: 0, c, sc, mine, rec: ownerRec, hit: new Set() });
    sfx('slash', mine ? 1 : lvlAt(o.x, o.y, o.z));
  }

  // ===================================================================== 광선 / 조준
  function worldRay(ox, oy, oz, dx, dy, dz, maxD) {   // 지면·소품에 닿는 거리(없으면 maxD+1)
    for (let t = 0.6; t <= maxD; t += 0.9) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (y < ctx.groundY(x, z, y + 0.3) - 0.02) return t;
      if (y - ctx.heightAt(x, z) < 2.2 && ctx.blocked(x, z, y - 0.2)) return t;   // props only stop a bullet near the ground: the solids list treats every tall thing (trees, posts) as an endless wall, so a shot at the boss's body must not die on a tree it passes over
    }
    return maxD + 1;
  }
  function muzzleWorld(rec, slot, out) {
    const wp = rec.wp, inst = wp && wp.inst[slot]; if (!inst || !inst.muzzle) return null;
    rec.av.root.updateMatrixWorld(true);
    return inst.muzzle.getWorldPosition(out);
  }
  const camPos = new T.Vector3(), camDir = new T.Vector3();
  function computeAim() {   // 화면 가운데 광선: 카메라 앞 cam.cur 부터(내 몸 뒤쪽은 건너뛴다)
    const cs = ctx.camState(); ctx.camera.getWorldPosition(camPos); ctx.camera.getWorldDirection(camDir);
    const p0 = camPos.clone().addScaledVector(camDir, cs.dist + 0.4), MAXD = 200;
    let tW = worldRay(p0.x, p0.y, p0.z, camDir.x, camDir.y, camDir.z, MAXD), kind = null, part = null, T0 = tW;
    const sp = ctx.spider();
    if (sp && sp.active) { const h = sp.hitRay(p0.x, p0.y, p0.z, camDir.x, camDir.y, camDir.z, Math.min(MAXD, tW), 0.1); if (h) { T0 = h.d; kind = h.kind; part = h.part; } }
    if (T0 > MAXD) T0 = 120;
    return { x: p0.x + camDir.x * T0, y: p0.y + camDir.y * T0, z: p0.z + camDir.z * T0, kind, part, dir: camDir.clone() };
  }

  // ===================================================================== 내 공격
  function canAct() { return ctx.canUse(); }
  function attackPress() {   // 슬롯에 맞는 한 번의 공격(검 휘두르기 · 한 발 사격). 맨손은 페이지가 punch 로 처리
    if (!canAct()) return false;
    const now = now0();
    if (my.slot === 2) return swordSwing(now);
    if (my.slot === 3 || my.slot === 4) return shoot(now);
    return false;
  }
  function trigger(down) {
    my.trig = !!down;
    if (down) { my.lastTrigAt = now0(); attackPress(); }
  }
  function reload() {
    if (!canAct() || (my.slot !== 3 && my.slot !== 4)) return false;
    const g = my.guns[my.slot], now = now0();
    if (!g || g.reload || g.mag >= WEAPONS[my.slot].mag) return false;
    if (g.reserve <= 0) { ctx.log('예비탄이 없습니다.'); return false; }
    if (!C.startReload(g, now)) return false;
    onReloadStart(ctx.me().rec, my.slot, g.reload.empty, true);
    ctx.net.send(C.wpnMsg.reload(my.slot, g.reload.empty));
    refreshHud(); return true;
  }
  function onReloadStart(rec, slot, empty, mine) {
    if (!rec) return;
    const wp = wpOf(rec), W_ = WEAPONS[slot], dur = slot === 3 ? (empty ? W_.reloadEmptyT : W_.reloadT) : W_.reloadT + W_.shellT * 3;
    wp.reload = { t0: now0(), dur, empty: !!empty, slot, ev: 0 };
    if (slot === 3) { sfx('magout', mine ? 1 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
  }

  function swordSwing(now) {
    const c = C.swordSwing(my.sword, now); if (c < 0) return false;
    const rec = ctx.me().rec, wp = wpOf(rec), m = ctx.me();
    startSwing(rec, c, true);
    const yaw = ctx.camState().yaw;
    ctx.net.send(C.wpnMsg.swing(c, [m.x, m.y, m.z], yaw));
    my.timeline.push({ at: now + COMBO[c].hit, fn: () => swordStrike(c, yaw) });
    return true;
  }
  function startSwing(rec, c, mine) {
    const wp = wpOf(rec); wp.swing = { c, t: 0, dur: COMBO[c].dur, hitDone: false };
    sfx('whoosh', mine ? 1 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z));
  }
  function swordStrike(c, yaw) {   // 접촉 프레임: 눈앞 근접 타격 + 검기 발사
    const m = ctx.me(); if (!m.rec) return;
    const sp = ctx.spider(), dx = -Math.sin(yaw), dz = -Math.cos(yaw), P = COMBO[c];
    const origin = new T.Vector3(m.x + dx * 0.6, m.y + 1.0, m.z + dz * 0.6);
    if (sp && sp.active) {
      const cx = m.x + dx * P.reach * 0.55, cz = m.z + dz * P.reach * 0.55;
      for (const h of sp.hitTest(cx, cz, 1.3 * P.reach / 2.6 + 0.6, m.y)) { reportHit(2, c, false, h.kind, h.id, 1); ctx.fx.spark(cx, m.y + 1.2, cz); sfx('slashHit', 0.8); }
    }
    spawnSlash(origin, yaw, c, true, m.rec);
  }
  function reportHit(w, c, sl, kind, id, n) {   // 내가 맞힌 것: 소유자면 바로, 아니면 소유자에게 알린다
    const sp = ctx.spider(); if (!sp) return;
    const d = C.dmgFor(w, sl ? 'sl' : 'm', c, n); if (!d) return;
    if (sp.owner) sp.damage(kind, id, d.amount, ctx.myId + '|' + d.key, d.cd);
    else ctx.net.send(C.wpnMsg.hit(w, c, sl, [kind === 'boss' ? 'b' : 'm', id], n));
  }

  function shoot(now) {
    const slot = my.slot, g = my.guns[slot], W_ = WEAPONS[slot];
    const st = C.fireState(g, now);
    if (st === 'cooldown' || st === 'reloading') return false;
    if (st === 'empty') {
      if (now - my.noAmmoAt > 0.35) { my.noAmmoAt = now; sfx('click', 1); if (g.reserve > 0) reload(); }
      return false;
    }
    if (!C.fireOnce(g, now)) return false;
    const m = ctx.me(), rec = m.rec, wp = wpOf(rec), inst = instOf(rec, slot);
    rec.av.root.updateMatrixWorld(true);
    const o = new T.Vector3(); if (!muzzleWorld(rec, slot, o)) o.set(m.x, m.y + 1.2, m.z);
    const aim = computeAim();
    let dir = v1.set(aim.x - o.x, aim.y - o.y, aim.z - o.z); const dist = dir.length();
    dir = dist < 2.5 ? aim.dir.clone() : dir.clone().normalize();
    const seed = (rnd() * 4294967295) >>> 0, rr = rngSeed(seed), sp = ctx.spider();
    let firstEnd = null, firstDir = null, firstHit = null, hitN = 0, firstLen = W_.range;
    const moving = ctx.me().speed > 0.5;
    for (let p = 0; p < W_.pellets; p++) {
      const sd = C.spreadDir(dir.x, dir.y, dir.z, W_.spread * (moving ? 1.5 : 1) * (p === 0 && slot === 3 ? 0.4 : 1), rr(), rr());
      const tW = worldRay(o.x, o.y, o.z, sd[0], sd[1], sd[2], W_.range);
      let hit = null;
      if (sp && sp.active) hit = sp.hitRay(o.x, o.y, o.z, sd[0], sd[1], sd[2], Math.min(W_.range, tW), 0.05);
      const L = hit ? hit.d : Math.min(tW, W_.range);
      const e = new T.Vector3(o.x + sd[0] * L, o.y + sd[1] * L, o.z + sd[2] * L);
      tracer(o, e); const ground = tW <= W_.range && !hit; later(C.impactDelay(L), () => impact(e, hit, ground));
      if (p === 0) { firstEnd = e; firstDir = sd; firstLen = L; }
      if (hit) { if (!firstHit) { firstHit = hit; hitN = 1; } else if (hit.kind === firstHit.kind && hit.id === firstHit.id) hitN++; }
    }
    // 소리·효과·반동
    sfx(slot === 3 ? 'rifle' : 'shotgun', 1);
    flashAt(o, slot === 3 ? 0.55 : 0.95, true);
    shotFx(rec, slot, true);
    wp.kick = Math.min(1.4, wp.kick + (slot === 3 ? 0.55 : 1.2)); wp.bolt = 1; wp.elevT = Math.asin(clamp(dir.y, -0.9, 0.9)); wp.elev = wp.elevT;
    kickAdd(slot === 3 ? 0.07 : 0.22);
    ctx.me().ctrl.setAim(ctx.camState().yaw); my.aimUntil = now + 2.2;
    // 네트워크 + 피해
    const h = firstHit ? [firstHit.kind === 'boss' ? 'b' : 'm', firstHit.id] : null;
    ctx.net.send(C.wpnMsg.fire(slot, [o.x, o.y, o.z], firstDir, firstLen, hitN, seed, h));
    my.stat.fired++; if (firstHit) { my.stat.hit++; reportHit(slot, 0, false, firstHit.kind, firstHit.id, hitN); }
    refreshHud();
    return true;
  }
  function rngSeed(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function impact(e, hit, ground) {
    if (hit) { ctx.fx.spark(e.x, e.y, e.z); if (hit.kind === 'boss') ctx.fx.spark(e.x, e.y + 0.2, e.z); }
    else if (ground) { if (ctx.waterY(e.x, e.z) > e.y - 0.1) ctx.fx.crown(e.x, ctx.waterY(e.x, e.z), e.z, 3); else ctx.fx.poof(e.x, e.y, e.z, 2); }
  }
  function shotFx(rec, slot, mine) {   // 탄피 배출 · 노리쇠 왕복 (내 것 · 남의 것 공통)
    const wp = wpOf(rec), inst = wp.inst[slot]; if (!inst) return;
    if (inst.eject) {
      rec.av.root.updateMatrixWorld(true); inst.eject.getWorldPosition(v1);
      const yaw = rec.av.root.rotation.y, rx = Math.cos(yaw), rz = -Math.sin(yaw);   // 사수 오른쪽
      if (slot === 3) casing(v1, rx * (1.6 + rnd()) + (rnd() - 0.5) * 0.6, 1.8 + rnd() * 0.8, rz * (1.6 + rnd()) + (rnd() - 0.5) * 0.6, false);
      else if (slot === 4) wp.shellPending = 0.34;   // 펌프를 당기는 순간 빈 탄이 튀어나온다
    }
  }

  // ===================================================================== 내 시간표 · 자동 연사 · 보급
  function frame(dt, now) {
    const t = now0();
    for (let i = my.timeline.length - 1; i >= 0; i--) if (t >= my.timeline[i].at) { const f = my.timeline[i].fn; my.timeline.splice(i, 1); try { f(); } catch (e) { console.warn('[bonfire] weapon timeline', e && e.message); } }
    const rec = ctx.me().rec;
    if (!ready || !rec) { updateFx(dt); return; }
    // 장전 진행 / 끝
    for (const s of [3, 4]) {
      const g = my.guns[s]; if (!g) continue;
      const done = C.tickReload(g, t);
      if (done) { if (s === my.slot) { refreshHud(); sfx(s === 3 ? 'magin' : 'pump', 0.8); } if (rec.wp) rec.wp.reload = null; }
    }
    // 자동 연사 (소총): 방아쇠를 쥔 채로
    if (my.trig && my.slot === 3 && canAct()) shoot(t);
    // 총이 올라가 있는 동안(쏜 뒤 2 s · 방아쇠를 쥔 동안)과 검을 휘두르는 동안 몸이 카메라를 향한다. 이동 속도는 휘두를 때 0.45, 총을 들면 0.85
    const gun = my.slot === 3 || my.slot === 4, swinging = my.slot === 2 && !!(rec.wp && rec.wp.swing);
    const aimOn = canAct() && ((gun && (my.trig || t < (my.aimUntil || 0))) || swinging);
    ctx.me().ctrl.setAim(aimOn ? ctx.camState().yaw : null);
    view.shoulder += ((gun && canAct() ? SHOULDER : 0) - view.shoulder) * (1 - Math.exp(-dt * 6));
    ctx.me().ctrl.setMoveScale(swinging ? 0.45 : gun && aimOn ? 0.8 : 1);
    // 예비탄은 무제한(탄창 단위로만 장전). 탄창이 비면 쏜 뒤 연사 간격이 지나는 대로 자동 장전한다
    if (gun && canAct() && C.needsAutoReload(my.guns[my.slot], t)) reload();
    if (!my.warm) { my.warm = true; for (const s of [2, 3, 4]) instOf(rec, s); }   // 세 무기를 미리 만들어 둔다: 처음 바꿀 때 끊기지 않게
    // 조준점 색 (화면 가운데에 보스·새끼 거미가 걸리는가): 6 프레임마다
    my.aimTick = (my.aimTick || 0) + 1;
    if (gun && my.aimTick % 6 === 0) { const a = computeAim(); view.aim = a.kind; ctx.hud.aim(a.kind); }
    else if (!gun && view.aim) { view.aim = null; ctx.hud.aim(null); }
    const g = my.guns[my.slot];
    view.reload01 = g && g.reload ? C.reloadT01(g, t) : 0;
    ctx.hud.reload(view.reload01, g ? WEAPONS[my.slot].name : '');
    view.kick = kickCam; view.combo = my.sword.step;
    updateFx(dt);
  }
  let kickCam = 0;

  // ===================================================================== 아바타 후처리: 자세·휘두르기·장전·반동 (내 것 · 남의 것 공통)
  function setEuler(bone, eu, w) {
    e1.set(eu[0] * DEG, eu[1] * DEG, eu[2] * DEG, 'XYZ'); q1.setFromEuler(e1);
    bone.quaternion.slerp(q1, w);
  }
  const KF = {   // 검 베기 키프레임: t(0..1), r(오른팔), l(왼팔), tor(몸통), 쥔 손목 roll
    0: [{ t: 0, r: [-150, 10, 60], l: [-30, 0, -50], tor: [-8, 34, 0] }, { t: 0.30, r: [-196, 8, 70], l: [-34, 0, -48], tor: [-12, 40, 0] }, { t: 0.46, r: [-66, -24, 86], l: [-40, 0, -56], tor: [22, -34, 0] }, { t: 0.62, r: [-62, -28, 90], l: [-36, 0, -54], tor: [24, -36, 0] }, { t: 1, r: [-60, -10, 54], l: [-18, 0, -58], tor: [0, 0, 0] }],
    1: [{ t: 0, r: [-96, 30, 78], l: [-22, 0, -54], tor: [0, -44, 0] }, { t: 0.30, r: [-96, 34, 78], l: [-24, 0, -54], tor: [2, -48, 0] }, { t: 0.46, r: [-92, -34, 84], l: [-30, 0, -56], tor: [8, 48, 0] }, { t: 0.62, r: [-90, -38, 86], l: [-30, 0, -56], tor: [8, 50, 0] }, { t: 1, r: [-60, -10, 54], l: [-18, 0, -58], tor: [0, 0, 0] }],
    2: [{ t: 0, r: [-110, 0, 70], l: [-60, 0, -60], tor: [-4, 0, 0] }, { t: 0.30, r: [-212, 0, 78], l: [-190, 0, -78], tor: [-28, 0, 0] }, { t: 0.46, r: [-84, 0, 80], l: [-80, 0, -80], tor: [38, 0, 0] }, { t: 0.66, r: [-76, 0, 80], l: [-72, 0, -76], tor: [40, 0, 0] }, { t: 1, r: [-60, -10, 54], l: [-18, 0, -58], tor: [0, 0, 0] }],
  };
  function sampleKF(kf, u) {
    let i = 0; while (i < kf.length - 2 && u > kf[i + 1].t) i++;
    const a = kf[i], b = kf[i + 1], k = smooth(clamp((u - a.t) / Math.max(1e-6, b.t - a.t), 0, 1));
    return { r: lerp3(a.r, b.r, k), l: lerp3(a.l, b.l, k), tor: lerp3(a.tor, b.tor, k) };
  }
  function afterUpdate(rec, dt, now) {
    const wp = rec.wp; if (!wp) return;
    const st = rec.ctrl.state, mine = rec === ctx.me().rec;
    const slot = wp.slot;
    // 착지('land') 때 총이 깜빡이지 않게 이어 가고, 앉기·엎드리기·감정·대시·구르기·수영은 총을 내린다
    const wantSoft = slot >= 2 && ready && st.swim !== 2 && !['dash', 'roll', 'leap', 'sit', 'prone', 'proneIn', 'proneOut', 'dance', 'cheer', 'nod', 'wave'].includes(st.act);
    const target = wantSoft ? 1 : 0;
    const stepW = dt / C.SWITCH_T; wp.w += clamp(target - wp.w, -stepW, stepW);   // 0.15 s 에 일정한 속도로 올라오고 내려간다
    wp.draw = Math.max(0, (wp.draw || 0) - stepW);
    // 모델 보이기
    for (const s of [2, 3, 4]) { const inst = wp.inst[s]; if (inst) inst.holder.visible = s === slot && wp.w > 0.04; }
    if (slot >= 2 && !wp.inst[slot] && ready) instOf(rec, slot);
    if (wp.w < 0.01) { wp.swing = null; return; }
    const inst = wp.inst[slot]; if (!inst) return;
    const bR = rec.av.model.getObjectByName('arm-right'), bL = rec.av.model.getObjectByName('arm-left'), bT = rec.av.model.getObjectByName('torso');
    if (!bR || !bL || !bT) return;
    const P = POSE[slot]; let r = P.r.slice(), l = P.l.slice(), tor = P.torso.slice();
    const t = now0();
    wp.kick = Math.max(0, wp.kick - dt * 7.5);
    if (slot === 2) {
      if (wp.swing) {
        wp.swing.t += dt; const u = wp.swing.t / wp.swing.dur;
        if (u >= 1) wp.swing = null;
        else { const k = sampleKF(KF[wp.swing.c], u); r = k.r; l = k.l; tor = k.tor; }
      } else {   // 대기: 가볍게 숨 쉬듯 칼끝이 흔들림 + 보석 반짝
        const b = Math.sin(t * 2.1) * 2; r[0] += b; l[0] += -b * 0.6;
      }
      if (inst.gem) inst.gem.scale.setScalar(1 + 0.25 * Math.sin(t * 5));
    } else {   // 총: 조준 방향으로 팔을 들고(고각/부각), 반동으로 위로 튄다
      wp.elev += (wp.elevT - wp.elev) * (1 - Math.exp(-dt * 8));
      if (!mine) wp.elevT *= Math.exp(-dt * 0.5);
      const e = clamp(wp.elev / DEG, -55, 55), kk = wp.kick * 6;
      r[0] -= e + kk; l[0] -= e + kk * 0.8; tor[0] += -e * 0.15;
      // 장전: 왼손이 탄창 쪽으로 내려갔다 올라옴 · 총이 살짝 기울어짐
      const rl = wp.reload;
      if (rl && rl.slot === slot) {
        const u = clamp((t - rl.t0) / rl.dur, 0, 1);
        if (slot === 3) {
          const p = C.rifleReloadPose(u, rl.empty), pouch = [-40, 14, -52], well = [-52, -10, -96];
          const away = p.mag > 0.02 ? 1 : 0;
          l = lerp3(l, p.magGone || u > 0.42 && u < 0.52 ? pouch : well, away ? smooth(clamp(p.mag * 1.4, 0, 1)) : 0);
          if (u > 0.4 && u < 0.52) l = lerp3(l, pouch, 1);
          r[0] += 12 * p.tilt; tor[2] += 6 * p.tilt; r[2] -= 8 * p.tilt;
          if (inst.mag) {
            inst.mag.o.position.set(inst.mag.p0.x, inst.mag.p0.y - 0.24 * p.mag, inst.mag.p0.z + 0.05 * p.mag);
            inst.mag.o.visible = !p.magGone && !(u > 0.28 && u < 0.5);
            if (!rl.dropped && u >= 0.28) { rl.dropped = true; dropMag(inst); }
          }
          if (inst.ch) inst.ch.o.position.set(inst.ch.p0.x, inst.ch.p0.y, inst.ch.p0.z + 0.075 * p.handle);
          if (inst.bolt) inst.bolt.o.position.set(inst.bolt.p0.x, inst.bolt.p0.y, inst.bolt.p0.z + 0.07 * p.handle);
          if (rl.ev < 1 && u >= 0.5) { rl.ev = 1; sfx('magin', mine ? 0.9 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
          if (rl.empty && rl.ev < 2 && u >= 0.8) { rl.ev = 2; sfx('slide', mine ? 0.9 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
        } else {   // 산탄총: 왼손이 펌프를 앞뒤로 · 탄을 한 발씩 밀어 넣음
          const ph = (t - rl.t0) / 0.42, bob = Math.sin(ph * Math.PI * 2) * 0.5 + 0.5;
          l = lerp3(l, [-62, 0, -96], 0.6 * bob); r[0] += 6 * bob;
          if (inst.pump) inst.pump.o.position.set(inst.pump.p0.x, inst.pump.p0.y, inst.pump.p0.z + 0.0);
          if (Math.floor(ph) > rl.ev) { rl.ev = Math.floor(ph); sfx('pump', mine ? 0.7 : 0.3); }
        }
      } else {
        if (inst.mag) { inst.mag.o.position.copy(inst.mag.p0); inst.mag.o.visible = true; }
        if (inst.ch) inst.ch.o.position.copy(inst.ch.p0);
        // 노리쇠: 쏠 때마다 뒤로 갔다 앞으로
        const b = wp.bolt; wp.bolt = Math.max(0, wp.bolt - dt * 14);
        if (inst.bolt) inst.bolt.o.position.set(inst.bolt.p0.x, inst.bolt.p0.y, inst.bolt.p0.z + 0.04 * b);
        if (inst.pump) inst.pump.o.position.set(inst.pump.p0.x, inst.pump.p0.y, inst.pump.p0.z + (slot === 4 ? (wp.pumpT > 0 ? Math.sin(clamp(1 - wp.pumpT / 0.5, 0, 1) * Math.PI) * 0.12 : 0) * 1 : 0));
      }
      if (wp.pumpT > 0) wp.pumpT -= dt;
      if (wp.shellPending > 0) { wp.shellPending -= dt; if (wp.shellPending <= 0) { wp.pumpT = 0.5; if (inst.eject) { rec.av.root.updateMatrixWorld(true); inst.eject.getWorldPosition(v1); const yaw = rec.av.root.rotation.y; casing(v1, Math.cos(yaw) * 2.2, 2.4, -Math.sin(yaw) * 2.2, true); sfx('pump', mine ? 0.8 : lvlAt(v1.x, v1.y, v1.z)); } } }
      // 총 모델이 반동으로 뒤로 밀림
      inst.holder.position.z = inst._z0 === undefined ? (inst._z0 = inst.holder.position.z) : inst._z0;
      inst.model.position.z = wp.kick * 0.045 / inst.sc * 0.5;
      if (inst.flashT > 0) inst.flashT -= dt;
    }
    if (wp.draw > 0) { const dr = smooth(clamp(wp.draw, 0, 1)); r[0] += 34 * dr; l[0] += 26 * dr; }   // 꺼내는 동작: 팔이 아래에서 올라온다(0.15 s)
    setEuler(bR, r, wp.w); setEuler(bL, l, wp.w); setEuler(bT, tor, wp.w);
  }

  // ===================================================================== 효과 갱신
  function updateFx(dt) {
    if (!fxs) return;
    for (const t of trs) {   // 날아가는 탄: 첫 프레임은 총구에 붙은 채로 보이고, 그 뒤부터 날아간다
      if (!t.on) continue;
      if (t.fresh) t.fresh = false; else t.age += dt;
      if (placeBullet(t).done) { t.on = false; t.g.visible = false; }
    }
    if (fxq.length) { const tn = now0(); for (let i = fxq.length - 1; i >= 0; i--) if (tn >= fxq[i].at) { const f = fxq[i].fn; fxq.splice(i, 1); try { f(); } catch (e) { console.warn('[bonfire] weapon fx', e && e.message); } } }
    for (const c of cas) {
      if (!c.m.visible) continue;
      c.life -= dt; if (c.life <= 0) { c.m.visible = false; continue; }
      if (!c.rest) {
        c.v.y -= 16 * dt; c.m.position.addScaledVector(c.v, dt); c.m.rotation.x += c.rot.x * dt; c.m.rotation.y += c.rot.y * dt; c.m.rotation.z += c.rot.z * dt;
        const g = ctx.groundY(c.m.position.x, c.m.position.z, c.m.position.y + 0.2) + 0.012;
        if (c.m.position.y <= g) { c.m.position.y = g; c.v.multiplyScalar(0.25); c.v.y = 0; c.rest = true; c.life = Math.min(c.life, 1.0); }
      }
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i]; d.life -= dt; if (d.life <= 0) { scene.remove(d.m); drops.splice(i, 1); continue; }
      d.v.y -= 14 * dt; d.m.position.addScaledVector(d.v, dt); d.m.rotation.x += 3 * dt;
      const g = ctx.groundY(d.m.position.x, d.m.position.z, d.m.position.y + 0.3) + 0.05; if (d.m.position.y < g) { d.m.position.y = g; d.v.set(0, 0, 0); }
    }
    for (let i = 0; i < 3; i++) { const f = fxs['fl' + i]; if (f.s.visible) { f.t -= dt; if (f.t <= 0) f.s.visible = false; else f.s.material.opacity = f.t / 0.06; } }
    if (fxs.lightT > 0) { fxs.lightT -= dt; if (fxs.lightT <= 0) fxs.light.intensity = 0; }
    kickCam = Math.max(0, kickCam - dt * 9);
    // 검기
    const sp = ctx.spider();
    for (let i = slashes.length - 1; i >= 0; i--) {
      const s = slashes[i]; s.t += dt;
      const step = SLASH.speed * dt, n = Math.max(1, Math.ceil(step / 0.6)), sub = step / n; let stop = false;
      for (let k = 0; k < n && !stop; k++) {
        s.x += s.dx * sub; s.z += s.dz * sub;
        s.y = Math.max(ctx.groundY(s.x, s.z, s.y + 0.3) + 0.9, s.o.y - 0.25);
        if (sp && sp.active) for (const h of sp.hitTest(s.x, s.z, SLASH.r * s.sc, s.y - 0.9)) {
          const key = h.kind + h.id; if (s.hit.has(key)) continue; s.hit.add(key);
          ctx.fx.spark(s.x, s.y, s.z); sfx('slashHit', s.mine ? 0.9 : lvlAt(s.x, s.y, s.z));
          if (s.mine) reportHit(2, s.c, true, h.kind, h.id, 1);
          if (h.kind === 'boss') stop = true;
        }
        if (s.t > SLASH.life || Math.hypot(s.x - s.o.x, s.z - s.o.z) > SLASH.range) stop = true;   // an energy crescent passes through props
      }
      s.holder.position.set(s.x, s.y, s.z);
      const grow = 1 + s.t * 0.45, fade = clamp((SLASH.life - s.t) / 0.25, 0, 1) * (stop ? 0 : 1);
      s.g.scale.setScalar(grow); fxs.crMat.opacity = 1; s.g.children.forEach((c) => c.scale.setScalar(c.scale.x));
      if (stop || s.t > SLASH.life) {
        scene.remove(s.holder); s.holder.traverse((o) => { if (o.isMesh) { /* 지오메트리·재질은 공유 */ } });
        if (stop) { ctx.fx.spark(s.x, s.y, s.z); }
        slashes.splice(i, 1);
      }
    }
  }
  function kickAdd(v) { kickCam = Math.min(1, kickCam + v); }

  // ===================================================================== 남의 무기 (네트워크)
  function setRemoteSlot(rec, slot) {
    const wp = wpOf(rec); if (wp.slot === slot) return;
    wp.slot = slot; wp.draw = slot >= 2 ? 1 : 0; if (slot >= 2) instOf(rec, slot);
    if (slot >= 2) sfx('equip', lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z));
  }
  function onNet(rec, senderId, d) {
    const m = C.sanitizeWpn(d); if (!m || !rec) return;
    const sp = ctx.spider(), s = rec.ctrl.state;
    if (m.k === 'f') {
      const wp = wpOf(rec); if (wp.slot !== m.w) setRemoteSlot(rec, m.w);
      const W_ = WEAPONS[m.w], sent = new T.Vector3(m.o[0], m.o[1], m.o[2]), o = sent.clone();
      const mz = new T.Vector3(); if (muzzleWorld(rec, m.w, mz) && mz.distanceTo(sent) < 2.2) o.copy(mz);
      // 탄은 이 화면에서 보이는 총구(mz)에서 출발한다. 보낸 쪽 총구(sent)에서 겨눈 끝점은 그대로 둔다
      const rr = rngSeed(m.seed), first = new T.Vector3(sent.x + m.d[0] * m.l, sent.y + m.d[1] * m.l, sent.z + m.d[2] * m.l);
      tracer(o, first); const hitM = m.h ? { kind: m.h.kind } : null, groundM = !m.h; later(C.impactDelay(o.distanceTo(first)), () => impact(first, hitM, groundM));
      for (let p = 1; p < W_.pellets; p++) {
        const sd = C.spreadDir(m.d[0], m.d[1], m.d[2], W_.spread, rr(), rr()), L = Math.min(W_.range, m.l * (0.7 + rr() * 0.5));
        tracer(o, new T.Vector3(sent.x + sd[0] * L, sent.y + sd[1] * L, sent.z + sd[2] * L));
      }
      const lv = lvlAt(o.x, o.y, o.z, 60);
      sfx(m.w === 3 ? 'rifle' : 'shotgun', lv);
      flashAt(o, m.w === 3 ? 0.55 : 0.95, lv > 0.1 && rnd() < 0.7);
      shotFx(rec, m.w, false); wp.kick = Math.min(1.4, wp.kick + (m.w === 3 ? 0.55 : 1.2)); wp.bolt = 1; wp.elevT = Math.asin(clamp(m.d[1], -0.9, 0.9)); wp.elev = wp.elevT;
      if (m.h) bookRemoteHit(senderId, s, m.w, 0, false, m.h, m.n || 1);
    } else if (m.k === 's') {
      const wp = wpOf(rec); if (wp.slot !== 2) setRemoteSlot(rec, 2);
      const yaw = m.a;
      setTimeout(() => {
        startSwing(rec, m.c, false);
        setTimeout(() => {
          if (!rec.av || !rec.av.root.parent) return;
          const p = rec.av.root.position;
          spawnSlash(new T.Vector3(p.x - Math.sin(yaw) * 0.6, p.y + 1.0, p.z - Math.cos(yaw) * 0.6), yaw, m.c, false, rec);
        }, COMBO[m.c].hit * 1000);
      }, 90);
    } else if (m.k === 'r') {
      const wp = wpOf(rec); if (wp.slot !== m.w) setRemoteSlot(rec, m.w);
      onReloadStart(rec, m.w, !!m.e, false);
    } else if (m.k === 'h') {
      bookRemoteHit(senderId, s, m.w, m.c, !!m.sl, m.h, m.n || 1);
    }
  }
  function bookRemoteHit(senderId, s, w, c, sl, h, n) {   // 보스를 돌리는 쪽(소유자)만 피해를 장부에 올린다. 값은 표에서 정하고, 거리를 확인한다
    const sp = ctx.spider(); if (!sp || !sp.owner || !sp.active) return;
    const v = sp.view; if (!C.reachOk(w, sl ? 'sl' : 'm', Math.hypot(s.x - v.x, s.z - v.z), sp.BOSS.hitReach)) return;
    const d = C.dmgFor(w, sl ? 'sl' : 'm', c, n); if (!d) return;
    sp.damage(h.kind, h.id, d.amount, senderId + '|' + d.key, d.cd);
  }

  function dispose() {
    fxq.length = 0;
    for (const s of slashes) scene.remove(s.holder); slashes.length = 0;
    for (const d of drops) scene.remove(d.m); drops.length = 0;
  }

  return {
    load, equip, cycle, trigger, reload, frame, afterUpdate, onNet, setRemoteSlot, dispose, attackPress,
    get slot() { return my.slot; }, get shoulder() { return view.shoulder; }, get view() { return view; }, get ready() { return ready; }, get kick() { return kickCam; }, get guns() { return my.guns; },
    get sword() { return my.sword; }, kickAdd, attachRec: (rec) => wpOf(rec), instOf,
    debug: { my, trs, cas, slashes, handCache, POSE, KF, computeAim, worldRay, spawnSlash, flashAt, tracer, get fxs() { return fxs; } },
  };
}
