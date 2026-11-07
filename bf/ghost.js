// bf/ghost.js — 쓰러진 사람 몸에서 「띠용」 하고 튀어 올라 둥실 떠오르는 반투명 유령 (나 · 다른 접속자 모두 같은 연출).
//   const G = createGhosts({ THREE, scene, camera })
//   G.spawn(x, y, z)       // 발 위치에서 유령을 하나 띄운다
//   G.update(dt)           // 매 프레임
//   G.warm(renderer)       // 입장할 때 한 번: 화면 밖 유령으로 셰이더를 미리 컴파일(첫 죽음에서 프레임이 멈추지 않게)
//   G.count                // 지금 떠 있는 유령 수
//   G.dispose()
// 몸 쪽의 「띠용」(튀어 오르는 몸) 은 bf/health.js 가 맡고, 소리는 bf/weapons.js 의 sfx('boing' · 'ghost').
// 시간표(초): 0~0.45 스프링 팝(작게 → 크게 튕겼다 자리잡음) · 떠오름 2.8 s · 1.7 s 부터 흐려져 2.8 s 에 사라짐.

export const GHOST = { life: 2.8, fadeAt: 1.7, rise: 3.4, alpha: 0.72, h: 1.1 };

// 스프링 팝: 0 에서 시작해 1 을 넘었다 돌아와 1 에 자리잡는 값(t 초)
export const pop = (t) => (t <= 0 ? 0 : 1 - Math.exp(-t * 9) * Math.cos(t * 22));
// 찌그러짐: 팝 동안 가로로 늘어나면 세로가 줄고 그 반대(서로 반대 방향으로 출렁인다)
export const wobble = (t) => Math.exp(-t * 5) * Math.sin(t * 24);
// 투명도 곡선: 0.12 s 만에 나타나서 fadeAt 까지 유지, 이후 life 까지 사라짐
export function alphaAt(t) {
  if (t < 0 || t >= GHOST.life) return 0;
  const inn = Math.min(1, t / 0.12), out = t <= GHOST.fadeAt ? 1 : 1 - ((t - GHOST.fadeAt) / (GHOST.life - GHOST.fadeAt)) ** 1.4;
  return GHOST.alpha * inn * Math.max(0, out);
}
// 높이 오름: 처음 빠르게 솟았다 천천히 둥실(ease-out)
export const riseAt = (t) => GHOST.rise * (1 - (1 - Math.min(1, t / GHOST.life)) ** 2.2);

