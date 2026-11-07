"""
인면 거미 보스 + 새끼 거미 절차적 모델링·리깅·애니메이션 → glb  (귀여운 얼굴 · 거대 크기 · 듬성한 잔털)

실행:  blender -b --factory-startup --python tools/spider/build_spider.py -- <boss|mini|both> [--out bf] [--preview <dir>]

- 순수 bpy/bmesh/mathutils. 외부 에셋 없음(유료·다운로드 없음).
- 보스는 K=BOSS_K 배(머리 꼭대기 약 12~13 m = 캐릭터 1.5 m 의 8~9배). 새끼는 K=MINI_K.
- 모델은 +Y(Blender) 가 앞. glb 로 내보내면 three.js 의 -Z 가 앞이다(캐릭터 ry=0 과 같은 방향).
- 뼈대: root / body / head / jaw / fangL·R / palpL·R / abdomen + 다리 8개 × (coxa, femur, tibia, metatarsus).
- 다리 포즈는 Blender IK/bake 를 쓰지 않고 파이썬에서 직접 푼다(2링크 IK + 대퇴 고각 탐색) → 뼈별 변환 행렬을 구해 키프레임.
- 애니메이션: idle · walk · swipe(앞다리 휘두르기, 접촉 프레임 13) · spit(독침, 발사 프레임 16) · summon(소환, 발사 프레임 30) · hurt · die
  (새끼 거미는 idle · walk · attack · die).
"""
import bpy, bmesh, math, sys, os, random
from mathutils import Vector, Matrix, Quaternion, Euler, noise

FPS = 24
BOSS_K = 3.8      # 보스 배율(원본 0.85 의 약 4.5배)
MINI_K = 0.16

# ----------------------------------------------------------------------------------------------------------------------
# 인자
# ----------------------------------------------------------------------------------------------------------------------
def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    what = argv[0] if argv and not argv[0].startswith('--') else 'both'
    out, prev = 'bf', None
    if '--out' in argv: out = argv[argv.index('--out') + 1]
    if '--preview' in argv: prev = argv[argv.index('--preview') + 1]
    return what, out, prev

# ----------------------------------------------------------------------------------------------------------------------
# 재질
# ----------------------------------------------------------------------------------------------------------------------
def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

PALETTE = {   # name: (hex, roughness, metallic, emissive hex or None, emissive strength)
    'chitin':   ('#6b4d9a', 0.5, 0.0, None, 0),        # 껍질: 말랑한 보라(밤 장면에서도 보이도록 밝게, 금속성 0)
    'chitin2':  ('#8a5b9c', 0.55, 0.0, None, 0),       # 복부 바탕
    'joint':    ('#e8863a', 0.5, 0.0, '#ff8a2a', 0.2),  # 관절 구: 따뜻한 주황
    'fur':      ('#d9b27c', 0.9, 0.0, None, 0),        # 잔털: 밝은 살구빛
    'skin':     ('#c9a08a', 0.55, 0.0, None, 0),       # 얼굴: 핏기 없는 사람 피부(주름 · 얼룩은 꼭짓점 색)
    'skin2':    ('#e3b9a0', 0.6, 0.0, None, 0),
    'lip':      ('#5e2830', 0.35, 0.0, None, 0),       # 갈라진 검붉은 입술
    'sclera':   ('#e6d8bc', 0.12, 0.0, None, 0),       # 누렇게 충혈된 흰자
    'iris':     ('#2e1a10', 0.2, 0.0, '#7a1804', 0.12),  # 홍채: 검붉은 · 안에서 희미하게 빛남
    'pupil':    ('#030203', 0.08, 0.0, None, 0),
    'lid':      ('#9a5652', 0.3, 0.0, None, 0),        # 젖은 눈가 점막
    'vein':     ('#a0141a', 0.3, 0.0, '#6a0a0a', 0.2),  # 흰자의 핏줄
    'teeth':    ('#cdbb8c', 0.3, 0.0, None, 0),        # 누렇고 고르지 않은 사람 이
    'spark':    ('#ffffff', 0.1, 0.0, '#ffffff', 1.2),  # 눈에 비친 반짝임
    'blush':    ('#ff9db0', 0.8, 0.0, '#ff7f9a', 0.25), # 볼터치
    'fang':     ('#fff4dc', 0.35, 0.0, None, 0),       # 작은 송곳니
    'mouth':    ('#140306', 0.7, 0.0, '#200204', 0.2),
    'mark':     ('#ff8fb1', 0.45, 0.0, '#ff6f9c', 0.5),  # 등의 분홍 물방울 무늬
}

def make_materials(names):
    out = {}
    for n in names:
        hexc, rough, metal, em, es = PALETTE[n]
        m = bpy.data.materials.new('sp_' + n)
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
# 지오메트리 빌더 (한 bmesh 에 모두 모으고, 정점마다 뼈 가중치 1.0)
# ----------------------------------------------------------------------------------------------------------------------
def perp_basis(axis):
    a = axis.normalized()
    t = Vector((1, 0, 0)) if abs(a.x) < 0.9 else Vector((0, 1, 0))
    u = a.cross(t).normalized(); w = a.cross(u).normalized()
    return u, w

def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))) if a != b else 0.0
    return t * t * (3 - 2 * t)

class Builder:
    def __init__(self, bones, mats):
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.gi = {b: i for i, b in enumerate(bones)}
        self.mi = {m: i for i, m in enumerate(mats)}

    def tag(self, verts, bone, mat, smooth=True):
        gi = self.gi[bone]
        faces = set()
        for v in verts:
            v[self.dl][gi] = 1.0
            faces.update(v.link_faces)
        for f in faces:
            f.material_index = self.mi[mat]; f.smooth = smooth
        return faces

    def sphere(self, center, radii, bone, mat, seg=14, rings=9, rot=None):
        m = Matrix.Translation(center)
        if rot is not None: m = m @ rot.to_4x4()
        m = m @ Matrix.Diagonal((radii[0], radii[1], radii[2], 1.0))
        r = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=1.0, matrix=m)
        self.tag(r['verts'], bone, mat); return r['verts']

    def tube(self, pts, radii, bone, mat, sides=8, cap=True, smooth=True):
        """pts: 중심선 점 목록, radii: 같은 길이. 평행이동 프레임으로 감은 관."""
        bm = self.bm; rings = []
        prev_u = None
        for i, p in enumerate(pts):
            if i == 0: ax = pts[1] - pts[0]
            elif i == len(pts) - 1: ax = pts[-1] - pts[-2]
            else: ax = pts[i + 1] - pts[i - 1]
            if prev_u is None: u, w = perp_basis(ax)
            else:
                u = (prev_u - ax.normalized() * prev_u.dot(ax.normalized())).normalized(); w = ax.normalized().cross(u).normalized()
            prev_u = u
            ring = [bm.verts.new(p + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides)) * radii[i]) for k in range(sides)]
            rings.append(ring)
        faces = []
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            for k in range(sides):
                faces.append(bm.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k])))
        if cap:
            faces.append(bm.faces.new(list(reversed(rings[0]))))
            faces.append(bm.faces.new(rings[-1]))
        verts = [v for r in rings for v in r]
        gi = self.gi[bone]
        for v in verts: v[self.dl][gi] = 1.0
        for f in faces: f.material_index = self.mi[mat]; f.smooth = smooth
        return verts

    def cone(self, base, tip, r, bone, mat, sides=4):
        bm = self.bm
        u, w = perp_basis(tip - base)
        ring = [bm.verts.new(base + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides)) * r) for k in range(sides)]
        ap = bm.verts.new(tip)
        gi = self.gi[bone]
        faces = [bm.faces.new((ring[k], ring[(k + 1) % sides], ap)) for k in range(sides)]
        for v in ring + [ap]: v[self.dl][gi] = 1.0
        for f in faces: f.material_index = self.mi[mat]; f.smooth = True
        return ring + [ap]

