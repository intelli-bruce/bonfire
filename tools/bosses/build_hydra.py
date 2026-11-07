"""
보스 — 뼈 가면 히드라(머리 셋 달린 용). 절차적 모델링 → 뼈대 → LOD 2단 → Draco 압축 glb.

실행:  blender -b --factory-startup --python tools/bosses/build_hydra.py -- [--out bf] [--preview <dir>]

- 순수 bpy/bmesh/mathutils/numpy. 외부 에셋·다운로드 없음(텍스처도 numpy 로 만든다 → 저작권 문제 없음). 공통 도구는 build_bosses.py 에서 가져온다.
- 모습: 은회색 비늘 몸(네 발), 긴 목 셋 끝에 뼈 가면을 쓴 머리(눈구멍 속 붉은 눈 · 이빨 두 줄 · 잇몸 · 혀 · 콧구멍 · 주름),
  찢어진 붉은 박쥐 날개 둘(손가락 뼈 · 구멍 · 너덜너덜한 뒷전), 붉은 발톱, 등과 꼬리를 따라 난 가시 · 가시 뭉치 꼬리 끝.
- 텍스처 2048²: 비늘(겹친 판 · 홈) 색+노멀맵, 뼈(금 · 구멍) 색+노멀맵, 날개막(핏줄) 색+노멀맵. 전부 이음매 없는 numpy 노이즈.
- LOD: Hydra_LOD0(가까이 약 7만 삼각형) · Hydra_LOD1(멀리 약 1.3만). 뼈대만(클립 없음) — 움직임은 bf/hydra.js 가 뼈 이름으로 만든다.
- 축: Blender +Y 앞, +Z 위, +X 오른쪽 → glb 에서 three.js 의 -Z 가 앞.
"""
import bpy, bmesh, math, sys, os, random
import numpy as np
from mathutils import Vector, Matrix, noise
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hq import bake_ao, rough_image, add_rough
from build_bosses import (reset_scene, lerp, smooth, basis_from, ell, tube, cone, obj_from_bm, remesh, decimate, solid, copy_obj,
                          verts_np, displace, shade_smooth, box_uv, set_colors, fill_colors, set_material, tex_fbm, height_to_normal,
                          make_image, material, make_armature, finish_lods, finalize, seg_d)

V = Vector

def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out, prev = 'bf', None
    if '--out' in argv: out = argv[argv.index('--out') + 1]
    if '--preview' in argv: prev = argv[argv.index('--preview') + 1]
    return out, prev

def cells_grid(n, g, seed, jit=0.9):
    """격자 지터 Voronoi(주기적, 빠름): F1 · F2 · 칸 안 상대 위치(dy). g×g 칸, 픽셀마다 이웃 9칸만 본다."""
    rng = np.random.default_rng(seed)
    P = rng.random((g, g, 2)) * jit + (1 - jit) / 2
    yy, xx = np.mgrid[0:n, 0:n] / n * g
    ci, cj = np.floor(yy).astype(int), np.floor(xx).astype(int)
    F1 = np.full((n, n), 9.0); F2 = np.full((n, n), 9.0); DY = np.zeros((n, n))
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            i2, j2 = (ci + di) % g, (cj + dj) % g
            py = ci + di + P[i2, j2, 0]; px = cj + dj + P[i2, j2, 1]
            dy = yy - py; dx = xx - px
            d = np.sqrt(dx * dx + dy * dy)
            closer = d < F1
            F2 = np.where(closer, F1, np.minimum(F2, d)); DY = np.where(closer, dy, DY); F1 = np.minimum(F1, d)
    return F1, F2, DY

# ----------------------------------------------------------------------------------------------------------------------
# 몸의 골격 좌표 (Blender 좌표, m)
# ----------------------------------------------------------------------------------------------------------------------
NECKS = {   # 목 마디 4점 + 머리 끝(주둥이 방향)
    'C': [V((0, 5.4, 9.2)), V((0, 7.6, 11.6)), V((0, 9.6, 13.4)), V((0, 11.1, 14.4)), V((0, 14.3, 14.0))],
    'L': [V((-1.9, 5.0, 8.7)), V((-3.9, 7.0, 10.3)), V((-5.7, 8.7, 11.6)), V((-6.7, 10.1, 12.2)), V((-7.8, 13.1, 11.7))],
    'R': [V((1.9, 5.0, 8.7)), V((3.9, 7.0, 10.3)), V((5.7, 8.7, 11.6)), V((6.7, 10.1, 12.2)), V((7.8, 13.1, 11.7))],
}
SPINE = [V((0, -4.6, 7.0)), V((0, -1.5, 7.5)), V((0, 1.5, 7.9)), V((0, 4.2, 8.3))]
SPINE_R = [(2.5, 2.4), (2.9, 2.7), (3.1, 2.9), (2.7, 2.6)]   # (가로, 세로) 반지름
TAIL = [V((0, -4.6, 7.0)), V((0, -9.0, 5.2)), V((0, -13.2, 3.3)), V((0, -17.2, 2.0)), V((0, -21.6, 1.4))]
TAIL_R = [2.2, 1.55, 1.0, 0.62, 0.32]
LEGS = {   # 어깨/엉덩이 → 무릎/팔꿈치 → 발목 → 발끝
    'FL': [V((-2.6, 3.4, 7.2)), V((-3.8, 4.4, 4.0)), V((-3.6, 5.0, 1.0)), V((-3.7, 6.4, 0.25))],
    'FR': [V((2.6, 3.4, 7.2)), V((3.8, 4.4, 4.0)), V((3.6, 5.0, 1.0)), V((3.7, 6.4, 0.25))],
    'BL': [V((-2.4, -3.6, 6.8)), V((-3.5, -1.9, 3.9)), V((-3.3, -4.0, 1.3)), V((-3.4, -2.6, 0.25))],
    'BR': [V((2.4, -3.6, 6.8)), V((3.5, -1.9, 3.9)), V((3.3, -4.0, 1.3)), V((3.4, -2.6, 0.25))],
}
def wing_pts(s):   # s = -1(왼쪽) | 1(오른쪽): 어깨 · 팔꿈치 · 손목 · 손가락 끝 넷 · 몸에 붙는 뒤 끝
    sh, el, wr = V((2.0 * s, 2.4, 9.9)), V((6.2 * s, 1.2, 13.4)), V((10.4 * s, -0.4, 14.8))
    fingers = [V((18.6 * s, -2.6, 12.6)), V((17.6 * s, -6.6, 9.0)), V((14.4 * s, -8.6, 6.8)), V((10.4 * s, -7.8, 6.6))]
    return sh, el, wr, fingers, V((2.4 * s, -3.4, 8.4))

