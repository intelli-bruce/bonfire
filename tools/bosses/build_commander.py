"""
보스 「대검 지휘관」(검정·금 판금 갑옷 · 찢어진 금문양 망토 · 금테 대검 · 열린 투구 속 썩은 얼굴) 절차적 모델링 → 뼈대 → LOD 2단 → Draco glb

실행:  blender -b --factory-startup --python tools/bosses/build_commander.py -- [--out bf] [--preview <dir>]

- build_bosses.py 의 도형·메시·텍스처·뼈대·내보내기 함수를 그대로 쓴다(외부 에셋·다운로드 없음, 텍스처도 numpy 로 생성 → 저작권 문제 없음).
- 키 약 14 m. 얼굴은 따로 촘촘한 메시(이마·눈가 주름, 땀구멍 노멀맵 2048, 움푹 꺼진 눈구멍 속 빛나는 세로 동공, 찢어진 입술 사이 들쭉날쭉한 이빨·잇몸).
  아래턱은 `jaw` 뼈에 붙어 포효할 때 벌어진다.
- LOD: Commander_LOD0(가까이) · Commander_LOD1(멀리) 두 메시가 같은 뼈대를 쓴다. 뼈는 회전만(클립 없음) — 움직임은 bf/commander.js.
- 축: Blender +Y 앞, +Z 위, +X 보스의 오른쪽(대검은 오른손 handR 뼈).
"""
import bpy, bmesh, math, sys, os, random
import numpy as np
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_bosses import (V, lerp, smooth, basis_from, ell, tube, cone, obj_from_bm, apply_mods, remesh, decimate, copy_obj,
                          verts_np, normals_np, displace, shade_smooth, box_uv, set_colors, fill_colors, set_material,
                          tex_fbm, tex_cells, height_to_normal, make_image, material, make_armature, skin, finish_lods,
                          finalize, reset_scene, seg_d, tri_count)

def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out, prev = 'bf', None
    if '--out' in argv: out = argv[argv.index('--out') + 1]
    if '--preview' in argv: prev = argv[argv.index('--preview') + 1]
    return out, prev

H = V((0, 0.35, 13.05))          # 머리 중심
GRIP = V((3.72, 1.45, 6.15))      # 대검 손잡이(오른손)
TIP = V((4.15, 9.6, 0.55))        # 쉬는 자세: 칼끝이 앞쪽 땅 가까이
SD = (TIP - GRIP).normalized()

BONES = [
    ('hips', (0, 0, 6.8), (0, 0, 8.2), None),
    ('spine', (0, 0, 8.2), (0, 0.1, 11.2), 'hips'),
    ('neck', (0, 0.1, 11.6), (0, 0.25, 12.4), 'spine'),
    ('head', (0, 0.25, 12.4), (0, 0.35, 14.0), 'neck'),
    ('jaw', tuple(H + V((0, 0.1, -0.25))), tuple(H + V((0, 0.8, -0.6))), 'head'),
    ('armL', (-2.9, 0, 11.2), (-3.5, 0.3, 8.5), 'spine'), ('foreL', (-3.5, 0.3, 8.5), (-3.7, 1.3, 6.3), 'armL'),
    ('armR', (2.9, 0, 11.2), (3.5, 0.3, 8.5), 'spine'), ('foreR', (3.5, 0.3, 8.5), (3.7, 1.3, 6.3), 'armR'),
    ('handR', tuple(GRIP), tuple(GRIP + SD * 1.2), 'foreR'),
    ('thighL', (-1.1, 0, 7.0), (-1.3, 0.4, 3.8), 'hips'), ('shinL', (-1.3, 0.4, 3.8), (-1.35, -0.1, 0.7), 'thighL'),
    ('thighR', (1.1, 0, 7.0), (1.3, 0.4, 3.8), 'hips'), ('shinR', (1.3, 0.4, 3.8), (1.35, -0.1, 0.7), 'thighR'),
    ('cape1', (0, -1.5, 11.2), (0, -2.0, 6.4), 'spine'), ('cape2', (0, -2.0, 6.4), (0, -2.5, 0.8), 'cape1'),
]

