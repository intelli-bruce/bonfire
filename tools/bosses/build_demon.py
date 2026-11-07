"""
대악마(Great Demon) 절차적 모델링 → 뼈대 → LOD 2단 → Draco 압축 glb (bf/demon.glb)

실행:  blender -b --factory-startup --python tools/bosses/build_demon.py -- [--out bf] [--preview <dir>]

- build_bosses.py 의 도구(타원체·관·원뿔·remesh·가중치·내보내기)를 그대로 쓴다. 외부 에셋 없음(텍스처도 numpy).
- 키 약 16 m, 굽은 등. 회백색 근육질 몸, 가슴의 붉은 빛 균열(발광 면 + 속 심장), 거대한 굽은 뿔 한 쌍, 검은 갈기,
  붉은 눈(세로 동공), 이마·콧등 주름, 위·아래 이빨 줄과 송곳니, 손가락마다 검은 갈고리 발톱.
- 머리는 몸보다 4배 촘촘한 voxel(0.035 m)로 따로 만들어 얼굴 근접 디테일(주름·눈두덩·광대·입술)을 살린다.
- 텍스처 2048²: 피부(모공·잔주름·핏줄) 색 + 노멀맵, 뿔(나이테 골) 색 + 노멀맵.
- LOD: Demon_LOD0(가까이) · Demon_LOD1(멀리). 뼈 이름은 bf/demon.js 가 쓴다.
"""
import bpy, bmesh, math, sys, os, random
import numpy as np
from mathutils import Vector, Matrix, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hq import bake_ao, hair_cards
from build_bosses import (V, lerp, smooth, basis_from, ell, tube, cone, obj_from_bm, remesh, decimate, shade_smooth, box_uv,
                          set_colors, fill_colors, set_material, copy_obj, displace, tex_fbm, tex_cells, height_to_normal,
                          make_image, material, make_armature, skin, finish_lods, finalize, reset_scene, tri_count)

H = V((0, 3.0, 13.6))          # 머리 중심
CHEST = V((0, 2.75, 11.1))     # 가슴 균열 중심(앞면)
DEMON_BONES = [
    ('hips', (0, 0, 7.0), (0, 0.4, 9.4), None),
    ('spine', (0, 0.4, 9.4), (0, 1.4, 12.4), 'hips'),
    ('head', (0, 2.0, 13.0), (0, 3.4, 14.0), 'spine'),
    ('jaw', (0, 2.6, 13.05), (0, 4.1, 12.65), 'head'),
    ('armL', (-3.9, 1.0, 12.2), (-5.3, 2.0, 8.8), 'spine'), ('foreL', (-5.3, 2.0, 8.8), (-5.6, 3.8, 6.0), 'armL'), ('handL', (-5.6, 3.8, 6.0), (-5.7, 4.9, 4.3), 'foreL'),
    ('armR', (3.9, 1.0, 12.2), (5.3, 2.0, 8.8), 'spine'), ('foreR', (5.3, 2.0, 8.8), (5.6, 3.8, 6.0), 'armR'), ('handR', (5.6, 3.8, 6.0), (5.7, 4.9, 4.3), 'foreR'),
    ('thighL', (-1.9, 0.2, 7.0), (-2.5, 1.8, 4.0), 'hips'), ('shinL', (-2.5, 1.8, 4.0), (-2.6, 0.0, 0.6), 'thighL'),
    ('thighR', (1.9, 0.2, 7.0), (2.5, 1.8, 4.0), 'hips'), ('shinR', (2.5, 1.8, 4.0), (2.6, 0.0, 0.6), 'thighR'),
]
EYES = [H + V((s * 0.5, 1.16, 0.15)) for s in (-1, 1)]