HEAD_LEN = 3.4
def head_frame(k):
    p = NECKS[k]; O = p[3]; d = (p[4] - O).normalized()
    R = basis_from(d)
    return Matrix.Translation(O) @ R.to_4x4()

BONES = [('hips', (0, -4.6, 7.0), (0, 0.0, 7.6), None), ('chest', (0, 0.0, 7.6), (0, 4.4, 8.4), 'hips')]
for k in 'LCR':
    p = NECKS[k]; par = 'chest'
    for i in range(3):
        BONES.append((f'n{k}{i + 1}', tuple(p[i]), tuple(p[i + 1]), par)); par = f'n{k}{i + 1}'
    BONES.append((f'head{k}', tuple(p[3]), tuple(p[4]), par))
    M = head_frame(k)
    BONES.append((f'jaw{k}', tuple(M @ V((0, 0.35, -0.5))), tuple(M @ V((0, 3.1, -0.85))), f'head{k}'))
for i in range(4):
    BONES.append((f't{i + 1}', tuple(TAIL[i]), tuple(TAIL[i + 1]), 'hips' if i == 0 else f't{i}'))
for k, pts in LEGS.items():
    par = 'chest' if k[0] == 'F' else 'hips'
    BONES.append((f'leg{k}', tuple(pts[0]), tuple(pts[1]), par)); BONES.append((f'shin{k}', tuple(pts[1]), tuple(pts[2]), f'leg{k}')); BONES.append((f'foot{k}', tuple(pts[2]), tuple(pts[3]), f'shin{k}'))
for s, side in ((-1, 'L'), (1, 'R')):
    sh, el, wr, fingers, _ = wing_pts(s)
    BONES += [(f'wing{side}1', tuple(sh), tuple(el), 'chest'), (f'wing{side}2', tuple(el), tuple(wr), f'wing{side}1'), (f'wing{side}3', tuple(wr), tuple(fingers[1]), f'wing{side}2')]
BONE_NAMES = [b[0] for b in BONES]

# 머리 안쪽 좌표(머리 틀: 원점 = 목 끝, +Y 주둥이, +Z 위)
EYE_L = V((-0.66, 1.25, 0.42)); EYE_R = V((0.66, 1.25, 0.42))
NOSTRILS = [V((-0.3, 3.35, 0.05)), V((0.3, 3.35, 0.05))]
def upper_lip(u):   # u: -1(왼 입꼬리) .. 1(오른 입꼬리) → 위 잇몸선
    a = u * math.pi / 2
    return V((0.62 * math.sin(a) * (0.8 + 0.2 * abs(u)), 0.75 + 2.6 * math.cos(a) ** 0.7, -0.42 - 0.05 * abs(u)))
def lower_lip(u):
    a = u * math.pi / 2
    return V((0.55 * math.sin(a) * (0.8 + 0.2 * abs(u)), 0.8 + 2.35 * math.cos(a) ** 0.7, -0.62 - 0.06 * abs(u)))