# ----------------------------------------------------------------------------------------------------------------------
# 텍스처
# ----------------------------------------------------------------------------------------------------------------------
def textures():
    rng = np.random.default_rng(5)
    T = {}
    # 검은 판금: 미세 긁힘 + 망치 자국
    n = 1024
    yy, xx = np.mgrid[0:n, 0:n] / n
    ham = tex_fbm(n, 1.6, 31); fine = tex_fbm(n, 0.6, 32)
    scr = np.zeros((n, n))
    for _ in range(260):   # 긁힌 자국: 짧은 직선(주기적)
        x0, y0 = rng.random(2); a = rng.uniform(0, math.pi); L = rng.uniform(0.02, 0.12)
        dx, dy = math.cos(a), math.sin(a)
        px = (xx - x0 + 0.5) % 1 - 0.5; py = (yy - y0 + 0.5) % 1 - 0.5
        t = np.clip(px * dx + py * dy, 0, L); d = np.hypot(px - t * dx, py - t * dy)
        scr = np.maximum(scr, np.clip(1 - d * n / 1.4, 0, 1) * rng.uniform(0.3, 1))
    h = ham * 0.5 + fine * 0.15 - scr * 0.35
    alb = (0.78 + 0.12 * fine + 0.35 * scr - 0.1 * ham)[..., None] * np.array([1, 1, 1])
    T['armorA'] = make_image('cmd_armor_albedo', alb); T['armorN'] = make_image('cmd_armor_normal', height_to_normal(h, 7.0), True)
    # 금 상감: 덩굴 무늬 (sin 왜곡 선)
    w1 = tex_fbm(n, 1.4, 33)
    v = np.sin((xx * 9 + 2.4 * np.sin(yy * 2 * math.pi * 3 + w1 * 6)) * 2 * math.pi) * np.sin((yy * 7 + 2 * np.sin(xx * 2 * math.pi * 2)) * 2 * math.pi)
    vine = np.clip(1 - np.abs(v) * 6, 0, 1)
    gh = vine * 0.8 + fine * 0.2
    T['goldA'] = make_image('cmd_gold_albedo', (0.85 + 0.15 * fine - 0.35 * vine)[..., None] * np.array([1, 0.95, 0.85]))
    T['goldN'] = make_image('cmd_gold_normal', height_to_normal(gh, 9.0), True)
    # 망토: 거친 천 + 아래로 갈수록 해짐(UV v=0 위, 1 아래), 가장자리 금실 무늬
    thread = (np.sin(xx * 2 * math.pi * 220) * 0.5 + 0.5) * 0.5 + (np.sin(yy * 2 * math.pi * 220) * 0.5 + 0.5) * 0.5
    grime = tex_fbm(n, 1.2, 34)
    base = np.stack([0.30 + 0.0 * xx, 0.035 + 0 * xx, 0.03 + 0 * xx], -1) * (0.55 + 0.45 * grime)[..., None] * (0.85 + 0.15 * thread)[..., None]
    border = ((xx < 0.075) | (xx > 0.925) | (yy < 0.06)).astype(float)
    fil = np.clip(1 - np.abs(np.sin((xx * 40 + np.sin(yy * 2 * math.pi * 14) * 0.8) * math.pi) * np.sin(yy * 2 * math.pi * 30)) * 3.5, 0, 1)
    band = np.clip(1 - np.abs(((xx * 2) % 1) - 0.5) * 2, 0, 1)
    mid = np.clip(1 - np.abs(v) * 5, 0, 1) * np.clip(1 - np.abs(yy - 0.32) * 7, 0, 1) * np.clip(1 - np.abs(xx - 0.5) * 3.2, 0, 1)   # 등판의 큰 금문양
    gold = np.array([0.95, 0.68, 0.22])
    g = np.clip(border * fil + mid, 0, 1)[..., None]
    burn = np.clip((yy - 0.75) * 4, 0, 1)[..., None] * (grime > 0.45)[..., None]
    alb = base * (1 - g) + gold * g * (0.7 + 0.3 * grime[..., None])
    alb = alb * (1 - 0.75 * burn)
    T['capeA'] = make_image('cmd_cape_albedo', alb); T['capeN'] = make_image('cmd_cape_normal', height_to_normal(thread * 0.25 + grime * 0.6 + g[..., 0] * 0.5, 4.0), True)
    # 피부 2048: 땀구멍 + 잔주름 + 굵은 주름, 정맥
    n2 = 2048
    yy2, xx2 = np.mgrid[0:n2, 0:n2] / n2
    F1, F2 = tex_cells(n2, 2600, 41)
    pore = np.clip(1 - F1 * n2 / 3.2, 0, 1) ** 1.5
    cr = np.clip(1 - (F2 - F1) * n2 / 2.2, 0, 1)
    wf = tex_fbm(n2, 1.3, 42)
    wr = np.abs(np.sin((yy2 * 46 + wf * 3.0) * math.pi)) ** 0.35
    wrink = (1 - wr) * 0.7
    blot = tex_fbm(n2, 1.7, 43)
    vein = np.clip(1 - np.abs(tex_fbm(n2, 1.9, 44) - 0.5) * 34, 0, 1)
    sh = 0.35 * blot - 0.5 * pore - 0.35 * cr - 0.6 * wrink + 0.25 * vein
    salb = np.stack([0.80 - 0.10 * vein, 0.76 - 0.18 * vein, 0.72 - 0.05 * vein], -1) * (0.75 + 0.3 * blot)[..., None] * (1 - 0.35 * pore - 0.25 * cr - 0.25 * wrink)[..., None]
    T['skinA'] = make_image('cmd_skin_albedo', salb); T['skinN'] = make_image('cmd_skin_normal', height_to_normal(sh, 11.0), True)
    # 이빨: 누런 법랑질 + 세로 금 + 뿌리 쪽 착색
    n3 = 512
    yy3, xx3 = np.mgrid[0:n3, 0:n3] / n3
    tf = tex_fbm(n3, 1.0, 51)
    crk = np.clip(1 - np.abs(np.sin((xx3 * 23 + tf * 2) * math.pi)) * 18, 0, 1)
    talb = np.stack([0.86 + 0 * xx3, 0.76 + 0 * xx3, 0.52 + 0 * xx3], -1) * (0.8 + 0.25 * tf)[..., None] * (1 - 0.45 * crk)[..., None]
    T['toothA'] = make_image('cmd_tooth_albedo', talb); T['toothN'] = make_image('cmd_tooth_normal', height_to_normal(tf * 0.4 - crk * 0.5, 5.0), True)
    # 눈 흰자: 누렇고 붉은 핏줄
    ef = tex_fbm(n3, 1.8, 52)
    ev = np.clip(1 - np.abs(ef - 0.5) * 22, 0, 1)
    ealb = np.stack([0.85 + 0 * xx3, 0.72 - 0.4 * ev, 0.48 - 0.3 * ev], -1) * (0.85 + 0.15 * tf)[..., None]
    T['eyeA'] = make_image('cmd_eye_albedo', ealb)
    return T