def skin_textures(n=2048):
    pores = tex_fbm(n, 0.15, 101, lo=180)                  # 모공(아주 고운 점)
    fine = tex_fbm(n, 0.9, 102, lo=24)                     # 잔주름 결
    F1, F2 = tex_cells(n, 260, 103)
    wr = np.clip(1 - (F2 - F1) * 60, 0, 1) ** 3            # 잔주름 망(그물)
    vein = 1 - np.abs(tex_fbm(n, 1.6, 104, lo=3) * 2 - 1)  # 핏줄(능선)
    vein = np.clip((vein - 0.9) / 0.1, 0, 1)
    lump = tex_fbm(n, 1.9, 105)
    fib = tex_fbm(n, 1.2, 106, lo=6)                       # 근섬유 결(길쭉한 골)
    yy, xx = np.mgrid[0:n, 0:n] / n
    fibre = 0.5 + 0.5 * np.sin((xx * 0.35 + yy) * 2 * np.pi * 34 + fib * 9)
    scar = 1 - np.abs(tex_fbm(n, 1.8, 107, lo=2) * 2 - 1)  # 흉터: 굵고 드문 능선
    scar = np.clip((scar - 0.965) / 0.035, 0, 1)
    h = 0.35 * lump + 0.25 * fine - 0.45 * wr - 0.12 * (pores > 0.62) + 0.3 * vein + 0.12 * fibre - 0.35 * scar
    tone = 0.84 + 0.12 * lump - 0.2 * wr - 0.08 * (pores > 0.6) - 0.08 * (1 - fibre)
    alb = tone[..., None] * np.array([0.88, 0.84, 0.86])   # 잿빛(살짝 보라)
    sss = np.clip(wr * 0.8 + (1 - fibre) * 0.15, 0, 1)[..., None]
    alb = alb * (1 - sss * np.array([0.0, 0.22, 0.2]))                  # 골·주름 속은 붉게(피하 산란 느낌)
    alb = alb * (1 - vein[..., None] * np.array([0.35, 0.62, 0.5]))      # 핏줄: 검붉은 보라
    alb = alb * (1 - scar[..., None] * 0.15) + scar[..., None] * np.array([0.12, 0.05, 0.06])   # 흉터: 붉은 기 도는 연한 줄
    rough = np.clip(0.62 + 0.18 * wr - 0.22 * vein - 0.25 * scar + 0.06 * (pores > 0.6), 0.25, 0.95)
    return (make_image('demon_skin', alb), make_image('demon_skin_n', height_to_normal(h, 16.0), True),
            make_image('demon_skin_r', np.stack([rough] * 3, -1), True))

def horn_textures(n=1024):
    yy = np.mgrid[0:n, 0:n][0] / n
    grain = tex_fbm(n, 0.7, 112, lo=10)
    flake = tex_fbm(n, 0.35, 113, lo=60)                   # 거친 각질 비늘
    streak = tex_fbm(n, 1.1, 114, lo=4)
    h = 0.5 * grain + 0.45 * (flake > 0.55) + 0.3 * streak
    alb = (0.6 + 0.35 * grain - 0.15 * (flake > 0.58))[..., None] * np.array([0.78, 0.7, 0.6])
    rough = np.clip(0.72 + 0.2 * (flake > 0.55) - 0.15 * grain, 0.3, 0.98)
    return (make_image('demon_horn', alb), make_image('demon_horn_n', height_to_normal(h, 12.0), True),
            make_image('demon_horn_r', np.stack([rough] * 3, -1), True))

