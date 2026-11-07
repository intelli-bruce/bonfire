// bf/spider.js — 인면 거미 보스 (bf/spider.glb) 와 새끼 거미 (bf/spider_mini.glb).
// 모델·리깅·애니메이션은 tools/spider/build_spider.py (Blender) 로 만든다.
//
// 구조: 보스는 한 명(소유자)의 화면에서만 AI 가 돌고 8 Hz 로 스냅샷을 보낸다. 나머지는 스냅샷을 받아 그대로 보여 준다.
//   - 소유자: 이동·패턴 선택·새끼 거미 AI·체력 계산(공격은 `damage()` 로만 깎임). 소유자가 사라지면 가장 작은 id 가 이어받는다.
//   - 모두: 같은 시각 효과(모델·독침·거미줄·새끼 거미). 내게 맞았는지는 내 화면에서 판정한다(기존 펀치 방식과 같다: 보이는 대로 맞는다).
// 모듈은 THREE 와 index.html 이 넘겨 주는 ctx 만 쓴다. ctx.players() 는 나 자신을 포함한다.
//
//   const sp = createSpiderBoss({ THREE, scene, baseUrl, heightAt, canStand, players, myId, me, onHitMe, fx })
//   sp.spawn(x, z, ry) · sp.despawn() · sp.update(dt, t) · sp.snapshot() · sp.applySnapshot(d, senderId)
//   sp.hitTest(cx, cz, radius, y) → [{ kind, id }] · sp.damage(kind, id, amount, fromId) · sp.slowAt(x, z) · sp.view

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapA = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const r2 = (v) => Math.round(v * 100) / 100;
const finite = (v, a, b) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : null);
const beats = (stA, idA, stB, idB) => stA < stB || (stA === stB && idA < idB);
const outranks = (epA, bornA, idA, epB, bornB, idB) => (epA !== epB ? epA > epB : beats(bornA, idA, bornB, idB));   // higher epoch wins; same epoch: earlier birth, then smaller id

export const BOSS = {
  hp: 480, hpPerExtra: 160, bodyR: 2.1, spawnT: 1.8, dieT: 4.2,
  walk: 3.0, turn: 2.2, melee: 3.4,
  swipe: { cd: 3.2, reach: 6.2, half: 1.25, contact: 13 / 24, dur: 28 / 24, minD: 0, maxD: 5.4 },
  spit: { cd: 5.6, fire: 16 / 24, dur: 30 / 24, speed: 17, life: 2.2, radius: 0.75, fan: 0.2, minD: 5.5, maxD: 34 },
  web: { cd: 13, fire: 16 / 24, dur: 30 / 24, flight: 0.75, radius: 2.7, life: 11, slow: 0.42, minD: 6, maxD: 30, max: 5 },
  summon: { cd: 17, fire: 30 / 24, dur: 48 / 24, count: 3, cap: 6 },
  gap: 0.7, rageAt: 0.35, dmgCooldown: 0.22,
};
export const MINI = { hp: 20, speed: 3.6, life: 28, hitR: 0.95, atkD: 1.5, hitCd: 0.9 };
const ONE_SHOT = { sw: 'swipe', sp: 'spit', wb: 'spit', sm: 'summon', d: 'die', h: 'hurt' };