# ----------------------------------------------------------------------------------------------------------------------
# 갑옷 몸통 (한 덩어리) — 금 띠는 꼭짓점 색
# ----------------------------------------------------------------------------------------------------------------------
TRIM_Z = [(11.05, 'torso'), (9.25, 'torso'), (7.85, 'torso'), (7.15, 'hip')]
def is_gold(c, nr):
    x, y, z = c.x, c.y, c.z
    ax = abs(x)
    if ax < 2.4 and 7.0 < z < 11.6:   # 몸통: 가로 띠 · 가슴 가운데 능선 · 가슴의 금 상감
        for zz, _ in TRIM_Z:
            if abs(z - zz) < 0.075: return 1.0
        if ax < 0.09 and y > 0.4: return 1.0
        if y > 0.6 and 9.4 < z < 10.9:
            v = math.sin((ax * 3.2 + math.sin(z * 3.0) * 0.6) * math.pi) * math.sin((z * 2.4 + ax) * math.pi)
            if abs(v) < 0.12: return 0.9
    if 2.6 < ax < 4.4 and z < 11.0:   # 팔: 팔꿈치·손목 띠
        if abs(z - 8.6) < 0.08 or abs(z - 7.0) < 0.08 or abs(z - 6.75) < 0.06: return 1.0
    if ax < 2.2 and z < 6.9:   # 다리: 무릎·발목 띠, 정강이 능선
        if abs(z - 4.35) < 0.08 or abs(z - 3.3) < 0.08 or abs(z - 1.0) < 0.07: return 1.0
        if 1.0 < z < 3.3 and y > 0.3 and abs(ax - 1.35) < 0.07: return 1.0
    return 0.0

def armor_body():
    bm = bmesh.new()
    ell(bm, (0, 0, 7.2), (2.05, 1.45, 1.0)); ell(bm, (0, 0.05, 8.45), (1.9, 1.35, 1.15))
    ell(bm, (0, 0.15, 10.1), (2.55, 1.75, 1.95)); ell(bm, (0, 1.05, 10.2), (1.2, 0.85, 1.4))      # 흉갑 + 앞 볼록
    ell(bm, (0, -0.5, 10.6), (2.3, 1.5, 1.4))                                                     # 등
    tube(bm, [(0, 0.05, 11.2), (0, 0.22, 12.4)], [0.78, 0.6], step=0.5)                           # 목가리개
    for sg in (-1, 1):
        ell(bm, (sg * 2.85, 0, 11.15), (1.05, 1.0, 1.0))
        tube(bm, [(sg * 3.0, 0.05, 10.8), (sg * 3.5, 0.3, 8.6)], [0.78, 0.66], step=0.5)
        ell(bm, (sg * 3.52, 0.25, 8.6), (0.8, 0.82, 0.62))                                        # 팔꿈치 덮개
        tube(bm, [(sg * 3.5, 0.32, 8.5), (sg * 3.7, 1.25, 6.6)], [0.6, 0.72], step=0.5)
        ell(bm, (sg * 3.72, 1.4, 6.15), (0.62, 0.7, 0.62))                                        # 건틀릿 주먹
        tube(bm, [(sg * 1.1, 0, 6.9), (sg * 1.3, 0.4, 4.1)], [1.05, 0.82], step=0.5)
        ell(bm, (sg * 1.32, 0.55, 3.85), (0.78, 0.8, 0.72))                                       # 무릎 덮개
        tube(bm, [(sg * 1.3, 0.4, 3.7), (sg * 1.35, 0.05, 0.9)], [0.78, 0.6], step=0.5)
        ell(bm, (sg * 1.36, 0.55, 0.38), (0.62, 1.25, 0.42))                                      # 쇠신
        for k in range(3):                                                                         # 허리 아래 늘어진 판(태싯)
            ell(bm, (sg * (0.9 + 0.55 * k), 0.75 - 0.2 * k, 6.25 - 0.05 * k), (0.6, 0.28, 0.85), basis_from(V((0, 0.2, -1))))
    body = obj_from_bm('cmd_body', bm)
    remesh(body, 0.065, 0.5, 4)
    def carve(c, nr):
        d = 0.012 * noise.noise(c * 2.2) + 0.006 * noise.noise(c * 9.0)
        g = is_gold(c, nr)
        if g: d += 0.035
        ax = abs(c.x)   # 판 이음매 홈
        if ax < 2.4 and 7.0 < c.z < 11.6:
            for zz in (10.55, 9.8, 8.7, 8.25):
                if abs(c.z - zz) < 0.05: d -= 0.04
        return d
    displace(body, carve)
    return body

def body_color(c, nr):
    g = is_gold(c, nr)
    blk = V((0.055, 0.055, 0.062)) * (0.85 + 0.3 * noise.noise(c * 0.8))
    gold = V((0.95, 0.66, 0.22)) * (0.85 + 0.2 * noise.noise(c * 3.0))
    col = blk.lerp(gold, g)
    soot = smooth(0.2, 0.7, noise.fractal(c * 0.6, 0.8, 2.0, 3)) * 0.6   # 그을음·피
    col = col.lerp(V((0.12, 0.02, 0.015)), soot * 0.35 * (1 - g))
    return (col.x, col.y, col.z)

# ----------------------------------------------------------------------------------------------------------------------
# 판금 부품: 견갑(겹판) · 투구 · 벨트 · 대검 · 망토
# ----------------------------------------------------------------------------------------------------------------------
def shell(name, center, r, cut_fn, thick, seg=(40, 24), rot=None):
    bm = bmesh.new(); ell(bm, center, r, rot, seg)
    kill = [f for f in bm.faces if cut_fn(f.calc_center_median())]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    o = obj_from_bm(name, bm)
    m = o.modifiers.new('so', 'SOLIDIFY'); m.thickness = thick; m.offset = 1.0
    apply_mods(o); shade_smooth(o.data); return o

