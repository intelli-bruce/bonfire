// bf/health.js — 머리 위 HP 바(나 · 다른 접속자 모두)와 쓰러짐/부활 모습. 체력 수치 규칙은 bf/weapons-core.js 의 HP·hpHit·hpTick.
//   const H = createHealthBars({ THREE })
//   H.update(rec, hp, dead, dt, y)   // 매 프레임: hp 0..100, dead true 면 옆으로 쓰러진다, y = 바를 둘 머리 위 높이(아바타 기준)
//   H.dispose(rec)
import { HP } from './weapons-core.js';

export function createHealthBars({ THREE: T }) {
  const W = 128, Hh = 18;
  function make(rec) {
    const c = document.createElement('canvas'); c.width = W; c.height = Hh;
    const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
    const s = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
    s.scale.set(0.95, 0.95 * Hh / W, 1); s.renderOrder = 9; s.name = 'hpbar';
    rec.av.root.add(s);
    rec._hp = { s, c, tex, shown: -1, dead: null, tilt: 0, ghost: HP.max, hitT: 0 };
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
    // 쓰러짐: 아바타 모델이 옆으로 눕는다(부활하면 다시 선다)
    b.tilt += ((dead ? 1 : 0) - b.tilt) * (1 - Math.exp(-dt * 7));
    if (rec.av.model) { rec.av.model.rotation.z = b.tilt * 1.45; rec.av.model.position.y = b.tilt * 0.25; }
  }
  function dispose(rec) {
    const b = rec && rec._hp; if (!b) return;
    if (b.s.parent) b.s.parent.remove(b.s); b.s.material.dispose(); b.tex.dispose(); rec._hp = null;
  }
  return { update, dispose };
}
