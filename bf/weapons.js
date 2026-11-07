// bf/weapons.js — 무기 슬롯(1 맨손 · 2 검 · 3 M4A1 · 4 산탄총 · 5 권총 · 6 선물상자 수류탄 · 7 저격총 · 8 RPG): 모델 장착, 자세·휘두르기·장전 애니메이션, 총구 섬광·탄 궤적·탄피·검기, 내 전투 로직과 네트워크 반영.
// 로직(탄약·콤보·피해 표·광선 수학·메시지 검증)은 bf/weapons-core.js 에 있다(node 테스트). 모델은 tools/weapons/build_weapons.py (Blender) 로 만든다.
//
//   const W = createWeapons({ THREE, scene, camera, baseUrl, myId, addFill, fx, groundY, heightAt, blocked, waterY, me, camState, others, spider, net, log, audio, canUse, standUp, hud,
//                             players, hurtPlayer, pvpFeedback })   // players() = 맞힐 수 있는 다른 접속자 [{ id, x, y, z }](발 위치) · hurtPlayer(amount, info) = 내가 맞았을 때 · pvpFeedback(id) = 내가 접속자를 맞혔을 때
//   W.load() · W.equip(slot) · W.cycle(dir) · W.trigger(down) · W.alt(down)(우클릭: 총 조준 · 검 궁극기) · W.reload() · W.frame(dt, now) · W.afterUpdate(rec, dt, now) · W.onNet(rec, senderId, msg)
//   W.setRemoteSlot(rec, slot) · W.view  (HUD 값) · W.dispose()