def rim(bm, pts, r, closed=False):
    pts = [V(p) for p in pts]
    if closed: pts = pts + [pts[0]]
    tube(bm, pts, [r] * len(pts), step=0.9, seg=(8, 6))

def pauldrons(li, m_black, m_gold):
    outs = []
    seg = (40, 22) if li == 0 else (16, 10)
    for sg in (-1, 1):
        for k in range(3):
            c = V((sg * (3.05 + 0.08 * k), 0.0, 11.55 - 0.55 * k)); r = (1.62 - 0.08 * k, 1.5 - 0.05 * k, 1.0 - 0.1 * k)
            o = shell(f'cmd_paul{sg}{k}_{li}', c, r, lambda p, c=c: p.z < c.z - 0.15 * (1 + k) or (p.x - c.x) * sg < -1.05 + 0.1 * k, 0.09, seg)
            set_material(o, m_black); outs.append((o, 'spine' if k == 0 else ('armL' if sg < 0 else 'armR')))
            bm = bmesh.new()   # 금 테두리(겹판 아래 가장자리)
            ring = [c + V((r[0] * math.cos(a) * 1.02, r[1] * math.sin(a) * 1.02, -0.15 * (1 + k))) for a in np.linspace(0, 2 * math.pi, 28 if li == 0 else 12, endpoint=False) if (math.cos(a) * sg) > -0.62]
            rim(bm, ring, 0.075)
            g = obj_from_bm(f'cmd_paulrim{sg}{k}_{li}', bm)
            if li == 0: remesh(g, 0.035, 0.5, 2); decimate(g, 1800)
            else: decimate(g, 300)
            set_material(g, m_gold); outs.append((g, 'spine' if k == 0 else ('armL' if sg < 0 else 'armR')))
        bm = bmesh.new()   # 견갑 위 뿔 가시 3개
        for k in range(3):
            b0 = V((sg * (2.6 + 0.55 * k), -0.25 + 0.1 * k, 12.35 - 0.1 * k))
            cone(bm, b0, b0 + V((sg * 0.5, -0.5, 1.5 - 0.3 * k)), 0.3, sides=8 if li == 0 else 5, rings=4 if li == 0 else 2, bend=V((sg * 0.25, -0.3, 0)))
        sp = obj_from_bm(f'cmd_spk{sg}_{li}', bm); shade_smooth(sp.data); set_material(sp, m_gold); outs.append((sp, 'spine'))
    return outs

def helmet(li, m_black, m_gold):
    outs = []
    seg = (56, 34) if li == 0 else (18, 12)
    c = H + V((0, -0.05, 0.12))
    def cut(p):   # 얼굴 구멍: 앞쪽 · 눈썹 아래 · 턱 위
        q = p - c
        return (q.y > 0.0 and -0.75 < q.z < 0.32 and abs(q.x) < 0.66) or q.z < -0.7
    o = shell(f'cmd_helm_{li}', c, (0.96, 1.02, 1.08), cut, 0.07, seg)
    set_material(o, m_black); outs.append((o, 'head'))
    bm = bmesh.new()
    # 얼굴 구멍 테두리(금) + 정수리 능선 + 왕관 가시
    edge = []
    for t in np.linspace(0, 1, 30 if li == 0 else 12):
        a = -0.62 + 1.24 * t; edge.append(c + V((a, math.sqrt(max(0.0, 1.02 ** 2 * (1 - (a / 0.96) ** 2 - (0.32 / 1.08) ** 2))) + 0.02, 0.32)))
    rim(bm, edge, 0.05)
    for sgn in (-1, 1):
        side = [c + V((sgn * 0.62, math.sqrt(max(0.0, 1.02 ** 2 * (1 - (0.62 / 0.96) ** 2 - (z / 1.08) ** 2))) + 0.02, z)) for z in np.linspace(0.32, -0.7, 12 if li == 0 else 5)]
        rim(bm, side, 0.045)
    crest = [c + V((0, 1.02 * math.sin(a) * 0.98, 1.08 * math.cos(a) + 0.04)) for a in np.linspace(-1.6, 1.0, 26 if li == 0 else 10)]
    rim(bm, crest, 0.07)
    g = obj_from_bm(f'cmd_helmrim_{li}', bm)
    if li == 0: remesh(g, 0.025, 0.5, 2); decimate(g, 3000)
    else: decimate(g, 400)
    set_material(g, m_gold); outs.append((g, 'head'))
    bm = bmesh.new(); rr = random.Random(4)
    nsp = 9
    for k in range(nsp):   # 이마 위 왕관 가시(가운데가 가장 길다)
        a = (k - (nsp - 1) / 2) / ((nsp - 1) / 2) * 1.1
        b0 = c + V((math.sin(a) * 0.85, math.cos(a) * 0.75 - 0.05, 0.62))
        L = 0.9 - 0.45 * abs(a) + rr.uniform(-0.05, 0.08)
        cone(bm, b0, b0 + V((math.sin(a) * 0.25, math.cos(a) * 0.12, L)), 0.13, sides=6 if li == 0 else 4, rings=3 if li == 0 else 1)
    for sgn in (-1, 1):   # 관자놀이에서 뒤로 휜 큰 뿔
        b0 = c + V((sgn * 0.82, -0.1, 0.35))
        cone(bm, b0, b0 + V((sgn * 1.1, -0.9, 0.9)), 0.26, sides=10 if li == 0 else 5, rings=6 if li == 0 else 2, bend=V((sgn * 0.2, -0.4, 0.6)))
    sp = obj_from_bm(f'cmd_crown_{li}', bm); shade_smooth(sp.data); set_material(sp, m_gold); outs.append((sp, 'head'))
    return outs