# ----------------------------------------------------------------------------------------------------------------------
# 사양 (보스 단위 m, K 로 크기 조절)
# ----------------------------------------------------------------------------------------------------------------------
LEGS = ['L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4']
HIP_Y = [0.85, 0.35, -0.2, -0.7]
HIP_X, HIP_Z = 0.72, 2.3
YAW = [38, 78, 112, 150]            # 앞(+Y)에서 바깥으로 잰 각도
LEN_SCALE = [1.15, 1.0, 0.95, 1.08]
LF, LT, LM = 2.1, 2.5, 2.9          # 대퇴·경골·중족골
REACH = [4.5, 4.9, 4.9, 4.6]        # 고관절 끝(coxa 끝) → 발 수평 거리
COXA = 0.45
HEAD_C = Vector((0, 1.8, 2.45))      # 얼굴 중심
HEAD_R = (0.98, 0.86, 0.90)         # 폭이 높이보다 넓은 둥근 얼굴

def leg_info(leg):
    i = int(leg[1]) - 1; sg = -1 if leg[0] == 'L' else 1
    yaw = math.radians(YAW[i])
    d = Vector((sg * math.sin(yaw), math.cos(yaw), 0.0))
    return i, sg, d

class Rig:
    """뼈 기준 행렬(Rm)과 사양을 들고 있다. 포즈는 상태 dict 로 계산."""
    def __init__(self, K, mini):
        self.K = K; self.mini = mini
        self.H0, self.H1, self.F0, self.L = {}, {}, {}, {}
        for leg in LEGS:
            i, sg, d = leg_info(leg)
            h0 = Vector((sg * HIP_X, HIP_Y[i], HIP_Z)) * K
            h1 = h0 + (d * COXA + Vector((0, 0, 0.25))) * K
            f = h1 + d * REACH[i] * K; f.z = 0.0
            self.H0[leg], self.H1[leg], self.F0[leg] = h0, h1, f
            s = LEN_SCALE[i] * K
            self.L[leg] = (LF * s, LT * s, LM * s)
        self.rest_pts = {}
        for leg in LEGS:
            kk, k2, t = self.solve_leg(leg, self.H1[leg], self.F0[leg])
            self.rest_pts[leg] = (self.H0[leg], self.H1[leg], kk, k2, t)
        self.pivot = {'body': Vector((0, 0.2, 2.3)) * K}
        # FK 뼈 (이름: (부모, head, tail))  — head 가 곧 회전 중심
        c = HEAD_C
        self.fk = {
            'body': ('root', Vector((0, -0.3, 2.3)) * K, Vector((0, 0.7, 2.3)) * K),
            'head': ('body', Vector((0, 1.0, 2.45)) * K, Vector((0, 1.9, 2.45)) * K),
            'jaw': ('head', (c + Vector((0, -0.15, -0.4))) * K, (c + Vector((0, 0.6, -0.75))) * K),
            'fangL': ('head', (c + Vector((-0.24, 0.62, -0.50))) * K, (c + Vector((-0.22, 0.70, -0.95))) * K),
            'fangR': ('head', (c + Vector((0.24, 0.62, -0.50))) * K, (c + Vector((0.22, 0.70, -0.95))) * K),
            'palpL': ('head', (c + Vector((-0.78, 0.3, -0.5))) * K, (c + Vector((-1.0, 0.8, -0.95))) * K),
            'palpR': ('head', (c + Vector((0.78, 0.3, -0.5))) * K, (c + Vector((1.0, 0.8, -0.95))) * K),
            'abdomen': ('body', Vector((0, -0.7, 2.45)) * K, Vector((0, -2.6, 2.7)) * K),
        }
        self.Rm = {}   # 뼈 기준 행렬 (Blender 가 만든 뒤 채움)
        self.names = ['root', 'body', 'head', 'jaw', 'fangL', 'fangR', 'palpL', 'palpR', 'abdomen'] + [f'{l}_{s}' for l in LEGS for s in 'cftm']

    # -- 다리 IK ------------------------------------------------------------------------------------------------------
    def solve_leg(self, leg, H1, F):
        i, sg, d_out = leg_info(leg)
        lf, lt, lm = self.L[leg]
        Z = Vector((0, 0, 1))
        F = F.copy()
        for _ in range(40):
            hz = Vector((F.x - H1.x, F.y - H1.y, 0.0))
            h = hz.normalized() if hz.length > 1e-4 else d_out
            ok = False
            for phi_d in range(64, 4, -3):
                phi = math.radians(phi_d)
                Kn = H1 + (h * math.cos(phi) + Z * math.sin(phi)) * lf
                dd = (F - Kn).length
                if abs(lt - lm) * 1.08 < dd < (lt + lm) * 0.985:
                    ok = True; break
            if ok: break
            F = Vector((H1.x + (F.x - H1.x) * 0.95, H1.y + (F.y - H1.y) * 0.95, F.z + (0.04 if F.z < 0.01 else 0.0)))
        if not ok:
            Kn = H1 + (h * math.cos(math.radians(30)) + Z * math.sin(math.radians(30))) * lf
            dd = (F - Kn).length
        e_d = (F - Kn) / max(dd, 1e-6)
        pole = d_out * 1.0 + Z * 0.25
        e_p = pole - e_d * pole.dot(e_d)
        e_p = e_p.normalized() if e_p.length > 1e-5 else Z
        dd = max(abs(lt - lm) * 1.02, min(dd, (lt + lm) * 0.999))
        ca = (lt * lt + dd * dd - lm * lm) / (2 * lt * dd); ca = max(-1, min(1, ca)); sa = math.sqrt(max(0.0, 1 - ca * ca))
        K2 = Kn + (e_d * ca + e_p * sa) * lt
        Tfoot = Kn + e_d * dd
        # 발이 도달 못 하면 Tfoot 가 F 와 어긋남 → 중족골 끝을 K2 에서 길이 lm 로 맞춘다
        tdir = (F - K2)
        Tpos = K2 + tdir.normalized() * lm if tdir.length > 1e-6 else Tfoot
        return Kn, K2, Tpos

    # -- 포즈 ---------------------------------------------------------------------------------------------------------
    @staticmethod
    def pivot_rot(piv, euler, scale=(1, 1, 1)):
        R = Euler(euler, 'XYZ').to_matrix().to_4x4()
        S = Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        return Matrix.Translation(piv) @ R @ S @ Matrix.Translation(-piv)

    def swing(self, name, nh, nt):
        Rb = self.Rm[name]; rh, rt = self.bone_rest[name]
        q = (rt - rh).rotation_difference(nt - nh)
        R3 = q.to_matrix() @ Rb.to_3x3()
        return Matrix.Translation(nh) @ R3.to_4x4()

    def eval_pose(self, st):
        """st: body_off, body_rot, head, jaw, fang, palp, abd(rot), abd_scale, feet{leg: Vector} → {bone: 포즈 행렬(arm 공간)}"""
        K = self.K; Rm = self.Rm; P = {}; M = {}
        P['root'] = Rm['root']
        piv = self.pivot['body']
        M['body'] = Matrix.Translation(st.get('body_off', Vector()) * K) @ self.pivot_rot(piv, st.get('body_rot', (0, 0, 0)))
        P['body'] = M['body'] @ Rm['body']
        loc = {
            'head': self.pivot_rot(self.fk['head'][1], st.get('head', (0, 0, 0))),
            'jaw': self.pivot_rot(self.fk['jaw'][1], (st.get('jaw', 0.0), 0, 0)),
            'fangL': self.pivot_rot(self.fk['fangL'][1], (0, 0, st.get('fang', 0.0))),
            'fangR': self.pivot_rot(self.fk['fangR'][1], (0, 0, -st.get('fang', 0.0))),
            'palpL': self.pivot_rot(self.fk['palpL'][1], (st.get('palp', 0.0), 0, st.get('palp', 0.0) * 0.5)),
            'palpR': self.pivot_rot(self.fk['palpR'][1], (st.get('palp', 0.0), 0, -st.get('palp', 0.0) * 0.5)),
            'abdomen': self.pivot_rot(self.fk['abdomen'][1], st.get('abd', (0, 0, 0)), st.get('abd_scale', (1, 1, 1))),
        }
        for b in ('head', 'jaw', 'fangL', 'fangR', 'palpL', 'palpR', 'abdomen'):
            par = self.fk[b][0]
            M[b] = M[par] @ loc[b]; P[b] = M[b] @ Rm[b]
        Mb = M['body']
        for leg in LEGS:
            h0 = Mb @ self.H0[leg]; h1 = Mb @ self.H1[leg]
            P[f'{leg}_c'] = Mb @ Rm[f'{leg}_c']
            F = st['feet'][leg] * (1.0)   # feet 는 이미 arm 공간 절대 좌표(K 적용됨)
            kk, k2, t = self.solve_leg(leg, h1, F)
            P[f'{leg}_f'] = self.swing(f'{leg}_f', h1, kk)
            P[f'{leg}_t'] = self.swing(f'{leg}_t', kk, k2)
            P[f'{leg}_m'] = self.swing(f'{leg}_m', k2, t)
        return P

    def basis(self, P):
        out = {}
        for b in self.names:
            par = self.parent_of[b]
            if par is None: out[b] = self.Rm[b].inverted() @ P[b]; continue
            out[b] = self.Rm[b].inverted() @ self.Rm[par] @ P[par].inverted() @ P[b]
        return out

