// 보스 전용 PBR 조명(대악마 · 대검 지휘관 · 히드라) — 공용 로더의 「색 × 0.14~0.3 회색 자가발광」을 대신한다.
// 회색 자가발광은 그늘·노멀맵·AO 를 모두 지워 몸이 평평한 회색 판처럼 보이게 했다. 여기서는 발광을 끄고(눈·균열·심장 같은
// 진짜 발광만 남김) 셰이더에 보스 전용 빛 넷을 더한다(장면의 다른 물체에는 영향 없음):
//   key  — 화면 왼쪽 위 앞에서 오는 차가운 달빛 키(노멀맵·AO 를 따라 근육·주름·비늘 음영이 선다)
//   wrap — 그늘 경계로 번지는 따뜻한 반사광(피부 밑 산란 느낌)
//   rim  — 실루엣 테두리 빛(밤하늘에서도 윤곽이 읽힌다)
//   spec — 러프니스(맵)가 정하는 하이라이트(판금·뿔 끝·이빨·젖은 비늘의 윤기)
// 표의 값: [key, wrap(r,g,b), rim, spec, 발광색, 발광세기, 발광에 색맵]
export const KEY_DIR = [-0.45, 0.62, 0.64];   // 보기 공간(카메라 기준) 방향

export const DEFAULT_LOOK = [0.9, [0.14, 0.08, 0.06], 0.4, 0.5, '#000000', 0, false];

// 이름(정확히) → 표 값. 없으면 정규식 목록 → 없으면 DEFAULT_LOOK. glow: 진짜 발광 재질(그대로 둔다).
export function lookFor(table, name) {
  if (table.exact && table.exact[name]) return table.exact[name];
  for (const [re, v] of table.match || []) if (re.test(name)) return v;
  return table.fallback || DEFAULT_LOOK;
}

export function applyLook(THREE, rig, table, tag = 'bossLook') {
  for (const m of rig.mats) {
    if (!m || !m.isMeshStandardMaterial || !m.emissive) continue;
    if (table.glow && table.glow.test(m.name)) continue;          // 눈·균열·심장: 원래 발광 유지
    const [key, wrap, rim, spec, ec, ei, emap] = lookFor(table, m.name);
    m.emissive.set(ec); m.emissiveIntensity = ei; if (emap && m.map) m.emissiveMap = m.map;
    const b = rig.base && rig.base.get(m); if (b) { b.e.copy(m.emissive); b.i = ei; }
    if (m.aoMap) m.aoMapIntensity = 1.0;
    if (!THREE.Vector3 || typeof m.onBeforeCompile !== 'function') continue;
    const U = { dKey: { value: key }, dWrap: { value: new THREE.Vector3(...wrap) }, dRim: { value: rim }, dSpec: { value: spec }, dDir: { value: new THREE.Vector3(...KEY_DIR).normalize() } };
    m.userData.bossLook = U;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.fragmentShader = 'uniform float dKey, dRim, dSpec; uniform vec3 dWrap, dDir;\n' + sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      {
        float dn = dot(normal, dDir);
        vec3 dv = normalize(vViewPosition);
        float kd = max(dn, 0.0);
        float wr = clamp((dn + 0.6) / 1.6, 0.0, 1.0) * (1.0 - kd);
        float fr = pow(1.0 - clamp(dot(normal, dv), 0.0, 1.0), 3.0);
        vec3 hv = normalize(dDir + dv);
        float sp = pow(max(dot(normal, hv), 0.0), mix(8.0, 90.0, 1.0 - roughnessFactor)) * (1.0 - roughnessFactor);
        reflectedLight.directDiffuse += diffuseColor.rgb * (vec3(0.62, 0.66, 0.8) * dKey * kd + dWrap * wr);
        reflectedLight.directSpecular += mix(vec3(0.8, 0.82, 0.95), diffuseColor.rgb * 1.6, metalnessFactor) * dSpec * sp * kd;
        reflectedLight.directDiffuse += (diffuseColor.rgb * 0.8 + vec3(0.05, 0.04, 0.07)) * vec3(0.8, 0.75, 1.0) * dRim * fr;   // 테두리 빛도 제 색을 띤다(연보라 막 방지)
      }`);
    };
    m.customProgramCacheKey = () => tag;
    m.needsUpdate = true;
  }
}

// 부드러운 2차 움직임(망토·갈기·날개막): 임계 감쇠 스프링. 목표 각도를 따라가되 늦게·출렁이며.
export function spring(st, key, target, dt, k = 28, c = 7) {
  const s = st[key] || (st[key] = { x: target, v: 0 });
  const h = Math.min(dt, 0.05);
  s.v += (k * (target - s.x) - c * s.v) * h; s.x += s.v * h;
  if (!Number.isFinite(s.x)) { s.x = target; s.v = 0; }
  return s.x;
}

// 숨쉬기: 들숨 짧고 날숨 긴 비대칭 곡선(0~1)
export function breath(t, rate = 0.22) {
  const p = (t * rate) % 1;
  return p < 0.4 ? Math.sin((p / 0.4) * Math.PI / 2) ** 2 : Math.cos(((p - 0.4) / 0.6) * Math.PI / 2) ** 2;
}