export function createGhosts({ THREE: T, scene, camera }) {
  // 몸통: 둥근 머리 + 아래로 퍼지는 이불 모양(옆면 선 → 회전체). 맨 아래 가장자리는 물결(출렁)
  const prof = [[0, 1.1], [0.15, 1.08], [0.27, 1.0], [0.35, 0.87], [0.39, 0.7], [0.41, 0.5], [0.43, 0.3], [0.45, 0.12], [0.45, 0.0]];
  const SEG = 28;
  const bodyGeo = new T.LatheGeometry(prof.map(([r, y]) => new T.Vector2(r, y)), SEG);
  const bottom = prof.length - 1, pos = bodyGeo.attributes.position, base = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) base[i] = pos.getY(i);
  const waveIdx = [];   // 맨 아래 고리(프로필 마지막 점)의 꼭짓점 번호와 그 각도
  for (let s = 0; s <= SEG; s++) waveIdx.push({ i: s * prof.length + bottom, a: (s / SEG) * Math.PI * 2 });
  const eyeGeo = new T.SphereGeometry(0.075, 10, 8), mouthGeo = new T.SphereGeometry(0.07, 10, 8), armGeo = new T.SphereGeometry(0.1, 10, 8);
  const dark = new T.MeshBasicMaterial({ color: 0x14102a, transparent: true, depthWrite: false, fog: false });
  const cheek = new T.MeshBasicMaterial({ color: 0xffa6c0, transparent: true, depthWrite: false, fog: false });
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(190,225,255,0.85)'); gr.addColorStop(0.5, 'rgba(150,200,255,0.28)'); gr.addColorStop(1, 'rgba(150,200,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  })();
  const list = [];

  function spawn(x, y, z) {
    const g = new T.Group(), holder = new T.Group();
    const mat = new T.MeshBasicMaterial({ color: 0xeaf5ff, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide, fog: false });
    const dk = dark.clone(), ck = cheek.clone();   // 투명도가 유령마다 따로 변한다
    const geo = bodyGeo.clone();   // 아래 물결을 유령마다 따로 움직이려면 복제가 필요하다(꼭짓점 280 개 안팎: 가볍다)
    const body = new T.Mesh(geo, mat); body.renderOrder = 8;
    const mk = (geoX, m, px, py, pz, sx = 1, sy = 1, sz = 1) => { const o = new T.Mesh(geoX, m); o.position.set(px, py, pz); o.scale.set(sx, sy, sz); o.renderOrder = 9; return o; };
    // 얼굴은 +Z 쪽(update 가 카메라 쪽으로 돌린다)
    const eyes = [mk(eyeGeo, dk, -0.15, 0.8, 0.34, 1, 1.35, 0.6), mk(eyeGeo, dk, 0.15, 0.8, 0.34, 1, 1.35, 0.6)];
    const mouth = mk(mouthGeo, dk, 0, 0.6, 0.38, 1.25, 1.7, 0.6);   // 「오」 입
    const cheeks = [mk(eyeGeo, ck, -0.27, 0.68, 0.3, 1.3, 0.7, 0.4), mk(eyeGeo, ck, 0.27, 0.68, 0.3, 1.3, 0.7, 0.4)];
    const arms = [mk(armGeo, mat, -0.46, 0.52, 0.05, 1, 0.8, 1), mk(armGeo, mat, 0.46, 0.52, 0.05, 1, 0.8, 1)];
    const glow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: 0 }));
    glow.scale.set(2.4, 2.4, 1); glow.position.y = 0.6; glow.renderOrder = 7;
    holder.add(body, ...eyes, mouth, ...cheeks, ...arms);
    g.add(holder, glow); g.position.set(x, y, z); g.visible = false; scene.add(g);
    const o = { g, holder, geo, mat, dk, ck, glow, eyes, mouth, cheeks, arms, t: 0, x, y, z, ph: Math.random() * 6.28 };
    list.push(o);
    if (list.length > 14) remove(0);   // 한꺼번에 너무 많이 쓰러져도 가볍게: 가장 오래된 것부터 치운다
    return o;
  }
  function remove(i) {
    const o = list[i]; scene.remove(o.g); o.geo.dispose(); o.mat.dispose(); o.dk.dispose(); o.ck.dispose(); o.glow.material.dispose(); list.splice(i, 1);
  }

  const cp = new T.Vector3();
  function update(dt) {
    if (!list.length) return;
    if (camera) camera.getWorldPosition(cp);
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i]; o.t += dt;
      if (o.t >= GHOST.life) { remove(i); continue; }
      const t = o.t, a = alphaAt(t), s = Math.max(0.01, pop(t)), w = wobble(t);
      o.g.visible = true;
      // 위치: 몸에서 솟아올라 둥실(좌우로 살랑)
      o.g.position.set(o.x + Math.sin(t * 2.4 + o.ph) * 0.22 * Math.min(1, t), o.y + 0.25 + riseAt(t), o.z + Math.cos(t * 2.0 + o.ph) * 0.18 * Math.min(1, t));
      // 크기: 스프링 팝 + 가로세로 출렁(띠용)
      o.holder.scale.set(s * (1 + 0.28 * w), s * (1 - 0.28 * w), s * (1 + 0.28 * w));
      if (camera) o.holder.rotation.y = Math.atan2(cp.x - o.g.position.x, cp.z - o.g.position.z);   // 얼굴이 카메라 쪽
      o.holder.rotation.z = Math.sin(t * 3 + o.ph) * 0.12;
      // 아래 물결 가장자리 출렁
      const P = o.geo.attributes.position;
      for (const q of waveIdx) P.setY(q.i, base[q.i] + Math.sin(q.a * 4 + t * 7) * 0.07 + Math.sin(q.a * 7 - t * 5) * 0.03);
      P.needsUpdate = true;
      // 팔을 번쩍 들었다 내림(「우어어」)
      const up = 0.15 * Math.sin(t * 6 + o.ph);
      o.arms[0].position.y = 0.52 + up; o.arms[1].position.y = 0.52 - up;
      // 투명도: 몸·팔은 a, 눈·입은 조금 더 진하게
      o.mat.opacity = a;
      const fa = Math.min(1, a / GHOST.alpha * 1.1);
      o.dk.opacity = fa; o.ck.opacity = fa * 0.65;
      o.glow.material.opacity = a * 0.55; const gs = 2.2 + 0.5 * Math.sin(t * 4); o.glow.scale.set(gs, gs, 1);
    }
  }
  let warmed = false;
  function warm(renderer) {
    if (warmed || !renderer || !renderer.compile) return;
    warmed = true;
    const o = spawn(0, -500, 0); o.g.visible = true;
    try { renderer.compile(scene, camera); } catch (e) { /* 미리 컴파일은 덤: 안 되면 첫 등장 때 컴파일된다 */ }
    remove(list.indexOf(o));
  }
  function dispose() { while (list.length) remove(0); bodyGeo.dispose(); eyeGeo.dispose(); mouthGeo.dispose(); armGeo.dispose(); dark.dispose(); cheek.dispose(); glowTex.dispose(); }
  return { spawn, update, warm, dispose, get count() { return list.length; } };
}