# ----------------------------------------------------------------------------------------------------------------------
# 애니메이션 상태
# ----------------------------------------------------------------------------------------------------------------------
def ease(t): return t * t * (3 - 2 * t)
def lerp(a, b, t): return a + (b - a) * t
def vlerp(a, b, t): return a + (b - a) * t
def key_interp(frames, f):
    """frames: [(frame, value)] 오름차순 → 부드럽게(ease) 보간. value 는 float 또는 Vector 또는 tuple"""
    if f <= frames[0][0]: return frames[0][1]
    for (f0, v0), (f1, v1) in zip(frames, frames[1:]):
        if f <= f1:
            t = ease((f - f0) / max(1e-6, f1 - f0))
            if isinstance(v0, tuple): return tuple(lerp(a, b, t) for a, b in zip(v0, v1))
            return v0 + (v1 - v0) * t
    return frames[-1][1]

def anim_state(rig, name, f):
    """name 별 f(프레임)에서의 상태. 길이는 boss 단위(rig.K 는 eval 쪽에서 곱함)이지만 feet 는 K 적용된 절대 좌표."""
    K = rig.K
    st = {'body_off': Vector(), 'body_rot': (0, 0, 0), 'head': (0, 0, 0), 'jaw': 0.0, 'fang': 0.0, 'palp': 0.0, 'abd': (0, 0, 0), 'abd_scale': (1, 1, 1)}
    feet = {l: rig.F0[l].copy() for l in LEGS}
    rad = math.radians

    def hipdir(leg):
        i, sg, d = leg_info(leg); return sg, d

    if name == 'idle':
        N = 48; ph = f / N * 2 * math.pi
        st['body_off'] = Vector((0, 0, 0.05 * math.sin(ph)))
        st['body_rot'] = (rad(1.2) * math.sin(ph), rad(0.8) * math.sin(ph * 2), 0)
        st['abd'] = (rad(2.5) * math.sin(ph + 0.9), 0, 0); st['abd_scale'] = (1, 1, 1 + 0.015 * math.sin(ph))
        st['jaw'] = -rad(3) * (0.5 + 0.5 * math.sin(ph * 2)); st['palp'] = rad(8) * math.sin(ph * 3)
        st['head'] = (rad(1.5) * math.sin(ph + 0.4), 0, rad(2) * math.sin(ph))
        for leg in ('L1', 'R1'):
            sg, d = hipdir(leg); feet[leg] += Vector((0, 0, 0.25 * K)) * (0.5 + 0.5 * math.sin(ph + (0 if sg < 0 else math.pi)))
    elif name == 'walk':
        N = 24; ph = f / N
        S = 1.7 * K; lift = 0.95 * K
        groupA = {'L1', 'R2', 'L3', 'R4'}
        for leg in LEGS:
            p = (ph + (0.0 if leg in groupA else 0.5)) % 1.0
            i, sg, d = leg_info(leg)
            Si = S * (1.15 if i == 0 else 1.0 if i == 1 else 0.95 if i == 2 else 1.05)
            if p < 0.5:
                u = p / 0.5; dy = Si / 2 - Si * u; dz = 0.0; dx = 0.0
            else:
                u = (p - 0.5) / 0.5; e = ease(u); dy = -Si / 2 + Si * e; dz = lift * math.sin(math.pi * u); dx = sg * 0.35 * K * math.sin(math.pi * u)
            feet[leg] = rig.F0[leg] + Vector((dx, dy, dz))
        st['body_off'] = Vector((0, 0, 0.07 * math.sin(ph * 4 * math.pi + 0.6)))
        st['body_rot'] = (rad(1.0) * math.sin(ph * 4 * math.pi), rad(2.2) * math.sin(ph * 2 * math.pi), rad(2.0) * math.sin(ph * 2 * math.pi + 1.2))
        st['abd'] = (rad(3) * math.sin(ph * 4 * math.pi + 1.0), 0, rad(4) * math.sin(ph * 2 * math.pi))
        st['palp'] = rad(14) * math.sin(ph * 4 * math.pi); st['jaw'] = -rad(5) * (0.5 + 0.5 * math.sin(ph * 4 * math.pi))
    elif name == 'swipe':
        # 0-9 준비(몸 젖힘, 앞다리 들어 올림) / 9-11 정지 / 11-15 휘두르기(접촉 13) / 15-28 복귀
        up = lambda sg: Vector((sg * 3.4, 2.4, 5.0)) * K
        hit = lambda sg: Vector((sg * 0.9, 5.6, 0.15)) * K
        for leg in ('L1', 'R1'):
            sg, d = hipdir(leg)
            a = rig.F0[leg]
            feet[leg] = key_interp([(0, a), (9, up(sg)), (11, up(sg)), (14, hit(sg)), (15, hit(sg)), (28, a)], f)
        st['body_rot'] = key_interp([(0, (0, 0, 0)), (9, (rad(14), 0, 0)), (11, (rad(14), 0, 0)), (14, (rad(-9), 0, 0)), (16, (rad(-9), 0, 0)), (28, (0, 0, 0))], f)
        st['body_off'] = key_interp([(0, Vector()), (9, Vector((0, -0.35, 0.25))), (11, Vector((0, -0.35, 0.25))), (14, Vector((0, 0.9, -0.2))), (16, Vector((0, 0.9, -0.2))), (28, Vector())], f)
        st['head'] = key_interp([(0, (0, 0, 0)), (9, (rad(10), 0, 0)), (14, (rad(-14), 0, 0)), (28, (0, 0, 0))], f)
        st['jaw'] = key_interp([(0, 0.0), (9, -rad(15)), (14, -rad(28)), (22, -rad(10)), (28, 0.0)], f)
        st['fang'] = key_interp([(0, 0.0), (9, rad(10)), (14, rad(22)), (28, 0.0)], f)
        st['abd'] = key_interp([(0, (0, 0, 0)), (11, (rad(-8), 0, 0)), (15, (rad(10), 0, 0)), (28, (0, 0, 0))], f)
        st['palp'] = rad(18) * math.sin(f / 28 * 4 * math.pi)
    elif name == 'spit':
        # 0-14 몸을 뒤로 젖히고 턱을 벌림 / 14-17 앞으로 내뱉음(발사 16) / 17-30 복귀
        st['body_rot'] = key_interp([(0, (0, 0, 0)), (14, (rad(24), 0, 0)), (16, (rad(-6), 0, 0)), (19, (rad(-6), 0, 0)), (30, (0, 0, 0))], f)
        st['body_off'] = key_interp([(0, Vector()), (14, Vector((0, -0.55, 0.45))), (16, Vector((0, 0.75, -0.25))), (19, Vector((0, 0.75, -0.25))), (30, Vector())], f)
        st['head'] = key_interp([(0, (0, 0, 0)), (14, (rad(20), 0, 0)), (16, (rad(-16), 0, 0)), (19, (rad(-12), 0, 0)), (30, (0, 0, 0))], f)
        st['jaw'] = key_interp([(0, 0.0), (12, -rad(38)), (18, -rad(46)), (24, -rad(20)), (30, 0.0)], f)
        st['fang'] = key_interp([(0, 0.0), (12, rad(28)), (18, rad(34)), (30, 0.0)], f)
        st['abd'] = key_interp([(0, (0, 0, 0)), (14, (rad(-12), 0, 0)), (17, (rad(14), 0, 0)), (30, (0, 0, 0))], f)
        st['abd_scale'] = key_interp([(0, (1, 1, 1)), (14, (1.1, 1.1, 1.12)), (17, (0.94, 0.94, 0.94)), (30, (1, 1, 1))], f)
        for leg in ('L1', 'R1'):
            sg, d = hipdir(leg)
            wide = rig.F0[leg] + Vector((sg * 0.8, 0.3, 0.0)) * K
            feet[leg] = key_interp([(0, rig.F0[leg]), (12, wide), (22, wide), (30, rig.F0[leg])], f)
        st['palp'] = rad(25) * math.sin(f / 30 * 6 * math.pi)
    elif name == 'summon':
        # 0-14 몸을 세우고 앞 네 다리를 높이 듦 / 14-38 배 맥동·턱 벌림(소환 30) / 38-48 복귀
        raise_t = key_interp([(0, 0.0), (14, 1.0), (38, 1.0), (48, 0.0)], f)
        st['body_rot'] = (rad(30) * raise_t, 0, 0)
        st['body_off'] = Vector((0, -0.7, 0.8)) * raise_t
        st['head'] = (rad(14) * raise_t, 0, 0)
        st['jaw'] = key_interp([(0, 0.0), (18, -rad(10)), (26, -rad(40)), (34, -rad(40)), (44, 0.0)], f)
        st['fang'] = key_interp([(0, 0.0), (18, rad(18)), (28, rad(32)), (38, rad(20)), (48, 0.0)], f)
        pulse = 0.0
        for c in (18, 26, 34):
            pulse = max(pulse, math.exp(-((f - c) / 2.8) ** 2))
        st['abd_scale'] = (1 + 0.17 * pulse, 1 + 0.17 * pulse, 1 + 0.2 * pulse)
        st['abd'] = (rad(-10) * raise_t + rad(3) * pulse, 0, 0)
        for leg in ('L1', 'R1', 'L2', 'R2'):
            sg, d = hipdir(leg); i, _, _ = leg_info(leg)
            wave = math.sin((f - 14) / 6.0 + (0 if sg < 0 else 1.6)) * 0.6 * raise_t
            high = Vector((sg * (3.0 + 0.7 * i), 1.6 + 1.9 * (1 - i), 5.4 + wave)) * K
            feet[leg] = vlerp(rig.F0[leg], high, raise_t)
        st['palp'] = rad(30) * math.sin(f / 48 * 8 * math.pi) * raise_t
    elif name == 'hurt':
        t = key_interp([(0, 0.0), (3, 1.0), (12, 0.0)], f)
        st['body_rot'] = (rad(9) * t, rad(3) * t, 0); st['body_off'] = Vector((0, -0.3, 0.15)) * t
        st['head'] = (rad(10) * t, 0, rad(6) * t); st['jaw'] = -rad(20) * t; st['fang'] = rad(15) * t
        st['abd'] = (rad(-10) * t, 0, 0)
    elif name == 'die':
        # 0-30 주저앉으며 다리를 말아 올림 / 30-36 정지
        t = key_interp([(0, 0.0), (22, 1.0), (36, 1.0)], f)
        st['body_off'] = Vector((0, 0.2, -1.55)) * t
        st['body_rot'] = (rad(8) * t, rad(14) * t, rad(6) * t)
        st['head'] = (rad(-24) * t, 0, rad(10) * t); st['jaw'] = -rad(26) * t; st['fang'] = rad(26) * t
        st['abd'] = (rad(10) * t, 0, rad(-6) * t)
        for leg in LEGS:
            i, sg, d = leg_info(leg)
            curl = rig.H1[leg] + d * (REACH[i] * 0.42 * K); curl.z = (0.35 + 1.1 * (i % 2)) * K + 0.0
            feet[leg] = vlerp(rig.F0[leg], curl, ease(min(1.0, max(0.0, (f - 2 * i * 0.6) / 24.0)))) if t > 0 else rig.F0[leg]
        st['palp'] = rad(-20) * t
    elif name == 'attack':
        return anim_state(rig, 'swipe', f)
    else:
        raise ValueError(name)
    st['feet'] = feet
    return st

