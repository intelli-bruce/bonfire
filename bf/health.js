// bf/health.js — 머리 위 HP 바(나 · 다른 접속자 모두)와 쓰러짐/부활 모습. 체력 수치 규칙은 bf/weapons-core.js 의 HP·hpHit·hpTick.
//   const H = createHealthBars({ THREE })
//   H.update(rec, hp, dead, dt, y)   // 매 프레임: hp 0..HP.max, dead true 면 「띠용」 튀어 오른 뒤 옆으로 쓰러진다(처음부터 쓰러져 있던 사람은 그냥 누움), y = 바를 둘 머리 위 높이(아바타 기준)
//   H.dispose(rec)
import { HP } from './weapons-core.js';

// 「띠용」: 쓰러지는 순간 몸이 웅크렸다 솟구치고(늘어남) 착지에 찌그러진 뒤 작게 한 번 더 튄다. t = 쓰러진 뒤 경과(s) → { y: 올라간 높이(m), sx: 가로 배율, sy: 세로 배율 }
export const BOING_T = 1.4;
export function boing(t) {
  if (!(t >= 0) || t >= BOING_T) return { y: 0, sx: 1, sy: 1 };
  if (t < 0.1) { const k = t / 0.1; return { y: 0, sx: 1 + 0.22 * k, sy: 1 - 0.3 * k }; }
  if (t < 0.62) { const u = (t - 0.1) / 0.52, s = Math.sin(Math.PI * u); return { y: 1.15 * s, sx: 1 + 0.22 * (1 - u) - 0.14 * s, sy: 1 - 0.3 * (1 - u) + 0.26 * s }; }
  if (t < 0.86) { const u = (t - 0.62) / 0.24, s = Math.sin(Math.PI * u); return { y: 0, sx: 1 + 0.2 * s, sy: 1 - 0.26 * s }; }
  if (t < 1.2) { const u = (t - 0.86) / 0.34, s = Math.sin(Math.PI * u); return { y: 0.3 * s, sx: 1 - 0.06 * s, sy: 1 + 0.08 * s }; }
  const u = (t - 1.2) / 0.2, s = Math.sin(Math.PI * Math.min(1, u)); return { y: 0, sx: 1 + 0.08 * s, sy: 1 - 0.1 * s };
}

export function createHealthBars({ THREE: T }) {
  const W = 128, Hh = 18;
  function make(rec) {
    const c = document.createElement('canvas'); c.width = W; c.height = Hh;
    const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
    const s = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
    s.scale.set(0.95, 0.95 * Hh / W, 1); s.renderOrder = 9; s.name = 'hpbar';
    rec.av.root.add(s);
    rec._hp = { s, c, tex, shown: -1, dead: null, tilt: 0, ghost: HP.max, hitT: 0, bt: BOING_T };
    return rec._hp;
  }
  function draw(b, hp, dead) {
    const g = b.c.getContext('2d'), k = Math.max(0, Math.min(1, hp / HP.max));
    g.clearRect(0, 0, W, Hh);
    g.fillStyle = 'rgba(12,8,24,0.82)'; g.beginPath(); g.roundRect(1, 1, W - 2, Hh - 2, 8); g.fill();
    if (b.ghost > hp) { g.fillStyle = 'rgba(255,230,180,0.7)'; g.beginPath(); g.roundRect(3, 3, (W - 6) * Math.min(1, b.ghost / HP.max), Hh - 6, 6); g.fill(); }
    g.fillStyle = dead ? '#555' : k > 0.5 ? '#5fe07a' : k > 0.25 ? '#ffc24a' : '#ff4d3a';
    if (k > 0) { g.beginPath(); g.roundRect(3, 3, (W - 6) * k, Hh - 6, 6); g.fill(); }
    g.strokeStyle = 'rgba(255,240,220,0.55)'; g.lineWidth = 1.5; g.beginPath(); g.roundRect(1, 1, W - 2, Hh - 2, 8); g.stroke();
    b.tex.needsUpdate = true;
  }
  function update(rec, hp, dead, dt, y) {
    if (!rec || !rec.av) return;
    const b = rec._hp || make(rec);
    const v = Math.round(hp);
    if (v < b.shown) b.hitT = 0.25;
    b.ghost = b.ghost > v ? Math.max(v, b.ghost - dt * 40) : v;
    if (v !== b.shown || dead !== b.dead || b.ghost > v) { b.shown = v; b.dead = dead; draw(b, v, dead); }
    b.hitT = Math.max(0, b.hitT - dt);
    b.s.position.y += ((y || 2.0) - b.s.position.y) * 0.3;
    const sc = 1 + b.hitT * 0.6; b.s.scale.set(0.95 * sc, 0.95 * Hh / W * sc, 1);
    // 쓰러짐: 처음 쓰러지는 순간 「띠용」 튀어 오르고(몸이 공중에 있는 동안 눕기 시작), 부활하면 다시 선다
    if (dead && b.prevDead === false) b.bt = 0;   // 산 모습을 보다가 쓰러진 순간만(처음부터 쓰러져 있던 사람은 튀지 않는다)
    b.prevDead = dead;
    b.bt = dead ? Math.min(BOING_T, b.bt + dt) : BOING_T;
    b.tilt += ((dead && b.bt > 0.28 ? 1 : 0) - b.tilt) * (1 - Math.exp(-dt * 7));
    const m = rec.av.model;
    if (m) {
      const bo = boing(b.bt), bs = m.userData.hb || (m.userData.hb = m.scale.x);
      m.rotation.z = b.tilt * 1.45; m.position.y = b.tilt * 0.25 + bo.y;
      m.scale.set(bs * bo.sx, bs * bo.sy, bs * bo.sx);
    }
  }
  function dispose(rec) {
    const b = rec && rec._hp; if (!b) return;
    if (b.s.parent) b.s.parent.remove(b.s); b.s.material.dispose(); b.tex.dispose(); rec._hp = null;
  }
  return { update, dispose };
}
