// node tools/weapon-vfx.test.mjs — bf/weapon-vfx.js 의 순수 수학(입자 운동식 · 고리 버퍼 · 불 색 경사)과 셰이더 문자열, bf/weapons.js 연결을 THREE 없이 확인한다.
import fs from 'node:fs';
import { particleAt, ringSlot, rampAt, FIRE_RAMP, MUZZLE, NOISE_GLSL } from '../bf/weapon-vfx.js';

let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.error('FAIL', m); } };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

// 1) 정점 셰이더와 같은 닫힌 식 = 작은 step 수치 적분
{
  const p0 = [1, 2, 3], v0 = [4, 5, -6], drag = 2.5, g = 9, T = 0.8;
  const p = p0.slice(), v = v0.slice(), h = 1e-5;
  // 닫힌 식은 감쇠를 초기 속도에만, 중력은 감쇠 없이 더한다(셰이더 정의) → 같은 모델로 적분
  const vd = v0.slice();
  for (let t = 0; t < T; t += h) { for (let k = 0; k < 3; k++) { vd[k] *= Math.exp(-drag * h); p[k] += vd[k] * h; } p[1] -= g * (t + h / 2) * h; }
  const r = particleAt(p0, v0, drag, g, T);
  ok(near(r.p[0], p[0], 1e-3) && near(r.p[1], p[1], 1e-3) && near(r.p[2], p[2], 1e-3), 'closed-form position matches integration');
  ok(near(r.v[0], v0[0] * Math.exp(-drag * T)) && near(r.v[1], v0[1] * Math.exp(-drag * T) - g * T), 'velocity decays and falls');
  const z = particleAt([0, 0, 0], [2, 0, 0], 0, 0, 1.5);
  ok(near(z.p[0], 3) && near(z.v[0], 2), 'no drag: straight line');
}
// 2) 고리 버퍼: 가장 오래된 칸부터 덮어쓴다
{
  let c = 0; const seen = new Set(); for (let i = 0; i < 10; i++) seen.add(c = ringSlot(c, 10));
  ok(seen.size === 10 && ringSlot(9, 10) === 0, 'ring wraps over all slots');
}
// 3) 불 색: 흰 심 → 주황 → 검붉음, 밝기 단조 감소
{
  const L = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; let prev = 9, mono = true;
  for (let u = 0; u <= 1.0001; u += 0.05) { const l = L(rampAt(FIRE_RAMP, u)); if (l > prev + 1e-9) mono = false; prev = l; }
  ok(mono, 'fire ramp gets darker with age');
  ok(rampAt(FIRE_RAMP, -1)[0] === 1 && near(rampAt(FIRE_RAMP, 2)[0], 0.12), 'ramp clamps');
}
// 4) 총구 화염 크기: 모든 총, RPG > 산탄 > 소총 > 권총
{
  ok([3, 4, 5, 7, 8].every((s) => MUZZLE[s] && MUZZLE[s].length === 3), 'muzzle table for every gun');
  ok(MUZZLE[8][2] > MUZZLE[4][2] && MUZZLE[4][2] > MUZZLE[3][2] && MUZZLE[3][2] > MUZZLE[5][2], 'flash size order');
}
// 5) 셰이더 · 연결
{
  ok(/float fbm\(vec2/.test(NOISE_GLSL) && /float fbm3\(vec3/.test(NOISE_GLSL), 'noise helpers');
  const src = fs.readFileSync(new URL('../bf/weapon-vfx.js', import.meta.url), 'utf8');
  ok(/InstancedBufferGeometry/.test(src) && /AdditiveBlending/.test(src) && /smoothstep\(thr/.test(src), 'instanced additive particles, dissolve threshold');
  const w = fs.readFileSync(new URL('../bf/weapons.js', import.meta.url), 'utf8');
  ok(/from '\.\/weapon-vfx\.js'/.test(w) && /fxs\.vfx\.boom\(/.test(w) && /fxs\.vfx\.muzzle\(/.test(w) && /vfx\.slashMat\(/.test(w) && /vfx\.deathMat\(/.test(w) && /bladeTrail\(rec\)/.test(w), 'weapons.js uses the shader effects');
  ok(!/ctx\.fx\.spark\(/.test(w), 'weapon hits use the new hit sparks');
  ok(/m\.dispose\(\)/.test(w), 'per-slash materials are disposed');
}
console.log(`${n - fails}/${n} ok`);
process.exit(fails ? 1 : 0);