ANIMS_BOSS = [('idle', 48, True), ('walk', 24, True), ('swipe', 28, False), ('spit', 30, False), ('summon', 48, False), ('hurt', 12, False), ('die', 36, False)]
ANIMS_MINI = [('idle', 24, True), ('walk', 24, True), ('attack', 28, False), ('die', 36, False)]

# ----------------------------------------------------------------------------------------------------------------------
# 얼굴 조각 — 둥글고 귀여운 얼굴(크고 동그란 눈 · 볼터치 · 웃는 입 · 작은 송곳니)
# ----------------------------------------------------------------------------------------------------------------------
def sculpt_head(b, K, detail):
    c = HEAD_C * K; rx, ry, rz = (HEAD_R[0] * K, HEAD_R[1] * K, HEAD_R[2] * K)
    seg, rings = (128, 96) if detail else (14, 9)
    m = Matrix.Translation(c) @ Matrix.Diagonal((rx, ry, rz, 1.0))
    if not b.bm.verts.layers.float.get('dark'): b.bm.verts.layers.float.new('dark')   # 레이어는 구를 만들기 전에(뒤에 만들면 꼭짓점 참조가 끊김)
    r = bmesh.ops.create_uvsphere(b.bm, u_segments=seg, v_segments=rings, radius=1.0, matrix=m)
    verts = r['verts']; dl = b.dl; dk_l = b.bm.verts.layers.float.get('dark')
    for v in verts:
        p = v.co - c; nx, ny, nz = p.x / rx, p.y / ry, p.z / rz
        v.co.x = c.x + (v.co.x - c.x) * (1 - 0.12 * smoothstep(0.05, -0.95, nz))   # 아래로 갈수록 살짝 좁아지는 둥근 턱
        # 턱 가중치: 입 선 아래 앞쪽만
        wj = smoothstep(-0.50, -0.66, nz) * smoothstep(-0.25, 0.30, ny)
        v[dl][b.gi['jaw']] = wj; v[dl][b.gi['head']] = 1.0 - wj
        if detail and ny > 0.15:   # 얼굴 깎기: 눈썹 뼈 · 미간 주름 · 눈구멍 · 콧날 · 콧구멍 · 광대 · 꺼진 볼 · 팔자 주름 · 입술 · 이마 주름 · 눈가 잔주름 · 눈 밑 그늘
            d, dark = face_relief(nx, nz)
            d *= smoothstep(0.15, 0.45, ny)
            v.co += Vector((nx / rx, ny / ry, nz / rz)).normalized() * d * K
            v[dk_l] = dark * smoothstep(0.15, 0.45, ny)
    faces = set()
    for v in verts: faces.update(v.link_faces)
    for f in faces:
        f.smooth = True; f.material_index = b.mi['skin']
    return c, rx, ry, rz