# ----------------------------------------------------------------------------------------------------------------------
def build(out, prev):
    reset_scene()
    n = 2048
    # 비늘: 비스듬히 겹친 판(칸 안에서 아래로 갈수록 솟음) + 칸 경계 홈 + 큰 주름
    F1, F2, DY = cells_grid(n, 96, 41)
    edge = np.clip((F2 - F1) * 5.0, 0, 1)
    plate = np.clip(0.5 - DY * 0.9, 0, 1) * edge ** 0.35
    wr = tex_fbm(n, 1.7, 42, lo=2, hi=80)
    fine = tex_fbm(n, 0.9, 43, lo=60)
    hS = plate * 0.65 + wr * 0.25 + fine * 0.1
    albS = (0.72 + 0.2 * plate + 0.08 * fine - 0.25 * (1 - edge) ** 4)[..., None] * np.array([1.0, 1.0, 1.03])
    SA = make_image('hydra_scale_albedo', albS); SN = make_image('hydra_scale_normal', height_to_normal(hS, 9.0), True)
    # 뼈 가면: 금(셀 경계) · 작은 구멍 · 얼룩
    G1, G2, _ = cells_grid(n, 22, 51)
    crack = np.clip(1 - (G2 - G1) * 24, 0, 1) ** 3
    pits = np.clip(1 - G1 * 12, 0, 1) ** 6 * (tex_fbm(n, 1.0, 52) > 0.62)
    lump = tex_fbm(n, 1.8, 53)
    hB = lump * 0.6 - crack * 0.45 - pits * 0.3 + tex_fbm(n, 0.8, 54, lo=80) * 0.08
    albB = (0.9 - 0.45 * crack - 0.25 * pits - 0.12 * tex_fbm(n, 1.4, 55))[..., None] * np.array([1.0, 0.95, 0.84])
    BA = make_image('hydra_bone_albedo', albB); BN = make_image('hydra_bone_normal', height_to_normal(hB, 7.0), True)
    # 날개막: 핏줄(능선 노이즈) · 주름
    vr = tex_fbm(n, 1.5, 61, lo=3, hi=120); ridge = np.clip(1 - np.abs(vr - 0.5) * 9, 0, 1) ** 2
    vr2 = tex_fbm(n, 1.3, 62, lo=8); ridge2 = np.clip(1 - np.abs(vr2 - 0.5) * 14, 0, 1) ** 2
    hM = ridge * 0.6 + ridge2 * 0.3 + tex_fbm(n, 1.0, 63) * 0.2
    albM = (0.75 + 0.25 * tex_fbm(n, 1.2, 64) - 0.35 * ridge - 0.2 * ridge2)[..., None] * np.array([1.0, 0.9, 0.9])
    MA = make_image('hydra_membrane_albedo', albM); MN = make_image('hydra_membrane_normal', height_to_normal(hM, 6.0), True)
    # 피부(입 둘레 · 목 안쪽): 잔주름
    yy = np.mgrid[0:1024, 0:1024][0] / 1024
    wk = 0.5 + 0.5 * np.sin(yy * 2 * math.pi * 40 + tex_fbm(1024, 1.6, 71) * 9)
    hK = wk * 0.5 + tex_fbm(1024, 1.1, 72) * 0.5
    KA = make_image('hydra_skin_albedo', (0.8 + 0.2 * hK)[..., None] * np.array([1, 1, 1])); KN = make_image('hydra_skin_normal', height_to_normal(hK, 6.0), True)

    m_scale = material('hydra_scale', rough=0.42, metal=0.35, albedo=SA, normal=SN, nstrength=1.4)
    add_rough(m_scale, rough_image('hydra_scale_r', tex_fbm(1024, 1.4, 404, lo=6) * 0.6 + tex_fbm(1024, 0.6, 405, lo=80) * 0.4, 0.25, 0.75))   # 비늘 가운데 매끈·사이 거칢
    m_bone = material('hydra_bone', rough=0.62, albedo=BA, normal=BN, nstrength=1.3, double=True)
    add_rough(m_bone, rough_image('hydra_bone_r', tex_fbm(1024, 1.0, 406, lo=4), 0.45, 0.9))
    m_spike = material('hydra_spike', base=(0.62, 0.56, 0.52), rough=0.5, albedo=BA, normal=BN, nstrength=1.0)
    m_mem = material('hydra_membrane', base=(0.62, 0.07, 0.05), rough=0.55, albedo=MA, normal=MN, nstrength=1.1, emit=(0.4, 0.02, 0.0), emit_k=0.18, double=True)
    m_claw = material('hydra_claw', base=(0.62, 0.05, 0.03), rough=0.28, albedo=BA, normal=BN, nstrength=0.6)
    m_teeth = material('hydra_teeth', base=(0.93, 0.88, 0.74), rough=0.28, albedo=BA, normal=BN, nstrength=0.4)
    m_gum = material('hydra_gum', base=(0.5, 0.09, 0.1), rough=0.32, albedo=KA, normal=KN, nstrength=1.0)
    m_mouth = material('hydra_mouth', base=(0.16, 0.015, 0.02), rough=0.3, emit=(0.6, 0.08, 0.0), emit_k=0.35)
    m_tongue = material('hydra_tongue', base=(0.42, 0.06, 0.09), rough=0.25, albedo=KA, normal=KN, nstrength=1.2)
    m_eye = material('hydra_eye', base=(1.0, 0.2, 0.04), rough=0.1, emit=(1.0, 0.16, 0.02), emit_k=9.0)
    m_pupil = material('hydra_pupil', base=(0.01, 0.0, 0.0), rough=0.05)
    arm = make_armature('Hydra', BONES)
    HF = {k: head_frame(k) for k in 'LCR'}
    HFi = {k: HF[k].inverted() for k in 'LCR'}

    # ---------------- 몸 덩어리(몸통 · 목 · 머리뼈 · 다리 · 꼬리) ----------------
    bm = bmesh.new()
    for i in range(len(SPINE) - 1):
        a, b = SPINE[i], SPINE[i + 1]; ra, rb = SPINE_R[i], SPINE_R[i + 1]
        for s in np.linspace(0, 1, 9, endpoint=False):
            c = a.lerp(b, s); rx = lerp(ra[0], rb[0], s); rz = lerp(ra[1], rb[1], s)
            ell(bm, c, (rx, 1.0, rz), seg=(30, 18))
    ell(bm, SPINE[-1] + V((0, 0.8, 0.4)), (2.4, 1.6, 2.4), seg=(28, 16))   # 가슴 앞(목 뿌리)
    ell(bm, V((0, 1.0, 5.6)), (2.3, 3.6, 1.4), seg=(26, 14))                  # 배
    tube(bm, TAIL, TAIL_R, flat=0.85, seg=(18, 12))
    for k in 'LCR':
        p = NECKS[k]
        tube(bm, p[:4], [1.45, 1.2, 1.0, 0.9], flat=0.95, seg=(18, 12))
        M = HF[k]; R3 = M.to_3x3()
        def H(c): return M @ V(c)
        ell(bm, H((0, 0.55, 0.15)), (1.0, 1.15, 0.85), R3, seg=(22, 14))      # 머리뼈 뒤
        ell(bm, H((0, -0.4, -0.1)), (0.95, 0.9, 0.9), R3, seg=(18, 12))       # 목과 이음
        for s in np.linspace(0, 1, 7):                                         # 주둥이(위턱)
            y = lerp(1.2, 3.35, s); w = lerp(0.78, 0.42, s); h = lerp(0.6, 0.32, s)
            ell(bm, H((0, y, -0.12 + 0.05 * s)), (w, 0.5, h), R3, seg=(18, 10))
        for sg in (-1, 1):                                                     # 눈두덩 · 광대
            ell(bm, H((sg * 0.62, 1.3, 0.52)), (0.36, 0.55, 0.26), R3, seg=(14, 8))
            ell(bm, H((sg * 0.72, 0.6, -0.15)), (0.32, 0.8, 0.4), R3, seg=(14, 8))
    for k, pts in LEGS.items():
        tube(bm, pts[:3], [1.5, 1.05, 0.72], seg=(16, 10))
        ell(bm, pts[0], (1.9, 1.9, 1.9), seg=(18, 12))
        ell(bm, pts[2].lerp(pts[3], 0.45) + V((0, 0, 0.1)), (0.95, 1.2, 0.5), seg=(16, 10))   # 발등
    for s in (-1, 1):   # 날개 팔(뼈대 근육)
        sh, el, wr, fingers, _ = wing_pts(s)
        tube(bm, [sh, el, wr], [0.95, 0.62, 0.45], seg=(14, 10))
        ell(bm, sh, (1.3, 1.3, 1.3), seg=(16, 10))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    body = obj_from_bm('hydra_body', bm)
    remesh(body, 0.085, 0.6, 8)
    decimate(body, 420000)

    neck_polys = [NECKS[k][:4] for k in 'LCR']
    def carve(c, nr):
        d = 0.03 * noise.noise(c * 0.9) + 0.012 * noise.noise(c * 3.1)
        # 목 주름: 목 축을 따라 고리 모양 골
        for pl in neck_polys:
            for i in range(3):
                a, b = pl[i], pl[i + 1]
                ab = b - a; t = max(0.0, min(1.0, (c - a).dot(ab) / ab.length_squared)); q = a + ab * t
                dd = (c - q).length
                if dd < 1.7:
                    s = (i + t) * 7.0
                    d -= 0.06 * max(0, math.sin(s * math.pi)) ** 6 * smooth(1.7, 0.9, dd) * smooth(0.0, 0.3, -nr.z + 0.2)   # 목 아래쪽 골이 깊다
        # 머리: 콧구멍 · 눈구멍 · 입꼬리 주름 · 이마 혹
        for k in 'LCR':
            l = HFi[k] @ c
            if -1.3 < l.y < 3.9 and abs(l.x) < 1.4 and -1.2 < l.z < 1.3:
                for nn in NOSTRILS:
                    dn = (l - nn).length
                    if dn < 0.32: d -= 0.16 * (1 - dn / 0.32) ** 2
                for e in (EYE_L, EYE_R):
                    de = (l - e).length
                    if de < 0.42: d -= 0.2 * (1 - de / 0.42) ** 1.5
                    elif de < 0.62: d += 0.04 * (1 - (de - 0.42) / 0.2)
                if 0.2 < l.y < 1.4 and abs(l.x) > 0.45 and l.z < -0.1:   # 입꼬리 뒤 겹주름
                    d -= 0.035 * max(0, math.sin(l.y * 18 + l.z * 6)) ** 4
                if l.z > 0.3 and abs(l.x) < 0.5 and 1.6 < l.y < 3.0:     # 콧등 혹
                    d += 0.05 * max(0, math.sin(l.y * 9)) ** 3
        # 척추 마루 · 배 비늘판(가로 골)
        if abs(c.x) < 0.6 and c.z > 9.5 and -5 < c.y < 5: d += 0.06
        if nr.z < -0.6 and -4 < c.y < 5 and c.z < 6.0: d -= 0.05 * max(0, math.sin(c.y * 5.2)) ** 8
        return d
    displace(body, carve)

    def body_color(c, nr):
        back = V((0.42, 0.44, 0.47)); side = V((0.62, 0.64, 0.67)); belly = V((0.78, 0.76, 0.72))
        col = side.lerp(back, smooth(0.2, 0.9, nr.z)).lerp(belly, smooth(-0.3, -0.85, nr.z))
        col = col * (0.84 + 0.16 * noise.noise(c * 0.35) + 0.07 * noise.noise(c * 2.2))
        for k in 'LCR':
            l = HFi[k] @ c
            if -1.0 < l.y < 3.9 and abs(l.x) < 1.4:
                for e in (EYE_L, EYE_R):
                    de = (l - e).length
                    if de < 0.75: col = col * (0.35 + 0.65 * smooth(0.25, 0.75, de)); col = col.lerp(V((0.5, 0.06, 0.04)), 0.4 * (1 - smooth(0.2, 0.6, de)))   # 눈 둘레 핏기
                for nn in NOSTRILS:
                    if (l - nn).length < 0.35: col = col * 0.4
                if l.z < -0.25 and l.y > 0.6: col = col.lerp(V((0.38, 0.22, 0.2)), 0.35)   # 입술 둘레 거무죽죽
        if c.z < 1.6: col = col * (0.6 + 0.4 * smooth(0.2, 1.6, c.z))   # 발에 흙때
        scr = noise.noise(V((c.x * 0.25, c.y * 3.5, c.z * 0.25)))
        if scr > 0.6: col = col.lerp(V((0.55, 0.32, 0.3)), (scr - 0.6) * 2.0)   # 긁힌 흉터
        return (col.x, col.y, col.z)

    # ---------------- 붙는 부품(LOD 별) ----------------
    def head_bits(li, k):
        M = HF[k]; R3 = M.to_3x3(); parts = []
        def H(c): return M @ V(c)
        hb = f'head{k}'; jb = f'jaw{k}'
        # 뼈 가면: 주둥이 위 · 이마 · 뒤로 휜 뿔 둘 · 볼 판. 눈구멍은 뚫는다
        bm = bmesh.new()
        for s in np.linspace(0, 1, 8):
            y = lerp(0.2, 3.25, s); w = lerp(1.05, 0.48, s); h = lerp(0.72, 0.36, s)
            ell(bm, H((0, y, 0.02 + 0.08 * (1 - s))), (w + 0.07, 0.52, h + 0.09), R3, seg=(20, 12))
        ell(bm, H((0, 0.3, 0.38)), (1.15, 0.9, 0.75), R3, seg=(20, 12))
        for sg in (-1, 1):
            ell(bm, H((sg * 0.82, 0.55, -0.05)), (0.3, 0.95, 0.5), R3, seg=(14, 8))
            # 이마 능선 가시
            for j in range(3): cone(bm, H((sg * 0.35, 1.9 - j * 0.65, 0.42 + 0.12 * j)), H((sg * 0.42, 1.55 - j * 0.65, 0.9 + 0.15 * j)), 0.16, sides=6, rings=2)
        mk = obj_from_bm(f'mask{k}{li}', bm)
        set_material(mk, m_bone); solid(mk, 0.045, [9000, 1600][li], 3)
        # 아래쪽 절반은 잘라 낸다(가면은 위턱 위만 덮음) + 눈구멍
        bmm = bmesh.new(); bmm.from_mesh(mk.data)
        Mi = M.inverted(); kill = []
        for v in bmm.verts:
            l = Mi @ v.co
            if l.z < -0.2 + 0.1 * math.sin(l.y * 7): kill.append(v); continue
            for e in (EYE_L, EYE_R):
                if (l - e - V((0, 0, 0.05))).length < 0.36: kill.append(v); break
        bmesh.ops.delete(bmm, geom=list(set(kill)), context='VERTS'); bmm.to_mesh(mk.data); bmm.free(); mk.data.update()
        box_uv(mk.data, 0.55)
        set_colors(mk.data, lambda c, nr: (lambda l: (lambda kk: (kk, kk * 0.97, kk * 0.9))(0.75 + 0.25 * noise.noise(c * 1.3) - 0.25 * smooth(0.2, -0.2, l.z)))(Mi @ c))
        parts.append((mk, hb))
        # 뿔: 뒤로 휜 큰 뿔 둘 + 작은 뿔 둘
        bm = bmesh.new()
        for sg in (-1, 1):
            cone(bm, H((sg * 0.55, 0.15, 0.7)), H((sg * 1.5, -2.6, 1.9)), 0.36, sides=9, rings=7, bend=R3 @ V((sg * 0.25, 0.3, -0.9)))
            cone(bm, H((sg * 0.85, 0.0, 0.05)), H((sg * 1.55, -1.5, 0.3)), 0.2, sides=7, rings=4, bend=R3 @ V((0, 0, -0.35)))
        hr = obj_from_bm(f'horn{k}{li}', bm); set_material(hr, m_bone); box_uv(hr.data, 0.8); fill_colors(hr.data, (0.85, 0.82, 0.74)); shade_smooth(hr.data)
        parts.append((hr, hb))
        # 눈: 붉은 알 + 세로 동공
        bm = bmesh.new()
        for e in (EYE_L, EYE_R): ell(bm, H(e), (0.2, 0.2, 0.17), R3, seg=(16, 10))
        ey = obj_from_bm(f'eye{k}{li}', bm); set_material(ey, m_eye); parts.append((ey, hb))
        bm = bmesh.new()
        for e in (EYE_L, EYE_R):
            sg = 1 if e.x > 0 else -1
            ell(bm, H(e + V((sg * 0.16, 0.05, 0))), (0.03, 0.06, 0.15), R3, seg=(8, 6))
        pu = obj_from_bm(f'pupil{k}{li}', bm); set_material(pu, m_pupil); parts.append((pu, hb))
        # 입 안 · 잇몸 · 이빨
        bm = bmesh.new(); ell(bm, H((0, 1.9, -0.5)), (0.52, 1.5, 0.22), R3, seg=(16, 10))
        mo = obj_from_bm(f'mouth{k}{li}', bm); set_material(mo, m_mouth); parts.append((mo, hb))
        us = np.linspace(-1, 1, 21)
        bm = bmesh.new(); tube(bm, [H(upper_lip(u) + V((0, -0.05, 0.08))) for u in us], [0.13] * len(us), flat=0.8, seg=(8, 6))
        gu = obj_from_bm(f'gumU{k}{li}', bm); set_material(gu, m_gum); solid(gu, 0.035, [1800, 300][li], 2); parts.append((gu, hb))
        bm = bmesh.new(); tube(bm, [H(lower_lip(u) + V((0, -0.05, -0.06))) for u in us], [0.12] * len(us), flat=0.8, seg=(8, 6))
        gl = obj_from_bm(f'gumL{k}{li}', bm); set_material(gl, m_gum); solid(gl, 0.035, [1800, 300][li], 2); parts.append((gl, jb))
        rnd = random.Random(hash(k) % 1000)
        bt = bmesh.new(); bl_ = bmesh.new()
        rows = 2 if li == 0 else 1
        for row in range(rows):
            cnt = [17, 15][row]; sc = [1.0, 0.6][row]; inset = [1.0, 0.82][row]
            for i in range(cnt):
                u = -0.94 + 1.88 * i / (cnt - 1)
                fang = 1.9 if row == 0 and abs(abs(u) - 0.55) < 0.07 else 1.0
                g = upper_lip(u); g = V((g.x * inset, g.y - 0.12 * row, g.z + 0.02 * row))
                L = (0.42 - 0.12 * abs(u)) * sc * fang * (0.8 + 0.4 * rnd.random())
                cone(bt, H(g), H(g + V((-g.x * 0.06, 0.05, -L))), 0.09 * sc * (1.3 if fang > 1 else 1), sides=6, flat=0.6, bend=R3 @ V((0, -0.06 * fang, 0)), rings=3)
                g2 = lower_lip(u); g2 = V((g2.x * inset, g2.y - 0.12 * row, g2.z - 0.02 * row))
                L2 = (0.36 - 0.1 * abs(u)) * sc * (1.6 if row == 0 and abs(abs(u) - 0.35) < 0.07 else 1.0) * (0.8 + 0.4 * rnd.random())
                cone(bl_, H(g2), H(g2 + V((-g2.x * 0.05, 0.04, L2))), 0.08 * sc, sides=6, flat=0.6, bend=R3 @ V((0, -0.05, 0)), rings=3)
        tu = obj_from_bm(f'teethU{k}{li}', bt); set_material(tu, m_teeth); fill_colors(tu.data, (0.9, 0.86, 0.75)); parts.append((tu, hb))
        tl = obj_from_bm(f'teethL{k}{li}', bl_); set_material(tl, m_teeth); fill_colors(tl.data, (0.9, 0.86, 0.75)); parts.append((tl, jb))
        # 아래턱(비늘 피부) + 혀
        bm = bmesh.new()
        for s in np.linspace(0, 1, 9):
            y = lerp(0.35, 3.1, s); w = lerp(0.7, 0.36, s); h = lerp(0.42, 0.22, s)
            ell(bm, H((0, y, -0.82 - 0.06 * s)), (w, 0.45, h), R3, seg=(16, 10))
        for sg in (-1, 1): ell(bm, H((sg * 0.55, 0.45, -0.6)), (0.32, 0.6, 0.4), R3, seg=(12, 8))
        jw = obj_from_bm(f'jaw{k}{li}', bm); solid(jw, 0.045, [5000, 900][li], 3)
        Mi2 = Mi
        displace(jw, lambda c, nr: 0.025 * noise.noise(c * 4.0) - 0.03 * max(0, math.sin((Mi2 @ c).y * 14)) ** 6 * smooth(0, -0.6, nr.z))
        box_uv(jw.data, 0.6); set_colors(jw.data, body_color); set_material(jw, m_scale); parts.append((jw, jb))
        bm = bmesh.new(); tube(bm, [H((0, 0.6, -0.62)), H((0, 1.6, -0.6)), H((0, 2.5, -0.62)), H((0.05, 3.0, -0.55))], [0.3, 0.27, 0.2, 0.09], flat=0.35, seg=(12, 8))
        for sg in (-1, 1): cone(bm, H((0.0, 2.9, -0.56)), H((sg * 0.22, 3.55, -0.5)), 0.08, sides=5, rings=3)   # 갈라진 혀끝
        tg = obj_from_bm(f'tongue{k}{li}', bm); set_material(tg, m_tongue); solid(tg, 0.03, [1500, 250][li], 2); parts.append((tg, jb))
        return parts

    def wing(li, s):
        side = 'L' if s < 0 else 'R'
        sh, el, wr, fingers, rear = wing_pts(s)
        parts = []
        # 손가락 뼈(가늘고 마디진 관) + 끝 발톱
        bm = bmesh.new()
        for f in fingers:
            mid = wr.lerp(f, 0.5) + V((0, 0, 0.6))
            tube(bm, [wr, mid, f], [0.32, 0.2, 0.08], seg=(10, 8))
        oF = obj_from_bm(f'wingbone{side}{li}', bm); set_material(oF, m_scale); solid(oF, 0.06, [5000, 900][li], 2); box_uv(oF.data, 0.5); set_colors(oF.data, body_color)
        parts.append((oF, (f'wing{side}2', f'wing{side}3')))
        bm = bmesh.new()
        cone(bm, wr + V((0, 0.2, 0.2)), wr + V((0.6 * s, 1.6, 1.5)), 0.22, sides=6, rings=3, bend=V((0, 0.3, -0.3)))   # 엄지 발톱
        cl = obj_from_bm(f'wingclaw{side}{li}', bm); set_material(cl, m_claw); fill_colors(cl.data, (1, 1, 1)); parts.append((cl, f'wing{side}2'))
        # 막: 손목 → 손가락 사이 부채꼴 패널(처짐) + 마지막 손가락 → 몸 패널. 찢어진 구멍 · 너덜너덜한 뒷전
        lines = [(wr, fingers[0]), (wr, fingers[1]), (wr, fingers[2]), (wr, fingers[3]), (sh.lerp(el, 0.3) + V((0, -1.0, -0.5)), rear)]
        lead = (sh, el, wr)
        nr_, nt_ = (16, 14) if li == 0 else (7, 6)
        bm = bmesh.new(); rr = random.Random(7 if s < 0 else 8)
        holes = [(V((s * (12 + 4 * rr.random()), -4 - 3 * rr.random(), 10 + 2 * rr.random())), 0.9 + 1.2 * rr.random()) for _ in range(5)]
        panels = [lines[i:i + 2] for i in range(len(lines) - 1)] + [[(sh, el), (sh.lerp(el, 0.3) + V((0, -1.0, -0.5)), rear)]]
        for (a0, a1), (b0, b1) in panels:
            grid = []
            for j in range(nt_ + 1):
                t = j / nt_; row = []
                for i in range(nr_ + 1):
                    u = i / nr_
                    pa = a0.lerp(a1, t); pb = b0.lerp(b1, t); p = pa.lerp(pb, u)
                    sag = 0.8 * math.sin(math.pi * u) * (0.3 + t)
                    scal = 1.3 * math.sin(math.pi * u) * t ** 3
                    p = p + V((0, -sag * 0.6, -sag)) - (p - a0.lerp(b0, u)).normalized() * scal
                    row.append(bm.verts.new(p))
                grid.append(row)
            for j in range(nt_):
                for i in range(nr_):
                    q = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]]
                    cen = sum((v.co for v in q), V()) / 4; t = (j + 0.5) / nt_
                    if any((cen - hc).length < hr for hc, hr in holes) and t > 0.2: continue
                    if t > 0.78 and noise.noise(cen * 0.9) + (t - 0.78) * 3.5 > 0.55: continue   # 뒷전이 찢겨 너덜너덜
                    bm.faces.new(q)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.01)
        mem = obj_from_bm(f'membrane{side}{li}', bm)
        me = mem.data; shade_smooth(me); box_uv(me, 0.16)
        set_colors(me, lambda c, nr: (lambda v: (0.7 + 0.3 * v, 0.65 + 0.25 * v, 0.65 + 0.25 * v))(0.5 + 0.5 * noise.noise(c * 0.6)))
        set_material(mem, m_mem)
        parts.append((mem, (f'wing{side}1', f'wing{side}2', f'wing{side}3', 'chest')))
        return parts

    def claws_spikes(li):
        parts = []
        bm = bmesh.new()
        for k, pts in LEGS.items():
            ft = pts[3]; sg = -1 if k[1] == 'L' else 1
            for f in range(4):
                a = (f - 1.5) * 0.42
                base = ft + V((math.sin(a) * 0.75, 0.15 + math.cos(a) * 0.2, 0.15))
                tip = base + V((math.sin(a) * 0.5, 1.15, -0.35))
                cone(bm, base, tip, 0.2, sides=7, rings=4, bend=V((0, 0.15, -0.4)))
            cone(bm, pts[2] + V((sg * 0.3, -0.5, -0.3)), pts[2] + V((sg * 0.4, -1.4, -0.9)), 0.14, sides=6, rings=3)   # 며느리발톱
        oc = obj_from_bm(f'claws{li}', bm); set_material(oc, m_claw); fill_colors(oc.data, (1, 1, 1))
        parts.append((oc, tuple(f'foot{k}' for k in LEGS) + tuple(f'shin{k}' for k in LEGS)))
        # 등 · 꼬리 가시
        bm = bmesh.new(); rnd = random.Random(3)
        path = SPINE[::-1] + TAIL[1:]
        rad = [r[1] for r in SPINE_R[::-1]] + TAIL_R[1:]
        L_tot = sum((path[i + 1] - path[i]).length for i in range(len(path) - 1)); step = 1.05 if li == 0 else 2.1
        d = 0.6
        while d < L_tot - 0.8:
            acc = 0
            for i in range(len(path) - 1):
                sl = (path[i + 1] - path[i]).length
                if acc + sl >= d:
                    t = (d - acc) / sl; p = path[i].lerp(path[i + 1], t); r = lerp(rad[i], rad[i + 1], t)
                    h = (0.75 + 0.5 * rnd.random()) * (0.5 + 0.7 * r / 3.0) * 1.6
                    tng = (path[i + 1] - path[i]).normalized()
                    cone(bm, p + V((0, 0, r * 0.9)), p + V((0, 0, r * 0.9 + h)) + tng * h * 0.45, 0.22 + 0.16 * r / 3.0, sides=6, rings=3, flat=0.45)
                    if r > 0.5 and rnd.random() < 0.5:
                        for sg in (-1, 1): cone(bm, p + V((sg * r * 0.7, 0, r * 0.55)), p + V((sg * (r * 0.7 + h * 0.5), 0, r * 0.55 + h * 0.4)) + tng * h * 0.3, 0.13, sides=5, rings=2)
                    break
                acc += sl
            d += step
        tip = TAIL[-1]
        for i in range(9 if li == 0 else 5):   # 꼬리 끝 가시 뭉치
            a = i / (9 if li == 0 else 5) * math.tau
            dv = V((math.cos(a), -0.6, math.sin(a))).normalized()
            cone(bm, tip + dv * 0.3, tip + dv * 2.1 + V((0, -0.6, 0)), 0.26, sides=6, rings=3)
        cone(bm, tip, tip + V((0, -2.6, 0.2)), 0.36, sides=7, rings=3)
        sp = obj_from_bm(f'spikes{li}', bm); set_material(sp, m_spike); fill_colors(sp.data, (0.9, 0.85, 0.8))
        parts.append((sp, ('hips', 'chest', 't1', 't2', 't3', 't4')))
        # 목 가시(머리 뒤에서 목을 따라)
        bm = bmesh.new()
        for k in 'LCR':
            pl = NECKS[k]
            for i in range(3):
                for t in ((0.25, 0.75) if li == 0 else (0.5,)):
                    p = pl[i].lerp(pl[i + 1], t); tng = (pl[i + 1] - pl[i]).normalized()
                    upv = V((0, 0, 1)) - tng * tng.z; upv.normalize()
                    cone(bm, p + upv * 0.9, p + upv * 1.9 - tng * 0.7, 0.18, sides=5, rings=2, flat=0.45)
        ns = obj_from_bm(f'neckspikes{li}', bm); set_material(ns, m_spike); fill_colors(ns.data, (0.9, 0.85, 0.8))
        parts.append((ns, tuple(f'n{k}{i}' for k in 'LCR' for i in (1, 2, 3))))
        return parts

    extras = []
    for li in range(2):
        ex = []
        for k in 'LCR':
            for (o, fb) in head_bits(li, k): ex.append((o, fb))
        ex += wing(li, -1) + wing(li, 1) + claws_spikes(li)
        extras.append(ex)
    # 몸 덩어리는 턱 · 날개 끝 뼈를 빼고 입힌다(위턱이 아래턱을 따라 벌어지지 않게)
    import build_bosses as BB
    body_only = tuple(n for n in BONE_NAMES if not n.startswith('jaw') and not (n.startswith('wing') and n.endswith('3')))
    _skin = BB.skin
    BB.skin = lambda o, a, b, fixed=None, sharp=4.0, only=None: _skin(o, a, b, fixed=fixed, sharp=sharp, only=only if (fixed or only) else body_only)
    lods = finish_lods('Hydra', body, extras, arm, BONES, [58000, 9000], 0.55, body_color, m_scale)
    bake_ao(lods, samples=16, dist=2.0)
    C = NECKS['C']
    hc = HF['C'] @ V((0, 1.6, 0.0))
    finalize(arm, lods, out, 'hydra.glb', prev, 'hydra', [((0, 42, 12), (0, 4, 9)), ((-26, 24, 14), (0, 0, 9)), ((2.2, 19.5, 14.6), tuple(hc)), ((-4.5, 18, 13), tuple(HF['L'] @ V((0, 1.6, 0))))])

if __name__ == '__main__':
    out, prev = parse_args()
    build(out, prev)