def belt(li, m_gold):
    bm = bmesh.new()
    pts = [V((2.1 * math.cos(a), 1.5 * math.sin(a) + 0.02, 7.55)) for a in np.linspace(0, 2 * math.pi, 40 if li == 0 else 14, endpoint=False)]
    rim(bm, pts, 0.14, closed=True)
    ell(bm, (0, 1.55, 7.55), (0.45, 0.14, 0.38))    # 버클
    o = obj_from_bm(f'cmd_belt_{li}', bm)
    if li == 0: remesh(o, 0.04, 0.5, 2); decimate(o, 2500)
    else: decimate(o, 400)
    set_material(o, m_gold); return [(o, 'hips')]

def sword(li, m_blade, m_gold, m_grip):
    outs = []
    up = V((0, 0, 1)); side = SD.cross(up).normalized(); flat = side.cross(SD).normalized()   # side: 날 폭 방향, flat: 날 면 법선
    side, flat = flat, side   # 날이 몸 앞에서 넓게 보이도록 면이 옆을 향하게
    guard = GRIP + SD * 0.75
    L = 9.0; ns = 60 if li == 0 else 14
    bm = bmesh.new()
    rows = []
    for i in range(ns + 1):
        t = i / ns
        w = 0.66 * (1 - 0.35 * t) * (1 if t < 0.9 else (1 - t) / 0.1 * 0.9 + 0.1)   # 반폭
        th = 0.11 * (1 - 0.6 * t)
        p = guard + SD * (L * t)
        # 단면: 가장자리(날) · 능선 · 혈조(fuller, 가운데 홈)
        prof = [(-w, 0.0), (-w * 0.55, th * 0.85), (-w * 0.12, th * 0.6), (0, th * 0.62 if t > 0.65 else th * 0.35), (w * 0.12, th * 0.6), (w * 0.55, th * 0.85), (w, 0.0), (w * 0.55, -th * 0.85), (w * 0.12, -th * 0.6), (0, -(th * 0.62 if t > 0.65 else th * 0.35)), (-w * 0.12, -th * 0.6), (-w * 0.55, -th * 0.85)]
        # 칼날 이빨: 손잡이 쪽 절반에 톱니(무섭게)
        if 0.08 < t < 0.5 and i % 3 == 0: prof[0] = (-w * 1.18, 0.0)
        rows.append([bm.verts.new(p + side * a + flat * b) for (a, b) in prof])
    m = len(rows[0])
    for i in range(ns):
        for j in range(m): bm.faces.new((rows[i][j], rows[i][(j + 1) % m], rows[i + 1][(j + 1) % m], rows[i + 1][j]))
    bm.faces.new(list(reversed(rows[0])))
    tipv = bm.verts.new(guard + SD * (L + 0.25))
    for j in range(m): bm.faces.new((rows[-1][j], rows[-1][(j + 1) % m], tipv))
    bl = obj_from_bm(f'cmd_blade_{li}', bm); shade_smooth(bl.data)
    me = bl.data; co = verts_np(me)
    uvl = me.uv_layers.new(name='UVMap'); uv = np.zeros(len(me.loops) * 2, dtype=np.float32)
    for p in me.polygons:
        for lj in p.loop_indices:
            v = V(co[me.loops[lj].vertex_index]) - guard
            uv[lj * 2] = v.dot(side) * 0.9 + 0.5; uv[lj * 2 + 1] = v.dot(SD) * 0.11
    uvl.data.foreach_set('uv', uv)
    def bcol(c, nr):   # 날: 어두운 쇠 · 날 끝 밝게 · 손잡이 쪽 1/4 금 상감 · 마른 피
        v = c - guard; t = v.dot(SD) / L; a = abs(v.dot(side)); w = 0.66 * (1 - 0.35 * t)
        col = V((0.16, 0.16, 0.17))
        if a > w * 0.8: col = V((0.55, 0.55, 0.57))
        if t < 0.28 and a < w * 0.5:
            vv = math.sin((t * 30 + math.sin(a * 25) * 0.6) * math.pi) * math.sin(a * 40)
            if abs(vv) < 0.35: col = V((0.95, 0.68, 0.24))
        blood = smooth(0.3, 0.75, noise.fractal(c * 1.2, 0.8, 2.0, 3)) * smooth(0.5, 1.0, t)
        col = col.lerp(V((0.18, 0.015, 0.01)), blood * 0.7)
        return (col.x, col.y, col.z)
    set_colors(me, bcol); set_material(bl, m_blade); outs.append((bl, 'handR'))
    # 코등이(가로대) · 손잡이 · 폼멜 — 금테
    bm = bmesh.new()
    tube(bm, [guard - side * 1.35 - SD * 0.25, guard - side * 0.4, guard + side * 0.4, guard + side * 1.35 - SD * 0.25], [0.16, 0.2, 0.2, 0.16], step=0.4, seg=(14, 8) if li == 0 else (6, 4))
    for sgn in (-1, 1): cone(bm, guard + side * sgn * 1.3 - SD * 0.22, guard + side * sgn * 1.75 - SD * 0.75, 0.15, sides=8 if li == 0 else 4, rings=3 if li == 0 else 1)
    ell(bm, guard, (0.32, 0.32, 0.32), seg=(16, 10) if li == 0 else (6, 4))
    ell(bm, GRIP - SD * 1.05, (0.3, 0.3, 0.3), seg=(16, 10) if li == 0 else (6, 4))
    cone(bm, GRIP - SD * 1.2, GRIP - SD * 1.75, 0.18, sides=8 if li == 0 else 4, rings=2 if li == 0 else 1)
    g = obj_from_bm(f'cmd_hilt_{li}', bm)
    if li == 0: remesh(g, 0.03, 0.5, 2); decimate(g, 3500)
    else: decimate(g, 500)
    set_material(g, m_gold); outs.append((g, 'handR'))
    bm = bmesh.new(); tube(bm, [GRIP - SD * 0.95, GRIP + SD * 0.6], [0.17, 0.17], step=0.5, seg=(14, 8) if li == 0 else (6, 4))
    gr = obj_from_bm(f'cmd_grip_{li}', bm); decimate(gr, 2000 if li == 0 else 200); shade_smooth(gr.data); set_material(gr, m_grip); outs.append((gr, 'handR'))
    return outs