FACE_DARK = {}
def _g(x, s): return math.exp(-(x / s) ** 2)
def face_relief(x, z):
    """얼굴 좌표(nx, nz; 정면 0,0 · 눈 ±0.46,0.14 · 입 -0.47)의 높이 변화(K 단위)와 주름 그늘(0~1)."""
    ax = abs(x); d = 0.0; dark = 0.0
    d += 0.07 * _g(z - 0.33, 0.06) * _g(ax - 0.3, 0.32)                                   # 눈썹 뼈(찌푸려 가운데로 내려옴)
    for k in (0.055, -0.055):
        w = _g(x - k, 0.012) * _g(z - 0.3, 0.12); d -= 0.03 * w; dark += 0.6 * w          # 미간 세로 주름
    e = _g(ax - 0.46, 0.17) * _g(z - 0.13, 0.12); d -= 0.11 * e; dark += 0.35 * e          # 눈구멍
    d += 0.13 * _g(x, 0.06) * (1 if -0.28 < z < 0.22 else 0) * (0.5 + 0.5 * (0.22 - z) / 0.5)   # 콧날
    d += 0.07 * _g(x, 0.1) * _g(z + 0.28, 0.06)                                           # 코끝
    n_ = _g(ax - 0.075, 0.03) * _g(z + 0.33, 0.025); d -= 0.05 * n_; dark += 0.9 * n_        # 콧구멍
    d += 0.06 * _g(ax - 0.6, 0.12) * _g(z + 0.02, 0.1)                                    # 광대
    c_ = _g(ax - 0.55, 0.14) * _g(z + 0.3, 0.12); d -= 0.06 * c_; dark += 0.3 * c_          # 꺼진 볼
    nl = _g(ax - (0.16 + 0.4 * (-0.18 - z)), 0.018) * (1 if -0.52 < z < -0.18 else 0); d -= 0.035 * nl; dark += 0.7 * nl   # 팔자 주름
    lip_u = _g(z + 0.44, 0.025) * _g(ax, 0.26); lip_l = _g(z + 0.53, 0.03) * _g(ax, 0.24)
    d += 0.03 * lip_u + 0.035 * lip_l
    mc = _g(z + 0.485, 0.012) * _g(ax, 0.3); d -= 0.05 * mc; dark += 0.9 * mc              # 입 선
    for k in range(4):
        fh = _g(z - (0.5 + 0.07 * k + 0.02 * math.cos(x * 6)), 0.01) * _g(x, 0.45); d -= 0.018 * fh; dark += 0.55 * fh   # 이마 주름
    for a in (-0.4, 0.0, 0.4):   # 눈가 잔주름(바깥 눈꼬리에서 퍼지는 선)
        px, pz = ax - 0.72, z - 0.13; along = px * math.cos(a) + pz * math.sin(a); perp = -px * math.sin(a) + pz * math.cos(a)
        cw = _g(perp, 0.01) * (1 if 0 < along < 0.14 else 0); d -= 0.015 * cw; dark += 0.6 * cw
    ub = _g(math.hypot(ax - 0.46, (z + 0.07) * 1.6) - 0.16, 0.025) * (1 if z < 0.0 else 0); d -= 0.02 * ub; dark += 0.7 * ub   # 눈 밑 처진 주름
    d += 0.008 * noise.noise(Vector((x * 30, z * 30, 0.5)))                                # 피부 결
    return d, min(1.0, dark)

def face_surface_y(c, rx, ry, rz, nx, nz, K):
    return c.y + ry * math.sqrt(max(0.0, 1 - nx * nx - nz * nz))

def hair(b, pos, d, L, r, bone):
    b.cone(pos, pos + d * L, r, bone, 'fur', sides=4)