import * as C from './weapons-core.js';
const { WEAPONS, COMBO, SLASH } = C;

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = C.clamp;
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// 월드에서 무기의 크기(m 배율)와 손에 쥐는 방식(모델 축 → 팔 뼈 축). 모델: 총구/칼끝 -Z, 위 +Y.
const SCALE = { 2: 1.2, 3: 1.3, 4: 1.15, 5: 1.45, 6: 1.9, 7: 1.25, 8: 1.0 };
const MODEL_FILE = { 2: 'sword.glb', 3: 'm4a1.glb', 4: 'shotgun.glb', 5: 'pistol.glb', 7: 'sniper.glb' };   // 6 선물상자 수류탄 · 8 RPG 는 코드로 만든다(buildGift · buildRpg)
const MODEL_SLOTS = [2, 3, 4, 5, 6, 7, 8];
const MAG_DROP = { 3: 0.24, 5: 0.11, 7: 0.12 };            // 장전 때 탄창이 빠지는 거리(모델 m)
const FLASH = { 3: 0.55, 4: 0.95, 5: 0.42, 7: 1.0, 8: 1.4 };       // 총구 섬광 크기(m)
const KICK = { 3: [0.55, 0.07], 4: [1.2, 0.22], 5: [0.6, 0.05], 7: [1.5, 0.3], 8: [1.6, 0.4] };   // [팔 반동, 화면 반동]
const SND = { 3: 'rifle', 4: 'shotgun', 5: 'pistol', 7: 'sniper', 8: 'rpg' };
const isGun = C.isGun;
// 자세(오일러 도, XYZ — 팔: X -90 = 앞, Z 90 = 아래로 늘어뜨림 기준, 위 바깥쪽은 Z 작게). controller/avatar 의 규약과 같다.
const POSE = {
  2: { r: [-60, -10, 54], l: [-18, 0, -58], torso: [0, 0, 0] },
  3: { r: [-90, 6, 84], l: [-84, -4, -78], torso: [0, -10, 0] },
  4: { r: [-90, 6, 86], l: [-86, -8, -72], torso: [0, -10, 0] },
  5: { r: [-90, 4, 86], l: [-88, -16, -74], torso: [0, -6, 0] },
  6: { r: [-62, -8, 66], l: [-18, 0, -58], torso: [0, 0, 0] },
  7: { r: [-90, 6, 84], l: [-84, -4, -78], torso: [0, -10, 0] },
  8: { r: [-96, 4, 80], l: [-92, -6, -76], torso: [0, -12, 0] },
};
// 쥐는 위치(모델의 grip 빈 노드 이름)와 손끝에서의 추가 이동(m, 무기 좌표)
const GRIP = { 2: { node: 'grip', off: [0, 0, 0] }, 3: { node: 'grip_r', off: [0, 0, 0] }, 4: { node: 'grip_r', off: [0, 0, 0] }, 5: { node: 'grip_r', off: [0, 0, 0] }, 6: { node: 'grip', off: [0, 0, 0] }, 7: { node: 'grip_r', off: [0, 0, 0] }, 8: { node: 'grip_r', off: [0, 0, 0] } };
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
      const slots = MODEL_SLOTS;
      const gl = await Promise.all(slots.map((s) => (MODEL_FILE[s] ? get(MODEL_FILE[s]) : Promise.resolve({ scene: s === 6 ? buildGift() : buildRpg() }))));
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

  // 선물상자 수류탄(크리스마스): 빨간 상자 + 금색 리본 십자 + 위 나비 매듭. 쥐는 곳 grip = 가운데. 모델 m(배율 SCALE[6])
  function buildGift() {
    const g = new T.Group(), S = 0.085;
    const box = new T.Mesh(new T.BoxGeometry(S, S * 0.9, S), new T.MeshStandardMaterial({ color: '#d42a35', roughness: 0.55 }));
    const gold = new T.MeshStandardMaterial({ color: '#ffd24a', roughness: 0.35, metalness: 0.2 });
    const r1 = new T.Mesh(new T.BoxGeometry(S * 1.02, S * 0.92, S * 0.2), gold), r2_ = new T.Mesh(new T.BoxGeometry(S * 0.2, S * 0.92, S * 1.02), gold);
    const bowGeo = new T.TorusGeometry(S * 0.2, S * 0.07, 6, 12);
    const b1 = new T.Mesh(bowGeo, gold), b2 = new T.Mesh(bowGeo, gold), knot = new T.Mesh(new T.SphereGeometry(S * 0.09, 8, 6), gold);
    b1.position.set(-S * 0.17, S * 0.58, 0); b1.rotation.set(0, Math.PI / 2, 0.5); b2.position.set(S * 0.17, S * 0.58, 0); b2.rotation.set(0, Math.PI / 2, -0.5); knot.position.y = S * 0.5;
    const grip = new T.Object3D(); grip.name = 'grip';
    g.add(box, r1, r2_, b1, b2, knot, grip); g.name = 'gift';
    return g;
  }
  // RPG-7 풍 발사기: 긴 원통(올리브) + 앞 탄두(원뿔·원통) + 뒤 나팔 + 손잡이 둘 + 조준기. 총구(-Z) 앞 · 위 +Y. 탄두 'warhead' 는 쏘면 사라지고 장전하면 다시 끼워진다
  function buildRpg() {
    const g = new T.Group();
    const olive = new T.MeshStandardMaterial({ color: '#4f5a34', roughness: 0.7 }), wood = new T.MeshStandardMaterial({ color: '#7a4a24', roughness: 0.8 });
    const dark = new T.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.6, metalness: 0.3 }), war = new T.MeshStandardMaterial({ color: '#6c7a3a', roughness: 0.6 });
    const cyl = (r0, r1, len, m) => new T.Mesh(new T.CylinderGeometry(r0, r1, len, 14).rotateX(Math.PI / 2), m);
    const tube = cyl(0.04, 0.04, 1.0, olive); tube.position.z = 0.05;
    const guard = cyl(0.05, 0.05, 0.3, wood); guard.position.z = -0.05;
    const flare = cyl(0.04, 0.075, 0.18, dark); flare.position.z = 0.62;
    const wh = new T.Group(); wh.name = 'warhead';
    const body = cyl(0.075, 0.075, 0.16, war); body.position.z = -0.6;
    const cone = new T.Mesh(new T.ConeGeometry(0.075, 0.2, 14).rotateX(-Math.PI / 2), war); cone.position.z = -0.78;
    const neck = cyl(0.03, 0.04, 0.12, dark); neck.position.z = -0.48;
    wh.add(body, cone, neck);
    const gripR = new T.Mesh(new T.BoxGeometry(0.035, 0.12, 0.05), dark); gripR.position.set(0, -0.09, 0.12); gripR.rotation.x = 0.25;
    const gripF = new T.Mesh(new T.BoxGeometry(0.03, 0.1, 0.04), dark); gripF.position.set(0, -0.08, -0.15);
    const sight = new T.Mesh(new T.BoxGeometry(0.03, 0.06, 0.08), dark); sight.position.set(0.045, 0.06, -0.1);
    const gr = new T.Object3D(); gr.name = 'grip_r'; gr.position.set(0, -0.11, 0.12);
    const mz = new T.Object3D(); mz.name = 'muzzle'; mz.position.set(0, 0, -0.5);
    g.add(tube, guard, flare, wh, gripR, gripF, sight, gr, mz); g.name = 'rpg';
    return g;
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
    return { slot, holder, model, warhead: model.getObjectByName('warhead'), mag: part('mag'), ch: part('charging_handle'), bolt: part('bolt'), pump: part('pump'), slide: part('slide'), gem: model.getObjectByName('gem'),
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
  const my = { slot: 1, recoil: 0, streak: 0, lastShotAt: -1e9, stepAcc: 0, guns: { 3: C.newGun(3), 4: C.newGun(4), 5: C.newGun(5), 7: C.newGun(7), 8: C.newGun(8) }, sword: C.newSword(), gren: { nextAt: 0 }, adsHeld: false, trig: false, noAmmoAt: 0, supply: 0, lastTrigAt: 0, aim: { kind: null, d: 0 }, timeline: [], stat: { fired: 0, hit: 0, sent: 0 } };
  const view = { slot: 1, ammo: '', mag: 0, reserve: 0, reload01: 0, kick: 0, aim: null, combo: -1, reloading: false, shoulder: 0, ads: 0, scope: 0, ult: 0, gren: 0 };
  const now0 = () => performance.now() / 1000;

  function equip(slot, quiet) {
    slot = clamp(Math.round(slot), 1, C.SLOT_COUNT);
    const rec = ctx.me().rec; if (!rec) return false;
    if (slot === my.slot) return true;
    my.slot = slot; my.trig = false;
    const wp = wpOf(rec); wp.slot = slot; wp.draw = slot >= 2 ? 1 : 0; if (slot >= 2) instOf(rec, slot);
    if (isGun(slot)) { const g = my.guns[slot]; if (g && g.reload) g.reload.t0 = now0(); }
    if (!isGun(slot)) my.adsHeld = false;
    if (slot !== 6) my.gAim = false;
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
    else if (kind === 'equip') { burst(0.05, 2400, 1600, 2.4, 0.24); tone(520, 380, 0.05, 0.12, 'triangle'); }
    else if (kind === 'slash') { burst(0.28, 900, 3800, 1.2, 0.3); tone(520, 1500, 0.2, 0.08); }
    else if (kind === 'slashHit') { tone(900, 300, 0.12, 0.3, 'triangle'); burst(0.08, 3500, 1500, 1.4, 0.3); }
    else if (kind === 'whoosh') { burst(0.18, 700, 2600, 1.4, 0.26); }
    else if (kind === 'pistol') { burst(0.12, 3600, 700, 0.7, 0.5, 'lowpass'); tone(210, 70, 0.09, 0.4); burst(0.04, 6000, 3500, 1.2, 0.2); }
    else if (kind === 'sniper') { burst(0.5, 2600, 200, 0.5, 0.95, 'lowpass'); tone(90, 26, 0.45, 0.9); burst(0.12, 5200, 1400, 0.8, 0.35); }
    else if (kind === 'bolt') { burst(0.07, 2400, 1400, 2.4, 0.3); tone(600, 380, 0.05, 0.12, 'square'); }
    else if (kind === 'throw') { burst(0.22, 500, 1800, 1.2, 0.22); }
    else if (kind === 'clink') { tone(1500, 1100, 0.06, 0.12, 'triangle'); }
    else if (kind === 'party') {   // 선물 폭발: 펑(종이 터짐) + 반짝 아르페지오 + 짤랑 + 바스락(색종이)
      const at = (dly, f0, f1, dur, gain, type = 'sine') => { const o = ac.createOscillator(), g = ac.createGain(), t0 = t + dly; o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain * level, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.connect(g); g.connect(a.dest); o.start(t0); o.stop(t0 + dur + 0.03); };
      burst(0.12, 5200, 900, 0.7, 0.9, 'lowpass'); tone(220, 70, 0.14, 0.55, 'triangle');
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => { at(0.06 + i * 0.07, f, f * 0.995, 0.32, 0.16, 'triangle'); at(0.06 + i * 0.07, f * 2, f * 2, 0.18, 0.05); });
      for (let i = 0; i < 6; i++) at(0.12 + rnd() * 0.5, 3000 + rnd() * 2500, 2600, 0.09, 0.05, 'sine');
      burst(0.7, 7000, 3500, 0.5, 0.12, 'highpass');
    }
    else if (kind === 'boom') { burst(0.9, 1400, 60, 0.4, 1.0, 'lowpass'); tone(70, 22, 0.8, 1.0); burst(0.25, 3000, 600, 0.6, 0.4); }
    else if (kind === 'ult') { burst(0.6, 600, 4200, 0.9, 0.35); tone(220, 880, 0.5, 0.18, 'sawtooth'); }
    else if (kind === 'rpg') { burst(0.55, 1800, 220, 0.5, 0.9, 'lowpass'); tone(160, 40, 0.4, 0.6, 'sawtooth'); burst(0.9, 900, 3000, 0.7, 0.35); }   // 쾅 + 로켓 쉬익
    else if (kind === 'rocket') { burst(0.35, 1200, 2600, 0.8, 0.22); }
    else if (kind === 'step') { burst(0.06, 420 + rnd() * 140, 160, 1.4, 0.28, 'lowpass'); tone(90, 60, 0.05, 0.12); }   // 모래 위 발소리
    else if (kind === 'stepWood') { tone(180 + rnd() * 40, 110, 0.06, 0.25, 'triangle'); burst(0.04, 900, 400, 2, 0.18); }
    else if (kind === 'shell') { tone(2400 + rnd() * 500, 1700, 0.05, 0.08, 'triangle'); tone(3300, 2600, 0.03, 0.05, 'triangle'); }   // 탄피가 땅에 떨어지는 소리
    else if (kind === 'hurt') { tone(240, 120, 0.16, 0.45, 'square'); burst(0.12, 1400, 500, 1.2, 0.4); }
    else if (kind === 'down') { tone(330, 70, 0.7, 0.5, 'sawtooth'); burst(0.4, 800, 150, 0.8, 0.4, 'lowpass'); }
    else if (kind === 'respawn') { tone(440, 880, 0.25, 0.25); tone(660, 1320, 0.3, 0.18, 'triangle'); }
    else if (kind === 'boing') {   // 「띠용」: 스프링처럼 튀어 올랐다 떨리며 내려오는 소리
      const o = ac.createOscillator(), g = ac.createGain(), l = ac.createOscillator(), lg = ac.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(820, t + 0.1); o.frequency.exponentialRampToValueAtTime(240, t + 0.55);
      l.frequency.value = 26; lg.gain.setValueAtTime(70, t + 0.05); lg.gain.exponentialRampToValueAtTime(4, t + 0.6); l.connect(lg); lg.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55 * level, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
      o.connect(g); g.connect(a.dest); o.start(t); l.start(t); o.stop(t + 0.66); l.stop(t + 0.66);
    }
    else if (kind === 'ghost') {   // 유령이 떠오르는 「우우우~」: 두 소리가 살짝 어긋난 채 미끄러지며 떨림(트레몰로), 숨소리가 섞임
      const t0 = t + 0.2, dur = 1.5;
      for (const [k, gn] of [[1, 0.26], [1.504, 0.16]]) {
        const o = ac.createOscillator(), g = ac.createGain(), l = ac.createOscillator(), lg = ac.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(300 * k, t0); o.frequency.exponentialRampToValueAtTime(520 * k, t0 + 0.5); o.frequency.exponentialRampToValueAtTime(260 * k, t0 + dur);
        l.frequency.value = 6.5; lg.gain.value = gn * 0.45 * level; l.connect(lg); lg.connect(g.gain);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gn * level, t0 + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(a.dest); o.start(t0); l.start(t0); o.stop(t0 + dur + 0.05); l.stop(t0 + dur + 0.05);
      }
      const src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g2 = ac.createGain();
      src.buffer = noise; src.loop = true; flt.type = 'bandpass'; flt.Q.value = 1.2; flt.frequency.setValueAtTime(900, t0); flt.frequency.exponentialRampToValueAtTime(2200, t0 + dur);
      g2.gain.setValueAtTime(0.0001, t0); g2.gain.exponentialRampToValueAtTime(0.07 * level, t0 + 0.4); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(flt); flt.connect(g2); g2.connect(a.dest); src.start(t0); src.stop(t0 + dur + 0.05);
    }
    else if (kind === 'hitmark') { tone(1700, 1250, 0.05, 0.26, 'triangle'); tone(880, 700, 0.07, 0.12, 'sine'); }
    else if (kind === 'ui') { tone(1200, 900, 0.04, 0.12, 'triangle'); }
    else if (kind === 'death') { burst(0.9, 300, 3200, 0.6, 0.6); tone(110, 55, 0.9, 0.7, 'sawtooth'); tone(880, 220, 0.6, 0.2); }
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
    // 수류탄 폭발: 불덩이(커지며 옅어짐) · 바닥 충격파 고리
    fxs.boomGeo = new T.SphereGeometry(1, 18, 12);
    fxs.boomMat = new T.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.95, depthWrite: false, blending: T.AdditiveBlending, fog: false });
    fxs.ringGeo = new T.RingGeometry(0.82, 1, 48);
    fxs.ringMat = new T.MeshBasicMaterial({ color: '#ffe0a0', transparent: true, opacity: 0.85, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false });
    // 선물 폭발(축하): 색종이·리본·포장지 조각(인스턴스 평면 하나) + 반짝이(점). 풀을 돌려 쓴다
    {
      const N = 420, geo = new T.PlaneGeometry(1, 1), mat = new T.MeshBasicMaterial({ side: T.DoubleSide, fog: false, transparent: true, opacity: 1, depthWrite: false });
      fxs.conf = new T.InstancedMesh(geo, mat, N); fxs.conf.frustumCulled = false; fxs.conf.count = N; fxs.conf.renderOrder = 6;
      fxs.confP = []; const hide = new T.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < N; i++) { fxs.conf.setMatrixAt(i, hide); fxs.conf.setColorAt(i, new T.Color('#ffffff')); fxs.confP.push({ life: 0, p: new T.Vector3(), v: new T.Vector3(), r: new T.Euler(), w: new T.Vector3(), sx: 0.1, sy: 0.1 }); }
      fxs.conf.instanceMatrix.setUsage(T.DynamicDrawUsage); scene.add(fxs.conf); fxs.confN = 0; fxs.confLive = 0;
      const SN = 200, sg = new T.BufferGeometry(); fxs.sparkPos = new Float32Array(SN * 3).fill(-999); fxs.sparkCol = new Float32Array(SN * 3);
      sg.setAttribute('position', new T.BufferAttribute(fxs.sparkPos, 3)); sg.setAttribute('color', new T.BufferAttribute(fxs.sparkCol, 3));
      fxs.spark = new T.Points(sg, new T.PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
      fxs.spark.frustumCulled = false; fxs.spark.renderOrder = 7; scene.add(fxs.spark);
      fxs.sparkP = Array.from({ length: SN }, () => ({ life: 0, p: new T.Vector3(), v: new T.Vector3(), c: new T.Color(), tw: 0 })); fxs.sparkN = 0; fxs.sparkLive = 0;
    }
    // 수류탄 궤적 미리보기(점선) + 착지 원
    const ag = new T.BufferGeometry(); fxs.arcPos = new T.Float32BufferAttribute(new Float32Array(96 * 3), 3); ag.setAttribute('position', fxs.arcPos);
    fxs.arc = new T.Line(ag, new T.LineDashedMaterial({ color: '#fff3c4', dashSize: 0.28, gapSize: 0.16, transparent: true, opacity: 0.9, depthTest: false, fog: false }));
    fxs.arc.frustumCulled = false; fxs.arc.renderOrder = 8; fxs.arc.visible = false; scene.add(fxs.arc);
    fxs.arcDots = new T.Points(ag, new T.PointsMaterial({ color: '#ffd27a', size: 0.2, transparent: true, opacity: 0.95, depthTest: false, fog: false }));   // 굵은 점: 밤 화면에서도 궤적이 보이게
    fxs.arcDots.frustumCulled = false; fxs.arcDots.renderOrder = 8; fxs.arcDots.visible = false; scene.add(fxs.arcDots);
    fxs.land = new T.Mesh(new T.RingGeometry(0.5, 0.7, 32).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ color: '#ff8a4a', transparent: true, opacity: 0.85, depthTest: false, side: T.DoubleSide, fog: false }));
    fxs.land.renderOrder = 8; fxs.land.visible = false; scene.add(fxs.land);
    // 궁극기 「死」 검기: 붉게 타오르는 글자 + 흰 심(캔버스 텍스처)
    fxs.deathTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '900 430px "Noto Serif KR", "Noto Serif CJK KR", "Songti SC", "Hiragino Mincho ProN", "MS Mincho", serif';
      g.shadowColor = 'rgba(255,40,40,1)'; g.shadowBlur = 48; g.fillStyle = 'rgba(255,60,50,0.95)'; g.fillText('死', 256, 270);
      g.shadowBlur = 18; g.shadowColor = 'rgba(255,200,180,1)'; g.fillStyle = 'rgba(255,240,235,1)'; g.font = g.font.replace('430px', '400px'); g.fillText('死', 256, 270);
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    })();
    fxs.deathMat = new T.MeshBasicMaterial({ map: fxs.deathTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false });
    fxs.deathGeo = new T.PlaneGeometry(1, 1);
  }
  function flashAt(p, size, lightOn, follow) {
    const f = fxs['fl' + (fxs.flN = (fxs.flN + 1) % 3)];
    f.s.position.copy(p); f.s.scale.setScalar(size); f.s.material.rotation = rnd() * TAU; f.s.material.opacity = 1; f.s.visible = true; f.t = 0.06; f.follow = follow || null;
    if (lightOn) { fxs.light.position.copy(p); fxs.light.intensity = 3.2; fxs.light.distance = 14; fxs.lightT = 0.05; }
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
  function spawnSlash(o, yaw, c, mine, ownerRec, mini, elev = 0) {
    const sc = COMBO[c].scale, rollZ = [-0.62, 1.5708, 0.18][c];   // 1타 비스듬히 · 2타 가로로 휘어 오른 호 · 3타 크고 곧게
    const g = new T.Group(), core = new T.Mesh(c === 2 ? fxs.crGeoBig : fxs.crGeo, fxs.crMat), glow = new T.Mesh(fxs.crGeo, fxs.crGlow);
    core.scale.setScalar(sc); glow.scale.setScalar(1.22 * sc); glow.position.x = -0.06;
    g.add(core, glow); g.rotation.set(0, 0, rollZ);
    const holder = new T.Group(); holder.add(g);
    // 판의 법선(Z)이 날아가는 방향을 향하고, 볼록한 쪽(+X)이 몸 앞쪽으로 오게 90° 돌려 세운다
    g.rotation.order = 'ZYX'; g.rotation.set(0, 0, rollZ);
    holder.position.copy(o); holder.rotation.order = 'YXZ'; holder.rotation.set(elev, yaw, 0); scene.add(holder);   // 위아래로 겨눈 만큼 판도 기운다
    const ce = Math.cos(elev), dx = -Math.sin(yaw) * ce, dz = -Math.cos(yaw) * ce, dy = Math.sin(elev);
    slashes.push({ holder, g, o: o.clone(), dx, dy, dz, x: o.x, y: o.y, z: o.z, t: 0, c, sc, mine, rec: ownerRec, hit: new Set(), mini: !!mini });
    if (mini) { holder.scale.setScalar(0.7); return; }
    my.stat.slashes = (my.stat.slashes || 0) + (mine ? 1 : 0);
    sfx('slash', mine ? 1 : lvlAt(o.x, o.y, o.z));
  }

  const deaths = [];
  function spawnDeath(o, yaw, mine, elev = 0) {   // 「死」 글자 거대 검기: 앞으로 쭉 날아가며 닿는 것마다 한 번씩
    const g = new T.Group(), S = C.ULT.size;
    const core = new T.Mesh(fxs.deathGeo, fxs.deathMat); core.scale.set(S, S, 1);
    const glow = new T.Mesh(fxs.deathGeo, fxs.deathMat); glow.scale.set(S * 1.25, S * 1.25, 1); glow.position.z = 0.3;
    const cr = new T.Mesh(fxs.crGeoBig, fxs.crMat); cr.scale.setScalar(S * 0.62); cr.rotation.z = Math.PI / 2; cr.position.z = -0.4;
    g.add(cr, glow, core); g.position.copy(o); g.rotation.order = 'YXZ'; g.rotation.set(elev, yaw, 0); scene.add(g);
    const ce = Math.cos(elev);
    deaths.push({ g, o: o.clone(), x: o.x, y: o.y, z: o.z, dx: -Math.sin(yaw) * ce, dy: Math.sin(elev), dz: -Math.cos(yaw) * ce, t: 0, mine, hit: new Set() });
    flashAt(o, 6, true); kickAdd(mine ? 0.6 : 0.2);
    sfx('death', mine ? 1 : lvlAt(o.x, o.y, o.z, 60));
    my.stat.deaths = (my.stat.deaths || 0) + 1;
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

  // ===================================================================== 접속자 맞히기(공격자 판정)
  // 내 화면에 보이는 다른 접속자의 몸(발 위치 → 세운 캡슐)에 닿았는가를 내가 정하고, 맞은 사람에게 알린다(맞은 사람 화면이 피해 표로 HP 를 깎는다).
  const pvpList = () => (ctx.players ? ctx.players() : []);
  function playerRay(o, d, maxD, skip) {   // 가장 가까운 접속자 몸에 닿는 거리 { id, d } | null (skip: 이 id 는 건너뜀)
    if (!(maxD > 0)) return null;
    let best = null;
    for (const p of pvpList()) {
      if (skip && p.id === skip) continue;
      const t = C.rayBody(o.x, o.y, o.z, d[0], d[1], d[2], p.x, p.y, p.z, maxD, 0.05);
      if (t >= 0 && (!best || t < best.d)) best = { id: p.id, d: t };
    }
    return best;
  }
  function playersNear(cx, cy, cz, r) {   // 한 점에서 몸 표면까지 r 안에 있는 접속자 [{ id, d }]
    const out = [];
    for (const p of pvpList()) { const d = C.distToBody(cx, cy, cz, p.x, p.y, p.z); if (d <= r) out.push({ id: p.id, d }); }
    return out;
  }
  function reportPlayer(id, w, c, sl, n, x) {   // 접속자를 맞혔다: 그 사람에게 피해 보고(값은 맞은 쪽 표가 정한다)
    ctx.net.send(C.wpnMsg.pvp(id, w, c, sl, n, x));
    my.stat.pvp = (my.stat.pvp || 0) + 1;
    sfx('hitmark', 0.8); if (ctx.pvpFeedback) ctx.pvpFeedback(id);
  }
  // 내가 맞았다: 보낸 사람 화면이 판정한 보고를 받아 내 화면이 피해를 정한다(보낸 값은 믿지 않고 표·거리·간격을 확인)
  const pvpSeen = new Map();   // 공격자|무기 → 마지막으로 받은 때(ms)
  function pvpHurt(rec, senderId, s, w, c, sl, n, x) {
    if (!ctx.hurtPlayer || !ctx.canBeHit || !ctx.canBeHit()) return;
    if (rec && rec.hpNet && rec.hpNet.dead) return;   // 쓰러진 사람의 공격은 받지 않는다
    const how = x || (sl ? 'sl' : 'm'), d = C.pvpDmgFor(w, how, c, n, x); if (!d) return;
    const me = ctx.me(); if (!C.pvpReachOk(w, how, Math.hypot(s.x - me.x, s.z - me.z))) return;
    const key = senderId + '|' + d.key, t = performance.now();
    if (t - (pvpSeen.get(key) || 0) < d.cd * 0.6) return;   // 같은 사람이 같은 무기로 너무 빨리 보내면 버린다(지연으로 몰려 온 것 감안)
    if (pvpSeen.size > 400) pvpSeen.clear();
    pvpSeen.set(key, t);
    ctx.hurtPlayer(d.amount, { id: senderId, rec, w, key: d.key, knock: C.PVP_KNOCK[d.key] || 0, from: [s.x, s.z] });
  }

  // ===================================================================== 내 공격
  function canAct() { return ctx.canUse(); }
  function attackPress() {   // 슬롯에 맞는 한 번의 공격(검 휘두르기 · 한 발 사격 · 수류탄 던지기). 맨손은 페이지가 punch 로 처리
    if (!canAct()) return false;
    const now = now0();
    if (my.slot === 2) return swordSwing(now);
    if (my.slot === 6) return throwGrenade(now);
    if (isGun(my.slot)) return shoot(now);
    return false;
  }
  function trigger(down) {
    my.trig = !!down;
    if (down) { my.lastTrigAt = now0(); attackPress(); }
  }
  // 우클릭(누르는 동안): 총은 조준 줌, 검은 궁극기, 수류탄은 던질 자세(포물선 표시)
  function alt(down) {
    if (!down) { my.adsHeld = false; my.gAim = false; return false; }
    if (!canAct()) return false;
    if (isGun(my.slot)) { my.adsHeld = true; return true; }
    if (my.slot === 6) { my.gAim = true; return true; }   // 수류탄: 누르는 동안 던지는 자세 + 포물선
    if (my.slot === 2) return ultimate(now0());
    return false;
  }
  function reload() {
    if (!canAct() || !isGun(my.slot)) return false;
    const g = my.guns[my.slot], now = now0();
    if (!g || g.reload || g.mag >= WEAPONS[my.slot].mag) return false;
    if (g.reserve <= 0) { ctx.log('예비탄이 없습니다.'); return false; }
    if (!C.startReload(g, now)) return false;
    onReloadStart(ctx.me().rec, my.slot, g.reload.empty, true);
    ctx.net.send(C.wpnMsg.reload(my.slot, g.reload.empty));
    refreshHud(); return true;
  }
  function showWarhead(rec) { const inst = rec && rec.wp && rec.wp.inst[8]; if (inst && inst.warhead) inst.warhead.visible = true; }
  function onReloadStart(rec, slot, empty, mine) {
    if (!rec) return;
    const wp = wpOf(rec), W_ = WEAPONS[slot], dur = slot === 4 ? W_.reloadT + W_.shellT * 3 : (empty ? W_.reloadEmptyT : W_.reloadT);
    wp.reload = { t0: now0(), dur, empty: !!empty, slot, ev: 0 };
    if (slot !== 4) { sfx('magout', mine ? 1 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
    if (slot === 8 && !mine) setTimeout(() => showWarhead(rec), dur * 1000);
  }

  // ---- 검: 클릭 한 번 = 베기 한 번 = 검기 한 발(빠른 클릭 = 빠른 검기)
  function swordSwing(now) {
    const c = C.swordSwing(my.sword, now); if (c < 0) return false;
    const rec = ctx.me().rec, m = ctx.me();
    startSwing(rec, c, true);
    const yaw = ctx.camState().yaw, elev = aimElev(m.y + 1.0);
    ctx.net.send(C.wpnMsg.swing(c, [m.x, m.y, m.z], yaw, elev));
    my.timeline.push({ at: now + C.SWORD_LAUNCH, fn: () => swordStrike(c, yaw, elev) });
    return true;
  }
  function startSwing(rec, c, mine) {   // 앞 동작은 끊고 새 동작을 시작한다(휘두르는 구간부터: 클릭에 바로 반응)
    const wp = wpOf(rec); wp.swing = { c, t: 0, dur: COMBO[c].dur * 0.7, hitDone: false, u0: 0.3 };
    sfx('whoosh', mine ? 1 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z));
  }
  // 화면 가운데 조준점을 향한 상하 각도(라디안, 위 +): 높이 fromY 에서 조준점까지. 검기·근접·궁극기가 카메라 상하를 따라간다
  function aimElev(fromY) {
    const a = computeAim(), m = ctx.me(), h = Math.hypot(a.x - m.x, a.z - m.z);
    const e = h > 1.5 ? Math.atan2(a.y - fromY, h) : Math.asin(clamp(a.dir.y, -1, 1));
    return clamp(e, -1.2, 1.25);
  }
  function swordStrike(c, yaw, elev = 0) {   // 접촉 프레임: 눈앞 근접 타격 + 검기 발사(겨눈 상하 각도 그대로)
    const m = ctx.me(); if (!m.rec) return;
    const sp = ctx.spider(), ce = Math.cos(elev), dx = -Math.sin(yaw), dz = -Math.cos(yaw), P = COMBO[c];
    const origin = new T.Vector3(m.x + dx * 0.6 * ce, m.y + 1.0 + Math.sin(elev) * 0.6, m.z + dz * 0.6 * ce);
    if (sp && sp.active) {
      const rr = P.reach * 0.55, cx = m.x + dx * rr * ce, cz = m.z + dz * rr * ce, cy = m.y + Math.sin(elev) * rr;
      for (const h of sp.hitTest(cx, cz, 1.3 * P.reach / 2.6 + 0.6, cy)) { reportHit(2, c, false, h.kind, h.id, 1); ctx.fx.spark(cx, cy + 1.2, cz); sfx('slashHit', 0.8); }
    }
    {   // 접속자: 눈앞 베기 구역(칼날 중심 ~ 몸 표면)
      const rr = P.reach * 0.55, px = m.x + dx * rr * ce, py = m.y + 1.0 + Math.sin(elev) * rr, pz = m.z + dz * rr * ce;
      for (const q of playersNear(px, py, pz, P.reach / 2.6 + 0.55)) { reportPlayer(q.id, 2, c, false, 1); ctx.fx.spark(px, py, pz); sfx('slashHit', 0.8); }
    }
    spawnSlash(origin, yaw, c, true, m.rec, false, elev);
  }
  // ---- 검 궁극기: 아주 빠른 난무(주변 연속 타격) → 「死」 거대 검기
  function ultimate(now) {
    if (!C.ultStart(my.sword, now)) { if (C.ultLeft(my.sword, now) > 0) ctx.log(`궁극기 대기 ${Math.ceil(C.ultLeft(my.sword, now))}초`); return false; }
    const m = ctx.me(), rec = m.rec, yaw = ctx.camState().yaw, elev = aimElev(m.y + 1.6);
    startUlt(rec, yaw, true);
    ctx.net.send(C.wpnMsg.ult([m.x, m.y, m.z], yaw, elev));
    const sp = ctx.spider();
    for (let i = 0; i < C.ULT.rushHits; i++) my.timeline.push({ at: now + C.ultHitT(i), fn: () => {
      const mm = ctx.me(); if (!mm.rec) return;
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw), cx = mm.x + dx * 1.6, cz = mm.z + dz * 1.6;
      if (sp && sp.active) for (const h of sp.hitTest(cx, cz, C.ULT.rushReach, mm.y)) { reportHit(2, 0, false, h.kind, h.id, 1, 'r'); ctx.fx.spark(cx + (rnd() - 0.5) * 2, mm.y + 0.8 + rnd() * 1.4, cz + (rnd() - 0.5) * 2); }
      for (const q of playersNear(cx, mm.y + 1.0, cz, C.ULT.rushReach * 0.7)) { reportPlayer(q.id, 2, 0, false, 1, 'r'); ctx.fx.spark(cx + (rnd() - 0.5) * 2, mm.y + 0.8 + rnd() * 1.4, cz + (rnd() - 0.5) * 2); }
    } });
    my.timeline.push({ at: now + C.ULT.rushT, fn: () => { const mm = ctx.me(); if (mm.rec) spawnDeath(new T.Vector3(mm.x - Math.sin(yaw) * 1.2, mm.y + 1.6, mm.z - Math.cos(yaw) * 1.2), yaw, true, elev); } });
    return true;
  }
  function startUlt(rec, yaw, mine) {
    const wp = wpOf(rec); wp.ult = { t: 0, yaw, n: -1 }; wp.swing = null;
    sfx('ult', mine ? 1 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z, 50));
  }
  function reportHit(w, c, sl, kind, id, n, x) {   // 내가 맞힌 것: 소유자면 바로, 아니면 소유자에게 알린다
    const sp = ctx.spider(); if (!sp) return;
    const d = x ? C.ultDmg(x) : C.dmgFor(w, sl ? 'sl' : 'm', c, n); if (!d || !(d.amount > 0)) return;
    if (sp.owner) sp.damage(kind, id, d.amount, ctx.myId + '|' + d.key, d.cd);
    else ctx.net.send(C.wpnMsg.hit(w, c, sl, [kind === 'boss' ? 'b' : 'm', id], n, x));
  }

  // ---- 총: 피해 계산은 지금 하고, 눈에 보이는 탄·섬광은 이번 프레임의 자세(팔·총)가 확정된 뒤 실제 총구에서 낸다(queueShot → flushShots)
  function shoot(now) {
    const slot = my.slot, g = my.guns[slot], W_ = WEAPONS[slot];
    const st = C.fireState(g, now);
    if (st === 'cooldown' || st === 'reloading') return false;
    if (st === 'empty') {
      if (now - my.noAmmoAt > 0.35) { my.noAmmoAt = now; sfx('click', 1); if (g.reserve > 0) reload(); }
      return false;
    }
    const m = ctx.me(), rec = m.rec, wp = wpOf(rec), inst = instOf(rec, slot);
    if (!inst) return false;
    if (lowered(rec)) return false;   // 구르기·대시 중에는 총이 내려가 있다: 허공에서 탄이 나가지 않게 쏘지 않는다
    if (!C.fireOnce(g, now)) return false;
    wp.w = 1; wp.draw = 0;            // 바꾸자마자 쏘면 총을 바로 든 자세로(총구가 실제 위치에 있게)
    const aim = computeAim();
    const o = new T.Vector3(); if (!muzzleWorld(rec, slot, o)) o.set(m.x, m.y + 1.3, m.z);
    let dir = v1.set(aim.x - o.x, aim.y - o.y, aim.z - o.z); const dist = dir.length();
    dir = dist < 2.5 ? aim.dir.clone() : dir.clone().normalize();
    const seed = (rnd() * 4294967295) >>> 0, rr = rngSeed(seed), sp = ctx.spider();
    let firstDir = null, firstHit = null, hitN = 0, firstLen = W_.range;
    const pv = new Map();   // 이번 발사가 맞힌 접속자 id → 맞은 알갱이 수
    const moving = ctx.me().speed > 0.5, ends = [];
    recoilShot(slot, now);
    if (W_.rocket) {   // RPG: 눈에 보이는 로켓이 날아가 닿는 곳에서 폭발(피해는 폭발이 계산)
      const rd = C.spreadDir(dir.x, dir.y, dir.z, C.spreadFor(slot, view.ads, moving), rr(), rr());
      spawnRocket([o.x, o.y, o.z], rd, true, rec);
      ctx.net.send(C.wpnMsg.rocket([o.x, o.y, o.z], rd));
      sfx('rpg', 1); flashAt(o, FLASH[8], true, { rec, slot });
      wp.kick = Math.min(1.6, wp.kick + KICK[8][0]); wp.elevT = Math.asin(clamp(dir.y, -0.9, 0.9)); wp.elev = wp.elevT;
      kickAdd(KICK[8][1]); ctx.me().ctrl.setAim(ctx.camState().yaw); my.aimUntil = now + 2.2;
      my.stat.fired++; refreshHud(); return true;
    }
    const pd = slot === 4 ? C.pelletDirs([dir.x, dir.y, dir.z], C.spreadFor(slot, view.ads, moving), W_.pellets, rr) : null;   // 산탄: seed 로 정해지는 퍼짐 무늬
    for (let p = 0; p < W_.pellets; p++) {
      const sd = pd ? pd[p] : C.spreadDir(dir.x, dir.y, dir.z, C.spreadFor(slot, view.ads, moving) * (p === 0 && slot === 3 ? 0.4 : 1), rr(), rr());
      const tW = worldRay(o.x, o.y, o.z, sd[0], sd[1], sd[2], W_.range);
      let hit = null, ph = null;
      if (sp && sp.active) hit = sp.hitRay(o.x, o.y, o.z, sd[0], sd[1], sd[2], Math.min(W_.range, tW), 0.05);
      ph = playerRay(o, sd, Math.min(W_.range, tW, hit ? hit.d : 1e9));   // 거미보다 가까운 접속자가 있으면 그 사람이 맞는다
      if (ph) hit = null;
      const L = ph ? ph.d : hit ? hit.d : Math.min(tW, W_.range);
      const e = new T.Vector3(o.x + sd[0] * L, o.y + sd[1] * L, o.z + sd[2] * L);
      ends.push({ e, hit: hit || (ph ? { kind: 'player' } : null), ground: tW <= W_.range && !hit && !ph });
      if (ph) pv.set(ph.id, (pv.get(ph.id) || 0) + 1);
      if (p === 0) { firstDir = sd; firstLen = L; }
      if (hit) { if (!firstHit) { firstHit = hit; hitN = 1; } else if (hit.kind === firstHit.kind && hit.id === firstHit.id) hitN++; }
    }
    queueShot(rec, slot, ends, o, true);
    sfx(SND[slot], 1);
    shotFx(rec, slot, true);
    wp.kick = Math.min(1.6, wp.kick + KICK[slot][0] * (1 - 0.4 * view.ads)); wp.bolt = 1; wp.elevT = Math.asin(clamp(dir.y, -0.9, 0.9)); wp.elev = wp.elevT;
    if (slot === 7) wp.boltCyc = 0;
    kickAdd(KICK[slot][1] * (1 - 0.5 * view.ads));
    ctx.me().ctrl.setAim(ctx.camState().yaw); my.aimUntil = now + 2.2;
    const h = firstHit ? [firstHit.kind === 'boss' ? 'b' : 'm', firstHit.id] : null;
    const pvl = [...pv].slice(0, 3);
    ctx.net.send(C.wpnMsg.fire(slot, [o.x, o.y, o.z], firstDir, firstLen, hitN, seed, h, view.ads, pvl));
    my.stat.fired++; if (firstHit) { my.stat.hit++; reportHit(slot, 0, false, firstHit.kind, firstHit.id, hitN); }
    if (pvl.length) { my.stat.pvp = (my.stat.pvp || 0) + pvl.length; sfx('hitmark', 0.8); if (ctx.pvpFeedback) for (const [id] of pvl) ctx.pvpFeedback(id); }
    refreshHud();
    return true;
  }
  const LOWER = ['dash', 'roll', 'leap', 'dance', 'cheer', 'nod', 'wave'];
  const lowered = (rec) => { const st = rec.ctrl.state; return st.swim === 2 || LOWER.includes(st.act); };
  function queueShot(rec, slot, ends, sent, mine) { const wp = wpOf(rec); (wp.pend || (wp.pend = [])).push({ slot, ends, sent: sent.clone(), mine }); }
  const shotLog = [];   // 검증용: 최근 발사의 (탄 시작점 ↔ 그 프레임 총구) 거리
  function flushShots(rec) {   // afterUpdate 가 자세를 다 잡은 뒤: 지금 총구 위치에서 탄·섬광을 낸다
    const wp = rec.wp; if (!wp || !wp.pend || !wp.pend.length) return;
    rec.av.root.updateMatrixWorld(true);
    for (const s of wp.pend) {
      const o = new T.Vector3(); if (!muzzleWorld(rec, s.slot, o) || o.distanceTo(s.sent) > 3) o.copy(s.sent);
      for (const it of s.ends) { tracer(o, it.e); later(C.impactDelay(o.distanceTo(it.e)), () => impact(it.e, it.hit, it.ground)); }
      const lv = s.mine ? 1 : lvlAt(o.x, o.y, o.z, 60);
      flashAt(o, FLASH[s.slot], s.mine || (lv > 0.1 && rnd() < 0.7), { rec, slot: s.slot });
      shotLog.push({ mine: s.mine, slot: s.slot, o: o.toArray(), t: now0() }); if (shotLog.length > 30) shotLog.shift();
    }
    wp.pend.length = 0;
  }
  function followFlash(rec) {   // 섬광이 보이는 동안 총구를 따라간다(달리면서 쏴도 총구에 붙어 있다)
    if (!fxs) return;
    for (let i = 0; i < 3; i++) {
      const f = fxs['fl' + i]; if (!f.s.visible || !f.follow || f.follow.rec !== rec) continue;
      if (muzzleWorld(rec, f.follow.slot, v2)) { f.s.position.copy(v2); if (fxs.lightT > 0) fxs.light.position.copy(v2); }
    }
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
      if (slot === 3 || slot === 5) casing(v1, rx * (1.6 + rnd()) + (rnd() - 0.5) * 0.6, 1.8 + rnd() * 0.8, rz * (1.6 + rnd()) + (rnd() - 0.5) * 0.6, false);
      else if (slot === 4) wp.shellPending = 0.34;   // 펌프를 당기는 순간 빈 탄이 튀어나온다
    }
  }

  // ---- 반동: 쏠 때마다 시선이 위로(좌우 살짝) 튀고 연사하면 누적, 멈추면 원래 시선으로 돌아온다
  function recoilShot(slot, now) {
    my.streak = now - my.lastShotAt < WEAPONS[slot].interval * 1.9 + 0.05 ? my.streak + 1 : 0; my.lastShotAt = now;
    const [up, side] = C.recoilKick(slot, my.streak, view.ads, rnd() * 2 - 1);
    my.recoil += up; if (ctx.kickView) ctx.kickView(-up, side);
    view.recoil = my.recoil;
  }
  function recoilFrame(dt, now) {
    if (!(my.recoil > 0)) return;
    const firing = my.trig && now - my.lastShotAt < 0.25, back = C.recoilRecover(my.recoil, dt, firing);
    my.recoil -= back; if (ctx.kickView) ctx.kickView(back, 0); view.recoil = my.recoil;
  }
  // ---- RPG 로켓
  const rockets = [];
  function spawnRocket(o, d, mine, rec) {
    if (!tpl) return;
    const wh = tpl[8].getObjectByName('warhead').clone(true), g = new T.Group(); wh.position.z += 0.62; g.add(wh);
    const fl = new T.Mesh(fxs.glowGeo, fxs.glowMat); fl.position.z = 0.25; fl.scale.set(0.9, 0.9, 2.4); g.add(fl);
    g.position.fromArray(o); g.quaternion.setFromUnitVectors(v2.set(0, 0, -1), v1.fromArray(d)); scene.add(g);
    rockets.push({ g, p: o.slice(), v: d.map((q) => q * C.ROCKET.speed), t: 0, mine, smoke: 0, owner: rec && rec.rid });
    if (rec && rec.wp) { const inst = rec.wp.inst[8]; if (inst && inst.warhead) inst.warhead.visible = false; }
    sfx('rocket', mine ? 0.8 : lvlAt(o[0], o[1], o[2], 50));
  }
  function rocketFrame(dt) {
    const sp = ctx.spider();
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i]; r.t += dt;
      const sub = Math.max(1, Math.ceil(dt * C.ROCKET.speed / 0.8)), h = dt / sub; let at = null;
      for (let k = 0; k < sub && !at; k++) {
        const px = r.p[0], py = r.p[1], pz = r.p[2];
        C.rocketStep(r.p, r.v, h);
        const sl = Math.hypot(r.p[0] - px, r.p[1] - py, r.p[2] - pz) || 1e-6;
        if (sp && sp.active && r.t > 0.03) { const hh = sp.hitRay(px, py, pz, (r.p[0] - px) / sl, (r.p[1] - py) / sl, (r.p[2] - pz) / sl, sl, 0.15); if (hh) { at = [px + (r.p[0] - px) / sl * hh.d, py + (r.p[1] - py) / sl * hh.d, pz + (r.p[2] - pz) / sl * hh.d]; break; } }
        if (r.t > 0.03) {   // 접속자 몸에 닿아도 터진다(쏜 사람 자신은 처음 0.3 s 건너뜀: 총구가 몸 안쪽에서 시작)
          const pr = playerRay({ x: px, y: py, z: pz }, [(r.p[0] - px) / sl, (r.p[1] - py) / sl, (r.p[2] - pz) / sl], sl, r.t < 0.3 ? r.owner : null);
          if (pr) { at = [px + (r.p[0] - px) / sl * pr.d, py + (r.p[1] - py) / sl * pr.d, pz + (r.p[2] - pz) / sl * pr.d]; break; }
        }
        if (r.p[1] < ctx.groundY(r.p[0], r.p[2], r.p[1] + 0.3) || (r.t > 0.08 && r.p[1] - ctx.heightAt(r.p[0], r.p[2]) < 2 && ctx.blocked(r.p[0], r.p[2], r.p[1] - 0.2))) at = r.p.slice();
      }
      if (!at && r.t > C.ROCKET.life) at = r.p.slice();
      r.g.position.fromArray(r.p); r.g.quaternion.setFromUnitVectors(v2.set(0, 0, -1), v1.fromArray(r.v).normalize());
      r.smoke -= dt; if (r.smoke <= 0) { r.smoke = 0.035; ctx.fx.poof(r.p[0], r.p[1], r.p[2], 1); }
      if (at) { scene.remove(r.g); rockets.splice(i, 1); explode(at, r.mine, 8); }
    }
  }

  // ---- 수류탄: 클릭 = 던지기(쿨 1.1 s). 손에서 떠난 뒤 포물선 · 튕김 · 2.2 s 뒤 폭발
  function throwGrenade(now) {
    if (now < my.gren.nextAt) return false;
    const m = ctx.me(), rec = m.rec, wp = wpOf(rec); if (lowered(rec)) return false;
    my.gren.nextAt = now + C.GREN.cd;
    wp.throwT = 0; sfx('throw', 1);
    const cs = ctx.camState();
    my.timeline.push({ at: now + 0.16, fn: () => {
      const mm = ctx.me(); if (!mm.rec) return;
      const o = handWorld(mm.rec, v1).toArray(), v = C.throwVel(cs.yaw, cs.pitch);
      spawnGrenade(o, v, true);
      ctx.net.send(C.wpnMsg.grenade(o, v));
    } });
    ctx.me().ctrl.setAim(cs.yaw); my.aimUntil = now + 0.8;
    return true;
  }
  function handWorld(rec, out) {   // 오른손(수류탄을 쥔 곳) 월드 위치
    const inst = rec.wp && rec.wp.inst[6];
    if (inst && inst.holder.visible) { rec.av.root.updateMatrixWorld(true); return inst.model.getWorldPosition(out); }
    const p = rec.av.root.position; return out.set(p.x, p.y + 1.5, p.z);
  }
  const nades = [], booms = [];
  function spawnGrenade(o, v, mine) {
    if (!tpl) return;
    const mesh = tpl[6].clone(true); mesh.scale.setScalar(SCALE[6]); mesh.position.fromArray(o); scene.add(mesh);
    nades.push({ mesh, p: o.slice(), v: v.slice(), t: 0, mine, spin: new T.Vector3(rnd() * 12 - 6, rnd() * 12 - 6, rnd() * 12 - 6) });
  }
  function explode(p, mine, w = 6) {
    const [x, y, z] = p, RAD = w === 8 ? C.ROCKET.r : C.GREN.r;
    const b = { t: 0, x, y, z, R: RAD, party: w === 6 };
    b.ball = new T.Mesh(fxs.boomGeo, fxs.boomMat.clone()); b.ball.position.set(x, y + 0.3, z); scene.add(b.ball);
    b.ring = new T.Mesh(fxs.ringGeo, fxs.ringMat.clone()); b.ring.rotation.x = -Math.PI / 2; b.ring.position.set(x, ctx.groundY(x, z, y + 0.5) + 0.08, z); scene.add(b.ring);
    if (b.party) { b.ball.material.color.set('#fff2c0'); b.ring.material.color.set('#ff8ad8'); confetti(x, y + 0.4, z); }
    b.flash = new T.Sprite(fxs.flashMat.clone()); b.flash.position.set(x, y + 0.6, z); b.flash.scale.setScalar(7); b.flash.renderOrder = 7; scene.add(b.flash);
    booms.push(b);
    fxs.light.position.set(x, y + 1, z); fxs.light.intensity = 30; fxs.light.distance = 30; fxs.lightT = 0.22;
    if (!b.party) {
      for (let i = 0; i < 4; i++) ctx.fx.poof(x + (rnd() - 0.5) * 2, y + 0.2, z + (rnd() - 0.5) * 2, 6);
      for (let i = 0; i < 6; i++) ctx.fx.spark(x + (rnd() - 0.5) * 2.4, y + 0.3 + rnd() * 1.6, z + (rnd() - 0.5) * 2.4);
    }
    if (ctx.waterY(x, z) > y - 0.3) ctx.fx.crown(x, ctx.waterY(x, z), z, 18);
    const lv = lvlAt(x, y, z, 70); sfx(b.party ? 'party' : 'boom', mine ? Math.max(0.6, lv) : lv);
    kickAdd(0.5 * lvlAt(x, y, z, 22));
    my.stat.booms = (my.stat.booms || 0) + 1;
    if (!mine) return;
    for (const q of playersNear(x, y + 0.3, z, RAD)) reportPlayer(q.id, w, 0, false, Math.min(q.d, RAD));   // 폭발 중심에서 몸까지의 거리가 피해를 정한다
    const sp = ctx.spider(); if (!sp || !sp.active) return;
    const seen = new Set();
    for (const r of [0.8, 1.8, 3, 4.4, 5.5, RAD].filter((q, i, a) => q <= RAD && a.indexOf(q) === i)) for (const h of sp.hitTest(x, z, r, y - 0.4)) {   // 가까운 반지름부터: 처음 걸린 반지름 ≈ 거리
      const key = h.kind + h.id; if (seen.has(key)) continue; seen.add(key);
      reportHit(w, 0, false, h.kind, h.id, Math.max(0, r - 0.8));
    }
  }
  // ---- 선물 폭발: 색종이(작은 네모) · 리본(가늘고 긴 띠) · 포장지 조각(큰 네모) · 반짝이
  const PARTY = ['#ff4f7b', '#ffd23f', '#3fd0ff', '#7dff6a', '#b07aff', '#ff8a3d', '#ffffff', '#ff5ad1'];
  function confetti(x, y, z) {
    const P = fxs.confP, M = P.length, col = new T.Color();
    for (let i = 0; i < 110; i++) {
      const qi = fxs.confN = (fxs.confN + 1) % M, q = P[qi], kind = i < 70 ? 0 : i < 92 ? 1 : 2;   // 0 색종이 · 1 리본 · 2 포장지
      const a = rnd() * Math.PI * 2, up = 0.35 + rnd() * 0.65, sp = (kind === 2 ? 5 : 7) + rnd() * 6;
      q.p.set(x + (rnd() - 0.5) * 0.6, y + rnd() * 0.4, z + (rnd() - 0.5) * 0.6);
      q.v.set(Math.cos(a) * Math.cos(up) * sp, Math.sin(up) * sp * 1.3 + 2, Math.sin(a) * Math.cos(up) * sp);
      q.r.set(rnd() * 6, rnd() * 6, rnd() * 6); q.w.set(rnd() * 14 - 7, rnd() * 14 - 7, rnd() * 14 - 7);
      q.sx = kind === 0 ? 0.13 : kind === 1 ? 0.06 : 0.3 + rnd() * 0.15; q.sy = kind === 0 ? 0.09 : kind === 1 ? 0.55 + rnd() * 0.4 : 0.22 + rnd() * 0.12;
      q.kind = kind; q.life = 2.6 + rnd() * 1.4; q.life0 = q.life;
      fxs.conf.setColorAt(qi, col.set(kind === 2 ? (rnd() < 0.5 ? '#d8263c' : '#1f9d55') : PARTY[(rnd() * PARTY.length) | 0]));   // 포장지는 성탄 빨강·초록
    }
    fxs.conf.instanceColor.needsUpdate = true; fxs.confLive = 4.2;
    const S = fxs.sparkP;
    for (let i = 0; i < 70; i++) {
      const q = S[fxs.sparkN = (fxs.sparkN + 1) % S.length], a = rnd() * Math.PI * 2, e = rnd() * Math.PI * 0.5, sp = 3 + rnd() * 8;
      q.p.set(x, y + 0.3, z); q.v.set(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 3, Math.sin(a) * Math.cos(e) * sp);
      q.c.set(PARTY[(rnd() * PARTY.length) | 0]).lerp(new T.Color('#ffffff'), 0.4); q.life = 1.0 + rnd() * 1.2; q.life0 = q.life; q.tw = rnd() * 10;
    }
    fxs.sparkLive = 2.4;
  }
  const _m4 = new T.Matrix4(), _q = new T.Quaternion(), _s = new T.Vector3(), _hide = new T.Matrix4().makeScale(0, 0, 0);
  function updateParty(dt) {
    if (fxs.confLive > 0) {
      fxs.confLive -= dt;
      const P = fxs.confP;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        if (q.life <= 0) { if (q.life0) { fxs.conf.setMatrixAt(i, _hide); q.life0 = 0; } continue; }
        q.life -= dt;
        const drag = q.kind === 0 ? 2.2 : q.kind === 1 ? 1.6 : 2.6;   // 종이: 공기 저항이 커서 팔랑팔랑 천천히 내려온다
        q.v.multiplyScalar(Math.exp(-drag * dt)); q.v.y -= (q.kind === 2 ? 5 : 3.2) * dt;
        q.p.addScaledVector(q.v, dt); q.p.x += Math.sin(q.life * 5 + i) * 0.6 * dt;
        const gy = ctx.groundY(q.p.x, q.p.z, q.p.y + 0.3) + 0.03; if (q.p.y < gy) { q.p.y = gy; q.v.set(0, 0, 0); q.w.multiplyScalar(0.0); }
        q.r.x += q.w.x * dt; q.r.y += q.w.y * dt; q.r.z += q.w.z * dt;
        const fade = Math.min(1, q.life / 0.5);
        _s.set(q.sx * fade, q.sy * fade, 1); _q.setFromEuler(q.r); _m4.compose(q.p, _q, _s); fxs.conf.setMatrixAt(i, _m4);
        if (q.life <= 0) { fxs.conf.setMatrixAt(i, _hide); q.life0 = 0; }
      }
      fxs.conf.instanceMatrix.needsUpdate = true;
    }
    if (fxs.sparkLive > 0) {
      fxs.sparkLive -= dt;
      const S = fxs.sparkP, pos = fxs.sparkPos, cl = fxs.sparkCol;
      for (let i = 0; i < S.length; i++) {
        const q = S[i];
        if (q.life <= 0) { pos[i * 3 + 1] = -999; continue; }
        q.life -= dt; q.v.multiplyScalar(Math.exp(-2.4 * dt)); q.v.y -= 2.5 * dt; q.p.addScaledVector(q.v, dt);
        const tw = 0.55 + 0.45 * Math.sin(q.tw + q.life * 30), f = Math.min(1, q.life / 0.4) * tw;
        pos[i * 3] = q.p.x; pos[i * 3 + 1] = q.life > 0 ? q.p.y : -999; pos[i * 3 + 2] = q.p.z; cl[i * 3] = q.c.r * f; cl[i * 3 + 1] = q.c.g * f; cl[i * 3 + 2] = q.c.b * f;
      }
      fxs.spark.geometry.attributes.position.needsUpdate = true; fxs.spark.geometry.attributes.color.needsUpdate = true;
    }
  }
  // ---- 궤적 미리보기(수류탄 + 우클릭을 누르는 동안): 손 → 첫 착지 + 튕김, 착지 원. 내 몸 안을 지나는 앞부분은 그리지 않는다
  function updateArc(show) {
    if (!fxs) return;
    if (!show) { fxs.arc.visible = false; fxs.arcDots.visible = false; fxs.land.visible = false; view.arcOn = false; return; }
    const cs = ctx.camState(), rec = ctx.me().rec, o = handWorld(rec, v1).toArray(), rp = rec.av.root.position;
    const r = C.grenadeArc(o, C.throwVel(cs.yaw, cs.pitch), (x, z, y) => ctx.groundY(x, z, y));
    const i0 = C.arcStart(r.pts, rp.x, rp.y, rp.z);
    const P = fxs.arcPos, pts = r.pts.slice(i0), n = Math.max(2, Math.min(pts.length, P.count));
    for (let i = 0; i < P.count; i++) { const q = pts[Math.min(i, pts.length - 1)]; P.setXYZ(i, q[0], q[1], q[2]); }
    view.arcOn = true; view.arcI0 = i0;
    P.needsUpdate = true; fxs.arc.geometry.setDrawRange(0, n); fxs.arc.computeLineDistances(); fxs.arc.visible = true; fxs.arcDots.visible = true;
    fxs.land.position.set(r.land[0], r.land[1] - C.GREN.radius + 0.06, r.land[2]); fxs.land.visible = true;
    view.arcLand = r.land;
  }

  // ===================================================================== 내 시간표 · 자동 연사 · 보급
  function frame(dt, now) {
    const t = now0();
    for (let i = my.timeline.length - 1; i >= 0; i--) if (t >= my.timeline[i].at) { const f = my.timeline[i].fn; my.timeline.splice(i, 1); try { f(); } catch (e) { console.warn('[bonfire] weapon timeline', e && e.message); } }
    const rec = ctx.me().rec;
    if (!ready || !rec) { updateFx(dt); return; }
    // 장전 진행 / 끝
    for (const s of C.GUN_SLOTS) {
      const g = my.guns[s]; if (!g) continue;
      const done = C.tickReload(g, t);
      if (done) { if (s === my.slot) { refreshHud(); sfx(s === 4 ? 'pump' : 'magin', 0.8); } if (rec.wp) rec.wp.reload = null; if (s === 8) showWarhead(rec); }
    }
    recoilFrame(dt, t);
    // 자동 연사 (소총): 방아쇠를 쥔 채로
    if (my.trig && isGun(my.slot) && WEAPONS[my.slot].auto && canAct()) shoot(t);
    // 총이 올라가 있는 동안(쏜 뒤 2 s · 방아쇠를 쥔 동안 · 조준 중)과 검을 휘두르는 동안 몸이 카메라를 향한다
    const gun = isGun(my.slot), wpr = rec.wp || {}, ulting = my.slot === 2 && !!wpr.ult, swinging = my.slot === 2 && (!!wpr.swing || ulting);
    // 조준(우클릭 누르는 동안): 0..1 로 부드럽게. 장전 중·총을 내린 동안은 풀린다
    const gg = my.guns[my.slot], adsT = ((gun && my.adsHeld && !(gg && gg.reload)) || (my.slot === 6 && my.gAim)) && canAct() && !lowered(rec) ? 1 : 0;   // 수류탄 조준도 같은 값(za 로 다른 탭에 던질 자세가 보인다)
    view.ads += (adsT - view.ads) * (1 - Math.exp(-dt * (adsT ? 13 : 16))); if (view.ads < 0.002) view.ads = 0;
    view.scope = my.slot === 7 ? clamp((view.ads - 0.72) / 0.25, 0, 1) : 0;
    if (ctx.hud.ads) ctx.hud.ads(view.ads, view.scope, my.slot);
    const aimOn = canAct() && ((gun && (my.trig || view.ads > 0.05 || t < (my.aimUntil || 0))) || swinging || (my.slot === 6 && t < (my.aimUntil || 0)));
    ctx.me().ctrl.setAim(aimOn ? ctx.camState().yaw : null);
    view.shoulder += ((gun && canAct() ? SHOULDER : 0) - view.shoulder) * (1 - Math.exp(-dt * 6));
    const adsMove = gun && C.ADS[my.slot] ? 1 + (C.ADS[my.slot].move - 1) * view.ads : 1;
    ctx.me().ctrl.setMoveScale(ulting ? 0.25 : swinging ? 0.45 : gun && aimOn ? 0.8 * adsMove : 1);
    // 예비탄은 무제한(탄창 단위로만 장전). 탄창이 비면 쏜 뒤 연사 간격이 지나는 대로 자동 장전한다
    if (gun && canAct() && C.needsAutoReload(my.guns[my.slot], t)) reload();
    if (!my.warm) { my.warm = true; for (const s of MODEL_SLOTS) instOf(rec, s); }   // 무기를 미리 만들어 둔다: 처음 바꿀 때 끊기지 않게
    // 수류탄 궤적 미리보기
    updateArc(my.slot === 6 && my.gAim && canAct() && !lowered(rec));
    // 궁극기·수류탄 쿨타임 HUD (10 Hz)
    view.ult = C.ultLeft(my.sword, t); view.gren = Math.max(0, my.gren.nextAt - t);
    if (ctx.hud.skill && (my.aimTick || 0) % 6 === 0) ctx.hud.skill(my.slot, my.slot === 2 ? view.ult : my.slot === 6 ? view.gren : 0, my.slot === 2 ? C.ULT.cd : C.GREN.cd);
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
  const KF_THROW = [{ t: 0, r: [-62, -8, 66], l: [-18, 0, -58], tor: [0, 0, 0] }, { t: 0.35, r: [-200, 10, 80], l: [-70, 0, -40], tor: [-10, 24, 0] }, { t: 0.55, r: [-84, -20, 82], l: [-30, 0, -56], tor: [18, -24, 0] }, { t: 1, r: [-62, -8, 66], l: [-18, 0, -58], tor: [0, 0, 0] }];
  // 발소리: 땅을 디딘 채 움직이면 걸음마다(달리면 더 자주). 남의 발소리는 거리만큼 작게
  function footsteps(rec, dt) {
    const st = rec.ctrl && rec.ctrl.state; if (!st || !st.grounded || st.swim === 2 || !(st.speed > 0.6)) { if (rec._step !== undefined) rec._step = 0.3; return; }
    rec._step = (rec._step || 0) + st.speed * dt;
    const stride = st.speed > 4.5 ? 1.25 : 0.85;
    if (rec._step >= stride) {
      rec._step = 0; const p = rec.av.root.position, mine = rec === ctx.me().rec;
      const lv = mine ? 0.55 : lvlAt(p.x, p.y, p.z, 14) * 0.5;
      sfx(p.y > ctx.heightAt(p.x, p.z) + 0.25 ? 'stepWood' : 'step', lv);
    }
  }
  function afterUpdate(rec, dt, now) {
    footsteps(rec, dt);
    if (!rec.wp) return;
    poseUpdate(rec, dt, now);
    flushShots(rec);   // 이번 프레임 자세가 끝난 뒤의 총구에서 탄·섬광을 낸다
    followFlash(rec);
  }
  function poseUpdate(rec, dt, now) {
    const wp = rec.wp; if (!wp) return;
    const st = rec.ctrl.state, mine = rec === ctx.me().rec;
    const slot = wp.slot;
    // 착지('land') 때 총이 깜빡이지 않게 이어 가고, 감정·대시·구르기·수영은 무기를 내린다. 앉기·엎드리기에서는 총을 든 채로(앉아서 쏘기)
    const wantSoft = slot >= 2 && ready && st.swim !== 2 && !['dash', 'roll', 'leap', 'proneIn', 'proneOut', 'dance', 'cheer', 'nod', 'wave'].includes(st.act) && !(slot === 2 && (st.act === 'sit' || st.act === 'prone'));
    const target = wantSoft ? 1 : 0;
    const stepW = dt / C.SWITCH_T; wp.w += clamp(target - wp.w, -stepW, stepW);   // 0.15 s 에 일정한 속도로 올라오고 내려간다
    wp.draw = Math.max(0, (wp.draw || 0) - stepW);
    if (wp.ult) { wp.ult.t += dt; if (wp.ult.t > C.ULT.rushT + 0.35) wp.ult = null; }
    // 모델 보이기
    for (const s of MODEL_SLOTS) { const inst = wp.inst[s]; if (inst) inst.holder.visible = s === slot && wp.w > 0.04 && !(s === 6 && wp.throwT !== undefined && wp.throwT > 0.17 && wp.throwT < 0.75); }
    if (slot >= 2 && !wp.inst[slot] && ready) instOf(rec, slot);
    if (wp.w < 0.01) { wp.swing = null; return; }
    const inst = wp.inst[slot]; if (!inst) return;
    const bR = rec.av.model.getObjectByName('arm-right'), bL = rec.av.model.getObjectByName('arm-left'), bT = rec.av.model.getObjectByName('torso');
    if (!bR || !bL || !bT) return;
    const P = POSE[slot]; let r = P.r.slice(), l = P.l.slice(), tor = P.torso.slice();
    const t = now0();
    wp.kick = Math.max(0, wp.kick - dt * 7.5);
    if (slot === 2) {
      if (wp.ult) {   // 난무: 0.1 s 마다 세 베기 동작을 번갈아 아주 빠르게 + 몸을 좌우로 비튼다
        const u = wp.ult.t;
        if (u < C.ULT.rushT) {
          const k = Math.floor(u / 0.1), f = (u % 0.1) / 0.1, kf = sampleKF(KF[k % 3], 0.3 + f * 0.5);
          r = kf.r; l = kf.l; tor = kf.tor;
          if (k !== wp.ult.n && fxs) {   // 휘두를 때마다 작은 초승달이 몸 주위에 번쩍
            wp.ult.n = k; const p = rec.av.root.position, a = wp.ult.yaw + (rnd() - 0.5) * 1.6;
            spawnSlash(new T.Vector3(p.x - Math.sin(a) * 1.0, p.y + 0.7 + rnd() * 1.0, p.z - Math.cos(a) * 1.0), a, k % 3, false, rec, true);
            if (k % 2 === 0) sfx('whoosh', mine ? 0.7 : lvlAt(p.x, 1, p.z) * 0.6);
          }
        } else { const kf = sampleKF(KF[2], clamp(0.3 + (u - C.ULT.rushT) / 0.35 * 0.5, 0, 1)); r = kf.r; l = kf.l; tor = kf.tor; }   // 마지막: 크게 내려베며 死 를 날린다
      } else if (wp.swing) {
        wp.swing.t += dt; const u = (wp.swing.u0 || 0) + (1 - (wp.swing.u0 || 0)) * wp.swing.t / wp.swing.dur;
        if (u >= 1) wp.swing = null;
        else { const k = sampleKF(KF[wp.swing.c], u); r = k.r; l = k.l; tor = k.tor; }
      } else {   // 대기: 가볍게 숨 쉬듯 칼끝이 흔들림 + 보석 반짝
        const b = Math.sin(t * 2.1) * 2; r[0] += b; l[0] += -b * 0.6;
      }
      if (inst.gem) inst.gem.scale.setScalar(1 + 0.25 * Math.sin(t * 5));
    } else if (slot === 6) {   // 수류탄: 쥐고 있다가 던지는 동작(어깨 위로 → 앞으로)
      if (wp.throwT !== undefined) {
        wp.throwT += dt; const u = wp.throwT / 0.8;
        if (u >= 1) wp.throwT = undefined; else { const k = sampleKF(KF_THROW, u); r = k.r; l = k.l; tor = k.tor; }
      } else {   // 우클릭(조준) 중: 팔을 뒤로 젖혀 던질 자세로 멈춘다(왼손은 앞으로 겨눔)
        const ga = mine ? view.ads : (wp.ads || 0);
        if (ga > 0.02) { const k = sampleKF(KF_THROW, 0.3); r = lerp3(r, k.r, ga); l = lerp3(l, [-80, 0, -30], ga); tor = lerp3(tor, k.tor, ga); }
      }
    } else {   // 총: 조준 방향으로 팔을 들고(고각/부각), 반동으로 위로 튄다
      wp.elev += (wp.elevT - wp.elev) * (1 - Math.exp(-dt * 8));
      if (!mine) wp.elevT *= Math.exp(-dt * 0.5);
      const e = clamp(wp.elev / DEG, -55, 55), kk = wp.kick * 6;
      r[0] -= e + kk; l[0] -= e + kk * 0.8; tor[0] += -e * 0.15;
      const ads = mine ? view.ads : (wp.ads || 0);   // 조준: 총을 눈높이로 끌어올리고 몸 가운데로
      if (ads > 0) { r[1] += 10 * ads; r[2] -= 6 * ads; l[1] += 6 * ads; tor[1] -= 4 * ads; }
      // 장전: 왼손이 탄창 쪽으로 내려갔다 올라옴 · 총이 살짝 기울어짐
      const rl = wp.reload;
      if (rl && rl.slot === slot) {
        const u = clamp((t - rl.t0) / rl.dur, 0, 1);
        if (slot !== 4) {
          const p = C.rifleReloadPose(u, rl.empty), pouch = [-40, 14, -52], well = [-52, -10, -96];
          const away = p.mag > 0.02 ? 1 : 0;
          l = lerp3(l, p.magGone || u > 0.42 && u < 0.52 ? pouch : well, away ? smooth(clamp(p.mag * 1.4, 0, 1)) : 0);
          if (u > 0.4 && u < 0.52) l = lerp3(l, pouch, 1);
          r[0] += 12 * p.tilt; tor[2] += 6 * p.tilt; r[2] -= 8 * p.tilt;
          if (inst.mag) {
            const dropD = MAG_DROP[slot] || 0.2;
            inst.mag.o.position.set(inst.mag.p0.x, inst.mag.p0.y - dropD * p.mag, inst.mag.p0.z + 0.05 * p.mag);
            inst.mag.o.visible = !p.magGone && !(u > 0.28 && u < 0.5);
            if (!rl.dropped && u >= 0.28) { rl.dropped = true; dropMag(inst); }
          }
          if (inst.ch) inst.ch.o.position.set(inst.ch.p0.x, inst.ch.p0.y, inst.ch.p0.z + 0.075 * p.handle);
          if (slot === 3 && inst.bolt) inst.bolt.o.position.set(inst.bolt.p0.x, inst.bolt.p0.y, inst.bolt.p0.z + 0.07 * p.handle);
          if (inst.slide) inst.slide.o.position.set(inst.slide.p0.x, inst.slide.p0.y, inst.slide.p0.z + 0.03 * p.handle);
          if (rl.ev < 1 && u >= 0.5) { rl.ev = 1; sfx('magin', mine ? 0.9 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
          if (rl.empty && rl.ev < 2 && u >= 0.8) { rl.ev = 2; sfx(slot === 7 ? 'bolt' : 'slide', mine ? 0.9 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
        } else {   // 산탄총: 왼손이 펌프를 앞뒤로 · 탄을 한 발씩 밀어 넣음
          const ph = (t - rl.t0) / 0.42, bob = Math.sin(ph * Math.PI * 2) * 0.5 + 0.5;
          l = lerp3(l, [-62, 0, -96], 0.6 * bob); r[0] += 6 * bob;
          if (inst.pump) inst.pump.o.position.set(inst.pump.p0.x, inst.pump.p0.y, inst.pump.p0.z + 0.0);
          if (Math.floor(ph) > rl.ev) { rl.ev = Math.floor(ph); sfx('pump', mine ? 0.7 : 0.3); }
        }
      } else {
        if (inst.mag) { inst.mag.o.position.copy(inst.mag.p0); inst.mag.o.visible = true; }
        if (inst.ch) inst.ch.o.position.copy(inst.ch.p0);
        // 노리쇠·슬라이드: 쏠 때마다 뒤로 갔다 앞으로
        const b = wp.bolt; wp.bolt = Math.max(0, wp.bolt - dt * 14);
        if (slot === 3 && inst.bolt) inst.bolt.o.position.set(inst.bolt.p0.x, inst.bolt.p0.y, inst.bolt.p0.z + 0.04 * b);
        if (inst.slide) inst.slide.o.position.set(inst.slide.p0.x, inst.slide.p0.y, inst.slide.p0.z + 0.032 * b);
        if (inst.pump) inst.pump.o.position.set(inst.pump.p0.x, inst.pump.p0.y, inst.pump.p0.z + (slot === 4 ? (wp.pumpT > 0 ? Math.sin(clamp(1 - wp.pumpT / 0.5, 0, 1) * Math.PI) * 0.12 : 0) * 1 : 0));
      }
      // 저격총 볼트액션: 쏜 뒤 손잡이 올림 → 뒤로 당김(탄피 배출) → 앞으로 → 내림. 왼손이 노리쇠로 간다
      if (slot === 7 && inst.bolt) {
        const B = inst.bolt; let rot = 0, back = 0;
        if (wp.boltCyc !== undefined) {
          wp.boltCyc += dt; const u = wp.boltCyc / WEAPONS[7].bolt;
          if (u >= 1) wp.boltCyc = undefined;
          else if (u > 0.18) {
            const sg = (a, b2) => smooth(clamp((u - a) / (b2 - a), 0, 1));
            rot = sg(0.18, 0.32) - sg(0.78, 0.92); back = sg(0.34, 0.52) - sg(0.58, 0.76);
            l = lerp3(l, [-74, 30, -30], clamp(Math.min((u - 0.18) / 0.12, (1 - u) / 0.1), 0, 1));
            if (!wp.boltEj && u > 0.5) { wp.boltEj = 1; if (inst.eject) { rec.av.root.updateMatrixWorld(true); inst.eject.getWorldPosition(v1); const yaw = rec.av.root.rotation.y; casing(v1, Math.cos(yaw) * 1.8, 2.0, -Math.sin(yaw) * 1.8, false); } sfx('bolt', mine ? 0.9 : lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z)); }
          }
          if (u < 0.5) wp.boltEj = 0;
        }
        B.o.rotation.z = -rot * 1.3; B.o.position.set(B.p0.x, B.p0.y, B.p0.z + 0.09 * back);
      }
      if (wp.pumpT > 0) wp.pumpT -= dt;
      if (wp.shellPending > 0) { wp.shellPending -= dt; if (wp.shellPending <= 0) { wp.pumpT = 0.5; if (inst.eject) { rec.av.root.updateMatrixWorld(true); inst.eject.getWorldPosition(v1); const yaw = rec.av.root.rotation.y; casing(v1, Math.cos(yaw) * 2.2, 2.4, -Math.sin(yaw) * 2.2, true); sfx('pump', mine ? 0.8 : lvlAt(v1.x, v1.y, v1.z)); } } }
      // 총 모델이 반동으로 뒤로 밀림
      inst.holder.position.z = inst._z0 === undefined ? (inst._z0 = inst.holder.position.z) : inst._z0;
      inst.model.position.z = wp.kick * 0.045 / inst.sc * 0.5;
      inst.model.rotation.x = wp.kick * (slot === 8 || slot === 7 ? 0.22 : 0.14);   // 총구가 위로 튄다(반동이 쌓이면 더 크게)
      if (inst.flashT > 0) inst.flashT -= dt;
    }
    if (wp.draw > 0) { const dr = smooth(clamp(wp.draw, 0, 1)); r[0] += 34 * dr; l[0] += 26 * dr; }   // 꺼내는 동작: 팔이 아래에서 올라온다(0.15 s)
    setEuler(bR, r, wp.w); setEuler(bL, l, wp.w); setEuler(bT, tor, wp.w);
  }

  // ===================================================================== 효과 갱신
  function updateFx(dt) {
    if (fxs) updateParty(dt);
    if (!fxs) return;
    rocketFrame(dt);
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
        if (c.m.position.y <= g) { c.m.position.y = g; c.v.multiplyScalar(0.25); c.v.y = 0; c.rest = true; c.life = Math.min(c.life, 1.0); sfx('shell', lvlAt(c.m.position.x, c.m.position.y, c.m.position.z, 12) * 0.8); }
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
    const sp = ctx.spider();
    // 수류탄: 포물선 · 튕김(땡그랑) · 회전 · 지연 폭발
    for (let i = nades.length - 1; i >= 0; i--) {
      const n = nades[i]; n.t += dt;
      const sub = Math.max(1, Math.ceil(dt / (1 / 60))), h = dt / sub;
      for (let k = 0; k < sub; k++) if (C.grenadeStep(n.p, n.v, h, (x, z, y) => ctx.groundY(x, z, y))) { sfx('clink', lvlAt(n.p[0], n.p[1], n.p[2], 30)); n.spin.multiplyScalar(0.5); }
      n.mesh.position.fromArray(n.p); n.mesh.rotation.x += n.spin.x * dt; n.mesh.rotation.y += n.spin.y * dt; n.mesh.rotation.z += n.spin.z * dt;
      if (n.t >= C.GREN.fuse) { scene.remove(n.mesh); nades.splice(i, 1); explode(n.p, n.mine); }
    }
    for (let i = booms.length - 1; i >= 0; i--) {   // 폭발: 불덩이 0.45 s 커지며 사라짐 · 충격파 고리 0.6 s · 섬광 0.12 s
      const b = booms[i]; b.t += dt;
      const u = b.t / (b.party ? 0.25 : 0.45), R = (b.party ? 0.4 : 0.6) + b.R * (b.party ? 0.3 : 0.55) * Math.sqrt(clamp(u, 0, 1));
      b.ball.scale.setScalar(R); b.ball.material.opacity = 0.95 * clamp(1 - u, 0, 1); if (!b.party) b.ball.material.color.setHSL(0.08 - 0.05 * clamp(u, 0, 1), 1, 0.6 - 0.25 * clamp(u, 0, 1));
      const ru = b.t / 0.6; b.ring.scale.setScalar(0.5 + b.R * ru); b.ring.material.opacity = 0.85 * clamp(1 - ru, 0, 1);
      b.flash.material.opacity = clamp(1 - b.t / 0.12, 0, 1); b.flash.visible = b.t < 0.12;
      if (b.t > 0.6) { scene.remove(b.ball, b.ring, b.flash); b.ball.material.dispose(); b.ring.material.dispose(); b.flash.material.dispose(); booms.splice(i, 1); }
    }
    // 궁극기 「死」 검기: 앞으로 쭉, 닿는 것마다 한 번
    for (let i = deaths.length - 1; i >= 0; i--) {
      const d = deaths[i]; d.t += dt;
      const step = C.ULT.speed * dt, n = Math.max(1, Math.ceil(step / 0.8)), sub = step / n;
      for (let k = 0; k < n; k++) {
        d.x += d.dx * sub; d.z += d.dz * sub; d.y = Math.max(ctx.groundY(d.x, d.z, d.y + 0.3) + C.ULT.size * 0.2, d.y + d.dy * sub);   // 겨눈 상하로(땅 밑으로는 안 들어감)
        if (sp && sp.active) for (const h of sp.hitTest(d.x, d.z, C.ULT.r, d.y - 1.6)) {
          const key = h.kind + h.id; if (d.hit.has(key)) continue; d.hit.add(key);
          for (let q = 0; q < 4; q++) ctx.fx.spark(d.x + (rnd() - 0.5) * 3, d.y - 1 + rnd() * 3, d.z + (rnd() - 0.5) * 3);
          if (d.mine) reportHit(2, 0, false, h.kind, h.id, 1, 'u');
        }
        if (d.mine) for (const q of playersNear(d.x, d.y, d.z, C.ULT.r)) {
          const key = 'p' + q.id; if (d.hit.has(key)) continue; d.hit.add(key);
          for (let k2 = 0; k2 < 4; k2++) ctx.fx.spark(d.x + (rnd() - 0.5) * 3, d.y - 1 + rnd() * 3, d.z + (rnd() - 0.5) * 3);
          reportPlayer(q.id, 2, 0, false, 1, 'u');
        }
      }
      d.g.position.set(d.x, d.y, d.z);
      const grow = 1 + d.t * 0.5, fade = clamp((C.ULT.life - d.t) / 0.35, 0, 1);
      d.g.scale.setScalar(grow); d.g.children.forEach((c) => { c.visible = fade > 0.02; });
      d.g.children[2].rotation.z = Math.sin(d.t * 30) * 0.03;
      if (d.t > C.ULT.life || Math.hypot(d.x - d.o.x, d.y - d.o.y, d.z - d.o.z) > C.ULT.range) { scene.remove(d.g); deaths.splice(i, 1); }
    }
    // 검기
    for (let i = slashes.length - 1; i >= 0; i--) {
      const s = slashes[i]; s.t += dt;
      if (s.mini) {   // 궁극기 난무의 작은 초승달: 0.22 s 동안 번쩍(피해 없음 — 난무 피해는 타격 시간표가 계산)
        s.holder.position.addScaledVector(v2.set(s.dx, 0, s.dz), dt * 8); s.g.scale.setScalar(1 + s.t * 3);
        if (s.t > 0.22) { scene.remove(s.holder); slashes.splice(i, 1); }
        continue;
      }
      const step = SLASH.speed * dt, n = Math.max(1, Math.ceil(step / 0.6)), sub = step / n; let stop = false;
      for (let k = 0; k < n && !stop; k++) {
        s.x += s.dx * sub; s.z += s.dz * sub; s.y += s.dy * sub;   // 겨눈 상하 각도대로 날아간다(땅에 붙이지 않는다)
        if (s.y < ctx.groundY(s.x, s.z, s.y + 0.3) + 0.15) { stop = true; ctx.fx.poof(s.x, s.y, s.z, 3); break; }
        if (sp && sp.active) for (const h of sp.hitTest(s.x, s.z, SLASH.r * s.sc, s.y - 0.9)) {
          const key = h.kind + h.id; if (s.hit.has(key)) continue; s.hit.add(key);
          ctx.fx.spark(s.x, s.y, s.z); sfx('slashHit', s.mine ? 0.9 : lvlAt(s.x, s.y, s.z));
          if (s.mine) reportHit(2, s.c, true, h.kind, h.id, 1);
          if (h.kind === 'boss') stop = true;
        }
        if (s.mine) for (const q of playersNear(s.x, s.y, s.z, SLASH.r * s.sc * 0.75)) {   // 검기는 사람을 뚫고 지나간다(한 사람에게 한 번)
          const key = 'p' + q.id; if (s.hit.has(key)) continue; s.hit.add(key);
          ctx.fx.spark(s.x, s.y, s.z); sfx('slashHit', 0.9);
          reportPlayer(q.id, 2, s.c, true, 1);
        }
        if (s.t > SLASH.life || Math.hypot(s.x - s.o.x, s.y - s.o.y, s.z - s.o.z) > SLASH.range) stop = true;   // an energy crescent passes through props
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
    if (slot !== 6) wp.throwT = undefined;
    if (slot >= 2) sfx('equip', lvlAt(rec.av.root.position.x, 1, rec.av.root.position.z));
  }
  function onNet(rec, senderId, d) {
    const m = C.sanitizeWpn(d); if (!m || !rec) return;
    const s = rec.ctrl.state;
    if (m.k === 'f') {
      const wp = wpOf(rec); if (wp.slot !== m.w) setRemoteSlot(rec, m.w);
      const W_ = WEAPONS[m.w], sent = new T.Vector3(m.o[0], m.o[1], m.o[2]);
      // 탄은 이 화면에서 보이는 총구에서 출발한다(자세가 잡힌 뒤 flushShots 가 계산). 보낸 쪽 총구(sent)에서 겨눈 끝점은 그대로 둔다
      const rr = rngSeed(m.seed), ends = [{ e: new T.Vector3(sent.x + m.d[0] * m.l, sent.y + m.d[1] * m.l, sent.z + m.d[2] * m.l), hit: m.h ? { kind: m.h.kind } : null, ground: !m.h }];
      if (m.w === 4) {   // 산탄: 보낸 쪽과 같은 seed → 같은 퍼짐 무늬(가운데 알갱이 방향 m.d 기준)
        const pd = C.pelletDirs(m.d, C.spreadFor(4, m.z || 0, false), W_.pellets, rr);
        for (let p = 1; p < pd.length; p++) { const sd = pd[p], L = Math.min(W_.range, m.l * (0.8 + 0.4 * ((p * 0.37) % 1))); ends.push({ e: new T.Vector3(sent.x + sd[0] * L, sent.y + sd[1] * L, sent.z + sd[2] * L), hit: null, ground: false }); }
      }
      queueShot(rec, m.w, ends, sent, false);
      sfx(SND[m.w], lvlAt(sent.x, sent.y, sent.z, 60));
      shotFx(rec, m.w, false); wp.kick = Math.min(1.6, wp.kick + KICK[m.w][0]); wp.bolt = 1; wp.elevT = Math.asin(clamp(m.d[1], -0.9, 0.9)); wp.elev = wp.elevT; wp.ads = m.z || 0; wp.adsAt = now0();
      if (m.w === 7) wp.boltCyc = 0;
      if (m.h) bookRemoteHit(senderId, s, m.w, 0, false, m.h, m.n || 1);
      if (m.v) for (const [id, n] of m.v) if (id === ctx.myId) pvpHurt(rec, senderId, s, m.w, 0, false, n);   // 이 발사가 나를 맞혔다고 한다
    } else if (m.k === 'p') {
      if (m.t === ctx.myId) pvpHurt(rec, senderId, s, m.w, m.c, !!m.sl, m.n, m.x);
    } else if (m.k === 's') {
      const wp = wpOf(rec); if (wp.slot !== 2) setRemoteSlot(rec, 2);
      const yaw = m.a;
      setTimeout(() => {
        startSwing(rec, m.c, false);
        setTimeout(() => {
          if (!rec.av || !rec.av.root.parent) return;
          const p = rec.av.root.position;
          const ce = Math.cos(m.p);
          spawnSlash(new T.Vector3(p.x - Math.sin(yaw) * 0.6 * ce, p.y + 1.0 + Math.sin(m.p) * 0.6, p.z - Math.cos(yaw) * 0.6 * ce), yaw, m.c, false, rec, false, m.p);
        }, C.SWORD_LAUNCH * 1000);
      }, 90);
    } else if (m.k === 'u') {
      const wp = wpOf(rec); if (wp.slot !== 2) setRemoteSlot(rec, 2);
      const yaw = m.a;
      setTimeout(() => {
        startUlt(rec, yaw, false);
        setTimeout(() => { if (!rec.av || !rec.av.root.parent) return; const p = rec.av.root.position; spawnDeath(new T.Vector3(p.x - Math.sin(yaw) * 1.2, p.y + 1.6, p.z - Math.cos(yaw) * 1.2), yaw, false, m.p); }, C.ULT.rushT * 1000);
      }, 90);
    } else if (m.k === 'k') {   // 남의 RPG: 같은 로켓이 이 화면에서도 날아가 터진다(피해는 쏜 사람 화면이 계산)
      const wp = wpOf(rec); if (wp.slot !== 8) setRemoteSlot(rec, 8);
      spawnRocket(m.o, m.d, false, rec); sfx('rpg', lvlAt(m.o[0], m.o[1], m.o[2], 70));
      flashAt(new T.Vector3(m.o[0], m.o[1], m.o[2]), FLASH[8], true, { rec, slot: 8 });
      wp.kick = Math.min(1.6, wp.kick + KICK[8][0]); wp.elevT = Math.asin(clamp(m.d[1], -0.9, 0.9)); wp.elev = wp.elevT;
    } else if (m.k === 'g') {
      const wp = wpOf(rec); if (wp.slot !== 6) setRemoteSlot(rec, 6);
      wp.throwT = 0.16; spawnGrenade(m.o, m.v, false); sfx('throw', lvlAt(m.o[0], m.o[1], m.o[2]));
    } else if (m.k === 'r') {
      const wp = wpOf(rec); if (wp.slot !== m.w) setRemoteSlot(rec, m.w);
      onReloadStart(rec, m.w, !!m.e, false);
    } else if (m.k === 'h') {
      bookRemoteHit(senderId, s, m.w, m.c, !!m.sl, m.h, m.n, m.x);
    }
  }
  function bookRemoteHit(senderId, s, w, c, sl, h, n, x) {   // 보스를 돌리는 쪽(소유자)만 피해를 장부에 올린다. 값은 표에서 정하고, 거리를 확인한다
    const sp = ctx.spider(); if (!sp || !sp.owner || !sp.active) return;
    const v = sp.view; if (!C.reachOk(w, x || (sl ? 'sl' : 'm'), Math.hypot(s.x - v.x, s.z - v.z), sp.BOSS.hitReach)) return;
    const d = x ? C.ultDmg(x) : C.dmgFor(w, sl ? 'sl' : 'm', c, n); if (!d || !(d.amount > 0)) return;
    sp.damage(h.kind, h.id, d.amount, senderId + '|' + d.key, d.cd);
  }

  function dispose() {
    fxq.length = 0;
    for (const s of slashes) scene.remove(s.holder); slashes.length = 0;
    for (const d of drops) scene.remove(d.m); drops.length = 0;
    for (const n of nades) scene.remove(n.mesh); nades.length = 0;
    for (const d of deaths) scene.remove(d.g); deaths.length = 0;
    for (const r of rockets) scene.remove(r.g); rockets.length = 0;
  }

  return {
    load, equip, cycle, trigger, alt, reload, frame, afterUpdate, onNet, setRemoteSlot, dispose, attackPress,
    get ads() { return view.ads; }, get scope() { return view.scope; }, get sensK() { return C.adsSens(my.slot, view.ads); }, get fp() { return C.adsFp(my.slot, view.ads); }, get arcOn() { return !!view.arcOn; }, get gAim() { return !!my.gAim; }, fov: (base) => C.adsFov(base, my.slot, view.ads), setRemoteAds: (rec, a) => { const wp = wpOf(rec); wp.ads = a; },
    get slot() { return my.slot; }, get shoulder() { return view.shoulder; }, get view() { return view; }, get ready() { return ready; }, get kick() { return kickCam; }, get guns() { return my.guns; },
    get sword() { return my.sword; }, kickAdd, attachRec: (rec) => wpOf(rec), instOf, sfx,
    debug: { pvpHurt, playerRay, playersNear, my, trs, cas, slashes, nades, booms, deaths, rockets, spawnRocket, aimElev, shotLog, handCache, POSE, KF, computeAim, worldRay, spawnSlash, flashAt, tracer, muzzleWorld, explode, get fxs() { return fxs; } },
  };
}