def cape(li, m_cape):
    nu, nv = (34, 46) if li == 0 else (12, 16)
    rr = random.Random(12)
    bm = bmesh.new(); grid = []
    for j in range(nv + 1):
        v = j / nv; row = []
        for i in range(nu + 1):
            u = i / nu; a = (u - 0.5) * 2
            wdt = lerp(2.5, 3.6, v)
            x = a * wdt
            y = -1.55 - 0.55 * v - 0.55 * (1 - a * a) * (0.3 + v) - 0.3 * math.sin(a * 5 + v * 4) * v
            z = 11.55 - 11.0 * v
            if v < 0.08: y += 0.6 * (1 - v / 0.08) * (a * a)   # 어깨 위로 감김
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            u0, v0 = i / nu, j / nv
            c = V(((u0 - 0.5) * 6, 0, v0 * 11))
            hole = noise.noise(c * 0.55 + V((3, 1, 2)))
            ragged = v0 > 0.82 - 0.12 * abs(noise.noise(V((u0 * 9, 0, 0)))) - 0.05 * rr.random()
            if ragged or (v0 > 0.35 and hole > 0.52 - 0.25 * v0): continue
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    bm.faces.ensure_lookup_table()
    uvl = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops:
            co = l.vert.co; u = clamp01(co.x / (2 * lerp(2.5, 3.6, (11.55 - co.z) / 11.0)) + 0.5); v = clamp01((11.55 - co.z) / 11.0)
            l[uvl].uv = (u, v)
    o = obj_from_bm(f'cmd_cape_{li}', bm)
    m = o.modifiers.new('so', 'SOLIDIFY'); m.thickness = 0.05; apply_mods(o)
    shade_smooth(o.data); fill_colors(o.data, (1, 1, 1)); set_material(o, m_cape)
    return [(o, ('spine', 'cape1', 'cape2'))]

def clamp01(x): return max(0.0, min(1.0, x))

# ----------------------------------------------------------------------------------------------------------------------
# 얼굴: 썩은 피부 · 주름 · 눈 · 이빨
# ----------------------------------------------------------------------------------------------------------------------
EYE = [H + V((sg * 0.27, 0.74, 0.07)) for sg in (-1, 1)]
def face_upper(li):
    bm = bmesh.new()
    ell(bm, H + V((0, -0.05, 0.15)), (0.76, 0.86, 0.85), seg=(32, 20))      # 두개
    for sg in (-1, 1):
        ell(bm, H + V((sg * 0.43, 0.56, -0.12)), (0.26, 0.24, 0.18))          # 광대
        ell(bm, H + V((sg * 0.55, 0.15, -0.35)), (0.2, 0.32, 0.3))            # 볼 아래 꺼짐 자리
    ell(bm, H + V((0, 0.74, 0.3)), (0.6, 0.2, 0.15))                          # 눈썹 뼈
    ell(bm, H + V((0, 0.86, 0.02)), (0.11, 0.14, 0.24))                       # 콧대
    ell(bm, H + V((0, 0.66, -0.36)), (0.4, 0.3, 0.2))                         # 윗턱
    o = obj_from_bm(f'cmd_face_{li}', bm)
    remesh(o, 0.018 if li == 0 else 0.05, 0.5, 4)
    def carve(c, nr):
        q = c - H; d = 0.0
        for e in EYE:   # 깊은 눈구멍
            r = (c - e).length
            if r < 0.24: d -= 0.17 * (1 - r / 0.24) ** 0.8
        nq = c - (H + V((0, 0.93, -0.16)))   # 콧구멍: 뼈만 남은 삼각 구멍
        if abs(nq.x) < 0.1 * (1 - nq.z * 3) and -0.08 < nq.z < 0.12 and q.y > 0.6: d -= 0.1
        mq = c - (H + V((0, 0.8, -0.47)))     # 입: 귀까지 찢어진 틈
        if abs(mq.z) < 0.06 * (1 - (mq.x / 0.52) ** 2) and abs(mq.x) < 0.52 and q.y > 0.3: d -= 0.09
        if q.y > 0.35 and 0.22 < q.z < 0.52:   # 이마 가로 주름
            d -= 0.012 * max(0.0, math.sin((q.z * 34 + noise.noise(c * 4) * 0.8) * math.pi)) ** 3
        for sg in (-1, 1):   # 눈가 잔주름(까마귀발) · 미간 세로 주름 · 팔자 주름
            e = EYE[0 if sg < 0 else 1]; v = c - e
            r = math.hypot(v.x, v.z)
            if 0.2 < r < 0.42 and v.x * sg > 0.05 and q.y > 0.3: d -= 0.009 * max(0.0, math.sin(math.atan2(v.z, v.x * sg) * 11 + r * 6)) ** 4
            nl = c - (H + V((sg * 0.2, 0.82, -0.25)))
            if abs(nl.x - sg * nl.z * -0.45) < 0.03 and abs(nl.z) < 0.22 and q.y > 0.4: d -= 0.02
        if abs(q.x) < 0.11 and 0.08 < q.z < 0.3 and q.y > 0.6: d -= 0.012 * max(0.0, math.sin(q.x * 70)) ** 2
        d -= 0.06 * smooth(0.3, 0.6, abs(q.x)) * smooth(0.1, -0.35, q.z) * (q.y > 0)   # 홀쭉한 볼
        d += 0.006 * noise.noise(c * 22) + 0.012 * noise.noise(c * 7)
        return d
    displace(o, carve)
    shade_smooth(o.data)
    return o