def build_boss_mesh(rig, mats, detail=True):
    K = rig.K; rng = random.Random(11)
    b = Builder(rig.names, mats)
    S = lambda v: Vector(v) * K
    sides = 10 if detail else 5
    # -- 흉부·복부 ------------------------------------------------------------------------------------------------
    tc, tr = S((0, 0.1, 2.35)), (0.95 * K, 1.2 * K, 0.82 * K)
    b.sphere(tc, tr, 'body', 'chitin', seg=24 if detail else 10, rings=16 if detail else 6)
    b.sphere(S((0, -0.2, 2.75)), (0.55 * K, 0.7 * K, 0.4 * K), 'body', 'chitin', seg=16 if detail else 8, rings=10 if detail else 5)   # 등딱지 융기
    # 복부
    ac, ar = S((0, -2.4, 2.65)), (1.3 * K, 1.95 * K, 1.3 * K)
    seg_a, rings_a = (40, 26) if detail else (12, 8)
    ab = bmesh.ops.create_uvsphere(b.bm, u_segments=seg_a, v_segments=rings_a, radius=1.0, matrix=Matrix.Translation(ac) @ Matrix.Diagonal((ar[0], ar[1], ar[2], 1.0)))['verts']
    b.tag(ab, 'abdomen', 'chitin2')
    # 등 쪽 분홍 물방울 무늬 5개(표면 법선에 맞춘 납작한 타원)
    if detail:
        for nx_, ny_, rr in ((0.0, 0.02, 0.27), (-0.34, 0.40, 0.19), (0.34, 0.40, 0.19), (-0.38, -0.40, 0.2), (0.38, -0.40, 0.2)):
            nz_ = math.sqrt(max(0.0, 1 - nx_ * nx_ - ny_ * ny_))
            n = Vector((nx_ / ar[0], ny_ / ar[1], nz_ / ar[2])).normalized()
            pos = ac + Vector((nx_ * ar[0], ny_ * ar[1], nz_ * ar[2])) * 0.995
            b.sphere(pos, (rr * ar[0], 0.05 * K, rr * ar[0]), 'abdomen', 'mark', seg=16, rings=8, rot=Vector((0, 1, 0)).rotation_difference(n).to_matrix())
    # 잔털: 복부·흉부에 듬성듬성(성능·인상 모두 가볍게)
    if detail:
        for _ in range(48):                     # 복부
            th = rng.uniform(0, math.pi * 0.62); ph = rng.uniform(0, 2 * math.pi)
            nrm = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            pos = ac + Vector((nrm.x * ar[0], nrm.y * ar[1], nrm.z * ar[2])) * 0.99
            hair(b, pos, (nrm + Vector((0, -0.35, 0.1))).normalized(), rng.uniform(0.10, 0.17) * K, 0.026 * K, 'abdomen')
        for _ in range(16):                     # 흉부(앞쪽은 머리가 가리므로 제외)
            th = rng.uniform(0, math.pi * 0.5); ph = rng.uniform(0, 2 * math.pi)
            nrm = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            if nrm.y > 0.55: continue
            pos = tc + Vector((nrm.x * tr[0], nrm.y * tr[1], nrm.z * tr[2])) * 0.99
            hair(b, pos, (nrm + Vector((0, -0.2, 0.1))).normalized(), rng.uniform(0.09, 0.15) * K, 0.024 * K, 'body')
    # -- 머리(둥근 얼굴) --------------------------------------------------------------------------------------------
    c, rx, ry, rz = sculpt_head(b, K, detail)
    def fp(nx, nz, off=0.0):   # 얼굴 좌표 → 3D (표면)
        return Vector((c.x + nx * rx, face_surface_y(c, rx, ry, rz, nx, nz, K) + off, c.z + nz * rz))
    def seg_(hi, lo): return hi if detail else lo
    # 크고 동그란 눈(흰자 + 호박색 홍채 + 큰 눈동자 + 반짝임 두 점)
    for sg in (-1, 1):
        ex, ez = 0.46, 0.14
        ec = Vector((c.x + sg * ex * rx, c.y + ry * math.sqrt(max(0.0, 1 - ex * ex - ez * ez)) - 0.16 * K, c.z + ez * rz))
        R_ = 0.24 * K
        ec = ec + Vector((0, -0.06 * K, 0))                     # 눈구멍 속으로 박힌 눈
        b.sphere(ec, (R_, R_, R_), 'head', 'sclera', seg=seg_(32, 10), rings=seg_(24, 7))
        b.sphere(ec + Vector((0, 0.215 * K, 0.01 * K)), (0.115 * K, 0.04 * K, 0.115 * K), 'head', 'iris', seg=seg_(24, 8), rings=seg_(12, 5))
        b.sphere(ec + Vector((0, 0.245 * K, 0.01 * K)), (0.045 * K, 0.02 * K, 0.045 * K), 'head', 'pupil', seg=seg_(14, 6), rings=seg_(8, 4))
        b.sphere(ec + Vector((-0.04 * K, 0.25 * K, 0.06 * K)), (0.014 * K,) * 3, 'head', 'spark', seg=seg_(8, 4), rings=seg_(6, 3))
        if detail:
            # 핏줄: 흰자 가장자리에서 홍채 쪽으로 구불구불
            for k in range(9):
                a = k / 9 * 2 * math.pi + 0.3; pts = []
                for j in range(5):
                    t = 0.95 - 0.13 * j; ang = a + 0.25 * math.sin(j * 1.7 + k)
                    dvec = Vector((math.cos(ang) * math.sin(math.acos(t)), t, math.sin(ang) * math.sin(math.acos(t))))
                    pts.append(ec + dvec.normalized() * R_ * 1.004 if False else ec + Vector((dvec.x, dvec.y, dvec.z)).normalized() * R_ * 1.006)
                pts = pts[::-1]
                b.tube(pts, [0.006 * K, 0.005 * K, 0.004 * K, 0.003 * K, 0.002 * K], 'head', 'vein', sides=4)
            # 무겁게 내려온 윗눈꺼풀 + 아랫눈꺼풀(젖은 점막 테) — 노려보는 눈
            lid_n = Vector((sg * 0.25, 1.0, 0.55)).normalized()
            b.sphere(ec + Vector((0, 0.02 * K, 0.1 * K)), (R_ * 1.12, R_ * 1.02, R_ * 0.72), 'head', 'skin', seg=24, rings=12, rot=Euler((0.55, 0, sg * 0.18)).to_matrix())
            b.sphere(ec + Vector((0, 0.03 * K, -0.12 * K)), (R_ * 1.08, R_ * 0.98, R_ * 0.55), 'head', 'skin', seg=24, rings=12, rot=Euler((-0.35, 0, 0)).to_matrix())
            ring = [ec + Vector((math.cos(a) * R_ * 0.98, 0.17 * K, math.sin(a) * R_ * 0.62 - 0.01 * K)) for a in [math.pi * (1.05 + 0.9 * i / 10) for i in range(11)]]
            b.tube(ring, [0.022 * K] * len(ring), 'head', 'lid', sides=5)
    if detail:
        # 입: 반쯤 벌어진 검붉은 입술 사이로 누런 사람 이(위 · 아래 줄, 고르지 않게) — 거미 몸에 붙은 사람 얼굴
        for (z0, bone, mat_r) in ((-0.43, 'head', 0.03), (-0.565, 'jaw', 0.034)):
            pts, rs = [], []
            for k in range(11):
                nx_ = -0.25 + 0.05 * k
                nz_ = z0 - 0.02 * (nx_ / 0.25) ** 2 * (1 if z0 > -0.5 else -1)
                pts.append(fp(nx_, nz_, 0.002 * K)); rs.append(mat_r * K * (0.4 + 0.6 * math.sin(math.pi * (k / 10))))
            b.tube(pts, rs, bone, 'lip', sides=8)
        b.sphere(Vector((c.x, c.y + ry * 0.48, c.z - 0.5 * rz)), (0.25 * K, 0.17 * K, 0.075 * K), 'head', 'mouth', seg=16, rings=8)
        rng_t = random.Random(4)
        for (zt, bone, up) in ((-0.445, 'head', True), (-0.55, 'jaw', False)):
            for k in range(10):
                nx_ = -0.19 + 0.042 * k
                if rng_t.random() < 0.12: continue                     # 빠진 이
                p0 = fp(nx_, zt, -0.012 * K)
                h = (0.045 + 0.02 * rng_t.random()) * K * (1.25 if abs(nx_) < 0.05 else 1.0)
                w = (0.019 + 0.004 * rng_t.random()) * K
                b.sphere(p0 + Vector((0, 0, -h * 0.5 if up else h * 0.5)), (w, w * 0.7, h * 0.55), bone, 'teeth', seg=10, rings=6, rot=Euler((0, rng_t.uniform(-0.15, 0.15), 0)).to_matrix())
        # 머리 위 삐죽 털 세 가닥
        for dx, L in ((-0.35, 0.22), (0.0, 0.32), (0.35, 0.22)):
            pos = c + Vector((dx * rx * 0.5, -0.05 * ry, rz * 0.985))
            hair(b, pos, Vector((dx * 0.9, -0.15, 1.0)).normalized(), L * K, 0.03 * K, 'head')
    # 작은 송곳니 + 볼 옆 작은 더듬이 손
    for sg, bone in ((-1, 'fangL'), (1, 'fangR')):
        base = fp(sg * 0.24, -0.50, -0.012 * K)
        pts = [base, base + Vector((-sg * 0.005, 0.035, -0.20)) * K, base + Vector((-sg * 0.01, 0.06, -0.38)) * K]
        b.tube(pts, [0.075 * K, 0.045 * K, 0.006 * K], bone, 'fang', sides=seg_(8, 5))
        pbone = 'palpL' if sg < 0 else 'palpR'
        a = c + Vector((sg * 0.78, 0.3, -0.5)) * K
        pp = [a, a + Vector((sg * 0.10, 0.25, -0.22)) * K, a + Vector((sg * 0.18, 0.50, -0.44)) * K]
        b.tube(pp, [0.11 * K, 0.095 * K, 0.075 * K], pbone, 'chitin', sides=sides)
        b.sphere(pp[-1] + Vector((0, 0.03, -0.02)) * K, (0.13 * K, 0.15 * K, 0.13 * K), pbone, 'chitin2', seg=seg_(12, 6), rings=seg_(8, 4))
    # -- 다리 -------------------------------------------------------------------------------------------------------
    for leg in LEGS:
        h0, h1, kk, k2, t = rig.rest_pts[leg]
        i, sg, d_out = leg_info(leg)
        k_ = K * 1.15   # 굵고 둥글게(멀리서도 보이도록)
        b.sphere(h0, (0.2 * k_, 0.2 * k_, 0.2 * k_), f'{leg}_c', 'chitin', seg=10 if detail else 6, rings=7 if detail else 4)
        b.tube([h0, h1], [0.17 * k_, 0.15 * k_], f'{leg}_c', 'chitin', sides=sides)
        def seg_pts(a, c_, rs, bone):
            n = len(rs)
            pts = [a + (c_ - a) * (j / (n - 1)) for j in range(n)]
            b.tube(pts, rs, bone, 'chitin', sides=sides)
            return pts
        seg_pts(h1, kk, [0.14 * k_, 0.17 * k_, 0.19 * k_, 0.16 * k_, 0.13 * k_] if detail else [0.14 * k_, 0.18 * k_, 0.13 * k_], f'{leg}_f')
        b.sphere(kk, (0.2 * k_,) * 3, f'{leg}_f', 'joint', seg=10 if detail else 6, rings=7 if detail else 4)                    # 무릎 구
        seg_pts(kk, k2, [0.12 * k_, 0.15 * k_, 0.16 * k_, 0.14 * k_, 0.11 * k_] if detail else [0.12 * k_, 0.16 * k_, 0.11 * k_], f'{leg}_t')
        b.sphere(k2, (0.165 * k_,) * 3, f'{leg}_t', 'joint', seg=10 if detail else 6, rings=7 if detail else 4)
        seg_pts(k2, t, [0.11 * k_, 0.115 * k_, 0.1 * k_, 0.07 * k_, 0.04 * k_, 0.012 * k_] if detail else [0.11 * k_, 0.07 * k_, 0.012 * k_], f'{leg}_m')
        # 잔털: 마디마다 두세 가닥만
        if detail:
            for (a, c_, bone) in ((h1, kk, f'{leg}_f'), (kk, k2, f'{leg}_t'), (k2, t, f'{leg}_m')):
                ax = (c_ - a); L = ax.length; axn = ax.normalized(); u, w = perp_basis(axn)
                for _ in range(3):
                    tt = rng.uniform(0.15, 0.85); ang = rng.uniform(0, 2 * math.pi)
                    rad_ = (0.17 if bone.endswith('_f') else 0.15 if bone.endswith('_t') else 0.09 * (1 - tt * 0.6)) * k_
                    dirp = (u * math.cos(ang) + w * math.sin(ang))
                    p0 = a + axn * (L * tt) + dirp * rad_ * 0.9
                    hair(b, p0, (dirp + axn * 0.4).normalized(), rng.uniform(0.10, 0.17) * k_, 0.026 * k_, bone)
    # 정점 색(COLOR_0): 전부 흰색(그림자 없음)
    cl = b.bm.loops.layers.color.new('Col')
    skin_i = b.mi['skin']; dk_l = b.bm.verts.layers.float.get('dark')
    for f in b.bm.faces:
        for lp in f.loops:
            dk = lp.vert[dk_l] if (dk_l is not None and f.material_index == skin_i) else 0.0
            if f.material_index == skin_i:   # 얼룩덜룩한 피부(검버섯 · 핏기 · 주름 속 그늘)
                p = lp.vert.co / max(0.001, K)
                m = 0.92 + 0.1 * noise.noise(p * 6.0) - 0.06 * max(0.0, noise.noise(p * 17.0 + Vector((3, 1, 2))) - 0.3)
                r_, g_, b_ = m * (1 - 0.55 * dk), m * (1 - 0.6 * dk) * 0.97, m * (1 - 0.6 * dk) * 0.95
                lp[cl] = (r_, g_, b_, 1.0)
            else:
                lp[cl] = (1.0, 1.0, 1.0, 1.0)
    return b

