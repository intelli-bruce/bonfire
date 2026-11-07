"""
무기 모델 절차적 모델링 → glb:  검(sword) · M4A1 소총(m4a1) · 펌프 산탄총(shotgun)

실행:  blender -b --factory-startup --python tools/weapons/build_weapons.py -- <sword|m4a1|shotgun|all> [--out bf] [--preview <dir>]

- 순수 bpy/bmesh/mathutils. 외부 에셋·유료 모델 없음.
- 좌표(Blender): +Y = 총구/칼끝 방향, +Z = 위, +X = 사수 오른쪽. glb 로 내보내면 three.js 의 -Z 가 앞이다(캐릭터 ry=0 과 같은 방향).
- 단위 m. M4A1 은 실제 치수 비율(전장 약 0.85 m)로 만든다. 게임에서는 캐릭터(약 1.5 m)에 맞춰 index 쪽에서 배율을 준다.
- 움직이는 부품은 따로 노드로 둔다(JS 가 이름으로 찾아 장전 애니메이션을 만든다):
    m4a1:    body · mag · charging_handle · bolt · selector,  빈 노드 muzzle · eject · grip_r · grip_l · mag_well
    shotgun: body · pump · shell_gate,                          빈 노드 muzzle · eject · grip_r · grip_l
    sword:   body · gem,                                        빈 노드 grip · tip
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix

# ----------------------------------------------------------------------------------------------------------------------
def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    what = argv[0] if argv and not argv[0].startswith('--') else 'all'
    out, prev = 'bf', None
    if '--out' in argv: out = argv[argv.index('--out') + 1]
    if '--preview' in argv: prev = argv[argv.index('--preview') + 1]
    return what, out, prev

def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

PALETTE = {   # name: (hex, roughness, metallic, emissive hex or None, emissive strength)
    # 밤 장면(달빛 + 모닥불)에서 읽히도록 아주 검은 색은 피하고 총기 재질을 한 단계 밝게 둔다.
    'steel':    ('#5a5f69', 0.38, 0.85, None, 0),      # 총열·볼트: 밝은 건메탈
    'anodized': ('#3a3d45', 0.46, 0.7, None, 0),       # 리시버: 검정 아노다이징(조금 밝게)
    'polymer':  ('#2d2f35', 0.62, 0.0, None, 0),       # 손잡이·개머리판·탄창
    'polymer2': ('#40444d', 0.6, 0.0, None, 0),        # 탄창 몸체 한 단계 밝은 톤
    'rail':     ('#4a4e58', 0.42, 0.8, None, 0),       # 피카티니 레일
    'brass':    ('#d9a13c', 0.3, 0.9, None, 0),        # 장전 손잡이 버튼 · 탄 끝
    'accent':   ('#e2733a', 0.5, 0.0, '#ff8a2a', 0.5), # 선택 레버 표식 · 주황 포인트
    'wood':     ('#8a5a35', 0.7, 0.0, None, 0),        # 산탄총 개머리판·펌프
    'woodDark': ('#5e3b22', 0.7, 0.0, None, 0),
    'blade':    ('#dbe6f2', 0.18, 0.95, None, 0),      # 검날
    'bladeEdge':('#f4fbff', 0.12, 0.95, '#bfe8ff', 0.35),
    'fuller':   ('#7ee3ff', 0.2, 0.2, '#4fd0ff', 1.6),  # 검날 홈: 푸른 빛
    'guard':    ('#e0b04c', 0.32, 0.9, None, 0),       # 가드·폼멜: 금빛
    'wrap':     ('#5b2c4a', 0.8, 0.0, None, 0),        # 손잡이 감개
    'gem':      ('#ff5a7a', 0.15, 0.0, '#ff4f7a', 1.8), # 폼멜 보석
}

def make_materials(names):
    out = {}
    for n in names:
        hexc, rough, metal, em, es = PALETTE[n]
        m = bpy.data.materials.new('w_' + n)
        m.use_nodes = True
        b = m.node_tree.nodes.get('Principled BSDF')
        b.inputs['Base Color'].default_value = (*lin(hexc), 1)
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        if em:
            b.inputs['Emission Color'].default_value = (*lin(em), 1)
            b.inputs['Emission Strength'].default_value = es
        m.diffuse_color = (*lin(hexc), 1)
        out[n] = m
    return out

# ----------------------------------------------------------------------------------------------------------------------
# 빌더: 하나의 bmesh 에 도형을 모으고 면마다 재질 인덱스를 매긴다
# ----------------------------------------------------------------------------------------------------------------------
class Part:
    def __init__(self, name, mat_names, mats):
        self.name = name; self.bm = bmesh.new()
        self.mat_names = list(mat_names); self.mats = mats

    def _tag(self, faces, mat, smooth=False):
        mi = self.mat_names.index(mat)
        for f in faces:
            f.material_index = mi; f.smooth = smooth

    def _bevel(self, faces, w):
        """둘러싼 날카로운 모서리를 살짝 깎아 하이라이트가 생기게 한다(실패해도 모델은 그대로)."""
        if w <= 0: return
        try:
            es = {e for f in faces for e in f.edges if e.is_valid and len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.6}
            if es: bmesh.ops.bevel(self.bm, geom=list(es), offset=w, segments=2, profile=0.6, affect='EDGES')
        except Exception as ex:
            print('bevel skipped', ex)

    def prism_xy(self, pts, z0, z1, mat, bevel=0.0):
        """(x, y) 위에서 본 다각형을 z0..z1 로 압출(검 가드처럼 가로로 넓은 부품)."""
        bm = self.bm
        a = [bm.verts.new((x, y, z1)) for (x, y) in pts]
        b = [bm.verts.new((x, y, z0)) for (x, y) in pts]
        n = len(pts); faces = [bm.faces.new(a), bm.faces.new(list(reversed(b)))]
        for i in range(n):
            j = (i + 1) % n
            faces.append(bm.faces.new((a[i], b[i], b[j], a[j])))
        self._tag(faces, mat); self._bevel(faces, bevel)
        return faces

    def prism(self, pts, x0, x1, mat, bevel=0.0012):
        """(y, z) 옆모습 다각형을 x0..x1 로 압출. pts 는 옆(+X 쪽)에서 봤을 때 반시계."""
        bm = self.bm
        a = [bm.verts.new((x1, y, z)) for (y, z) in pts]
        b = [bm.verts.new((x0, y, z)) for (y, z) in pts]
        n = len(pts); faces = []
        faces.append(bm.faces.new(a)); faces.append(bm.faces.new(list(reversed(b))))
        for i in range(n):
            j = (i + 1) % n
            faces.append(bm.faces.new((a[i], b[i], b[j], a[j])))
        self._tag(faces, mat); self._bevel(faces, bevel)
        return faces

    def box(self, c, size, mat, rot=None, bevel=0.0008):
        m = Matrix.Translation(c)
        if rot is not None: m = m @ rot.to_4x4()
        m = m @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        faces = {f for v in r['verts'] for f in v.link_faces}
        self._tag(faces, mat); self._bevel(faces, bevel if min(size) > 0.006 else 0)
        return faces

    def cyl(self, c, r0, r1, length, axis, mat, seg=20, smooth=True):
        """축 방향 원기둥/원뿔. axis: 'x'|'y'|'z' 또는 Vector. r0 = 뒤쪽 반지름, r1 = 앞쪽 반지름."""
        a = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0)), 'z': Vector((0, 0, 1))}.get(axis) if isinstance(axis, str) else Vector(axis).normalized()
        q = Vector((0, 0, 1)).rotation_difference(a)
        m = Matrix.Translation(c) @ q.to_matrix().to_4x4()
        r = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r0, radius2=r1, depth=length, matrix=m)
        faces = {f for v in r['verts'] for f in v.link_faces}
        self._tag(faces, mat, smooth)
        if smooth:
            axw = a
            for f in faces:   # 캡은 평평하게, 둘레는 부드럽게: 캡 둘레 모서리를 날카롭게
                if abs(f.normal.dot(axw)) > 0.9:
                    f.smooth = False
                    for e in f.edges: e.smooth = False
        return faces

    def sphere(self, c, r, mat, seg=14, scale=(1, 1, 1)):
        m = Matrix.Translation(c) @ Matrix.Diagonal((r * scale[0], r * scale[1], r * scale[2], 1.0))
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=max(6, seg // 2), radius=1.0, matrix=m)
        faces = {f for v in res['verts'] for f in v.link_faces}
        self._tag(faces, mat, True)
        return faces

    def loft(self, stations, mat, smooth=False):
        """stations: [(y, [(x, z), ...]) ...] 같은 점 수의 단면을 이어 붙임(앞뒤 캡 포함)."""
        bm = self.bm; rings = []
        for (y, sec) in stations: rings.append([bm.verts.new((x, y, z)) for (x, z) in sec])
        n = len(stations[0][1]); faces = []
        for i in range(len(rings) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                faces.append(bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k])))
        faces.append(bm.faces.new(list(reversed(rings[0])))); faces.append(bm.faces.new(rings[-1]))
        self._tag(faces, mat, smooth)
        return faces

    def build(self, parent=None, loc=(0, 0, 0)):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me); self.bm.free()
        for n in self.mat_names: me.materials.append(self.mats[n])
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = loc
        if parent is not None: ob.parent = parent
        return ob

def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'; e.empty_display_size = 0.02
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    if parent is not None: e.parent = parent
    return e

def rot_x(deg): return Matrix.Rotation(math.radians(deg), 3, 'X')
def rot_z(deg): return Matrix.Rotation(math.radians(deg), 3, 'Z')

# ----------------------------------------------------------------------------------------------------------------------
# M4A1 카빈 (RIS 레일 핸드가드, 6단 신축 개머리판, A2 조준기, STANAG 30발 탄창)
# 원점 = 방아쇠 바로 위 리시버 중앙. y 앞(총구) · z 위 · 총열 중심선 z = 0.066.
# ----------------------------------------------------------------------------------------------------------------------
BORE = 0.066

def build_m4a1(mats):
    names = ['anodized', 'steel', 'polymer', 'rail', 'brass', 'accent']
    root = empty('m4a1', (0, 0, 0))
    B = Part('body', names, mats)

    # --- 상부 리시버 (옆모습 단면: 뒤가 높고 앞은 낮은 평평한 윗면) + 윗면 레일
    B.prism([(-0.135, 0.032), (0.140, 0.032), (0.140, 0.094), (0.040, 0.099), (-0.040, 0.099), (-0.100, 0.097), (-0.135, 0.090)], -0.017, 0.017, 'anodized')
    # 배출구 덮개(경첩 + 돌출) 와 앞쪽 보조 장전(포워드 어시스트) 돌기
    B.box((0.018, -0.005, 0.082), (0.003, 0.085, 0.030), 'steel')           # 배출구 덮개 오른쪽
    B.box((-0.018, 0.0, 0.085), (0.003, 0.07, 0.024), 'anodized')
    B.cyl((0.027, -0.095, 0.083), 0.007, 0.006, 0.022, 'x', 'steel', 12)    # 포워드 어시스트
    # 윗면 피카티니 레일: 바닥판 + 홈 간격 12.7 mm 의 돌기
    B.box((0, 0.0, 0.1015), (0.021, 0.275, 0.005), 'rail')
    y = -0.128
    while y < 0.136:
        B.box((0, y, 0.1065), (0.021, 0.0065, 0.0055), 'rail'); y += 0.0127
    # --- 하부 리시버
    B.prism([(-0.130, 0.034), (0.076, 0.034), (0.076, -0.004), (0.060, -0.020), (0.008, -0.030), (-0.008, -0.030), (-0.050, -0.016), (-0.075, -0.0), (-0.130, 0.004)], -0.017, 0.017, 'anodized')
    # 탄창 입구(매거진 웰) : 아래로 살짝 벌어진 사각 슬리브
    B.prism([(0.004, -0.004), (0.068, -0.004), (0.070, -0.052), (0.001, -0.052)], -0.0155, 0.0155, 'anodized')
    # 탄창 해제 버튼 + 노리쇠 멈치
    B.cyl((0.0175, 0.014, -0.0), 0.0075, 0.0075, 0.006, 'x', 'steel', 14)
    B.box((-0.0185, -0.020, 0.015), (0.004, 0.02, 0.008), 'steel')
    # 방아쇠울 + 방아쇠
    B.prism([(-0.052, -0.012), (-0.022, -0.012), (-0.010, -0.036), (-0.030, -0.052), (-0.060, -0.040), (-0.062, -0.024), (-0.046, -0.026), (-0.046, -0.020)], -0.0035, 0.0035, 'anodized')
    B.prism([(-0.040, -0.004), (-0.034, -0.004), (-0.024, -0.030), (-0.031, -0.030)], -0.0022, 0.0022, 'steel')
    # --- 권총 손잡이 (A2, 뒤로 기울고 손가락 홈)
    B.prism([(-0.062, 0.006), (-0.095, 0.002), (-0.116, -0.112), (-0.116, -0.122), (-0.080, -0.128), (-0.066, -0.100), (-0.056, -0.050), (-0.060, -0.010)], -0.0155, 0.0155, 'polymer')
    for k in range(5):
        zz = -0.020 - k * 0.020
        B.box((0.0, -0.067 - 0.0095 * k, zz), (0.033, 0.003, 0.004), 'anodized')   # 앞 손가락 홈
    # --- 완충관 + 6단 신축 개머리판
    B.cyl((0, -0.215, 0.050), 0.0165, 0.0165, 0.17, 'y', 'anodized', 22)
    B.prism([(-0.135, 0.078), (-0.150, 0.066), (-0.150, 0.014), (-0.138, 0.008)], -0.012, 0.012, 'anodized')   # 완충관 받침(리시버 뒤 연결부)
    def rrect(w, z0, z1, r=0.006, n=3):   # 모서리가 둥근 단면 (x, z) 목록
        pts = []; cx = [w / 2 - r, -(w / 2 - r), -(w / 2 - r), w / 2 - r]; cz = [z1 - r, z1 - r, z0 + r, z0 + r]; a0 = [0, 90, 180, 270]
        for k in range(4):
            for i in range(n + 1):
                a = math.radians(a0[k] + 90 * i / n); pts.append((cx[k] + r * math.cos(a), cz[k] + r * math.sin(a)))
        return pts
    # 개머리판(6단 신축형) : 뒤로 갈수록 아래로 길어지고 폭이 좁아지는 몸통 + 볼 받침 + 어깨 패드
    B.loft([(-0.138, rrect(0.034, 0.012, 0.083)), (-0.190, rrect(0.034, 0.002, 0.086)), (-0.250, rrect(0.032, -0.022, 0.086)), (-0.292, rrect(0.030, -0.040, 0.082))], 'polymer')
    B.loft([(-0.292, rrect(0.034, -0.050, 0.092, 0.008)), (-0.304, rrect(0.036, -0.054, 0.096, 0.008)), (-0.311, rrect(0.034, -0.052, 0.092, 0.008))], 'anodized')   # 어깨 패드(살짝 굽은 고무 판)
    for k in range(5):
        B.box((0.0, -0.172 - 0.024 * k, -0.0105 - 0.0045 * k), (0.019, 0.004, 0.0045), 'anodized')     # 신축 걸쇠 홈
    B.box((0.0, -0.212, 0.0865), (0.019, 0.060, 0.004), 'steel')                                                  # 윗면 신축 레일(완충관이 비치는 홈)
    B.prism([(-0.230, 0.0), (-0.262, -0.026), (-0.270, -0.040), (-0.236, -0.014)], -0.0042, 0.0042, 'anodized')   # 신축 레버
    # --- 핸드가드 (RIS 4면 레일) + 배럴 너트
    hy0, hy1 = 0.136, 0.395
    B.cyl((0, 0.141, BORE), 0.0255, 0.0255, 0.012, 'y', 'steel', 20)                     # 배럴 너트
    B.box((0, (hy0 + hy1) / 2, BORE), (0.0405, hy1 - hy0, 0.0405), 'anodized')            # 몸체
    B.box((0, (hy0 + hy1) / 2 + 0.002, BORE + 0.0225), (0.021, hy1 - hy0 - 0.004, 0.005), 'rail')        # 윗 레일 바닥
    y = hy0 + 0.006
    while y < hy1 - 0.004:
        B.box((0, y, BORE + 0.0255), (0.021, 0.0065, 0.0055), 'rail')                     # 윗 레일 돌기(리시버와 같은 높이로 이어짐)
        for sx in (-1, 1):
            B.box((sx * 0.0222, y, BORE), (0.0045, 0.0065, 0.019), 'rail')             # 옆 레일
        B.box((0, y, BORE - 0.0222), (0.019, 0.0065, 0.0045), 'rail')                    # 아래 레일
        y += 0.0127
    B.box((0, 0.139, BORE + 0.020), (0.036, 0.020, 0.008), 'anodized')                   # 핸드가드 뒷고리
    # --- 총열 · 가스블록 · 앞가늠쇠 · 소염기
    B.cyl((0, 0.400, BORE), 0.0095, 0.0095, 0.16, 'y', 'steel', 18)
    B.cyl((0, 0.396, BORE), 0.0185, 0.0185, 0.032, 'y', 'steel', 18)                     # 가스블록(앞가늠쇠 받침)
    B.prism([(0.384, BORE + 0.012), (0.410, BORE + 0.012), (0.405, BORE + 0.050), (0.397, BORE + 0.058), (0.389, BORE + 0.050)], -0.0050, 0.0050, 'steel')   # 앞가늠쇠 탑
    B.cyl((0, 0.397, BORE + 0.066), 0.0022, 0.0022, 0.022, 'z', 'steel', 8)
    B.cyl((0, 0.500, BORE), 0.0125, 0.0125, 0.052, 'y', 'steel', 20)                    # A2 소염기(새장)
    for k in range(3):
        for sx in (-1, 1):
            B.box((sx * 0.0126, 0.488 + 0.012 * k, BORE), (0.0035, 0.0045, 0.010), 'anodized')   # 슬롯 암시
        B.box((0, 0.488 + 0.012 * k, BORE + 0.0126), (0.010, 0.0045, 0.0035), 'anodized')
    B.cyl((0, 0.529, BORE), 0.0095, 0.0105, 0.008, 'y', 'steel', 16)
    # --- 뒤 가늠자 (접이식 A2 조준기: 두 개의 구멍 가늠자)
    B.prism([(-0.112, 0.107), (-0.084, 0.107), (-0.086, 0.122), (-0.092, 0.132), (-0.104, 0.132), (-0.110, 0.122)], -0.0085, 0.0085, 'anodized')
    B.box((0.0095, -0.098, 0.138), (0.0035, 0.012, 0.012), 'anodized')
    B.box((-0.0095, -0.098, 0.138), (0.0035, 0.012, 0.012), 'anodized')
    B.cyl((0, -0.098, 0.138), 0.0042, 0.0042, 0.02, 'y', 'steel', 8)
    # --- 선택 레버(안전/단발/연발) 와 주황 표식
    B.cyl((-0.0175, -0.050, 0.018), 0.0085, 0.0085, 0.006, 'x', 'steel', 14)
    B.box((-0.0205, -0.047, 0.018), (0.004, 0.026, 0.0065), 'accent')
    # --- 총구 · 배출구 위치 빈 노드
    bodyObj = B.build(root)

    # --- 움직이는 부품
    M = Part('mag', ['polymer', 'rail', 'brass', 'anodized'], mats)
    N = 12; half = 0.0235
    def yc(t): return 0.036 + 0.052 * t * t + 0.004 * t      # 중심선: 아래로 갈수록 앞으로 휨
    def zc(t): return -0.002 - 0.168 * t
    front = [(yc(i / N) + half, zc(i / N)) for i in range(N + 1)]
    back = [(yc(i / N) - half, zc(i / N)) for i in range(N, -1, -1)]
    M.prism(front + back, -0.0125, 0.0125, 'polymer')
    for i in range(1, N, 2):                                    # 옆면 리브
        t = i / N
        for sx in (-1, 1):
            M.box((sx * 0.0128, yc(t), zc(t)), (0.003, half * 1.7, 0.0045), 'anodized', rot=rot_x(-math.degrees(math.atan2(0.1 * t + 0.01, 0.168)) * 0.0))
    t = 1.0                                                       # 바닥판
    M.prism([(yc(t) - half - 0.003, zc(t) + 0.002), (yc(t) + half + 0.007, zc(t) + 0.002), (yc(t) + half + 0.007, zc(t) - 0.010), (yc(t) - half - 0.003, zc(t) - 0.010)], -0.0138, 0.0138, 'rail')
    M.box((0, yc(0.0), -0.003), (0.0105, 0.020, 0.004), 'brass')    # 맨 위 탄 끝(황동)
    magObj = M.build(root)

    C = Part('charging_handle', ['anodized', 'rail', 'brass'], mats)
    C.box((0, -0.108, 0.1005), (0.012, 0.030, 0.006), 'anodized')                                 # 장전 손잡이 몸통(윗면 레일 위)
    C.prism([(-0.138, 0.098), (-0.118, 0.098), (-0.118, 0.110), (-0.128, 0.114), (-0.138, 0.110)], -0.0155, 0.0155, 'anodized')       # 래치 날개
    C.cyl((0.0, -0.140, 0.105), 0.0045, 0.0045, 0.036, 'x', 'brass', 10)
    chObj = C.build(root)

    Bo = Part('bolt', ['steel', 'brass'], mats)
    Bo.box((0.0185, -0.010, 0.080), (0.002, 0.060, 0.018), 'steel')        # 배출구에서 보이는 노리쇠 뭉치
    Bo.box((0.0185, 0.0, 0.0755), (0.0015, 0.014, 0.006), 'brass')
    boObj = Bo.build(root)

    empty('muzzle', (0, 0.536, BORE), root)
    empty('eject', (0.020, -0.040, 0.082), root)
    empty('grip_r', (0, -0.088, -0.020), root)        # 오른손이 쥐는 곳(권총 손잡이)
    empty('grip_l', (0, 0.255, -0.005), root)         # 왼손이 받치는 곳(핸드가드 아래)
    empty('mag_well', (0, 0.036, -0.004), root)
    return root

# ----------------------------------------------------------------------------------------------------------------------
# 펌프 산탄총 (나무 개머리판·펌프, 튜브 탄창)
# ----------------------------------------------------------------------------------------------------------------------
def build_shotgun(mats):
    names = ['anodized', 'steel', 'wood', 'woodDark', 'brass', 'accent']
    root = empty('shotgun', (0, 0, 0))
    B = Part('body', names, mats)
    B.prism([(-0.10, 0.012), (0.12, 0.012), (0.12, 0.074), (0.04, 0.080), (-0.10, 0.074)], -0.0175, 0.0175, 'anodized')      # 리시버
    B.cyl((0, 0.45, 0.066), 0.0145, 0.0145, 0.66, 'y', 'steel', 20)                                                       # 총열
    B.cyl((0, 0.44, 0.032), 0.0125, 0.0125, 0.60, 'y', 'steel', 18)                                                       # 튜브 탄창
    B.cyl((0, 0.775, 0.066), 0.0165, 0.0165, 0.016, 'y', 'steel', 18)                                                    # 총구 링
    B.box((0, 0.13, 0.090), (0.010, 0.05, 0.010), 'steel')                                                               # 리브 받침
    B.cyl((0, 0.45, 0.0925), 0.0035, 0.0035, 0.66, 'y', 'steel', 8)                                                       # 윗리브
    B.cyl((0, 0.76, 0.106), 0.005, 0.005, 0.014, 'z', 'accent', 10)                                                       # 구슬 가늠쇠
    B.prism([(-0.10, 0.074), (-0.34, 0.058), (-0.38, 0.0), (-0.36, -0.040), (-0.14, 0.0), (-0.10, 0.014)], -0.019, 0.019, 'wood')   # 개머리판
    B.box((0, -0.372, 0.0), (0.040, 0.014, 0.078), 'woodDark')                                                            # 개머리 패드
    B.prism([(-0.02, 0.012), (0.05, 0.012), (0.056, -0.02), (0.044, -0.050), (0.012, -0.054), (-0.004, -0.030)], -0.0035, 0.0035, 'anodized')   # 방아쇠울
    B.prism([(-0.095, 0.012), (-0.082, 0.012), (-0.092, -0.108), (-0.140, -0.108), (-0.128, 0.004)], -0.0155, 0.0155, 'wood')   # 권총 손잡이
    B.box((0, 0.054, 0.0), (0.0, 0.0, 0.0), 'steel') if False else None
    bodyObj = B.build(root)
    P = Part('pump', ['wood', 'woodDark', 'steel'], mats)
    P.prism([(0.20, 0.0), (0.40, 0.0), (0.405, 0.058), (0.20, 0.058)], -0.0245, 0.0245, 'wood')
    for k in range(9):
        P.box((0, 0.215 + 0.02 * k, 0.0), (0.050, 0.0045, 0.0045), 'woodDark')                                          # 펌프 홈
    P.cyl((0, 0.30, 0.0285), 0.0165, 0.0165, 0.012, 'y', 'steel', 14) if False else None
    pObj = P.build(root, (0, 0, 0.002))
    G = Part('shell_gate', ['steel', 'brass'], mats)
    G.box((0.0185, 0.03, 0.040), (0.002, 0.06, 0.024), 'steel')
    G.box((0.0195, 0.03, 0.040), (0.001, 0.03, 0.010), 'brass')
    G.build(root)
    empty('muzzle', (0, 0.785, 0.066), root)
    empty('eject', (0.019, 0.04, 0.050), root)
    empty('grip_r', (0, -0.112, -0.040), root)
    empty('grip_l', (0, 0.300, 0.030), root)
    return root

# ----------------------------------------------------------------------------------------------------------------------
# 검 (푸른 빛 홈이 있는 장검, 금빛 가드, 보석 폼멜). 원점 = 손잡이 중앙, 칼끝 +Y.
# ----------------------------------------------------------------------------------------------------------------------
def build_sword(mats):
    names = ['blade', 'bladeEdge', 'fuller', 'guard', 'wrap', 'gem']
    root = empty('sword', (0, 0, 0))
    B = Part('body', names, mats)
    # 날: 육각 단면(가운데 능선 + 양쪽 날)을 길이를 따라 점점 좁혀 가며 잇는다. 밑동 폭 0.070 → 칼끝 점. 게임 크기(캐릭터 1.5 m)에서 읽히도록 굵게.
    def sec(w, t):
        return [(-w / 2, 0), (-w * 0.22, t / 2), (w * 0.22, t / 2), (w / 2, 0), (w * 0.22, -t / 2), (-w * 0.22, -t / 2)]
    st = [(0.150, sec(0.072, 0.020)), (0.34, sec(0.072, 0.020)), (0.64, sec(0.066, 0.018)), (0.86, sec(0.052, 0.015)), (1.00, sec(0.032, 0.011)), (1.085, sec(0.006, 0.004))]
    B.loft(st, 'blade')
    B.loft([(1.085, sec(0.006, 0.004)), (1.125, sec(0.001, 0.001))], 'bladeEdge')
    # 날 가운데 푸른 빛 홈(양면) — 뒤쪽 넓고 끝으로 갈수록 가늘어지는 띠
    for sz in (1, -1):
        B.box((0, 0.46, sz * 0.0102), (0.016, 0.56, 0.0026), 'fuller', bevel=0)
        B.box((0, 0.84, sz * 0.0083), (0.010, 0.18, 0.0022), 'fuller', bevel=0)
        B.box((0, 0.97, sz * 0.0064), (0.0055, 0.07, 0.0018), 'fuller', bevel=0)
    # 날 양쪽 가장자리 하이라이트(하얗게 빛나는 칼날)
    for sx in (-1, 1):
        B.box((sx * 0.0345, 0.40, 0.0), (0.0035, 0.50, 0.0036), 'bladeEdge', bevel=0)
        B.box((sx * 0.0290, 0.75, 0.0), (0.0030, 0.22, 0.0032), 'bladeEdge', bevel=0)
    # 가드: 가운데가 처지고 양 끝이 위로 휘어 올라간 날개형(위에서 본 모양을 압출) + 끝 구슬
    top = [(-0.185, 0.178), (-0.150, 0.158), (-0.105, 0.141), (-0.055, 0.132), (0.0, 0.130), (0.055, 0.132), (0.105, 0.141), (0.150, 0.158), (0.185, 0.178)]
    bot = [(0.185, 0.152), (0.150, 0.130), (0.105, 0.112), (0.055, 0.102), (0.0, 0.100), (-0.055, 0.102), (-0.105, 0.112), (-0.150, 0.130), (-0.185, 0.152)]
    B.prism_xy(top + bot, -0.016, 0.016, 'guard', 0.0035)
    for sx in (-1, 1):
        B.sphere((sx * 0.190, 0.168, 0), 0.0185, 'guard', 14)
    B.box((0, 0.121, 0), (0.060, 0.050, 0.040), 'guard', bevel=0.004)                 # 가드 중앙 칼집 받침
    B.sphere((0, 0.121, 0.0205), 0.017, 'gem', 14, (1.0, 1.0, 0.55))                  # 가드 중앙 보석
    # 손잡이: 기둥 + 감개 띠 + 폼멜
    B.cyl((0, -0.004, 0), 0.0165, 0.0165, 0.200, 'y', 'wrap', 16)
    for k in range(7):
        B.cyl((0, -0.090 + 0.0285 * k, 0), 0.0185, 0.0185, 0.0075, 'y', 'guard', 16)
    B.sphere((0, -0.122, 0), 0.030, 'guard', 18, (1, 1.12, 1))
    B.cyl((0, -0.096, 0), 0.0215, 0.0215, 0.012, 'y', 'guard', 18)
    bodyObj = B.build(root)
    # 별도 노드 gem(JS 가 깜박이게): 폼멜 끝의 보석
    G = Part('gem', ['gem'], mats)
    G.sphere((0, 0.0, 0), 0.0125, 'gem', 12)
    G.build(root, (0, -0.1495, 0))
    empty('grip', (0, 0, 0), root)
    empty('tip', (0, 1.125, 0), root)
    return root

# ----------------------------------------------------------------------------------------------------------------------
def export(root, path):
    for o in bpy.context.selected_objects: o.select_set(False)
    kw = dict(filepath=path, export_format='GLB', use_selection=False, export_apply=False, export_animations=False,
              export_yup=True, export_materials='EXPORT', export_cameras=False, export_lights=False)
    bpy.ops.export_scene.gltf(**kw)
    print(f'wrote {path} {os.path.getsize(path) // 1024} KB')

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def look_at(cam, target):
    d = target - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

def render_previews(kind, out, shots):
    os.makedirs(out, exist_ok=True)
    scene = bpy.context.scene
    try: scene.render.engine = 'BLENDER_EEVEE'
    except Exception: scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y = 1100, 640
    scene.render.image_settings.file_format = 'PNG'
    w = bpy.data.worlds.new('w'); scene.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.20, 0.22, 0.30, 1); bg.inputs[1].default_value = 1.0
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 2.2; sun.rotation_euler = (math.radians(55), math.radians(10), math.radians(-40)); scene.collection.objects.link(sun)
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'POINT')); fill.data.energy = 120; fill.location = Vector((-0.6, -0.6, 0.5)); scene.collection.objects.link(fill)
    warm = bpy.data.objects.new('warm', bpy.data.lights.new('warm', 'POINT')); warm.data.energy = 60; warm.data.color = (1.0, 0.7, 0.45); warm.location = Vector((0.7, 0.5, 0.35)); scene.collection.objects.link(warm)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam
    for (nm, cp, tp, lens) in shots:
        cam.data.lens = lens; cam.location = Vector(cp); look_at(cam, Vector(tp))
        scene.render.filepath = os.path.join(out, f'{kind}_{nm}.png')
        bpy.ops.render.render(write_still=True)

def main():
    what, out, prev = parse_args()
    kinds = ['sword', 'm4a1', 'shotgun'] if what == 'all' else [what]
    os.makedirs(out, exist_ok=True)
    for kind in kinds:
        reset_scene()
        if kind == 'sword':
            mats = make_materials(['blade', 'bladeEdge', 'fuller', 'guard', 'wrap', 'gem']); root = build_sword(mats)
            shots = [('full', (0.9, -0.6, 0.35), (0, 0.5, 0), 32), ('hilt', (0.32, -0.20, 0.14), (0, 0.10, 0), 55), ('hilt_top', (0.0, 0.1, 0.45), (0, 0.1, 0), 50), ('tip', (0.26, 0.95, 0.12), (0, 0.98, 0), 50)]
        elif kind == 'm4a1':
            mats = make_materials(['anodized', 'steel', 'polymer', 'polymer2', 'rail', 'brass', 'accent']); root = build_m4a1(mats)
            shots = [('side', (1.2, 0.18, 0.08), (0, 0.12, 0.03), 42), ('side_close', (0.55, 0.0, 0.07), (0, -0.02, 0.04), 50), ('three_quarter', (0.75, -0.55, 0.30), (0, 0.12, 0.03), 40),
                     ('front', (0.12, 1.0, 0.18), (0, 0.2, 0.05), 40), ('top', (0.0, 0.1, 0.9), (0, 0.1, 0.05), 40), ('mag_close', (0.45, 0.10, -0.02), (0, 0.04, -0.05), 55),
                     ('receiver_close', (-0.38, -0.22, 0.22), (0, -0.03, 0.06), 50), ('muzzle_close', (0.28, 0.62, 0.13), (0, 0.48, 0.065), 55)]
        else:
            mats = make_materials(['anodized', 'steel', 'wood', 'woodDark', 'brass', 'accent']); root = build_shotgun(mats)
            shots = [('side', (1.5, 0.2, 0.1), (0, 0.2, 0.03), 40), ('three_quarter', (1.0, -0.8, 0.4), (0, 0.2, 0.03), 40)]
        # 정리: 편집용 도구가 아닌 순수 지오메트리 — 스무딩은 면 단위로 이미 지정
        export(root, os.path.join(out, {'sword': 'sword.glb', 'm4a1': 'm4a1.glb', 'shotgun': 'shotgun.glb'}[kind]))
        if prev: render_previews(kind, prev, shots)

if __name__ == '__main__':
    main()