def face_color(c, nr):
    q = c - H
    col = V((0.74, 0.71, 0.66)) * (0.85 + 0.25 * noise.noise(c * 3))   # 시체 같은 잿빛
    col = col.lerp(V((0.45, 0.5, 0.42)), 0.3 * smooth(0.0, 0.6, noise.noise(c * 1.5)))
    for e in EYE:
        r = (c - e).length
        if r < 0.23: col = col.lerp(V((0.1, 0.02, 0.02)), smooth(0.23, 0.1, r))   # 눈두덩 피멍 + 시커먼 구멍
    mq = c - (H + V((0, 0.8, -0.47)))
    if abs(mq.x) < 0.56 and abs(mq.z) < 0.14 and q.y > 0.3: col = col.lerp(V((0.3, 0.03, 0.03)), smooth(0.14, 0.03, abs(mq.z)))   # 갈라진 입술 · 피
    nq = c - (H + V((0, 0.93, -0.16)))
    if nq.length < 0.11: col = col.lerp(V((0.06, 0.02, 0.02)), smooth(0.11, 0.04, nq.length))
    vein = abs(noise.noise(c * 5.5)) < 0.04
    if vein: col = col.lerp(V((0.28, 0.12, 0.3)), 0.5)
    drip = smooth(0.55, 0.85, noise.noise(V((c.x * 7, c.y * 7, c.z * 0.8))))   # 눈에서 흘러내린 검붉은 자국
    if q.y > 0.4 and q.z < 0.05: col = col.lerp(V((0.2, 0.02, 0.02)), drip * 0.8 * min(1, sum(smooth(0.12, 0.0, abs(c.x - e.x)) for e in EYE)))
    return (col.x, col.y, col.z)

def face_lower(li):
    bm = bmesh.new()
    ell(bm, H + V((0, 0.44, -0.66)), (0.47, 0.42, 0.19))
    ell(bm, H + V((0, 0.73, -0.75)), (0.2, 0.15, 0.13))
    for sg in (-1, 1): tube(bm, [H + V((sg * 0.5, 0.0, -0.3)), H + V((sg * 0.42, 0.55, -0.68))], [0.12, 0.13], step=0.5)
    o = obj_from_bm(f'cmd_jaw_{li}', bm)
    remesh(o, 0.02 if li == 0 else 0.05, 0.5, 3)
    def carve(c, nr):
        q = c - H; d = 0.006 * noise.noise(c * 22) + 0.01 * noise.noise(c * 7)
        if q.y > 0.3 and -0.62 < q.z < -0.5: d -= 0.05 * smooth(0.6, 0.2, abs(q.x))   # 아랫입술 자리
        if q.y > 0.4 and q.z < -0.7: d -= 0.01 * max(0.0, math.sin(q.x * 60)) ** 3   # 턱 주름
        return d
    displace(o, carve); shade_smooth(o.data)
    return o

def teeth(li, upper):
    bm = bmesh.new(); rr = random.Random(7 if upper else 8)
    n = 22 if li == 0 else 10
    zc = -0.43 if upper else -0.55
    for k in range(n):
        u = (k + 0.5) / n * 2 - 1   # -1..1 (왼→오)
        x = 0.42 * math.sin(u * 1.35); y = 0.44 + 0.36 * math.cos(u * 1.35)
        base = H + V((x, y, zc))
        fang = abs(abs(u) - 0.42) < 0.08
        L = (rr.uniform(0.2, 0.27) if fang else rr.uniform(0.04, 0.17)) * (1.0 if upper else 0.8)
        if rr.random() < 0.12: continue   # 빠진 이
        w = rr.uniform(0.028, 0.04) * (1.3 if fang else 1)
        tip = base + V((rr.uniform(-0.02, 0.02), rr.uniform(-0.01, 0.03), -L if upper else L))
        cone(bm, base, tip, w, sides=8 if li == 0 else 4, rings=4 if li == 0 else 1, bend=V((0, 0.015, 0)), flat=0.75)
    o = obj_from_bm(f'cmd_teeth{"U" if upper else "L"}_{li}', bm); shade_smooth(o.data)
    return o

def gums(li, upper):
    bm = bmesh.new()
    zc = -0.43 if upper else -0.55
    pts = [H + V((0.43 * math.sin(u * 1.35), 0.43 + 0.36 * math.cos(u * 1.35), zc + (0.015 if upper else -0.015))) for u in np.linspace(-1, 1, 14 if li == 0 else 6)]
    pts = [p + V((0, -0.03, 0)) for p in pts]
    tube(bm, pts, [0.03] * len(pts), step=0.8, seg=(10, 6) if li == 0 else (5, 3))
    ell(bm, H + V((0, 0.42, zc + (0.07 if upper else -0.06))), (0.4, 0.34, 0.05), seg=(16, 8) if li == 0 else (6, 4))   # 입천장 · 혀 자리(어둡게)
    o = obj_from_bm(f'cmd_gum{"U" if upper else "L"}_{li}', bm); shade_smooth(o.data)
    return o