def build_mini_mesh(rig, mats):
    return build_boss_mesh(rig, mats, detail=False)

# ----------------------------------------------------------------------------------------------------------------------
# Blender 장면 구성
# ----------------------------------------------------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.actions):
        for d in list(coll): coll.remove(d)

def build(kind, out_dir, prev_dir):
    mini = kind == 'mini'
    K = MINI_K if mini else BOSS_K
    reset_scene()
    scene = bpy.context.scene; scene.render.fps = FPS
    rig = Rig(K, mini)
    mat_names = ['chitin', 'chitin2', 'joint', 'fur', 'skin', 'lip', 'sclera', 'iris', 'pupil', 'spark', 'blush', 'fang', 'mouth', 'mark', 'lid', 'vein', 'teeth']
    mats = make_materials(mat_names)

    # 1) 뼈대 (휴식 자세 = idle 0프레임)
    arm_data = bpy.data.armatures.new('SpiderArm'); arm = bpy.data.objects.new('SpiderRig', arm_data)
    scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    def add(name, head, tail, parent):
        e = eb.new(name); e.head = head; e.tail = tail
        if (tail - head).length < 1e-4: e.tail = head + Vector((0, 0, 0.05 * K))
        if parent: e.parent = eb[parent]
        return e
    add('root', Vector((0, 0, 0)), Vector((0, 0.5 * K, 0)), None)
    for name, (par, h, t) in rig.fk.items(): add(name, h, t, par)
    rig.parent_of = {'root': None}
    for name, (par, h, t) in rig.fk.items(): rig.parent_of[name] = par
    for leg in LEGS:
        h0, h1, kk, k2, t = rig.rest_pts[leg]
        add(f'{leg}_c', h0, h1, 'body'); add(f'{leg}_f', h1, kk, f'{leg}_c'); add(f'{leg}_t', kk, k2, f'{leg}_f'); add(f'{leg}_m', k2, t, f'{leg}_t')
        rig.parent_of[f'{leg}_c'] = 'body'; rig.parent_of[f'{leg}_f'] = f'{leg}_c'; rig.parent_of[f'{leg}_t'] = f'{leg}_f'; rig.parent_of[f'{leg}_m'] = f'{leg}_t'
        # 발끝 표지 뼈(`{leg}_e`): 가중치·키프레임 없이 중족골 끝에 붙어 있어 게임이 발 위치(타격·밀어냄 판정)를 읽는다
        add(f'{leg}_e', t, t + (t - k2).normalized() * 0.05 * K, f'{leg}_m')
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.bone_rest = {}
    for n in rig.names:
        bn = arm_data.bones[n]; rig.Rm[n] = bn.matrix_local.copy(); rig.bone_rest[n] = (bn.head_local.copy(), bn.tail_local.copy())

    # 2) 메시
    bld = build_boss_mesh(rig, mat_names, detail=not mini)
    me = bpy.data.meshes.new('SpiderMesh')
    bld.bm.normal_update(); bld.bm.to_mesh(me); bld.bm.free()
    for n in mat_names: me.materials.append(mats[n])
    obj = bpy.data.objects.new('Spider', me); scene.collection.objects.link(obj)
    for n in rig.names: obj.vertex_groups.new(name=n)
    # bmesh 의 deform 층은 to_mesh 로 vertex group 가중치가 된다 (그룹 이름은 위에서 같은 순서로 만들어야 함)
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    print(f'[{kind}] verts={len(me.vertices)} tris={sum(len(p.vertices) - 2 for p in me.polygons)} bones={len(rig.names)}')

    # 3) 미리보기 (애니메이션 데이터 만들기 전에 포즈만 적용해서 렌더)
    if prev_dir:
        os.makedirs(prev_dir, exist_ok=True)
        render_previews(kind, rig, arm, obj, prev_dir)
        for pb in arm.pose.bones: pb.matrix_basis = Matrix.Identity(4)

    # 4) 애니메이션
    arm.animation_data_create()
    for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
    anims = ANIMS_MINI if mini else ANIMS_BOSS
    for (name, nfr, loop) in anims:
        act = bpy.data.actions.new(name)
        arm.animation_data.action = act
        prevq = {}
        for f in range(0, nfr + 1):
            fr = f if (not loop or f < nfr) else 0
            st = anim_state(rig, name, fr)
            P = rig.eval_pose(st); Bm = rig.basis(P)
            for bn_, mtx in Bm.items():
                pb = arm.pose.bones[bn_]; pb.matrix_basis = mtx
                q = mtx.to_quaternion()
                if bn_ in prevq and prevq[bn_].dot(q) < 0: q = -q   # 부호 뒤집힘 방지(연속 사원수)
                prevq[bn_] = q; pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f)
                if bn_ == 'body': pb.keyframe_insert('location', frame=f)
                if bn_ == 'abdomen': pb.keyframe_insert('scale', frame=f)
        tr = arm.animation_data.nla_tracks.new(); tr.name = name
        tr.strips.new(name, 0, act)
        arm.animation_data.action = None
    for pb in arm.pose.bones: pb.matrix_basis = Matrix.Identity(4)

    # 5) 내보내기
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'spider.glb' if not mini else 'spider_mini.glb')
    for o in bpy.context.selected_objects: o.select_set(False)
    kw = dict(filepath=path, export_format='GLB', use_selection=False, export_apply=False, export_animations=True, export_animation_mode='NLA_TRACKS',
              export_yup=True, export_def_bones=False, export_skins=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
              export_vertex_color='ACTIVE')
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        print('export kw error', e)
        kw.pop('export_vertex_color', None)
        bpy.ops.export_scene.gltf(**kw)
    print(f'[{kind}] wrote {path} {os.path.getsize(path) // 1024} KB')