export function createSpiderBoss(ctx) {
  const { THREE, scene } = ctx;
  const B = { active: false, owner: false, ownerId: '', ep: 0, born: 0, x: 0, z: 0, ry: 0, hp: 0, maxHp: 0, a: 'i', ac: 0, sa: 0, wt: null, webs: [], minions: [], seq: 0, spawnT: 0, dieT: 0, rage: false };
  const R = { tx: 0, tz: 0, try_: 0, lastAc: 0, lastSnap: 0 };       // replica-side targets
  const O = { act: null, cd: { sw: 0, sp: 2.2, wb: 6, sm: 8 }, gap: 0, webId: 0, minId: 0, hitAt: new Map(), lastBy: '' };   // owner-side AI
  let assets = null, loading = null, loadFailed = false;
  let boss = null;                                   // { root, mixer, clips, cur, os, jaw, mats }
  const timers = [];                                 // { t, fn }
  const proj = [];                                   // spit needles in flight
  const arcs = [];                                   // web balls in flight
  const webVis = new Map();                          // id -> { m, age }
  const minVis = new Map();                          // id -> visual record
  const ghosts = [];                                 // dying minions (visual only)
  const listeners = {};
  const emit = (k, v) => { for (const f of listeners[k] || []) { try { f(v); } catch (e) { /* listener */ } } };
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const myHit = { swipe: 0, minion: 0, body: 0, spit: 0 };   // victim-side cooldowns (s)

  // ---------- assets ----------
  function load() {
    if (assets) return Promise.resolve(assets);
    if (loading) return loading;
    loading = (async () => {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const SU = await import('three/addons/utils/SkeletonUtils.js');
      const ld = new GLTFLoader();
      const get = (f) => new Promise((res, rej) => ld.load(new URL(f, ctx.baseUrl).href, res, undefined, rej));
      const [b, m] = await Promise.all([get('spider.glb'), get('spider_mini.glb')]);
      assets = { boss: b, mini: m, SU };
      // shared projectile / web resources
      assets.needleGeo = new THREE.ConeGeometry(0.1, 0.85, 6).rotateX(Math.PI / 2);   // tip along +Z
      assets.needleMat = new THREE.MeshBasicMaterial({ color: '#b6ff4a' });
      assets.glowGeo = new THREE.SphereGeometry(0.26, 10, 8);
      assets.glowMat = new THREE.MeshBasicMaterial({ color: '#5dff2a', transparent: true, opacity: 0.45, depthWrite: false });
      assets.ballGeo = new THREE.SphereGeometry(0.3, 10, 8);
      assets.ballMat = new THREE.MeshBasicMaterial({ color: '#eaf2ff' });
      assets.webTex = makeWebTexture();
      assets.webGeo = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
      return assets;
    })().catch((e) => { loadFailed = true; console.warn('[bonfire] spider assets failed', e && e.message); throw e; });
    return loading;
  }
  function makeWebTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'); g.translate(128, 128); g.lineCap = 'round';
    const spokes = 12;
    g.strokeStyle = 'rgba(236,242,255,0.95)'; g.lineWidth = 2.2;
    for (let i = 0; i < spokes; i++) { const a = (i / spokes) * TAU + 0.13; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 124, Math.sin(a) * 124); g.stroke(); }
    g.lineWidth = 1.6; g.strokeStyle = 'rgba(220,230,255,0.85)';
    for (let r = 22; r <= 120; r += 20) {
      g.beginPath();
      for (let i = 0; i <= spokes; i++) {
        const a = (i / spokes) * TAU + 0.13, rr = r * (1 + (((i * 7 + r) % 5) - 2) * 0.018);
        const px = Math.cos(a) * rr * (i % 2 ? 0.93 : 1), py = Math.sin(a) * rr * (i % 2 ? 0.93 : 1);
        if (i === 0) g.moveTo(px, py); else g.quadraticCurveTo(Math.cos(a - Math.PI / spokes) * rr * 0.86, Math.sin(a - Math.PI / spokes) * rr * 0.86, px, py);
      }
      g.stroke();
    }
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 128); grd.addColorStop(0, 'rgba(180,200,255,0.28)'); grd.addColorStop(1, 'rgba(180,200,255,0.06)');
    g.fillStyle = grd; g.beginPath(); g.arc(0, 0, 126, 0, TAU); g.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // ---------- one animated rig (boss or minion) ----------
  function makeRig(gltf, { cloneMats }) {
    const root = assets.SU.clone(gltf.scene);
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
        if (cloneMats) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      }
    });
    const mixer = new THREE.AnimationMixer(root);
    const clips = {};
    for (const c of gltf.animations) clips[c.name] = mixer.clipAction(c);
    let jaw = null; root.traverse((o) => { if (o.isBone && o.name === 'jaw') jaw = o; });
    const mats = new Set(); root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) mats.add(m); });
    // night scene without an environment map: metal would render black, and a little self-light keeps the dark shell readable
    for (const m of mats) { if (!m.isMeshStandardMaterial) continue; m.metalness = Math.min(m.metalness, 0.05); if (m.emissive.getHex() === 0) m.emissive.copy(m.color).multiplyScalar(/skin|lip/.test(m.name) ? 0.18 : 0.3); }
    const base = new Map(); for (const m of mats) base.set(m, { e: m.emissive ? m.emissive.clone() : null, i: m.emissiveIntensity });
    scene.add(root);
    return { root, mixer, clips, cur: null, os: null, jaw, mats, base, flash: 0 };
  }
  function setLoop(rig, name, ts = 1) {
    const a = rig.clips[name]; if (!a) return;
    if (rig.os) return;   // a one-shot is playing; it returns to the loop when done
    if (rig.cur === name) { a.timeScale = ts; return; }
    const prev = rig.cur && rig.clips[rig.cur];
    a.reset().setLoop(THREE.LoopRepeat, Infinity); a.timeScale = ts; a.enabled = true; a.play();
    if (prev) { a.crossFadeFrom(prev, 0.2, false); } else a.setEffectiveWeight(1);
    rig.cur = name;
  }
  function playOnce(rig, name, ts = 1, hold = false) {
    const a = rig.clips[name]; if (!a) return 0;
    const prev = rig.cur && rig.clips[rig.cur];
    a.reset().setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.timeScale = ts; a.enabled = true; a.play();
    if (prev && prev !== a) a.crossFadeFrom(prev, 0.12, false);
    rig.cur = name; const dur = a.getClip().duration / ts;
    rig.os = { name, t: dur, hold }; return dur;
  }
  function tickRig(rig, dt) {
    rig.mixer.update(dt);
    if (rig.os && !rig.os.hold) { rig.os.t -= dt; if (rig.os.t <= 0) { rig.os = null; rig.cur = null; } }   // back to a loop: the caller picks it next
    if (rig.flash > 0) {
      rig.flash = Math.max(0, rig.flash - dt);
      const on = rig.flash > 0;
      for (const m of rig.mats) {
        if (!m.emissive) continue;
        const b = rig.base.get(m);
        if (on) { m.emissive.setRGB(1, 0.05, 0.03); m.emissiveIntensity = 1.2; } else { m.emissive.copy(b.e); m.emissiveIntensity = b.i; }
      }
    }
  }
  function disposeRig(rig) {
    if (!rig) return;
    scene.remove(rig.root); rig.mixer.stopAllAction(); rig.mixer.uncacheRoot(rig.root);
    rig.root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose(); });
  }

  // ---------- life cycle ----------
  function resetState() {
    B.active = false; B.owner = false; B.ownerId = ''; B.a = 'i'; B.webs = []; B.minions = []; B.spawnT = 0; B.dieT = 0; B.rage = false; B.wt = null;
    O.act = null; O.cd = { sw: 0, sp: 2.2, wb: 6, sm: 8 }; O.gap = 0.8; O.hitAt.clear();
    timers.length = 0;
    if (boss) { disposeRig(boss); boss = null; }
    for (const p of proj) scene.remove(p.g); proj.length = 0;
    for (const a of arcs) scene.remove(a.m); arcs.length = 0;
    for (const [, v] of webVis) { scene.remove(v.m); v.m.material.dispose(); } webVis.clear();
    for (const [, v] of minVis) disposeRig(v.rig); minVis.clear();
    for (const g of ghosts) disposeRig(g.rig); ghosts.length = 0;
  }
  function ensureBoss() {
    if (boss || !assets || !B.active) return;
    boss = makeRig(assets.boss, { cloneMats: true });
    setLoop(boss, 'idle');
  }
  function spawn(x, z, ry) {
    if (B.active) return false;
    const n = Math.max(1, ctx.players().length);
    B.active = true; B.owner = true; B.ownerId = ctx.myId; B.ep = 0; B.born = Date.now(); B.seq = 0;
    B.x = x; B.z = z; B.ry = ry; B.maxHp = B.hp = BOSS.hp + BOSS.hpPerExtra * (n - 1);
    B.a = 's'; B.spawnT = BOSS.spawnT; B.ac++;
    R.tx = x; R.tz = z; R.try_ = ry; R.lastSnap = performance.now();
    emit('spawn', { owner: true });
    load().then(() => { ensureBoss(); ctx.fx.poof(x, ctx.heightAt(x, z), z, 6); }).catch(() => { despawn(); });
    return true;
  }
  function despawn() {
    const was = B.active; resetState(); if (was) emit('despawn', {});
  }

  // ---------- owner AI ----------
  const nearest = (x, z) => {
    let best = null, bd = 1e9;
    for (const p of ctx.players()) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
    return best ? { p: best, d: bd } : null;
  };
  const faceTo = (dx, dz) => Math.atan2(-dx, -dz);
  function stepTo(o, dx, dz, sp, dt) {   // move along (dx,dz) only if the spot is dry land
    const nx = o.x + dx * sp * dt, nz = o.z + dz * sp * dt;
    if (ctx.canStand(nx, nz)) { o.x = nx; o.z = nz; return true; }
    if (ctx.canStand(nx, o.z)) { o.x = nx; return true; }
    if (ctx.canStand(o.x, nz)) { o.z = nz; return true; }
    return false;
  }
  function pickAction(tg) {
    const d = tg.d, k = B.rage ? 0.7 : 1, c = O.cd;
    const ok = [];
    if (c.sw <= 0 && d < BOSS.swipe.maxD) ok.push(['sw', 5]);
    if (c.sm <= 0 && B.minions.length < BOSS.summon.cap - 2) ok.push(['sm', d > 8 ? 4 : 2]);
    if (c.wb <= 0 && d > BOSS.web.minD && d < BOSS.web.maxD && B.webs.length < BOSS.web.max) ok.push(['wb', 3]);
    if (c.sp <= 0 && d > BOSS.spit.minD && d < BOSS.spit.maxD) ok.push(['sp', 4]);
    if (!ok.length) return null;
    let tot = 0; for (const [, w] of ok) tot += w;
    let r = Math.random() * tot; let pick = ok[0][0];
    for (const [n, w] of ok) { r -= w; if (r <= 0) { pick = n; break; } }
    return { name: pick, k };
  }
  function startAction(name, aimAngle, wt, fromNet) {
    // shared by the owner (starting a pattern) and replicas (the owner's counter moved): visuals + timed effects
    const cfg = name === 'sw' ? BOSS.swipe : name === 'sp' ? BOSS.spit : name === 'wb' ? BOSS.web : BOSS.summon;
    B.a = name;
    if (boss) { playOnce(boss, ONE_SHOT[name], 1); }
    if (name === 'sw') {
      timers.push({ t: BOSS.swipe.contact, fn: () => swipeContact() });
    } else if (name === 'sp') {
      timers.push({ t: BOSS.spit.fire, fn: () => fireSpit(aimAngle) });
    } else if (name === 'wb') {
      timers.push({ t: BOSS.web.fire, fn: () => throwWeb(wt) });
    } else if (name === 'sm') {
      if (!fromNet) timers.push({ t: BOSS.summon.fire, fn: () => ownerSummon() });
      timers.push({ t: 0.3, fn: () => ctx.fx.poof(B.x, ctx.heightAt(B.x, B.z), B.z, 4) });
    }
    return cfg;
  }
  function ownerBegin(name, tg) {
    const cfg = name === 'sw' ? BOSS.swipe : name === 'sp' ? BOSS.spit : name === 'wb' ? BOSS.web : BOSS.summon;
    const k = B.rage ? 0.7 : 1;
    O.cd[name] = cfg.cd * k; O.act = { name, t: 0, dur: cfg.dur, track: name !== 'sm' };
    const dx = tg ? tg.p.x - B.x : 0, dz = tg ? tg.p.z - B.z : 0;
    B.sa = faceTo(dx, dz);   // world yaw of the aim (same convention as ry)
    B.wt = name === 'wb' && tg ? [r2(tg.p.x), r2(tg.p.z)] : null;
    B.ac++; startAction(name, B.sa, B.wt, false);
  }
  function ownerSummon() {
    if (!B.owner || B.dieT > 0) return;
    const n = Math.min(BOSS.summon.count, BOSS.summon.cap - B.minions.length);
    for (let i = 0; i < n; i++) {
      const a = B.ry + (i - (n - 1) / 2) * 0.95 + (Math.random() - 0.5) * 0.3, r = 3.0 + Math.random() * 0.8;   // in front of the boss, fanned out
      let x = B.x - Math.sin(a) * r, z = B.z - Math.cos(a) * r;
      if (!ctx.canStand(x, z)) { x = B.x; z = B.z; }
      B.minions.push({ id: ++O.minId, x, z, ry: a, hp: MINI.hp, a: 'i', life: MINI.life, atk: 0, tx: x, tz: z });
      ctx.fx.poof(x, ctx.heightAt(x, z), z, 3);
    }
  }
  function ownerUpdate(dt) {
    for (const k of ['sw', 'sp', 'wb', 'sm']) O.cd[k] = Math.max(0, O.cd[k] - dt);
    if (B.spawnT > 0) { B.spawnT -= dt; if (B.spawnT <= 0) { B.a = 'i'; } return; }
    if (B.dieT > 0) { B.dieT -= dt; if (B.dieT <= 0) emit('request-despawn', { dead: true }); return; }
    if (!B.rage && B.hp <= B.maxHp * BOSS.rageAt) { B.rage = true; emit('rage', {}); }
    const tg = nearest(B.x, B.z);
    // minions
    for (let i = B.minions.length - 1; i >= 0; i--) {
      const m = B.minions[i]; m.life -= dt;
      if (m.hp <= 0 || m.life <= 0) { B.minions.splice(i, 1); continue; }
      const t = nearest(m.x, m.z);
      if (m.atk > 0) { m.atk -= dt; m.a = 'k'; continue; }
      if (!t) { m.a = 'i'; continue; }
      const dx = t.p.x - m.x, dz = t.p.z - m.z, d = Math.hypot(dx, dz) || 1;
      m.ry = faceTo(dx, dz);
      if (d < MINI.atkD) { m.atk = 0.9; m.a = 'k'; continue; }
      m.a = 'w'; stepTo(m, dx / d, dz / d, MINI.speed, dt);
    }
    if (O.act) {
      const a = O.act; a.t += dt;
      if (tg && a.track && a.t < a.dur * 0.55) { const want = faceTo(tg.p.x - B.x, tg.p.z - B.z), dd = wrapA(want - B.ry), m = BOSS.turn * 0.8 * dt; B.ry = wrapA(B.ry + clamp(dd, -m, m)); }
      if (a.t >= a.dur) { O.act = null; O.gap = BOSS.gap; B.a = 'i'; }
      return;
    }
    if (!tg) { B.a = 'i'; return; }
    O.gap = Math.max(0, O.gap - dt);
    const want = faceTo(tg.p.x - B.x, tg.p.z - B.z), dd = wrapA(want - B.ry), tm = BOSS.turn * (B.rage ? 1.3 : 1) * dt;
    B.ry = wrapA(B.ry + clamp(dd, -tm, tm));
    if (O.gap <= 0 && Math.abs(dd) < 0.9) {
      const pick = pickAction(tg);
      if (pick) { ownerBegin(pick.name, tg); return; }
    }
    if (tg.d > BOSS.melee && Math.abs(dd) < 1.4) {
      const sp = BOSS.walk * (B.rage ? 1.25 : 1);
      const moved = stepTo(B, -Math.sin(B.ry), -Math.cos(B.ry), sp, dt);
      B.a = moved ? 'w' : 'i';
    } else B.a = 'i';
  }

  // ---------- shared effects ----------
  function mouthPos(out) {
    if (boss && boss.jaw) { boss.jaw.getWorldPosition(out); out.x += -Math.sin(B.ry) * 0.7; out.z += -Math.cos(B.ry) * 0.7; out.y -= 0.1; return out; }
    return out.set(B.x - Math.sin(B.ry) * 2.2, ctx.heightAt(B.x, B.z) + 2.2, B.z - Math.cos(B.ry) * 2.2);
  }
  function swipeContact() {
    const cfg = BOSS.swipe;
    ctx.fx.thump(0.9);
    // knock-up dust at the claws
    const fx = -Math.sin(B.ry), fz = -Math.cos(B.ry);
    ctx.fx.poof(B.x + fx * 4.4, ctx.heightAt(B.x + fx * 4.4, B.z + fz * 4.4) + 0.05, B.z + fz * 4.4, 5);
    if (!ctx.me().ok || myHit.swipe > 0) return;
    const m = ctx.me(), dx = m.x - B.x, dz = m.z - B.z, d = Math.hypot(dx, dz);
    if (d > cfg.reach || d < 0.3 || Math.abs(m.y - ctx.heightAt(B.x, B.z)) > 2.4) return;
    if (Math.abs(wrapA(faceTo(dx, dz) - B.ry)) > cfg.half) return;
    myHit.swipe = 0.6;
    ctx.onHitMe({ src: 'swipe', dx: dx / d, dz: dz / d, power: 1.7 });
  }
  function fireSpit(aim) {
    if (!assets) return;
    const o = mouthPos(new THREE.Vector3());
    const n = 3;
    for (let i = 0; i < n; i++) {
      const a = aim + (i - 1) * BOSS.spit.fan;
      const g = new THREE.Group();
      const needle = new THREE.Mesh(assets.needleGeo, assets.needleMat), glow = new THREE.Mesh(assets.glowGeo, assets.glowMat);
      glow.scale.set(1, 1, 1.9); needle.position.z = 0; g.add(needle, glow);
      g.position.copy(o); scene.add(g);
      const vx = -Math.sin(a) * BOSS.spit.speed, vz = -Math.cos(a) * BOSS.spit.speed;
      g.rotation.y = Math.atan2(vx, vz);
      proj.push({ g, vx, vz, vy: -0.9 + (Math.random() - 0.5) * 0.3, life: BOSS.spit.life });
    }
    ctx.fx.thump(0.5);
  }
  function throwWeb(wt) {
    if (!assets || !wt) return;
    const x = finite(wt[0], -90, 90), z = finite(wt[1], -100, 100); if (x === null || z === null) return;
    const o = mouthPos(new THREE.Vector3());
    const m = new THREE.Mesh(assets.ballGeo, assets.ballMat); m.position.copy(o); scene.add(m);
    arcs.push({ m, sx: o.x, sy: o.y, sz: o.z, tx: x, tz: z, ty: ctx.heightAt(x, z) + 0.1, t: 0, dur: BOSS.web.flight });
  }
  function landWeb(a) {
    ctx.fx.poof(a.tx, a.ty, a.tz, 4);
    if (B.owner && B.active && B.webs.length < BOSS.web.max + 2) B.webs.push({ id: ++O.webId, x: a.tx, z: a.tz, age: 0 });
  }
  function webVisual(w) {
    let v = webVis.get(w.id);
    if (!v) {
      const mat = new THREE.MeshBasicMaterial({ map: assets.webTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const m = new THREE.Mesh(assets.webGeo, mat); m.renderOrder = 2; m.scale.setScalar(BOSS.web.radius * 0.4);
      m.position.set(w.x, ctx.heightAt(w.x, w.z) + 0.07, w.z); scene.add(m);
      v = { m }; webVis.set(w.id, v);
    }
    return v;
  }

  // ---------- minions (visual) ----------
  function minionVisual(m) {
    let v = minVis.get(m.id);
    if (!v) {
      const rig = makeRig(assets.mini, { cloneMats: false });
      rig.root.position.set(m.x, ctx.heightAt(m.x, m.z), m.z); rig.root.rotation.y = m.ry;
      setLoop(rig, 'idle');
      v = { rig, x: m.x, z: m.z, ry: m.ry, a: m.a, born: 0 }; minVis.set(m.id, v);
      rig.root.scale.setScalar(0.2);
    }
    return v;
  }
  function dropMinion(id, v) {
    ctx.fx.spark(v.x, ctx.heightAt(v.x, v.z) + 0.3, v.z);
    playOnce(v.rig, 'die', 1.6, true); ghosts.push({ rig: v.rig, t: 0.8 }); minVis.delete(id);
  }

  // ---------- per-frame ----------
  function update(dt, t) {
    for (const k in myHit) myHit[k] = Math.max(0, myHit[k] - dt);
    if (!B.active) return;
    if (loadFailed) { despawn(); return; }
    ensureBoss();
    const now = performance.now();
    if (B.owner) ownerUpdate(dt);
    else {
      // follow the owner's stream; take over when it goes quiet
      const k = Math.min(1, dt * 9);
      B.x += (R.tx - B.x) * k; B.z += (R.tz - B.z) * k; B.ry = wrapA(B.ry + wrapA(R.try_ - B.ry) * k);
      if (B.spawnT > 0) B.spawnT -= dt;
      const quiet = now - R.lastSnap;
      if (quiet > 7000) { const dead = B.a === 'd'; despawn(); emit('gone', { dead }); return; }
      if (quiet > 2600 && B.a !== 'd') {   // the owner went quiet: the smallest id among those still here carries on from the last snapshot
        const ids = ctx.players().map((p) => p.id).sort();
        if (ids[0] === ctx.myId) { B.owner = true; B.ownerId = ctx.myId; B.ep++; O.act = null; O.gap = 1.2; O.minId = Math.max(O.minId, ...B.minions.map((m) => m.id), 0); O.webId = Math.max(O.webId, ...B.webs.map((w) => w.id), 0); emit('takeover', {}); }
      }
    }
    // timers
    for (let i = timers.length - 1; i >= 0; i--) { timers[i].t -= dt; if (timers[i].t <= 0) { const f = timers[i].fn; timers.splice(i, 1); try { f(); } catch (e) { /* effect */ } } }
    if (!assets) return;   // models still loading: the state above keeps running, the visuals start once they are in
    // boss visual
    if (boss) {
      const g = ctx.heightAt(B.x, B.z), sp = B.spawnT > 0 ? clamp(1 - B.spawnT / BOSS.spawnT, 0, 1) : 1, se = 1 - (1 - sp) * (1 - sp);
      boss.root.position.set(B.x, g - (1 - se) * 2.2, B.z); boss.root.rotation.y = B.ry; boss.root.scale.setScalar(0.35 + 0.65 * se);
      if (B.a === 'd') { if (boss.cur !== 'die') { boss.os = null; playOnce(boss, 'die', 1, true); } }
      else if (!boss.os) setLoop(boss, B.a === 'w' ? 'walk' : 'idle', B.a === 'w' ? (BOSS.walk * (B.rage ? 1.25 : 1)) / 3.4 : 1);
      tickRig(boss, dt);
      if (B.spawnT > 0 && Math.random() < dt * 14) ctx.fx.poof(B.x + (Math.random() - 0.5) * 4, g + 0.05, B.z + (Math.random() - 0.5) * 4, 2);
    }
    // projectiles (every client simulates them; only my own body is tested)
    for (let i = proj.length - 1; i >= 0; i--) {
      const p = proj[i]; p.life -= dt; p.vy -= 3.0 * dt;
      p.g.position.x += p.vx * dt; p.g.position.z += p.vz * dt; p.g.position.y += p.vy * dt;
      const gy = ctx.heightAt(p.g.position.x, p.g.position.z);
      let dead = p.life <= 0 || p.g.position.y < gy + 0.1;
      const m = ctx.me();
      if (!dead && m.ok && myHit.spit <= 0 && Math.hypot(p.g.position.x - m.x, p.g.position.z - m.z) < BOSS.spit.radius && Math.abs(p.g.position.y - (m.y + 0.8)) < 1.3) {
        const l = Math.hypot(p.vx, p.vz) || 1; myHit.spit = 0.5;
        ctx.onHitMe({ src: 'spit', dx: p.vx / l, dz: p.vz / l, power: 0.7, poison: true }); dead = true;
      }
      if (dead) { if (p.life > 0) ctx.fx.spark(p.g.position.x, Math.max(gy + 0.2, p.g.position.y), p.g.position.z); scene.remove(p.g); proj.splice(i, 1); }
    }
    for (let i = arcs.length - 1; i >= 0; i--) {
      const a = arcs[i]; a.t += dt; const u = Math.min(1, a.t / a.dur);
      a.m.position.set(a.sx + (a.tx - a.sx) * u, a.sy + (a.ty - a.sy) * u + Math.sin(u * Math.PI) * 3.2, a.sz + (a.tz - a.sz) * u);
      if (u >= 1) { landWeb(a); scene.remove(a.m); arcs.splice(i, 1); }
    }
    // webs: age runs locally on everyone (the owner's stream re-bases it)
    const seen = new Set();
    for (const w of B.webs) {
      seen.add(w.id); const v = webVisual(w); w.age += dt;
      const grow = clamp(w.age / 0.35, 0, 1), fade = clamp((BOSS.web.life - w.age) / 1.6, 0, 1);
      v.m.scale.setScalar(BOSS.web.radius * (0.4 + 0.6 * grow)); v.m.material.opacity = 0.92 * grow * fade;
    }
    for (const [id, v] of webVis) if (!seen.has(id)) { scene.remove(v.m); v.m.material.dispose(); webVis.delete(id); }
    B.webs = B.webs.filter((w) => w.age < BOSS.web.life);
    // minions
    const mseen = new Set();
    for (const m of B.minions) {
      mseen.add(m.id); const v = minionVisual(m);
      const k = B.owner ? 1 : Math.min(1, dt * 10);
      v.x += ((B.owner ? m.x : m.x) - v.x) * k; v.z += (m.z - v.z) * k; v.ry = wrapA(v.ry + wrapA(m.ry - v.ry) * Math.min(1, dt * 12));
      const grow = Math.min(1, (v.born += dt) / 0.35); v.rig.root.scale.setScalar(0.2 + 0.8 * grow);
      v.rig.root.position.set(v.x, ctx.heightAt(v.x, v.z), v.z); v.rig.root.rotation.y = v.ry;
      if (m.a === 'k') { if (v.a !== 'k') { v.rig.os = null; playOnce(v.rig, 'attack', 1.5); } } else if (!v.rig.os) setLoop(v.rig, m.a === 'w' ? 'walk' : 'idle', m.a === 'w' ? 1.45 : 1);
      v.a = m.a; tickRig(v.rig, dt);
      // contact with me
      const me = ctx.me();
      if (me.ok && myHit.minion <= 0 && Math.hypot(me.x - v.x, me.z - v.z) < MINI.hitR && Math.abs(me.y - ctx.heightAt(v.x, v.z)) < 1.3 && m.a === 'k') {
        const dx = me.x - v.x, dz = me.z - v.z, l = Math.hypot(dx, dz) || 1; myHit.minion = MINI.hitCd;
        ctx.onHitMe({ src: 'minion', dx: dx / l, dz: dz / l, power: 0.55 });
      }
    }
    for (const [id, v] of minVis) if (!mseen.has(id)) dropMinion(id, v);
    for (let i = ghosts.length - 1; i >= 0; i--) { const g = ghosts[i]; g.t -= dt; tickRig(g.rig, dt); if (g.t <= 0) { disposeRig(g.rig); ghosts.splice(i, 1); } }
    // I cannot walk through the body
    const me = ctx.me();
    if (me.ok && B.dieT <= 0 && B.a !== 'd') {
      const dx = me.x - B.x, dz = me.z - B.z, d = Math.hypot(dx, dz);
      if (d < BOSS.bodyR && me.y < ctx.heightAt(B.x, B.z) + 2.3) { const l = d > 0.05 ? d : 1; ctx.pushMe(B.x + (d > 0.05 ? dx / l : 1) * BOSS.bodyR, B.z + (d > 0.05 ? dz / l : 0) * BOSS.bodyR); }
    }
  }

  // ---------- combat from the players ----------
  function hitTest(cx, cz, radius, y) {
    const out = [];
    if (!B.active) return out;
    if (B.spawnT <= 0 && B.a !== 'd' && B.dieT <= 0 && Math.hypot(cx - B.x, cz - B.z) < BOSS.bodyR + 0.6 + radius && Math.abs(y - ctx.heightAt(B.x, B.z)) < 3.2) out.push({ kind: 'boss', id: 0 });
    for (const m of B.minions) { const v = minVis.get(m.id), px = v ? v.x : m.x, pz = v ? v.z : m.z; if (Math.hypot(cx - px, cz - pz) < 0.45 + radius) out.push({ kind: 'minion', id: m.id }); }
    return out;
  }
  function damage(kind, id, amount, fromId) {
    if (!B.owner || !B.active) return false;
    if (kind === 'boss') {
      if (B.spawnT > 0 || B.dieT > 0 || B.hp <= 0) return false;
      const now = performance.now(), last = O.hitAt.get(fromId) || -1e9;
      if (now - last < BOSS.dmgCooldown * 1000) return false;
      O.hitAt.set(fromId, now);
      B.hp = Math.max(0, B.hp - clamp(amount, 1, 25));
      if (boss) boss.flash = 0.12;
      ctx.fx.spark(B.x + (Math.random() - 0.5) * 2, ctx.heightAt(B.x, B.z) + 1.6, B.z + (Math.random() - 0.5) * 2);
      if (B.hp <= 0) { B.a = 'd'; B.dieT = BOSS.dieT; B.ac++; O.act = null; timers.length = 0; B.minions = []; ctx.fx.thump(1); emit('die', { by: fromId }); }
      emit('hp', { hp: B.hp, maxHp: B.maxHp });
      return true;
    }
    if (kind === 'minion') {
      const m = B.minions.find((q) => q.id === id); if (!m) return false;
      m.hp -= clamp(amount, 1, 25); return true;
    }
    return false;
  }
  function slowAt(x, z) {
    let s = 1;
    for (const w of B.webs) if (Math.hypot(x - w.x, z - w.z) < BOSS.web.radius * 0.95 && w.age < BOSS.web.life - 0.5) s = Math.min(s, BOSS.web.slow);
    return s;
  }

  // ---------- network ----------
  function snapshot() {
    if (!B.active || !B.owner) return null;
    return {
      id: ctx.myId, n: ++B.seq, b: B.born, ep: B.ep, hp: Math.round(B.hp), mh: B.maxHp, x: r2(B.x), z: r2(B.z), r: r2(B.ry), a: B.a, ac: B.ac, sa: r2(B.sa), wt: B.wt,
      w: B.webs.slice(0, 7).map((w) => [w.id, r2(w.x), r2(w.z), r2(w.age)]),
      m: B.minions.slice(0, 8).map((m) => [m.id, r2(m.x), r2(m.z), r2(m.ry), m.hp, m.a]),
    };
  }
  const A_OK = new Set(['i', 'w', 's', 'sw', 'sp', 'wb', 'sm', 'd', 'h']);
  function applySnapshot(d, senderId) {
    if (!d || typeof d !== 'object') return false;
    const x = finite(d.x, -90, 90), z = finite(d.z, -100, 100), ry = finite(d.r, -7, 7), hp = finite(d.hp, 0, 5000), mh = finite(d.mh, 1, 5000);
    const born = finite(d.b, 0, 1e15), ep = finite(d.ep, 0, 1e6), ac = finite(d.ac, 0, 1e9);
    if ([x, z, ry, hp, mh, born, ep, ac].some((v) => v === null) || !A_OK.has(d.a)) return false;
    if (B.active && B.owner) {
      if (!outranks(ep, born, senderId, B.ep, B.born, ctx.myId)) return false;   // I am the rightful owner: ignore
      resetState();                                                               // yield: another owner outranks me
    } else if (B.active && B.ownerId && B.ownerId !== senderId && !outranks(ep, born, senderId, B.ep, B.born, B.ownerId)) return false;
    const fresh = !B.active;
    if (fresh) { resetState(); B.active = true; B.x = x; B.z = z; B.ry = ry; B.spawnT = d.a === 's' ? BOSS.spawnT : 0; R.lastAc = ac; load().then(() => ensureBoss()).catch(() => despawn()); emit('spawn', { owner: false }); }
    B.owner = false; B.ownerId = senderId; B.ep = ep; B.born = born; B.maxHp = mh;
    R.tx = x; R.tz = z; R.try_ = ry; R.lastSnap = performance.now();
    if (hp < B.hp && boss) boss.flash = 0.12;
    if (hp !== B.hp) { B.hp = hp; emit('hp', { hp, maxHp: mh }); }
    if (d.a === 'd' && B.a !== 'd') { B.dieT = 0; emit('die', {}); }
    const wasA = B.a; B.a = d.a;
    if (ac !== R.lastAc) {
      const adv = ac - R.lastAc; R.lastAc = ac;
      if (adv > 0 && adv < 6 && (d.a === 'sw' || d.a === 'sp' || d.a === 'wb' || d.a === 'sm')) {
        const aim = finite(d.sa, -7, 7) ?? ry, wt = Array.isArray(d.wt) ? d.wt : null;
        B.sa = aim; B.wt = wt; startAction(d.a, aim, wt, true);
      }
    }
    // webs and minions come as lists (a new id appears, a missing id goes)
    if (Array.isArray(d.w)) {
      const ws = [];
      for (const q of d.w.slice(0, 7)) {
        if (!Array.isArray(q)) continue;
        const id = finite(q[0], 0, 1e9), wx = finite(q[1], -90, 90), wz = finite(q[2], -100, 100), age = finite(q[3], 0, 60);
        if ([id, wx, wz, age].some((v) => v === null)) continue;
        ws.push({ id, x: wx, z: wz, age: age + 0.06 });
      }
      B.webs = ws;
    }
    if (Array.isArray(d.m)) {
      const ms = [];
      for (const q of d.m.slice(0, 8)) {
        if (!Array.isArray(q)) continue;
        const id = finite(q[0], 0, 1e9), mx = finite(q[1], -90, 90), mz = finite(q[2], -100, 100), mr = finite(q[3], -7, 7), mhp = finite(q[4], 0, 999);
        if ([id, mx, mz, mr, mhp].some((v) => v === null) || !['i', 'w', 'k'].includes(q[5])) continue;
        ms.push({ id, x: mx, z: mz, ry: mr, hp: mhp, a: q[5] });
      }
      B.minions = ms;
    }
    return true;
  }

  return {
    load, spawn, despawn, update, snapshot, applySnapshot, hitTest, damage, slowAt,
    on(k, f) { (listeners[k] = listeners[k] || []).push(f); },
    act(name) { if (B.owner && B.active && !O.act && B.spawnT <= 0 && B.dieT <= 0 && ['sw', 'sp', 'wb', 'sm'].includes(name)) { ownerBegin(name, nearest(B.x, B.z)); return true; } return false; },   // test hook
    get active() { return B.active; }, get owner() { return B.owner; }, get ownerId() { return B.ownerId; },
    get view() { return { born: B.born, active: B.active, owner: B.owner, hp: B.hp, maxHp: B.maxHp, a: B.a, rage: B.rage, x: B.x, z: B.z, ry: B.ry, minions: B.minions.length, webs: B.webs.length, proj: proj.length, spawnT: B.spawnT, dying: B.a === 'd' }; },
    get debug() { return { B, O, R, boss, proj, arcs, webVis, minVis, ghosts, timers, myHit }; },
    BOSS, MINI,
  };
}