def mane_textures(n=1024):
    """털 다발: 세로로 길게 늘어진 가닥(이방성 노이즈) — 색·노멀."""
    rng = np.random.default_rng(121)
    w = rng.standard_normal((n, n // 32))
    xx = np.linspace(0, n // 32, n, endpoint=False)
    cols = np.array([np.interp(xx, np.arange(n // 32 + 1), np.append(w[r], w[r][0])) for r in range(n)])   # 가로로만 변하고 세로로 길다
    strand = (cols - cols.min()) / (np.ptp(cols) + 1e-6)
    fine = tex_fbm(n, 0.4, 122, lo=40)
    h = 0.7 * strand + 0.3 * fine
    alb = (0.08 + 0.22 * strand ** 2 + 0.05 * fine)[..., None] * np.array([1.0, 0.82, 0.78])
    return make_image('demon_mane', alb), make_image('demon_mane_n', height_to_normal(h, 10.0), True)

def rough_map(m, img):
    """러프니스 맵(glTF metallicRoughness 의 G 채널로 내보내진다)."""
    nt = m.node_tree; bs = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
    sp = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(t.outputs['Color'], sp.inputs['Color']); nt.links.new(sp.outputs['Green'], bs.inputs['Roughness'])

def build_demon(out, prev):
    reset_scene()
    A, N, R = skin_textures()
    HA, HN, HR = horn_textures()
    MA, MN = mane_textures()
    m_skin = material('demon_skin', rough=0.62, albedo=A, normal=N, nstrength=1.6); rough_map(m_skin, R)
    m_crack = material('demon_crack', base=(1.0, 0.12, 0.04), rough=0.5, emit=(1.0, 0.1, 0.02), emit_k=6.0)
    m_core = material('demon_core', base=(1.0, 0.35, 0.18), rough=0.2, emit=(1.0, 0.22, 0.06), emit_k=9.0)
    m_eye = material('demon_eye', base=(1.0, 0.1, 0.03), rough=0.15, emit=(1.0, 0.08, 0.02), emit_k=7.0)
    m_pupil = material('demon_pupil', base=(0.02, 0.0, 0.0), rough=0.1)
    m_horn = material('demon_horn', rough=0.8, albedo=HA, normal=HN, nstrength=1.4); rough_map(m_horn, HR)
    m_tip = material('demon_horn_tip', base=(0.09, 0.07, 0.06), rough=0.18, normal=HN, nstrength=0.4)   # 끝: 매끈하게 닳아 광택
    m_tooth = material('demon_tooth', base=(0.86, 0.8, 0.66), rough=0.35)
    m_gum = material('demon_gum', base=(0.22, 0.03, 0.03), rough=0.45, emit=(0.5, 0.03, 0.01), emit_k=0.35)
    m_claw = material('demon_claw', base=(0.05, 0.04, 0.04), rough=0.25, metal=0.2)
    m_mane = material('demon_mane', rough=0.7, albedo=MA, normal=MN, nstrength=1.3, double=True)
    arm = make_armature('Demon', DEMON_BONES)

    # ---------- 몸: 골반 · 굽은 등 · 가슴 근육 · 어깨 · 팔 · 다리 ----------
    bm = bmesh.new()
    ell(bm, (0, 0.1, 7.2), (2.6, 1.9, 1.5)); ell(bm, (0, 0.5, 8.7), (2.3, 1.7, 1.4))       # 골반 · 배
    for k in range(3):   # 복근 3단
        for s in (-1, 1): ell(bm, (s * 0.55, 1.75 - 0.15 * k, 9.0 + 0.7 * k), (0.62, 0.45, 0.38))
    ell(bm, (0, 1.1, 10.9), (3.3, 2.2, 1.9)); ell(bm, (0, -0.4, 11.9), (3.4, 2.2, 2.0))     # 흉곽 + 굽은 등
    for s in (-1, 1):
        ell(bm, (s * 1.45, 2.15, 11.4), (1.55, 0.75, 1.05), basis_from(V((s * 0.5, 1, -0.2))))   # 대흉근
        ell(bm, (s * 1.5, 0.2, 12.9), (1.6, 1.4, 0.9))                                            # 승모근(목 옆 혹)
        ell(bm, (s * 3.9, 0.9, 12.15), (1.55, 1.45, 1.4))                                         # 삼각근
        ell(bm, (s * 2.6, -1.6, 11.0), (1.2, 0.9, 1.9))                                           # 광배근
        tube(bm, [(s * 4.1, 1.0, 11.6), (s * 5.3, 2.0, 8.8)], [1.25, 0.95], step=0.5)              # 위팔
        ell(bm, (s * 4.75, 1.85, 10.2), (0.85, 0.8, 1.15))                                        # 이두근
        tube(bm, [(s * 5.3, 2.0, 8.8), (s * 5.6, 3.8, 6.0)], [1.05, 0.7], step=0.5)                # 아래팔
        ell(bm, (s * 5.45, 2.6, 8.1), (0.85, 0.8, 0.95))                                          # 아래팔 근육
        tube(bm, [(s * 1.9, 0.2, 7.0), (s * 2.5, 1.8, 4.0)], [1.45, 1.0], step=0.5)                # 허벅지
        ell(bm, (s * 2.2, 1.3, 5.8), (1.1, 1.0, 1.4))
        tube(bm, [(s * 2.5, 1.8, 4.0), (s * 2.55, 0.6, 2.0), (s * 2.6, 0.0, 0.7)], [1.0, 0.8, 0.6], step=0.5)   # 정강이(뒤로 꺾인 발목)
        ell(bm, (s * 2.6, 0.9, 0.4), (0.85, 1.6, 0.45))                                            # 발
    tube(bm, [(0, 0.7, 12.6), (0, 1.7, 13.2)], [1.2, 1.0], step=0.5)                               # 목
    body = obj_from_bm('demon_body', bm)
    remesh(body, 0.09, 0.6, 8)

    def carve(c, nr):
        d = 0.012 * noise.noise(c * 1.6) + 0.008 * noise.noise(c * 5.0)
        # 근육 결(가는 줄무늬)
        d += 0.008 * math.sin(c.x * 9 + c.y * 3 + noise.noise(c * 0.8) * 4)
        # 가슴 균열: 사발처럼 파이고 가장자리가 갈라진다
        q = c - CHEST
        if q.length < 2.4 and nr.y > 0.2:
            dist, _ = noise.voronoi(c * 0.9, distance_metric='DISTANCE'); e = dist[1] - dist[0]
            if e < 0.1: d -= 0.16 * (1 - e / 0.1)
            d -= 0.12 * (1 - q.length / 2.4)
        # 갈비뼈 윤곽
        if abs(c.x) > 1.4 and abs(c.x) < 3.2 and 9.6 < c.z < 11.2 and nr.y > -0.3: d += 0.05 * max(0.0, math.sin(c.z * 6.5))
        return d
    displace(body, carve)

    def demon_color(c, nr):
        base = V((0.86, 0.84, 0.86)) * (0.86 + 0.18 * noise.noise(c * 0.6))
        # 오목한 곳(아래를 향한 면) 은 어둡게: 근육 사이 그늘
        base = base * (0.5 + 0.5 * smooth(-0.8, 0.6, nr.z))
        base = base.lerp(V((0.48, 0.44, 0.46)), 0.35 * smooth(0.2, 0.9, noise.noise(c * 0.25) + 0.3))   # 멍든 듯 탁한 반점
        q = (c - CHEST).length
        if q < 3.6: base = base.lerp(V((0.45, 0.08, 0.06)), 0.85 * (1 - q / 3.6) ** 1.6)                # 균열 둘레 달아오름
        if c.z < 1.6: base = base * 0.6                                                                  # 발: 그을음
        hd = (c - H).length
        if hd < 2.2: base = base * (0.8 + 0.2 * hd / 2.2)
        return (base.x, base.y, base.z)

    def crack_faces(o, li):
        me = o.data
        if len(me.materials) < 2: me.materials.append(m_crack)
        for p in me.polygons:
            c = p.center; q = (c - CHEST).length
            if q > 2.6 or p.normal.y < 0.1: continue
            dist, _ = noise.voronoi(c * 0.9, distance_metric='DISTANCE'); e = dist[1] - dist[0]
            if e < 0.022 * (1.5 - q / 2.6) or q < 0.35: p.material_index = 1
        me.update()

    # ---------- 머리(촘촘한 voxel): 두개골 · 눈두덩 · 광대 · 주둥이 · 윗입술 ----------
    def head_mesh(li):
        bm = bmesh.new()
        ell(bm, H + V((0, -0.1, 0.2)), (1.15, 1.25, 1.05))
        ell(bm, H + V((0, 1.02, 0.34)), (1.15, 0.5, 0.3))                     # 눈두덩(앞으로 튀어나온 이마뼈)
        for s in (-1, 1):
            ell(bm, H + V((s * 0.78, 0.85, -0.12)), (0.42, 0.5, 0.32))          # 광대
            ell(bm, H + V((s * 0.38, 1.35, -0.52)), (0.4, 0.42, 0.3))           # 윗입술 볼록
        ell(bm, H + V((0, 1.25, -0.22)), (0.55, 0.65, 0.5))                     # 콧등·주둥이
        ell(bm, H + V((0, 1.62, -0.05)), (0.3, 0.22, 0.24))                     # 코끝
        for s in (-1, 1): ell(bm, H + V((s * 0.7, 0.2, -0.55)), (0.42, 0.75, 0.45))   # 볼·턱관절
        o = obj_from_bm(f'demon_head{li}', bm)
        remesh(o, 0.035 if li == 0 else 0.08, 0.5, 4)

        def face(c, nr):
            q = c - H; d = 0.0
            # 이마 주름: 눈썹 위로 가로 골 5줄(가운데로 모이며 아래로 휜다)
            if q.y > 0.3 and 0.45 < q.z < 1.15 and abs(q.x) < 1.1:
                w = math.sin((q.z + 0.18 * abs(q.x) ** 2) * 34) * smooth(0.45, 0.6, q.z) * (1 - smooth(0.95, 1.15, q.z))
                d += 0.018 * w
            # 미간 세로 주름(찡그림)
            if q.y > 0.9 and 0.2 < q.z < 0.75 and abs(q.x) < 0.35: d -= 0.03 * max(0.0, math.cos(q.x * 30)) * (1 - abs(q.x) / 0.35)
            # 콧등 주름(으르렁): 코 위 가로 골
            if q.y > 1.1 and -0.3 < q.z < 0.2 and abs(q.x) < 0.55: d += 0.022 * math.sin(q.z * 42) * (1 - abs(q.x) / 0.55)
            # 눈 밑 처진 주름 · 광대 아래 깊은 골
            for s in (-1, 1):
                e = EYES[0 if s < 0 else 1]; de = (c - e)
                if de.length < 0.36: d -= 0.09 * (1 - de.length / 0.36) ** 1.5           # 눈구멍
                if -0.45 < de.z < -0.12 and abs(de.x) < 0.45 and de.y > -0.3: d += 0.014 * math.sin(de.z * 60)
                nl = c - (H + V((s * 0.55, 1.25, -0.55)))
                if nl.length < 0.32: d -= 0.05 * (1 - nl.length / 0.32)                  # 팔자 골
            nn = c - (H + V((0, 1.7, -0.08)))                                            # 콧구멍
            for s in (-1, 1):
                k = (nn - V((s * 0.13, 0, -0.05))).length
                if k < 0.1: d -= 0.07 * (1 - k / 0.1)
            # 입가: 윗입술이 들려 이빨이 보인다 → 윗입술 아래 가장자리를 파낸다
            if q.y > 0.8 and q.z < -0.62: d -= 0.12 * smooth(-0.62, -0.85, q.z)
            d += 0.012 * noise.noise(c * 9.0) + 0.006 * noise.noise(c * 24.0)
            return d
        displace(o, face)
        return o

    def jaw_mesh(li):
        bm = bmesh.new()
        ell(bm, H + V((0, 0.95, -1.38)), (0.8, 0.85, 0.27))
        for s in (-1, 1): ell(bm, H + V((s * 0.62, 0.35, -1.1)), (0.3, 0.6, 0.38))
        ell(bm, H + V((0, 1.5, -1.45)), (0.38, 0.3, 0.24))                       # 턱 끝
        o = obj_from_bm(f'demon_jaw{li}', bm)
        remesh(o, 0.035 if li == 0 else 0.08, 0.5, 3)
        displace(o, lambda c, n: 0.012 * noise.noise(c * 9.0) + (0.015 * math.sin(c.y * 40) if n.z < -0.3 else 0))
        return o

    def mouth_bits(li):
        """이빨(위·아래 줄 + 송곳니 4) · 잇몸 · 입속. 위 줄은 머리뼈, 아래 줄은 턱뼈."""
        rnd = random.Random(7); outs = []
        for (updown, c0, bn) in ((-1, H + V((0, 1.05, -0.78)), 'head'), (1, H + V((0, 0.98, -1.2)), 'jaw')):
            bmT, bmG = bmesh.new(), bmesh.new()
            nT = 11 if li == 0 else 7
            for i in range(nT):
                u = (i / (nT - 1)) * 2 - 1
                p = c0 + V((0.6 * math.sin(u * 1.25), 0.5 * math.cos(u * 1.25) - 0.1, 0))
                fang = abs(abs(u) - 0.55) < 0.12
                L = (0.5 if fang else 0.2 + 0.08 * rnd.random()) * (1.25 if updown < 0 else 0.9)
                tip = p + V((0, 0.05, updown * L))
                cone(bmT, p, tip, (0.085 if fang else 0.05) * (1 + 0.15 * rnd.random()), sides=6 if li == 0 else 4, rings=3, bend=V((0, 0.04, 0)))
                ell(bmG, p, (0.075, 0.075, 0.05), seg=(8, 5))
            if updown > 0: ell(bmG, H + V((0, 0.55, -1.0)), (0.6, 0.7, 0.3), seg=(16, 8))   # 입속(어두운 붉은 목구멍)
            T = obj_from_bm(f'demon_teeth{bn}{li}', bmT); set_material(T, m_tooth)
            G = obj_from_bm(f'demon_gum{bn}{li}', bmG); set_material(G, m_gum)
            outs += [(T, bn), (G, bn)]
        return outs

    def eyes(li):
        bmE, bmP = bmesh.new(), bmesh.new()
        for e in EYES:
            tilt = Matrix.Rotation((0.38 if e.x > 0 else -0.38), 3, 'Y')   # 눈꼬리가 위로 찢어진 노려보는 눈
            ell(bmE, e, (0.19, 0.09, 0.075), tilt, seg=(16, 10) if li == 0 else (8, 6))
            ell(bmP, e + V((0, 0.085, 0)), (0.022, 0.02, 0.07), tilt, seg=(8, 6))        # 세로 동공
        E = obj_from_bm(f'demon_eye{li}', bmE); set_material(E, m_eye)
        P = obj_from_bm(f'demon_pupil{li}', bmP); set_material(P, m_pupil)
        return [(E, 'head'), (P, 'head')]

    def horns(li):
        """굽은 거대 뿔: 이마 옆에서 바깥·뒤로 솟았다가 크게 휘어 앞을 향한다(숫양형 + 위로 치솟은 끝)."""
        bm = bmesh.new()
        for s in (-1, 1):
            pts, rad = [], []
            nP = 46
            for k in range(nP):
                t = k / (nP - 1)
                a = t * 3.6
                r = 0.9 + 1.4 * t
                x = s * (0.75 + 1.6 * t + 0.25 * math.sin(a))
                y = 0.3 - r * math.sin(a) * 0.55 + 2.2 * t * t
                z = 0.9 + r * (1 - math.cos(a)) * 0.45 + 1.2 * t
                pts.append(H + V((x, y, z)))
                rad.append((0.48 * (1 - t) ** 0.9 + 0.03) * (1 + 0.07 * math.sin(k * 2.1)))   # 마디(골) 무늬
            tube(bm, pts, rad, step=0.35, seg=(14, 10) if li == 0 else (8, 6))
            # 작은 곁뿔 두 개(이마)
            cone(bm, H + V((s * 0.35, 0.85, 0.7)), H + V((s * 0.55, 1.15, 1.35)), 0.13, sides=8 if li == 0 else 5, rings=4, bend=V((s * 0.1, 0.12, 0)))
        o = obj_from_bm(f'demon_horns{li}', bm)
        remesh(o, 0.045 if li == 0 else 0.1, 0.5, 2)
        decimate(o, 7000 if li == 0 else 1800)
        box_uv(o.data, 0.8); set_material(o, m_horn)
        # 고리 무늬(뿌리에서 끝으로 갈수록 촘촘) · 끝은 매끈한 검은 광택 재질
        def hc(c, nr):
            d = (c - H).length; ring = 0.5 + 0.5 * math.sin(d * 9.0 + noise.noise(c * 2.0) * 1.5)
            k = 0.62 + 0.38 * ring ** 2
            return (k * 1.0, k * 0.95, k * 0.9)
        set_colors(o.data, hc)
        me = o.data; dmax = max((v.co - H).length for v in me.vertices)
        me.materials.append(m_tip)
        for p in me.polygons:
            if (p.center - H).length > dmax * 0.8: p.material_index = 1
        me.update()
        return o

    def mane(li):
        """검은 갈기: 뒷머리 · 목 · 어깨 위로 뻗은 굵은 털다발(뒤·아래로 휘어짐)."""
        bm = bmesh.new(); rnd = random.Random(11)
        cnt = 240 if li == 0 else 70
        if li == 0:   # 가까이: 헤어 카드 — 다발마다 가는 띠 7장(뿌리 굵고 끝 가늘게, 뒤·아래로 휨) + 속을 채우는 작은 원뿔
            roots = []
            for _ in range(cnt):
                u = rnd.random(); s = rnd.choice((-1, 1))
                base = V((s * rnd.uniform(0, 2.6) * (0.4 + u), lerp(1.6, -1.0, u) + rnd.uniform(-0.3, 0.3), lerp(14.2, 12.0, u) + rnd.uniform(-0.3, 0.3)))
                L = rnd.uniform(1.2, 2.8) * (1.2 - 0.4 * u)
                tip = base + V((s * rnd.uniform(0.2, 0.9), -L * 0.8, rnd.uniform(-0.2, 0.7)))
                roots.append((base, tip, V((0, -0.2, -rnd.uniform(0.4, 1.1))), 0.16))
                if rnd.random() < 0.4: cone(bm, base, base + (tip - base) * 0.55, rnd.uniform(0.16, 0.28), sides=4, rings=2, bend=V((0, -0.1, -0.3)), flat=0.5)
            hair_cards(bm, roots, rnd, cards_per_lock=7, segs=5, width=0.09)
            o = obj_from_bm(f'demon_mane{li}', bm)
            box_uv(o.data, 0.5); set_colors(o.data, lambda c, n: (0.45 + 0.55 * smooth(11.4, 14.4, c.z),) * 3); set_material(o, m_mane)
            return o
        for _ in range(cnt):
            u = rnd.random(); s = rnd.choice((-1, 1))
            base = V((s * rnd.uniform(0, 2.6) * (0.4 + u), lerp(1.6, -1.0, u) + rnd.uniform(-0.3, 0.3), lerp(14.2, 12.0, u) + rnd.uniform(-0.3, 0.3)))
            L = rnd.uniform(1.0, 2.4) * (1.2 - 0.4 * u)
            tip = base + V((s * rnd.uniform(0.2, 0.9), -L * 0.8, rnd.uniform(-0.2, 0.7)))
            cone(bm, base, tip, rnd.uniform(0.18, 0.36), sides=5 if li == 0 else 4, rings=3 if li == 0 else 2, bend=V((0, -0.2, -rnd.uniform(0.4, 1.1))), flat=0.5)
        o = obj_from_bm(f'demon_mane{li}', bm)
        box_uv(o.data, 0.5); set_colors(o.data, lambda c, n: (0.6 + 0.4 * smooth(-0.6, 0.8, n.z),) * 3); set_material(o, m_mane)
        return o

    def hands(li, s):
        """손바닥 · 손가락 4 + 엄지(관) · 손가락 끝 검은 갈고리 발톱."""
        bm = bmesh.new(); bc = bmesh.new()
        wrist = V((s * 5.6, 3.8, 6.0)); palm = V((s * 5.68, 4.3, 5.1))
        ell(bm, palm, (0.75, 0.55, 0.85), basis_from(V((0, 0.3, -1))))
        for f in range(5):
            thumb = f == 4
            ang = (-0.5 + f * 0.33) if not thumb else 1.15
            root = palm + V((s * 0.5 * math.sin(ang) * (1.4 if thumb else 1), 0.35 if not thumb else 0.1, -0.55 if not thumb else -0.1))
            L = 1.4 if not thumb else 0.9
            j1 = root + V((s * 0.25 * math.sin(ang), 0.45, -L * 0.45))
            j2 = j1 + V((s * 0.12 * math.sin(ang), 0.45, -L * 0.3))
            tip = j2 + V((0, 0.35, -L * 0.18))
            tube(bm, [root, j1, j2, tip], [0.24, 0.2, 0.16, 0.12], step=0.45, seg=(10, 8) if li == 0 else (6, 5))
            cone(bc, tip - V((0, 0.05, -0.02)), tip + V((0, 0.62, -0.38)), 0.13, sides=7 if li == 0 else 4, rings=4 if li == 0 else 2, bend=V((0, 0.1, -0.28)))
        hb = obj_from_bm(f'demon_hand{"L" if s < 0 else "R"}{li}', bm)
        remesh(hb, 0.05 if li == 0 else 0.12, 0.5, 3); decimate(hb, 3500 if li == 0 else 700)
        displace(hb, lambda c, n: 0.012 * math.sin(c.z * 28) + 0.01 * noise.noise(c * 6))   # 마디 주름
        box_uv(hb.data, 0.3); set_colors(hb.data, lambda c, n: (0.62, 0.6, 0.58)); set_material(hb, m_skin)
        cl = obj_from_bm(f'demon_claws{"L" if s < 0 else "R"}{li}', bc); set_material(cl, m_claw)
        bn = 'handL' if s < 0 else 'handR'
        return [(hb, bn), (cl, bn)]

    def toe_claws(li):
        bm = bmesh.new()
        for s in (-1, 1):
            for k in range(3):
                b = V((s * (2.6 + (k - 1) * 0.42), 2.2, 0.35))
                cone(bm, b, b + V((0, 0.55, -0.35)), 0.15, sides=6 if li == 0 else 4, rings=3, bend=V((0, 0.05, -0.1)))
        o = obj_from_bm(f'demon_toes{li}', bm); set_material(o, m_claw)
        return o

    def core(li):
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2 if li == 0 else 1, radius=0.55, matrix=Matrix.Translation(CHEST + V((0, -0.35, 0))))
        o = obj_from_bm(f'demon_core{li}', bm); set_material(o, m_core); return o

    def grow(o, k):
        me = o.data; co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        co = np.array(H) + (co - np.array(H)) * k; me.vertices.foreach_set('co', co.reshape(-1).astype(np.float32)); me.update()
    HEADK = 1.35   # 머리를 몸에 비해 크게(얼굴이 무섭게 읽히게)
    extras = []
    for li in range(2):
        hd = head_mesh(li)
        decimate(hd, 24000 if li == 0 else 4000)
        box_uv(hd.data, 0.6); set_colors(hd.data, lambda c, n: demon_color(c, n)); set_material(hd, m_skin)
        jw = jaw_mesh(li); decimate(jw, 9000 if li == 0 else 1500)
        box_uv(jw.data, 0.6); set_colors(jw.data, lambda c, n: demon_color(c, n)); set_material(jw, m_skin)
        e = [(hd, 'head'), (jw, 'jaw'), (horns(li), 'head'), (mane(li), ('head', 'spine')), (toe_claws(li), None), (core(li), 'spine')]
        e += mouth_bits(li) + eyes(li) + hands(li, -1) + hands(li, 1)
        for (o, fb) in e:
            if fb in ('head', 'jaw') and not o.name.startswith('demon_hand'): grow(o, HEADK)
        extras.append(e)
    lods = finish_lods('Demon', body, extras, arm, DEMON_BONES, [40000, 7000], 0.32, demon_color, m_skin, post_lod=crack_faces)
    bake_ao(lods, samples=16, dist=1.4)
    finalize(arm, lods, out, 'demon.glb', prev, 'demon', [((0, 30, 9), (0, 0, 9)), ((9, 22, 12), (0, 1, 11)), ((0.8, 10.5, 13.6), (0, 3.4, 13.3)), ((4.0, 9.5, 14.8), (0, 3.0, 13.4))])

if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[argv.index('--out') + 1] if '--out' in argv else 'bf'
    prev = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    build_demon(out, prev)