# ----------------------------------------------------------------------------------------------------------------------
# 미리보기 렌더
# ----------------------------------------------------------------------------------------------------------------------
def look_at(cam, target):
    d = target - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

def render_previews(kind, rig, arm, obj, out):
    scene = bpy.context.scene
    try: scene.render.engine = 'BLENDER_EEVEE'
    except Exception: scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y = 900, 640
    scene.render.image_settings.file_format = 'PNG'
    w = bpy.data.worlds.new('w'); scene.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.05, 0.06, 0.12, 1); bg.inputs[1].default_value = 0.8
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 3.2; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35)); scene.collection.objects.link(sun)
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'POINT')); fill.data.energy = 900 * (rig.K ** 2 * 1.4 + 0.02); fill.location = Vector((2.5, 6, 3)) * rig.K * 1.5; scene.collection.objects.link(fill)
    warm = bpy.data.objects.new('warm', bpy.data.lights.new('warm', 'POINT')); warm.data.energy = 1200 * (rig.K ** 2 * 1.4 + 0.02); warm.data.color = (1.0, 0.55, 0.25); warm.location = Vector((-3, 7, 1.2)) * rig.K * 1.5; scene.collection.objects.link(warm)
    ground = bpy.data.objects.new('ground', bpy.data.meshes.new('g'))
    bmg = bmesh.new(); bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=30 * rig.K); bmg.to_mesh(ground.data); bmg.free(); scene.collection.objects.link(ground)
    gm = bpy.data.materials.new('gm'); gm.use_nodes = True; gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.35, 0.3, 0.22, 1); ground.data.materials.append(gm)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam
    K = rig.K
    shots = [('front', 'idle', 0, (0, 14, 3.2), (0, 0, 2.2), 38), ('side', 'idle', 0, (13, -1.5, 3.6), (0, -0.8, 2.2), 38), ('top', 'idle', 0, (0.01, -1, 17), (0, -0.5, 0), 34),
             ('swipe', 'swipe', 13, (-9, 12, 4.5), (0, 2.5, 2.4), 40), ('spit', 'spit', 15, (7, 11, 2.8), (0, 1.5, 2.4), 40), ('summon', 'summon', 30, (0, 13, 3.4), (0, 0, 3.4), 38),
             ('walk', 'walk', 6, (11, 6, 3.6), (0, 0, 2.0), 38), ('die', 'die', 36, (8, 8, 3.8), (0, 0, 1.2), 38),
             ('face', 'idle', 0, (0.0, 6.2, 2.6), (0, 2.2, 2.45), 36), ('face2', 'idle', 0, (2.5, 5.8, 2.8), (0, 2.2, 2.35), 36), ('face_open', 'spit', 15, (2.3, 6.0, 2.0), (0, 2.0, 2.1), 36)]
    for (nm, an, fr, cp, tp, lens) in shots:
        st = anim_state(rig, an, fr); P = rig.eval_pose(st); Bm = rig.basis(P)
        for bn_, mtx in Bm.items(): arm.pose.bones[bn_].matrix_basis = mtx
        cam.data.lens = lens * 1.0
        if kind == 'mini':
            cam.location = Vector(cp) * K; tgt = Vector(tp) * K
        else:
            cam.location = Vector(cp) * K / 0.85; tgt = Vector(tp) * K / 0.85 * 0.85 if False else Vector(tp) * (K / 0.85)
        look_at(cam, tgt)
        scene.render.filepath = os.path.join(out, f'{kind}_{nm}.png')
        bpy.ops.render.render(write_still=True)
    for o in (sun, fill, warm, cam, ground): bpy.data.objects.remove(o, do_unlink=True)

if __name__ == '__main__':
    what, out, prev = parse_args()
    for kind in (['boss', 'mini'] if what == 'both' else [what]):
        build(kind, out, prev)