def eyes(li, m_eyeball, m_iris, m_pupil):
    outs = []
    seg = (24, 16) if li == 0 else (8, 6)
    for e in EYE:
        c = e + V((0, -0.04, 0))
        bm = bmesh.new(); ell(bm, c, (0.105, 0.105, 0.1), seg=seg)
        ob = obj_from_bm('cmd_eyeball', bm); shade_smooth(ob.data); box_uv(ob.data, 4.0); set_material(ob, m_eyeball); outs.append((ob, 'head'))
        bm = bmesh.new(); ell(bm, c + V((0, 0.088, 0)), (0.072, 0.025, 0.07), seg=seg)   # 빛나는 홍채
        oi = obj_from_bm('cmd_iris', bm); shade_smooth(oi.data); set_material(oi, m_iris); outs.append((oi, 'head'))
        bm = bmesh.new(); ell(bm, c + V((0, 0.108, 0)), (0.014, 0.012, 0.055), seg=(12, 8) if li == 0 else (6, 4))   # 세로로 찢어진 동공
        op = obj_from_bm('cmd_pupil', bm); set_material(op, m_pupil); outs.append((op, 'head'))
    return outs

# ----------------------------------------------------------------------------------------------------------------------
def build(out, prev):
    reset_scene()
    T = textures()
    m_armor = material('cmd_armor', rough=0.4, metal=0.7, albedo=T['armorA'], normal=T['armorN'], nstrength=0.8)
    m_black = material('cmd_plate', base=(0.07, 0.07, 0.078), rough=0.36, metal=0.7, albedo=T['armorA'], normal=T['armorN'], nstrength=0.8)
    m_gold = material('cmd_gold', base=(1.0, 0.7, 0.22), rough=0.32, metal=0.75, albedo=T['goldA'], normal=T['goldN'], nstrength=1.0)
    m_blade = material('cmd_blade', rough=0.28, metal=0.95, albedo=T['armorA'], normal=T['armorN'], nstrength=0.6)
    m_grip = material('cmd_grip', base=(0.12, 0.06, 0.04), rough=0.85, albedo=T['capeA'], normal=T['capeN'])
    m_cape = material('cmd_cape', rough=0.9, albedo=T['capeA'], normal=T['capeN'], nstrength=1.0, double=True)
    m_skin = material('cmd_skin', rough=0.62, albedo=T['skinA'], normal=T['skinN'], nstrength=1.3)
    m_tooth = material('cmd_tooth', rough=0.35, albedo=T['toothA'], normal=T['toothN'], nstrength=0.8)
    m_gum = material('cmd_gum', base=(0.32, 0.03, 0.04), rough=0.25, emit=(0.08, 0.0, 0.0), emit_k=0.3)
    m_eyeball = material('cmd_eyeball', rough=0.12, albedo=T['eyeA'])
    m_iris = material('cmd_iris', base=(1.0, 0.55, 0.08), rough=0.2, emit=(1.0, 0.45, 0.05), emit_k=7.0)
    m_pupil = material('cmd_pupil', base=(0.0, 0.0, 0.0), rough=0.1)
    arm = make_armature('Commander', BONES)
    body = armor_body()
    extras = []
    for li in range(2):
        ex = []
        fu = face_upper(li)
        if li == 0: decimate(fu, 26000)
        else: decimate(fu, 2600)
        box_uv(fu.data, 1.3); set_colors(fu.data, face_color); set_material(fu, m_skin); ex.append((fu, 'head'))
        fl = face_lower(li)
        decimate(fl, 9000 if li == 0 else 900)
        box_uv(fl.data, 1.3); set_colors(fl.data, face_color); set_material(fl, m_skin); ex.append((fl, 'jaw'))
        for up in (True, False):
            t = teeth(li, up); box_uv(t.data, 3.0); fill_colors(t.data, (1, 1, 1)); set_material(t, m_tooth); ex.append((t, 'head' if up else 'jaw'))
            g = gums(li, up); fill_colors(g.data, (1, 1, 1)); set_material(g, m_gum); ex.append((g, 'head' if up else 'jaw'))
        ex += eyes(li, m_eyeball, m_iris, m_pupil)
        ex += helmet(li, m_black, m_gold)
        ex += pauldrons(li, m_black, m_gold)
        ex += belt(li, m_gold)
        ex += sword(li, m_blade, m_gold, m_grip)
        ex += cape(li, m_cape)
        extras.append(ex)
    if prev:   # 미리보기 전용 얼굴 조명(내보내기에는 안 들어감)
        lo = bpy.data.objects.new('facefill', bpy.data.lights.new('facefill', 'POINT')); lo.data.energy = 900; lo.data.color = (1.0, 0.75, 0.6); lo.location = H + V((1.2, 3.5, 0.6)); bpy.context.scene.collection.objects.link(lo)
    lods = finish_lods('Commander', body, extras, arm, BONES, [42000, 8000], 0.45, body_color, m_armor)
    finalize(arm, lods, out, 'commander.glb', prev, 'commander',
             [((8, 30, 9), (0, 0, 8.0)), ((1.3, 4.6, 13.0), (0, 0.6, 12.9)), ((-14, -18, 10), (0, 0, 7.5))])

if __name__ == '__main__':
    out, prev = parse_args()
    build(out, prev)
