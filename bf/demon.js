// bf/demon.js — 대악마(Great Demon): bf/bosses.js 의 거대 보스 틀에 꽂히는 확장(ext). 모델은 tools/bosses/build_demon.py → bf/demon.glb.
//
// 패턴(모두 같은 시간표로 재생, 내가 맞았는지는 내 화면에서 판정):
//   claw  — 손톱 할퀴기: 왼손 → 오른손 두 번 앞쪽 부채꼴을 긁는다(붉은 궤적).
//   rift  — 붉은 균열 광선: 가슴 균열이 달아올랐다가(1.1 s) 광선을 뿜어 땅을 좌→우로 훑는다(분노하면 더 넓게).
//   quake — 지면 균열 폭발: 두 주먹으로 땅을 내리치면 갈라진 금이 세 줄(분노 다섯 줄)로 뻗어 나가며 차례로 불기둥이 솟는다.
// 등장: 땅이 붉게 갈라지고 불기둥 고리 속에서 솟아오른다. 처치: 무릎 꿇고 앞으로 쓰러지며 가슴 불이 꺼진다.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const win = (t, a, b) => clamp((t - a) / (b - a), 0, 1);   // a..b 구간 진행도

// 지면 균열 폭발 지점: 시작 위치·조준 각만으로 정해진다(네트워크로 점을 보내지 않아도 모두 같은 곳)
export function quakePoints(x, z, sa, rage) {
  const n = rage ? 5 : 3, out = [];
  for (let l = 0; l < n; l++) {
    const ang = sa + (l - (n - 1) / 2) * (rage ? 0.5 : 0.6);
    const fx = -Math.sin(ang), fz = -Math.cos(ang);
    for (let r = 6, k = 0; r <= 34; r += 4, k++) out.push({ x: x + fx * r, z: z + fz * r, delay: 0.25 + k * 0.16 });
  }
  return out;
}
// 균열 광선의 끝점: 조준 각에서 좌→우로 훑는다(u: 0..1)
export function riftEnd(x, z, sa, tx, tz, u, rage) {
  const sweep = rage ? 0.75 : 0.5, d = clamp(Math.hypot(tx - x, tz - z), 12, 46);
  const ang = sa + lerp(-sweep, sweep, u);
  return { x: x - Math.sin(ang) * d, z: z - Math.cos(ang) * d };
}
function segDist3(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, l2 = abx * abx + aby * aby + abz * abz || 1;
  const u = clamp(((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / l2, 0, 1);
  return Math.hypot(px - (ax + abx * u), py - (ay + aby * u), pz - (az + abz * u));
}

export const DEMON = {
  name: '대악마', title: '불타는 심장 · 대악마', file: 'demon.glb', hp: 6800, hpPerExtra: 2200, hitReach: 30, camR: 1.0, camLift: 1.35, lodD: 75,
  speed: 4.6, turn: 1.0, spawnT: 3.6, dieT: 6.0, fly: false, water: false,
  // 몸 캡슐: [뼈, a(Blender), b(Blender), 반지름, col] — 머리는 1.35배로 키운 모델 기준
  hull: [['hips', [0, 0, 6.6], [0, 0.5, 8.8], 2.2, true], ['spine', [-3.0, 0.5, 11.2], [3.0, 0.5, 11.2], 2.3, true], ['spine', [0, 1.0, 9.0], [0, 0, 12.6], 2.4],
    ['head', [0, 2.4, 13.7], [0, 4.6, 12.9], 1.45], ['head', [-1.6, 3.0, 15.0], [1.6, 3.0, 15.0], 0.9],
    ['armL', [-4.1, 1.0, 11.8], [-5.3, 2.0, 8.8], 1.3], ['foreL', [-5.3, 2.0, 8.8], [-5.6, 3.8, 6.0], 1.05], ['handL', [-5.6, 3.8, 6.0], [-5.7, 5.0, 4.2], 1.05],
    ['armR', [4.1, 1.0, 11.8], [5.3, 2.0, 8.8], 1.3], ['foreR', [5.3, 2.0, 8.8], [5.6, 3.8, 6.0], 1.05], ['handR', [5.6, 3.8, 6.0], [5.7, 5.0, 4.2], 1.05],
    ['thighL', [-1.9, 0.2, 7.0], [-2.5, 1.8, 4.0], 1.4], ['shinL', [-2.5, 1.8, 4.0], [-2.6, 0.3, 0.6], 1.05],
    ['thighR', [1.9, 0.2, 7.0], [2.5, 1.8, 4.0], 1.4], ['shinR', [2.5, 1.8, 4.0], [2.6, 0.3, 0.6], 1.05]],
  patterns: [
    { code: 'claw', w: 5, cd: 4.2, minD: 0, maxD: 17, dur: 2.0 },
    { code: 'rift', w: 4, cd: 7.5, minD: 9, maxD: 60, dur: 3.3 },
    { code: 'quake', w: 4, cd: 8.5, minD: 0, maxD: 42, dur: 3.6 },
  ],
  // 패턴 피해(내 HP 100 기준) · 넉백
  hits: { claw: [30, 2.8], rift: [14, 1.0], quake: [28, 2.6] },
  msgs: { claw: '대악마의 손톱에 찢겼습니다!', rift: '가슴의 붉은 광선에 타올랐습니다!', quake: '갈라진 땅에서 솟은 불기둥에 휩쓸렸습니다!' },
  ext: null,   // 아래에서 채운다
};

// ---------------------------------------------------------------------------------------------------------------------
// 확장: bosses.js 가 X(내부 도구 묶음)를 넘겨 부른다. 상태는 X.S 에 둔다(보스 인스턴스마다 하나).
// ---------------------------------------------------------------------------------------------------------------------
function res(X) {
  if (X.S.res) return X.S.res;
  const { THREE } = X;
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
  const m = (c, o) => new THREE.MeshBasicMaterial({ color: c, ...add, opacity: o });
  X.S.res = {
    arc: new THREE.RingGeometry(0.82, 1, 40, 1, -0.2, Math.PI * 0.9).rotateX(-Math.PI / 2),
    disc: new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).translate(0, 0.5, 0),
    cone: new THREE.CylinderGeometry(0.15, 1, 1, 12, 1, true).translate(0, 0.5, 0),
    m, add,
  };
  return X.S.res;
}
function own(X, c, o) { const mm = res(X).m(c, o); mm.userData.own = true; return mm; }
function drop(X, f) { if (f.g) { X.scene.remove(f.g); f.g.traverse((o) => { if (o.material && o.material.userData.own) o.material.dispose(); }); f.g = null; } }
function fxAdd(X, f) { (X.S.fx || (X.S.fx = [])).push(f); return f; }
function chestPos(X) {   // 가슴 균열(앞면) 세계 좌표 — 뼈가 있으면 등뼈 기울기를 따른다
  const { B } = X, fx = -Math.sin(B.ry), fz = -Math.cos(B.ry);
  const lean = X.S.lean || 0;
  return { x: B.x + fx * (2.9 + lean * 2.4), y: B.y + 11.1 - lean * 1.2, z: B.z + fz * (2.9 + lean * 2.4) };
}

const ext = {
  light(THREE, root) { const l = new THREE.PointLight('#ff2a14', 0, 46, 1.5); root.add(l); l.position.set(0, 11.1, -3.6); return l; },

  reset(X) { for (const f of X.S.fx || []) drop(X, f); X.S.fx = []; X.S.lean = 0; X.S.charge = 0; },

  intro(X) {   // 땅이 붉게 갈라지고 불기둥 고리 속에서 솟아오른다
    const { B, ctx } = X;
    ctx.sfx(X.kind, 'quake', B.x, B.z);
    X.addFx({ type: 'ring', x: B.x, z: B.z, r0: 2, r1: 30, t: 0, life: 1.8, hit: false, color: '#ff3a1a' });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU, r = 9 + (i % 2) * 3;
      fxAdd(X, { type: 'erupt', x: B.x + Math.sin(a) * r, z: B.z + Math.cos(a) * r, t: -0.15 * i, warn: 0.5, life: 1.6, hit: false });
    }
    for (let i = 0; i < 8; i++) setTimeout(() => ctx.fx.poof(B.x + (Math.random() - 0.5) * 12, ctx.heightAt(B.x, B.z) + 0.2, B.z + (Math.random() - 0.5) * 12, 6), i * 200);
  },

  run(X, a, dt, h) {
    const { B, ctx, kind } = X, T = h.T, g = ctx.heightAt;
    const fwd = () => [-Math.sin(B.ry), -Math.cos(B.ry)];
    if (a.code === 'claw') {   // 한 걸음 다가서며 왼손 → 오른손
      h.turnTo(h.tgA, 1.8);
      if (a.t > 0.3 && a.t < 0.7 && Math.hypot(T.x - B.x, T.z - B.z) > 9) X.moveBy(6 * dt);
      for (const [key, at, side] of [['l', 0.72, -1], ['r', 1.32, 1]]) {
        if (X.once(a, key, at)) {
          const [fx, fz] = fwd();
          X.hitCone(B.x + fx * 2, B.z + fz * 2, B.ry, 15, 1.15, 'claw', 6);
          ctx.sfx(kind, 'claw', B.x + fx * 8, B.z + fz * 8); ctx.shake(0.45, 0.35);
          fxAdd(X, { type: 'slash', x: B.x + fx * 4, z: B.z + fz * 4, y: B.y + 6.5 + side * 0.6, ry: B.ry, side, t: 0, life: 0.45 });
        }
      }
    } else if (a.code === 'rift') {   // 충전 1.1 s → 1.5 s 동안 광선으로 땅을 훑는다
      const ch = 1.1, on = 1.5;
      h.turnTo(h.tgA, a.t < ch ? 1.2 : 0.15);
      X.S.charge = win(a.t, 0, ch);
      if (a.t < ch && Math.random() < dt * 24) { const c = chestPos(X); ctx.fx.spark(c.x + (Math.random() - 0.5) * 3, c.y + (Math.random() - 0.5) * 3, c.z + (Math.random() - 0.5) * 3); }
      if (X.once(a, 'fire', ch)) { ctx.sfx(kind, 'rift', B.x, B.z); ctx.shake(0.6, on); }
      if (a.t >= ch && a.t < ch + on) {
        const u = (a.t - ch) / on, c = chestPos(X), e = riftEnd(h.F.x, h.F.z, B.sa, T.x, T.z, u, B.rage), ey = g(e.x, e.z) + 0.3;
        a.beam = { ax: c.x, ay: c.y, az: c.z, bx: e.x, by: ey, bz: e.z };
        if (Math.random() < dt * 30) ctx.fx.spark(e.x + (Math.random() - 0.5) * 2, ey + Math.random(), e.z + (Math.random() - 0.5) * 2);
        if (Math.random() < dt * 8) ctx.fx.poof(e.x, ey, e.z, 3);
        const m = ctx.me();
        if (m.ok && segDist3(m.x, m.y + 0.9, m.z, c.x, c.y, c.z, e.x, ey, e.z) < 2.2) X.hitMe('rift', e.x - c.x, e.z - c.z);
        if (Math.floor(u * 6) !== Math.floor((u - dt / on) * 6)) fxAdd(X, { type: 'scorch', x: e.x, z: e.z, t: 0, life: 2.4 });
      } else a.beam = null;
    } else if (a.code === 'quake') {   // 두 주먹 내려치기 → 균열이 뻗으며 불기둥
      h.turnTo(h.tgA, 1.0);
      if (X.once(a, 'slam', 1.05)) {
        const [fx, fz] = fwd(), cx = B.x + fx * 5.5, cz = B.z + fz * 5.5;
        X.hitCircle(cx, cz, 6.5, 'quake', 0); ctx.shake(1.3, 1.1); ctx.sfx(kind, 'quake', cx, cz);
        X.addFx({ type: 'ring', x: cx, z: cz, r0: 2, r1: 16, t: 0, life: 0.9, hit: false, color: '#ff4a20' });
        for (let i = 0; i < 8; i++) ctx.fx.poof(cx + (Math.random() - 0.5) * 8, g(cx, cz) + 0.2, cz + (Math.random() - 0.5) * 8, 6);
        for (const p of quakePoints(h.F.x, h.F.z, B.sa, B.rage)) fxAdd(X, { type: 'erupt', x: p.x, z: p.z, t: -p.delay, warn: 0.55, life: 1.5, hit: true });
      }
    }
    X.S.beam = a.code === 'rift' ? a.beam : null;
    if (a.code !== 'rift') X.S.charge = Math.max(0, (X.S.charge || 0) - dt * 2);
  },

  tick(X, dt, t) {
    const { THREE, scene, ctx } = X, R = res(X);
    if (!THREE.Mesh) return;
    // 균열 광선(재생 중일 때만)
    const bm = X.S.beam && X.B.active && X.B.a === 'rift' ? X.S.beam : null;
    if (bm) {
      if (!X.S.beamG) {
        const g = new THREE.Group(), o = new THREE.Mesh(R.cyl, own(X, '#ff2a10', 0.55)), c = new THREE.Mesh(R.cyl, own(X, '#ffd0a0', 0.95)), s = new THREE.Mesh(R.disc, own(X, '#ff5020', 0.8));
        g.add(o, c); scene.add(g); scene.add(s); X.S.beamG = { g, o, c, s, q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), d: new THREE.Vector3() };
      }
      const G = X.S.beamG, dx = bm.bx - bm.ax, dy = bm.by - bm.ay, dz = bm.bz - bm.az, L = Math.hypot(dx, dy, dz) || 1;
      G.g.visible = G.s.visible = true;
      G.g.position.set(bm.ax, bm.ay, bm.az); G.d.set(dx / L, dy / L, dz / L); G.q.setFromUnitVectors(G.up, G.d); G.g.quaternion.copy(G.q);
      const fl = 1 + 0.15 * Math.sin(t * 40);
      G.o.scale.set(1.5 * fl, L, 1.5 * fl); G.c.scale.set(0.55 * fl, L, 0.55 * fl);
      G.s.position.set(bm.bx, bm.by, bm.bz); G.s.scale.setScalar(3.2 * fl);
    } else if (X.S.beamG) { X.S.beamG.g.visible = X.S.beamG.s.visible = false; }
    const fx = X.S.fx || [];
    const m = ctx.me();
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i]; f.t += dt;
      if (f.t < 0) continue;
      if (f.type === 'slash') {   // 손톱 궤적: 앞쪽 허공에 붉은 호 세 줄
        if (!f.g) {
          f.g = new THREE.Group();
          for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(R.arc, own(X, k === 1 ? '#ffd0b0' : '#ff2a18', 0.9)); s.position.y = (k - 1) * 0.9; s.scale.setScalar(9 + k * 0.7); f.g.add(s); }
          f.g.position.set(f.x, f.y, f.z); f.g.rotation.set(f.side * 0.35, f.ry + (f.side < 0 ? 0.2 : Math.PI - 0.2), 0); scene.add(f.g);
        }
        const u = f.t / f.life;
        f.g.children.forEach((c, k) => { c.material.opacity = 0.9 * (1 - u); c.rotation.y = -f.side * u * 0.6; });
        if (u >= 1) { drop(X, f); fx.splice(i, 1); }
      } else if (f.type === 'erupt') {   // 바닥 균열 표식(warn) → 불기둥(원 안이면 맞음)
        const gy = ctx.heightAt(f.x, f.z) + 0.15;
        if (!f.g) {
          f.g = new THREE.Group();
          const crack = new THREE.Mesh(R.disc, own(X, '#ff2a10', 0.7)), col = new THREE.Mesh(R.cone, own(X, '#ff5a1a', 0)), core = new THREE.Mesh(R.cone, own(X, '#ffe0a0', 0));
          f.g.add(crack, col, core); f.p = { crack, col, core }; f.g.position.set(f.x, gy, f.z); scene.add(f.g);
        }
        const P = f.p, w = Math.min(1, f.t / f.warn), on = f.t >= f.warn, k = on ? clamp(1 - (f.t - f.warn) / (f.life - f.warn), 0, 1) : 0;
        P.crack.scale.set(3.0 * w, 1, 3.0 * w * (0.5 + 0.5 * w)); P.crack.material.opacity = on ? 0.6 * k : 0.35 + 0.35 * Math.sin(f.t * 30);
        const rise = on ? Math.min(1, (f.t - f.warn) / 0.15) : 0;
        P.col.scale.set(2.6 * (0.6 + 0.4 * k), 10 * rise * (0.7 + 0.3 * k), 2.6 * (0.6 + 0.4 * k)); P.col.material.opacity = on ? 0.7 * k : 0;
        P.core.scale.set(1.0, 12 * rise, 1.0); P.core.material.opacity = on ? 0.9 * k : 0;
        if (on && !f.fired) {
          f.fired = true;
          if (f.hit) { ctx.sfx(X.kind, 'erupt', f.x, f.z); ctx.shake(0.25, 0.25); }
          ctx.fx.poof(f.x, gy, f.z, 4); for (let s = 0; s < 3; s++) ctx.fx.spark(f.x + (Math.random() - 0.5) * 2, gy + Math.random() * 4, f.z + (Math.random() - 0.5) * 2);
          if (f.hit && m.ok) { const d = Math.hypot(m.x - f.x, m.z - f.z); if (d < 3.2 && m.y - ctx.heightAt(m.x, m.z) < 4) X.hitMe('quake', (m.x - f.x) / (d || 1), (m.z - f.z) / (d || 1)); }
        }
        if (f.t >= f.life) { drop(X, f); fx.splice(i, 1); }
      } else if (f.type === 'scorch') {   // 광선이 지나간 그을린 자국
        if (!f.g) { f.g = new THREE.Mesh(R.disc, own(X, '#ff3a10', 0.5)); f.g.position.set(f.x, ctx.heightAt(f.x, f.z) + 0.1, f.z); f.g.scale.setScalar(2.2); scene.add(f.g); }
        f.g.material.opacity = 0.5 * (1 - f.t / f.life);
        if (f.t >= f.life) { drop(X, f); fx.splice(i, 1); }
      }
    }
  },

  anim(X, o, dt, t, s) {
    const { B, pose } = X, rig = X.rig;
    const { at, code, se, dying, dk, dieU, ph, a } = s;
    const walk = B.a === 'move' ? 1 : 0, w = ph * 0.55, sn = Math.sin(w);
    let armL = 0.12 * sn * walk, armR = -0.12 * sn * walk, ayL = 0, ayR = 0, azL = 0.12, azR = -0.12, foreL = -0.35, foreR = -0.35, handL = -0.2, handR = -0.2;
    let spine = 0.08 + 0.04 * Math.sin(t * 0.9), spineY = 0.04 * Math.sin(w * 0.5) * walk, head = -0.05 + 0.05 * Math.sin(t * 0.6), headY = 0.12 * Math.sin(t * 0.35);
    let jaw = 0.18 + 0.08 * Math.sin(t * 1.3);   // 늘 으르렁 벌린 입
    if (code === 'claw') {
      const l1 = win(at, 0, 0.55), l2 = win(at, 0.55, 0.8), r1 = win(at, 0.75, 1.15), r2 = win(at, 1.15, 1.4), back = win(at, 1.5, 2.0);
      armL = lerp(-1.6 * ease(l1), -0.6, ease(l2)) * (1 - back); ayL = lerp(0.9 * ease(l1), -1.0, ease(l2)) * (1 - back); azL = 0.12 + 0.6 * l1 * (1 - l2);
      armR = lerp(-1.6 * ease(r1), -0.6, ease(r2)) * (1 - back); ayR = lerp(-0.9 * ease(r1), 1.0, ease(r2)) * (1 - back); azR = -0.12 - 0.6 * r1 * (1 - r2);
      handL = handR = -0.5; spine = 0.25; spineY = (0.3 * l2 - 0.3 * r2) * (1 - back); jaw = 0.55;
    } else if (code === 'rift') {
      const ch = win(at, 0, 1.1), fire = at >= 1.1 && at < 2.6 ? 1 : 0, end = win(at, 2.6, 3.3);
      spine = lerp(-0.3 * ease(ch), 0.22, fire) * (1 - end); azL = 0.12 + 0.9 * ease(ch) * (1 - end); azR = -azL; armL = armR = -0.4 * ch * (1 - end);
      head = -0.35 * ch * (1 - fire) + 0.15 * fire; jaw = 0.25 + 0.75 * Math.max(ch * (1 - fire), fire) * (1 - end);
      if (fire) spineY = 0.25 * Math.sin((at - 1.1) / 1.5 * Math.PI - Math.PI / 2) * (B.rage ? 1.4 : 1);
    } else if (code === 'quake') {
      const up = ease(win(at, 0, 0.85)), dn = win(at, 0.85, 1.05), rec = win(at, 1.8, 3.4);
      armL = armR = (-2.7 * up * (1 - dn) + 0.35 * dn) * (1 - rec); foreL = foreR = -0.35 - 0.5 * up * (1 - dn);
      spine = (-0.25 * up * (1 - dn) + 0.55 * dn) * (1 - rec) + 0.08; head = 0.25 * dn * (1 - rec); jaw = 0.3 + 0.6 * up;
    }
    if (B.spawnT > 0) { o.y = B.y - 17 * (1 - se); armL = armR = -2.2 * (1 - se); spine = -0.35 * (1 - se); jaw = 0.9; head = -0.4 * (1 - se); }
    X.S.lean = spine;
    pose('hips', 0, 0, 0); pose('spine', spine, spineY, 0); pose('head', head, headY, 0); pose('jaw', -0.55 * jaw, 0, 0);
    pose('armL', armL, ayL, azL); pose('armR', armR, ayR, azR); pose('foreL', foreL, 0, 0); pose('foreR', foreR, 0, 0); pose('handL', handL, 0, 0); pose('handR', handR, 0, 0);
    pose('thighL', 0.4 * sn * walk, 0, 0); pose('thighR', -0.4 * sn * walk, 0, 0); pose('shinL', 0.3 * Math.max(0, -sn) * walk, 0, 0); pose('shinR', 0.3 * Math.max(0, sn) * walk, 0, 0);
    o.y += Math.abs(Math.cos(w)) * 0.3 * walk;
    if (walk && rig && Math.sign(sn) !== rig.lastStep) { rig.lastStep = Math.sign(sn); X.ctx.shake(0.15, 0.2); X.ctx.sfx(X.kind, 'step', B.x, B.z); }
    if (dying) {   // 무릎 꿇고 → 앞으로 쓰러진다
      const kneel = ease(win(dieU, 0, 0.45)), fall = ease(win(dieU, 0.4, 1));
      pose('thighL', -1.0 * kneel, 0, 0); pose('thighR', -1.0 * kneel, 0, 0); pose('shinL', 1.4 * kneel, 0, 0); pose('shinR', 1.4 * kneel, 0, 0);
      pose('armL', 0.4 * kneel, 0, 0.4); pose('armR', 0.4 * kneel, 0, -0.4); pose('jaw', -0.5, 0, 0); pose('head', 0.4 * kneel, 0, 0);
      o.y = B.y - 3.2 * kneel - 4 * clamp((dk - 0.5) / 0.5, 0, 1); o.pitch = 1.25 * fall;
    }
    // 가슴 불: 숨 쉬듯 → 광선 충전 때 크게, 분노 때 더 밝게, 죽으면 꺼진다
    if (rig) {
      const hk = dying ? 1 - dk : se, ch = X.S.charge || 0;
      rig.glow = hk * (0.75 + 0.25 * Math.sin(t * 2.6) + 1.6 * ch + (B.rage ? 0.5 : 0));
      if (rig.light) rig.light.intensity = 16 * rig.glow;
      if (!rig.eyeFix) { rig.eyeFix = true; for (const m of rig.mats) if (m.name === 'demon_eye') { const bb = rig.base.get(m); m.emissiveIntensity = 1.4; if (bb) bb.i = 1.4; } }
      if (!(rig.flash > 0)) for (const m of rig.mats) { if (m.name === 'demon_crack' || m.name === 'demon_core') { const b = rig.base.get(m); if (b) m.emissiveIntensity = b.i * (0.4 + 0.7 * rig.glow); } }
    }
  },

  sound(name, k) {   // 합성음(녹음 없음): k = { osc, noise, roar, rumble }
    const { osc, noise, roar, rumble } = k;
    switch (name) {
      case 'intro': case 'rage': rumble(3.0, 1); roar(42, 2.8, 5); roar(63, 2.4, 7); osc('sawtooth', 55, 38, 0.3, 0.25, 2.6); noise('lowpass', 1200, 200, 0.6, 0.2, 0.7, 2.4); return true;
      case 'die': roar(48, 3.2, 3); rumble(3.4, 0.9); osc('sine', 120, 30, 0.1, 0.4, 3.0); return true;
      case 'claw': noise('bandpass', 3200, 900, 2.5, 0.005, 0.8, 0.3); noise('highpass', 5000, 2500, 0.7, 0.003, 0.4, 0.2); roar(80, 0.7, 12); return true;
      case 'rift': osc('sawtooth', 70, 140, 0.05, 0.35, 1.6); osc('square', 210, 420, 0.05, 0.12, 1.5); noise('bandpass', 900, 2600, 1.5, 0.05, 0.6, 1.6); rumble(1.6, 0.6); return true;
      case 'quake': rumble(1.8, 1); noise('bandpass', 700, 120, 1, 0.005, 0.9, 0.7); osc('sine', 60, 28, 0.01, 0.7, 1.2); return true;
      case 'erupt': noise('lowpass', 1600, 300, 0.6, 0.01, 0.6, 0.6); osc('sine', 95, 40, 0.01, 0.35, 0.4); return true;
      case 'step': rumble(0.45, 0.4); return true;
      default: return false;
    }
  },
};
DEMON.ext = ext;
