"""
보스 3종(메갈로돈 · 초거대 바위 골렘 · 반천사·반악마) 절차적 모델링 → 뼈대 → LOD 2단 → Draco 압축 glb

실행:  blender -b --factory-startup --python tools/bosses/build_bosses.py -- <shark|golem|seraph|all> [--out bf] [--preview <dir>]

- 순수 bpy/bmesh/mathutils/numpy. 외부 에셋·다운로드 없음(텍스처도 numpy 로 만든다 → 저작권 문제 없음).
- 몸통은 타원체 여러 개를 겹쳐 놓고 voxel remesh 로 한 덩어리로 녹인 뒤, 파이썬 노이즈로 표면을 깎는다(균열·흉터·아가미·이끼 자리).
- 텍스처: 색(albedo, 꼭짓점 색과 곱해짐) + 노멀맵(normal map), 둘 다 이음매 없는(tileable) numpy 노이즈. glb 안에 JPEG 로 들어간다.
- LOD: `<이름>_LOD0`(가까이, 약 4~5만 삼각형) · `<이름>_LOD1`(멀리, 약 0.8~1만 삼각형) 두 메시가 같은 뼈대를 쓴다. three.js 쪽이 거리로 고른다.
- 뼈대는 회전만 쓴다(애니메이션 클립 없음). 움직임은 bf/bosses.js 가 뼈 이름으로 절차적으로 만든다.
- 축: Blender +Y 가 앞, +Z 위, +X 가 보스의 오른쪽. glb(+Y up) 로 내보내면 three.js 의 -Z 가 앞이다(기존 거미와 같다).
"""
import bpy, bmesh, math, sys, os, random
import numpy as np
from mathutils import Vector, Matrix, noise

# ----------------------------------------------------------------------------------------------------------------------
def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    what = argv[0] if argv and not argv[0].startswith('--') else 'all'
    out, prev = 'bf', None
    if '--out' in argv: out = argv[argv.index('--out') + 1]
    if '--preview' in argv: prev = argv[argv.index('--preview') + 1]
    return what, out, prev

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.objects, bpy.data.armatures):
        for x in list(c): c.remove(x)

V = Vector
def lerp(a, b, t): return a + (b - a) * t
def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)

# ----------------------------------------------------------------------------------------------------------------------
# 기본 도형 (bmesh 에 더한다)
# ----------------------------------------------------------------------------------------------------------------------
def basis_from(d, up=V((0, 0, 1))):
    d = d.normalized()
    if abs(d.dot(up)) > 0.95: up = V((1, 0, 0))
    x = up.cross(d).normalized(); z = d.cross(x).normalized()
    return Matrix(((x[0], d[0], z[0]), (x[1], d[1], z[1]), (x[2], d[2], z[2])))   # columns: x, d(=local Y), z

def ell(bm, c, r, rot=None, seg=(18, 12)):
    """타원체: 중심 c, 반지름 (rx, ry, rz), rot 3x3."""
    S = Matrix.Diagonal((r[0], r[1], r[2], 1.0))
    R = (rot.to_4x4() if rot is not None else Matrix.Identity(4))
    M = Matrix.Translation(V(c)) @ R @ S
    bmesh.ops.create_uvsphere(bm, u_segments=seg[0], v_segments=seg[1], radius=1.0, matrix=M)

def tube(bm, pts, radii, flat=1.0, step=0.42, seg=(14, 10)):
    """폴리라인을 따라 타원체를 촘촘히(반지름의 step 배 간격) 놓는다. radii: 점마다 반지름. flat: 단면 납작함(z 축 배율)."""
    pts = [V(p) for p in pts]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]; ra, rb = radii[i], radii[i + 1]
        L = (b - a).length; n = max(1, int(L / (max(0.05, min(ra, rb)) * step)))
        R = basis_from(b - a)
        for k in range(n + (1 if i == len(pts) - 2 else 0)):
            t = k / n; r = lerp(ra, rb, t)
            ell(bm, a.lerp(b, t), (r, r * 0.9, r * flat), R, seg)

def blade(bm, A, B, apex, thick, n=(10, 10), sweep=V((0, 0, 0)), curl=0.0):
    """지느러미·날: 밑변 A-B, 끝 apex 인 삼각 판(두께는 가운데가 두껍고 가장자리 0). sweep: 끝으로 갈수록 휘는 양."""
    A, B, apex = V(A), V(B), V(apex)
    nrm = (B - A).cross(apex - A).normalized()
    ns, nt = n
    top, bot = [], []
    for j in range(nt + 1):
        t = j / nt
        rowT, rowB = [], []
        for i in range(ns + 1):
            s = i / ns
            p = (A.lerp(B, s)).lerp(apex, t) + sweep * (t * t) + nrm * (curl * math.sin(math.pi * s) * t)
            th = thick * (1 - t) ** 0.8 * (math.sin(math.pi * s) ** 0.6 if 0 < s < 1 else 0.0)
            rowT.append(bm.verts.new(p + nrm * th)); rowB.append(bm.verts.new(p - nrm * th))
        top.append(rowT); bot.append(rowB)
    for j in range(nt):
        for i in range(ns):
            bm.faces.new((top[j][i], top[j][i + 1], top[j + 1][i + 1], top[j + 1][i]))
            bm.faces.new((bot[j][i], bot[j + 1][i], bot[j + 1][i + 1], bot[j][i + 1]))
    # 가장자리를 닫는다(위·아래 두께 0 이 되는 테두리 꼭짓점은 같은 자리 → remove_doubles 로 붙음)
    for i in range(ns):
        bm.faces.new((top[0][i], bot[0][i], bot[0][i + 1], top[0][i + 1]))
    for j in range(nt):
        bm.faces.new((top[j][0], top[j + 1][0], bot[j + 1][0], bot[j][0]))
        bm.faces.new((top[j][ns], bot[j][ns], bot[j + 1][ns], top[j + 1][ns]))

def cone(bm, base, tip, r, sides=6, flat=1.0, bend=V((0, 0, 0)), rings=4):
    """뿔·이빨: base 에서 tip 으로 가늘어지는 원뿔(링 여러 개, bend 로 휜다)."""
    base, tip = V(base), V(tip)
    d = tip - base; R = basis_from(d)
    xs, zs = R.col[0], R.col[2]
    prev = None; ringsv = []
    for k in range(rings + 1):
        t = k / rings
        c = base.lerp(tip, t) + bend * (t * t)
        rr = r * (1 - t) ** 1.15 + 0.0005
        ring = [bm.verts.new(c + xs * (math.cos(a) * rr) + zs * (math.sin(a) * rr * flat)) for a in [2 * math.pi * i / sides for i in range(sides)]]
        ringsv.append(ring)
    for k in range(rings):
        a, b = ringsv[k], ringsv[k + 1]
        for i in range(sides):
            bm.faces.new((a[i], a[(i + 1) % sides], b[(i + 1) % sides], b[i]))
    bm.faces.new(list(reversed(ringsv[0])))
    tipv = bm.verts.new(tip + bend)
    last = ringsv[-1]
    for i in range(sides): bm.faces.new((last[i], last[(i + 1) % sides], tipv))

def serr_tooth(bm, base, tip, side, inward, w, th, n=7, serr=0.06, curve=0.0):
    """톱니 이빨: 밑변 폭 w · 두께 th 인 납작한 삼각 날, 양 날에 n 개 톱니(serr: 톱니 깊이 비율). side: 폭 방향, inward: 두께 방향(입 안쪽)."""
    base, tip, side, inward = V(base), V(tip), V(side).normalized(), V(inward).normalized()
    L, R, F, Bk = [], [], [], []
    m = n * 2
    for k in range(m + 1):
        t = k / m
        c = base.lerp(tip, t) + inward * (curve * t * t)
        half = w * 0.5 * (1 - t) ** 0.92
        z = serr * w * (1 - t) * (1.0 if k % 2 else 0.0)     # 톱니: 홀수 칸만 바깥으로
        L.append(bm.verts.new(c - side * (half + z)))
        R.append(bm.verts.new(c + side * (half + z)))
        tt = th * (1 - t) ** 0.85
        F.append(bm.verts.new(c - inward * tt * 0.5)); Bk.append(bm.verts.new(c + inward * tt * 0.5))
    for k in range(m):
        bm.faces.new((L[k], L[k + 1], F[k + 1], F[k])); bm.faces.new((F[k], F[k + 1], R[k + 1], R[k]))
        bm.faces.new((R[k], R[k + 1], Bk[k + 1], Bk[k])); bm.faces.new((Bk[k], Bk[k + 1], L[k + 1], L[k]))
    bm.faces.new((L[0], F[0], R[0], Bk[0]))

# ----------------------------------------------------------------------------------------------------------------------
# 메시 처리
# ----------------------------------------------------------------------------------------------------------------------
def obj_from_bm(name, bm):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); return o

def apply_mods(o):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear(); old = o.data; o.data = me; bpy.data.meshes.remove(old)
    return o

def remesh(o, voxel, smooth_f=0.5, smooth_it=6):
    m = o.modifiers.new('rm', 'REMESH'); m.mode = 'VOXEL'; m.voxel_size = voxel; m.use_smooth_shade = True
    if smooth_it:
        s = o.modifiers.new('sm', 'SMOOTH'); s.factor = smooth_f; s.iterations = smooth_it
    return apply_mods(o)

def decimate(o, tris_target):
    o.data.calc_loop_triangles()
    n = len(o.data.loop_triangles)
    if n > tris_target:
        m = o.modifiers.new('dc', 'DECIMATE'); m.ratio = tris_target / n
        apply_mods(o)
    return o

def solid(o, voxel, tris, sm=4):
    """구슬을 이어 만든 부품을 한 덩어리 표면으로 녹이고 삼각형 수를 줄인다."""
    mats = list(o.data.materials); remesh(o, voxel, 0.5, sm); decimate(o, tris); shade_smooth(o.data)
    o.data.materials.clear()
    for m in mats: o.data.materials.append(m)
    return o

def copy_obj(o, name):
    me = o.data.copy(); c = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(c); return c

def verts_np(me):
    a = np.zeros(len(me.vertices) * 3, dtype=np.float64); me.vertices.foreach_get('co', a); return a.reshape(-1, 3)

def normals_np(me):
    a = np.zeros(len(me.vertices) * 3, dtype=np.float64); me.vertices.foreach_get('normal', a); return a.reshape(-1, 3)

def displace(o, fn):
    """fn(co: Vector, n: Vector) → 법선 방향 이동량(m). 파이썬 반복(정점 수만큼)."""
    me = o.data; co = verts_np(me); nr = normals_np(me)
    out = co.copy()
    for i in range(len(co)):
        c = V(co[i]); n = V(nr[i])
        out[i] = co[i] + nr[i] * fn(c, n)
    me.vertices.foreach_set('co', out.reshape(-1).astype(np.float32)); me.update()

def shade_smooth(me):
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons)); me.update()

def box_uv(me, scale):
    """면 법선의 주축으로 평면 투영(이음매 없는 텍스처라 경계가 거의 안 보인다)."""
    uvl = me.uv_layers.new(name='UVMap') if not me.uv_layers else me.uv_layers[0]
    co = verts_np(me)
    uv = np.zeros(len(me.loops) * 2, dtype=np.float32)
    for p in me.polygons:
        n = p.normal; ax = max(range(3), key=lambda k: abs(n[k]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for li in p.loop_indices:
            v = co[me.loops[li].vertex_index]
            uv[li * 2] = v[a] * scale; uv[li * 2 + 1] = v[b] * scale
    uvl.data.foreach_set('uv', uv)

def set_colors(me, fn):
    """꼭짓점 색 (POINT, FLOAT_COLOR). fn(co, n) → (r, g, b)."""
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    co = verts_np(me); nr = normals_np(me)
    cols = np.ones((len(co), 4), dtype=np.float32)
    for i in range(len(co)):
        r, g, b = fn(V(co[i]), V(nr[i])); cols[i, 0] = r; cols[i, 1] = g; cols[i, 2] = b
    ca.data.foreach_set('color', cols.reshape(-1))
    me.color_attributes.active_color = ca
    try: me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception: pass

def fill_colors(me, rgb):
    set_colors(me, lambda c, n: rgb)

def set_material(o, mat):
    o.data.materials.clear(); o.data.materials.append(mat)

def join(objs, name):
    """같은 뼈대를 쓰는 부품들을 하나로(재질 슬롯 유지)."""
    bm = bmesh.new(); mats = []
    for o in objs:
        me = o.data
        idx = []
        for m in me.materials:
            if m not in mats: mats.append(m)
            idx.append(mats.index(m))
        tmp = bmesh.new(); tmp.from_mesh(me)
        for f in tmp.faces: f.material_index = idx[f.material_index] if idx else 0
        tme = bpy.data.meshes.new('_t'); tmp.to_mesh(tme); tmp.free()
        bm.from_mesh(tme); bpy.data.meshes.remove(tme)
    o = obj_from_bm(name, bm)
    for m in mats: o.data.materials.append(m)
    return o

# ----------------------------------------------------------------------------------------------------------------------
# 이음매 없는 텍스처 (numpy)
# ----------------------------------------------------------------------------------------------------------------------
def tex_fbm(n, beta, seed, lo=2, hi=None):
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    F = np.fft.fft2(w)
    fx = np.fft.fftfreq(n)[:, None] * n; fy = np.fft.fftfreq(n)[None, :] * n
    f = np.sqrt(fx * fx + fy * fy); f[0, 0] = 1
    amp = f ** (-beta)
    amp[f < lo] = 0
    if hi: amp[f > hi] = 0
    h = np.real(np.fft.ifft2(F * amp))
    h -= h.min(); h /= (h.max() + 1e-9); return h

def tex_cells(n, count, seed, jitter=1.0):
    """주기적 Voronoi: F1, F2 (0..1 화면 단위)."""
    rng = np.random.default_rng(seed)
    pts = rng.random((count, 2))
    yy, xx = np.mgrid[0:n, 0:n] / n
    F1 = np.full((n, n), 9.0); F2 = np.full((n, n), 9.0)
    for p in pts:
        dx = np.abs(xx - p[0]); dx = np.minimum(dx, 1 - dx)
        dy = np.abs(yy - p[1]); dy = np.minimum(dy, 1 - dy)
        d = np.sqrt(dx * dx + dy * dy)
        F2 = np.where(d < F1, F1, np.minimum(F2, d)); F1 = np.minimum(F1, d)
    return F1, F2

def height_to_normal(h, strength):
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5 * strength
    nz = np.ones_like(h)
    l = np.sqrt(dx * dx + dy * dy + nz * nz)
    return np.stack([(-dx / l) * 0.5 + 0.5, (-dy / l) * 0.5 + 0.5, (nz / l) * 0.5 + 0.5], axis=-1)

def make_image(name, rgb, non_color=False):
    n = rgb.shape[0]
    img = bpy.data.images.new(name, n, n, alpha=False)
    px = np.ones((n, n, 4), dtype=np.float32); px[..., :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(px.reshape(-1))
    if non_color: img.colorspace_settings.name = 'Non-Color'
    img.file_format = 'JPEG'
    img.pack()
    return img

def material(name, base=(1, 1, 1), rough=0.6, metal=0.0, albedo=None, normal=None, nstrength=1.0, emit=None, emit_k=0.0, double=False):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; bs = nt.nodes['Principled BSDF']
    bs.inputs['Base Color'].default_value = (*base, 1); bs.inputs['Roughness'].default_value = rough; bs.inputs['Metallic'].default_value = metal
    if albedo is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = albedo
        if base != (1, 1, 1):
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs['Factor'].default_value = 1.0
            mix.inputs[6].default_value = (*base, 1); nt.links.new(t.outputs['Color'], mix.inputs[7]); nt.links.new(mix.outputs[2], bs.inputs['Base Color'])
        else:
            nt.links.new(t.outputs['Color'], bs.inputs['Base Color'])
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = nstrength
        nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bs.inputs['Normal'])
    if emit is not None:
        bs.inputs['Emission Color'].default_value = (*emit, 1); bs.inputs['Emission Strength'].default_value = emit_k
    m.use_backface_culling = not double
    return m

# ----------------------------------------------------------------------------------------------------------------------
# 뼈대 · 가중치
# ----------------------------------------------------------------------------------------------------------------------
def make_armature(name, bones):
    """bones: [(name, head, tail, parent or None)]."""
    ad = bpy.data.armatures.new(name + 'Rig'); arm = bpy.data.objects.new(name + 'Rig', ad)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm; arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for (n, h, t, p) in bones:
        b = ad.edit_bones.new(n); b.head = V(h); b.tail = V(t); b.roll = 0.0
        if p: b.parent = eb[p]; b.use_connect = False
        eb[n] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm

def skin(o, arm, bones, fixed=None, sharp=4.0, only=None):
    """정점마다 뼈 선분까지 거리로 가중치(가까운 3개, 1/d^sharp). fixed: 부품 전체를 한 뼈에. only: 이 뼈들 중에서만."""
    me = o.data
    names = [b[0] for b in bones]
    for n in names:
        if n not in o.vertex_groups: o.vertex_groups.new(name=n)
    co = verts_np(me)
    if fixed:
        o.vertex_groups[fixed].add(list(range(len(co))), 1.0, 'REPLACE')
    else:
        use = [b for b in bones if (only is None or b[0] in only)]
        D = np.zeros((len(co), len(use)))
        for j, (n, h, t, p) in enumerate(use):
            a = np.array(h); b = np.array(t); ab = b - a; l2 = max(1e-9, ab.dot(ab))
            u = np.clip(((co - a) @ ab) / l2, 0, 1)
            q = a + u[:, None] * ab
            D[:, j] = np.linalg.norm(co - q, axis=1)
        W = 1.0 / (D + 0.05) ** sharp
        nk = min(3, len(use)); top = np.argsort(-W, axis=1)[:, :nk]
        for i in range(len(co)):
            ws = W[i, top[i]]; s = ws.sum()
            for k in range(nk):
                w = ws[k] / s
                if w > 0.02: o.vertex_groups[use[top[i, k]][0]].add([i], float(w), 'REPLACE')
    o.parent = arm
    m = o.modifiers.new('Armature', 'ARMATURE'); m.object = arm

def export(path, objs_keep):
    for o in bpy.context.scene.objects: o.select_set(o in objs_keep)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=False, export_animations=False,
              export_yup=True, export_skins=True, export_materials='EXPORT', export_cameras=False, export_lights=False,
              export_vertex_color='ACTIVE', export_image_format='JPEG', export_jpeg_quality=82,
              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
              export_draco_position_quantization=14, export_draco_normal_quantization=10, export_draco_texcoord_quantization=12,
              export_draco_color_quantization=10, export_draco_generic_quantization=12)
    for k in ('export_vertex_color', 'export_jpeg_quality'):
        try:
            bpy.ops.export_scene.gltf(**kw); break
        except TypeError as e:
            print('export kw error', e); kw.pop(k, None)
    else:
        bpy.ops.export_scene.gltf(**kw)
    print(f'wrote {path} {os.path.getsize(path) // 1024} KB')

def tri_count(o):
    o.data.calc_loop_triangles(); return len(o.data.loop_triangles)

# ----------------------------------------------------------------------------------------------------------------------
# 공통: 몸(덩어리) → LOD 두 개
# ----------------------------------------------------------------------------------------------------------------------
def finish_lods(name, body_hi, extras_by_lod, arm, bones, targets, uv_scale, color_fn, body_mat, post_lod=None, body_only=None):
    """body_hi: 깎기까지 끝난 고해상 몸. extras_by_lod[i]: [(obj, fixedBone or None)] (재질은 이미 붙어 있음)."""
    outs = []
    for li, tgt in enumerate(targets):
        b = copy_obj(body_hi, f'{name}_body{li}')
        decimate(b, tgt)
        shade_smooth(b.data)
        box_uv(b.data, uv_scale)
        set_colors(b.data, color_fn)
        set_material(b, body_mat)
        if post_lod: post_lod(b, li)
        parts = [b] + [e for (e, fb) in extras_by_lod[li]]
        for (e, fb) in extras_by_lod[li]:
            if not e.data.uv_layers: box_uv(e.data, uv_scale)
            if not e.data.color_attributes: fill_colors(e.data, (1, 1, 1))
        outs.append((parts, extras_by_lod[li]))
    final = []
    for li, (parts, extras) in enumerate(outs):
        for p in parts:
            fb = body_only if p is parts[0] else None
            for (e, f) in extras:
                if e is p: fb = f
            if isinstance(fb, tuple): skin(p, arm, bones, only=fb)
            else: skin(p, arm, bones, fixed=fb)
        # 같은 뼈대 · 같은 LOD 를 한 메시로 (가중치 유지: 수동 join)
        bpy.ops.object.select_all(action='DESELECT')
        for p in parts: p.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        bpy.ops.object.join()
        o = parts[0]; o.name = f'{name}_LOD{li}'; o.data.name = f'{name}_LOD{li}'
        # 모디파이어 중복 정리
        mods = [m for m in o.modifiers if m.type == 'ARMATURE']
        for m in mods[1:]: o.modifiers.remove(m)
        print(f'[{name}] LOD{li} tris={tri_count(o)} verts={len(o.data.vertices)}')
        final.append(o)
    bpy.data.objects.remove(body_hi, do_unlink=True)
    return final

# ======================================================================================================================
# 1) 메갈로돈 — 길이 약 20 m (초대형 거미의 절반). 이빨 세 줄, 왼눈 흉터 세 줄, 아가미 다섯, 반상 비늘(피치) 노멀맵.
# ======================================================================================================================
SHARK_BONES = [
    ('body', (0, 0, 0), (0, 3, 0.05), None),
    ('head', (0, 3, 0.05), (0, 9.6, 0.3), 'body'),
    ('jaw', (0, 4.6, -1.55), (0, 8.4, -1.0), 'head'),
    ('t1', (0, 0, 0), (0, -3.5, 0.1), 'body'),
    ('t2', (0, -3.5, 0.1), (0, -6.8, 0.15), 't1'),
    ('t3', (0, -6.8, 0.15), (0, -10.4, 0.3), 't2'),
    ('pecL', (-1.9, 3.8, -1.3), (-5.6, 1.0, -2.6), 'body'),
    ('pecR', (1.9, 3.8, -1.3), (5.6, 1.0, -2.6), 'body'),
]
SHARK_ST = [  # y, rx, rz, zc
    (10.0, 0.25, 0.3, 0.35), (9.4, 0.85, 0.75, 0.3), (8.4, 1.35, 1.15, 0.35), (7.2, 1.75, 1.5, 0.35), (5.8, 2.1, 1.95, 0.25),
    (4.2, 2.35, 2.45, 0.05), (2.5, 2.45, 2.65, 0.0), (0.6, 2.35, 2.55, 0.05), (-1.5, 2.0, 2.2, 0.1), (-3.6, 1.5, 1.65, 0.12),
    (-5.4, 1.0, 1.1, 0.15), (-6.8, 0.68, 0.78, 0.18), (-8.0, 0.55, 0.6, 0.2), (-8.9, 0.5, 0.5, 0.22)]
UPPER_GUM = lambda u: V((1.95 * math.sin(u * math.pi / 2) * (0.75 + 0.25 * abs(u)), 4.9 + 3.6 * math.cos(u * math.pi / 2) ** 0.8, lerp(-0.62, -1.55, abs(u) ** 1.3)))
LOWER_GUM = lambda u: V((1.8 * math.sin(u * math.pi / 2) * (0.75 + 0.25 * abs(u)), 4.9 + 3.3 * math.cos(u * math.pi / 2) ** 0.8, lerp(-1.02, -1.75, abs(u) ** 1.3)))
SCARS = [  # 왼눈(−x) 위를 비스듬히 가로지르는 흉터 세 줄 + 몸통의 오래된 흉터
    (V((-1.75, 8.3, 1.25)), V((-1.25, 6.2, -0.3)), 0.11), (V((-1.9, 7.9, 1.35)), V((-1.45, 5.8, -0.1)), 0.09), (V((-2.0, 7.4, 1.4)), V((-1.7, 5.5, 0.15)), 0.08),
    (V((2.3, 2.0, 1.4)), V((2.2, -0.6, 0.3)), 0.06), (V((-2.2, 0.5, 1.8)), V((-1.8, -2.4, 1.2)), 0.05)]

def seg_d(p, a, b):
    ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.length_squared))); return (p - (a + ab * t)).length

def build_shark(out, prev):
    reset_scene()
    # 텍스처: 비늘(피치) — 아주 잘게 겹친 세포 + 저주파 주름
    # 2048: 비늘(피부 이빨 · 1024 세포를 2×2 로 이어 붙여 이음매 없음) + 잔주름 + 땀구멍 같은 점 + 긁힌 선
    n = 2048
    F1, F2 = tex_cells(1024, 1600, 7)
    den = np.tile(np.clip(1 - F1 * 60, 0, 1) ** 1.5, (2, 2))
    ridge = np.tile(np.clip(1 - (F2 - F1) * 140, 0, 1), (2, 2))          # 비늘 사이 홈
    wr = tex_fbm(n, 1.6, 3, lo=2, hi=90)
    fine = tex_fbm(n, 0.6, 4, lo=200)                                   # 잔결
    pores = (tex_fbm(n, 0.1, 5) > 0.86).astype(float)
    scr = np.zeros((n, n)); rng = np.random.default_rng(8)
    for _ in range(500):
        x0, y0 = rng.integers(0, n, 2); ang = rng.normal(0.0, 0.35); L = rng.integers(30, 220)
        for t in range(L): scr[int(y0 + math.sin(ang) * t) % n, int(x0 + math.cos(ang) * t) % n] = 1
    h = den * 0.45 + wr * 0.4 + fine * 0.12 - ridge * 0.18 - pores * 0.25 - scr * 0.3
    alb = (0.8 + 0.18 * tex_fbm(n, 1.1, 11) - 0.08 * ridge + 0.1 * scr - 0.12 * pores)[..., None] * np.array([1, 1, 1]) * (0.92 + 0.08 * den[..., None])
    A = make_image('shark_albedo', alb); N = make_image('shark_normal', height_to_normal(h, 7.0), True)
    m_skin = material('shark_skin', rough=0.4, albedo=A, normal=N, nstrength=1.1)
    # 입 속: 젖은 살(주름 · 점막 혈관) 1024
    k = 1024; fm = tex_fbm(k, 1.3, 41); Fv1, Fv2 = tex_cells(k, 140, 42)
    vein = np.clip(1 - (Fv2 - Fv1) * 55, 0, 1) ** 2
    rug = 0.5 + 0.5 * np.sin(np.mgrid[0:k, 0:k][0] / k * math.pi * 2 * 22 + fm * 6)  # 입천장 가로 주름(rugae)
    falb = np.stack([0.62 + 0.25 * fm - 0.25 * vein, 0.12 + 0.08 * fm - 0.08 * vein, 0.13 + 0.06 * fm - 0.06 * vein], -1)
    FA = make_image('shark_flesh_albedo', falb); FN = make_image('shark_flesh_normal', height_to_normal(fm * 0.6 + rug * 0.35 - vein * 0.3, 6.0), True)
    m_mouth = material('shark_mouth', base=(0.55, 0.12, 0.13), rough=0.28, albedo=FA, normal=FN, nstrength=1.2)
    m_gum = material('shark_gum', base=(0.95, 0.42, 0.44), rough=0.22, albedo=FA, normal=FN, nstrength=1.4)
    m_tongue = material('shark_tongue', base=(1.0, 0.3, 0.3), rough=0.3, albedo=FA, normal=FN, nstrength=1.6)
    m_throat = material('shark_throat', base=(0.035, 0.004, 0.006), rough=0.5)
    # 이빨: 뿌리 쪽 누렇고 끝은 반투명한 흰색, 세로 결
    tk = 512; ty = np.mgrid[0:tk, 0:tk][0] / tk
    talb = np.stack([0.95 - 0.12 * ty, 0.92 - 0.2 * ty, 0.84 - 0.32 * ty], -1) * (0.93 + 0.07 * tex_fbm(tk, 0.8, 43))[..., None]
    TA = make_image('shark_tooth_albedo', talb); TN = make_image('shark_tooth_normal', height_to_normal(tex_fbm(tk, 1.0, 44) * 0.5 + 0.5 * np.sin(np.mgrid[0:tk, 0:tk][1] / tk * math.pi * 40) * 0.1, 3.0), True)
    m_teeth = material('shark_teeth', base=(1, 1, 1), rough=0.18, albedo=TA, normal=TN, nstrength=0.8)
    m_eye = material('shark_eye', base=(0.004, 0.004, 0.005), rough=0.02)
    m_iris = material('shark_iris', base=(0.12, 0.16, 0.18), rough=0.1, emit=(0.05, 0.08, 0.09), emit_k=0.6)
    arm = make_armature('Shark', SHARK_BONES)

    # 몸통: 단면 타원 + 지느러미
    bm = bmesh.new()
    for i in range(len(SHARK_ST) - 1):
        a, b = SHARK_ST[i], SHARK_ST[i + 1]
        k = max(3, int(abs(a[0] - b[0]) / 0.16))
        for s in range(k):
            t = s / k; y = lerp(a[0], b[0], t); rx = lerp(a[1], b[1], t); rz = lerp(a[2], b[2], t); zc = lerp(a[3], b[3], t)
            ell(bm, (0, y, zc), (rx, 0.9, rz), seg=(28, 16))
    # 꼬리자루 용골(keel)
    for y in np.linspace(-7.2, -9.0, 6): ell(bm, (0, y, 0.2), (0.85, 0.35, 0.28), seg=(14, 8))
    blade(bm, (0, 1.9, 2.3), (0, -1.6, 1.9), (0, -1.9, 5.4), 0.32, sweep=V((0, -0.6, 0)))           # 등지느러미(높고 뒤로 휨)
    blade(bm, (0, -5.6, 0.9), (0, -6.6, 0.75), (0, -6.9, 1.7), 0.1)                                    # 둘째 등지느러미
    for sg in (-1, 1):
        blade(bm, (sg * 1.6, 4.6, -1.2), (sg * 1.5, 2.3, -1.5), (sg * 6.2, 0.4, -3.1), 0.26, sweep=V((0, -0.5, 0.3)))   # 가슴지느러미
        blade(bm, (sg * 0.7, -3.4, -1.1), (sg * 0.6, -4.6, -0.9), (sg * 1.6, -5.4, -1.8), 0.1)        # 배지느러미
    blade(bm, (0, -5.9, -0.45), (0, -6.6, -0.35), (0, -7.1, -1.15), 0.08)                             # 뒷지느러미
    blade(bm, (0, -8.4, 0.6), (0, -9.2, 0.05), (0, -11.6, 4.6), 0.18, sweep=V((0, -0.9, 0)))          # 꼬리 위 잎
    blade(bm, (0, -8.6, -0.05), (0, -9.1, 0.35), (0, -10.6, -2.9), 0.14, sweep=V((0, -0.5, 0)))       # 꼬리 아래 잎
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    body = obj_from_bm('shark_body', bm)
    remesh(body, 0.085, 0.6, 10)
    # 입 속 굴: 위턱 잇몸 안쪽을 파낸다(턱을 벌리면 입천장 · 목구멍이 보이게)
    bm = bmesh.new(); ell(bm, (0, 5.5, -1.75), (1.72, 2.95, 1.15), seg=(40, 24)); ell(bm, (0, 3.6, -1.6), (1.4, 1.6, 0.9), seg=(32, 18))
    cav = obj_from_bm('shark_cavity', bm); remesh(cav, 0.06, 0.3, 2)
    bo = body.modifiers.new('cav', 'BOOLEAN'); bo.operation = 'DIFFERENCE'; bo.object = cav; bo.solver = 'EXACT'
    apply_mods(body); bpy.data.objects.remove(cav, do_unlink=True)

    eyes = [V((-1.42, 7.25, 0.62)), V((1.42, 7.25, 0.62))]
    gills = [3.9 - 0.42 * i for i in range(5)]
    def carve(c, nrm):
        d = 0.0
        # 아가미: 옆구리 세로 홈
        if abs(c.x) > 1.3 and -1.5 < c.z < 1.3:
            for gy in gills:
                w = abs(c.y - (gy - 0.12 * c.z)); d -= 0.11 * max(0, 1 - w / 0.06) * smooth(-1.5, -1.1, c.z) * (1 - smooth(0.9, 1.3, c.z))
        # 흉터
        for (a, b, wd) in SCARS:
            dd = seg_d(c, a, b)
            if dd < wd * 2.2: d -= 0.08 * max(0, 1 - dd / (wd * 2.2)) ** 1.5 - 0.02 * max(0, 1 - abs(dd - wd * 1.6) / (wd * 0.6))
        # 눈구멍
        for e in eyes:
            de = (c - e).length
            if de < 0.5: d -= 0.14 * (1 - de / 0.5) ** 2
        # 주름: 콧등 · 턱 아래
        d += 0.025 * noise.noise(c * 1.7) + 0.012 * noise.noise(c * 5.3)
        # 입꼬리 주름: 입 끝(뺨)에서 뒤로 뻗는 깊은 접힘 세 줄
        if 3.4 < c.y < 5.6 and abs(c.x) > 1.4 and -1.9 < c.z < -0.2:
            for kf in range(3):
                zz = -1.25 + 0.28 * kf + 0.18 * (c.y - 4.6)
                d -= 0.05 * max(0, 1 - abs(c.z - zz) / 0.06)
        # 주둥이 아래 감각 구멍(로렌치니 기관): 잔 점
        if c.y > 7.2 and c.z < 0.4:
            q = noise.noise(c * 9.0)
            if q > 0.55: d -= 0.03 * (q - 0.55) / 0.45
        # 입 선: 위턱 잇몸을 따라 안쪽으로 패인 선 (입이 닫혀 있을 때 경계)
        if c.y > 4.5 and c.z < 0.2:
            u = max(-1, min(1, math.asin(max(-1, min(1, c.x / 1.95))) * 2 / math.pi))
            g = UPPER_GUM(u)
            if abs(c.y - g.y) < 1.2 and abs(c.z - g.z) < 0.25: d -= 0.05 * (1 - abs(c.z - g.z) / 0.25)
        return d
    displace(body, carve)

    # 아래턱(따로: 입을 벌릴 수 있게)
    bm = bmesh.new()
    for u in np.linspace(-1, 1, 23):
        p = LOWER_GUM(u); r = 0.42 + 0.25 * abs(u)
        ell(bm, (p.x * 0.93, p.y - 0.15, p.z - 0.32), (r, r * 0.9, 0.42), seg=(14, 10))
    for y in np.linspace(5.0, 8.0, 8):
        w = lerp(1.95, 0.7, (y - 5.0) / 3.0)
        ell(bm, (0, y, -1.75 + (y - 5) * 0.14), (w, 0.45, 0.42), seg=(18, 10))
    jaw = obj_from_bm('shark_jaw', bm)
    remesh(jaw, 0.07, 0.5, 4)
    displace(jaw, lambda c, nr: 0.018 * noise.noise(c * 3.0))

    def gum_tan(fn, u):
        a, b = fn(max(-1, u - 0.02)), fn(min(1, u + 0.02)); return (b - a).normalized()
    def teeth_parts(rows, ns=7):
        """여러 줄 톱니 이빨: 앞줄은 곧게 서고, 뒷줄일수록 작고 입 안쪽으로 눕는다(교체용 이빨 줄)."""
        bm = bmesh.new(); bl = bmesh.new()
        rnd = random.Random(5)
        for row in range(rows):
            sc = [1.0, 0.8, 0.64, 0.5, 0.4][row]; inset = [1.0, 0.92, 0.85, 0.78, 0.72][row]; lay = [0.0, 0.35, 0.7, 1.0, 1.25][row]
            cnt = [26, 26, 24, 22, 20][row]
            for i in range(cnt):
                u = -0.96 + 1.92 * (i + 0.5 * (row % 2)) / cnt
                g = UPPER_GUM(u); g = V((g.x * inset, g.y - 0.3 * row, g.z + 0.06 * row))
                L = (1.05 - 0.4 * abs(u)) * sc * (0.85 + 0.3 * rnd.random())
                inward = V((-g.x, -1.2, 0)).normalized()
                tip = g + V((0, 0, -L)) * math.cos(lay * 0.9) + inward * L * math.sin(lay * 0.9) + V((-g.x * 0.04, 0, 0))
                serr_tooth(bm, g, tip, gum_tan(UPPER_GUM, u), inward, 0.5 * sc, 0.16 * sc, n=ns, serr=0.07, curve=0.08 * sc)
                if row < rows - 1:
                    g2 = LOWER_GUM(u); g2 = V((g2.x * inset * 0.95, g2.y - 0.28 * row, g2.z - 0.05 * row))
                    L2 = (0.9 - 0.32 * abs(u)) * sc * (0.85 + 0.3 * rnd.random())
                    inw2 = V((-g2.x, -1.2, 0)).normalized()
                    tip2 = g2 + V((0, 0.04, L2)) * math.cos(lay * 0.9) + inw2 * L2 * math.sin(lay * 0.9)
                    serr_tooth(bl, g2, tip2, gum_tan(LOWER_GUM, u), inw2, 0.42 * sc, 0.14 * sc, n=max(2, ns - 1), serr=0.07, curve=0.06 * sc)
        up = obj_from_bm('shark_teeth_up', bm); lo = obj_from_bm('shark_teeth_lo', bl)
        for o in (up, lo):
            set_material(o, m_teeth); me = o.data; uvl = me.uv_layers.new(name='UVMap')
            # 이빨 UV: 높이(z) → v 로, 뿌리 누런 색 · 끝 흰색
            for lp in me.loops:
                c = me.vertices[lp.vertex_index].co; uvl.data[lp.index].uv = (c.x * 0.6 + c.y * 0.6, 0.5 + 0.5 * math.sin(c.z * 1.2))
        return up, lo

    def gum_parts(gt):
        """두툼한 잇몸(이빨마다 부풀고) · 주름진 입천장 · 혀 · 어두운 목구멍 · 입 바닥."""
        us = np.linspace(-1, 1, 33)
        bm = bmesh.new()
        tube(bm, [V((UPPER_GUM(u).x * 0.95, UPPER_GUM(u).y - 0.5, UPPER_GUM(u).z + 0.12)) for u in us], [0.42] * len(us), flat=0.75, seg=(12, 8))
        for u in np.linspace(-0.96, 0.96, 26): g = UPPER_GUM(u); ell(bm, (g.x * 0.98, g.y - 0.05, g.z + 0.02), (0.3, 0.26, 0.2), seg=(10, 6))
        up = obj_from_bm('shark_gum_up', bm); set_material(up, m_gum); solid(up, 0.05, gt)
        bm = bmesh.new()
        tube(bm, [V((LOWER_GUM(u).x * 0.92, LOWER_GUM(u).y - 0.45, LOWER_GUM(u).z - 0.1)) for u in us], [0.38] * len(us), flat=0.75, seg=(12, 8))
        for u in np.linspace(-0.96, 0.96, 24): g = LOWER_GUM(u); ell(bm, (g.x * 0.94, g.y - 0.05, g.z - 0.02), (0.27, 0.24, 0.18), seg=(10, 6))
        lo = obj_from_bm('shark_gum_lo', bm); set_material(lo, m_gum); solid(lo, 0.05, gt)
        # 입천장: 위턱 안쪽 둥근 천장 + 가로 주름 띠
        bm = bmesh.new(); ell(bm, (0, 5.6, -0.5), (1.45, 2.4, 0.42), seg=(24, 14))
        for k in range(8): yk = 7.4 - k * 0.38; ell(bm, (0, yk, -0.86 + 0.02 * k), (1.15 - 0.06 * abs(k - 4), 0.09, 0.07), seg=(16, 6))
        mo = obj_from_bm('shark_mouth', bm); set_material(mo, m_mouth); solid(mo, 0.05, gt)
        # 입 바닥 + 혀(굵게 부푼 붉은 혀, 가운데 홈)
        bm = bmesh.new(); ell(bm, (0, 5.9, -1.6), (1.6, 2.5, 0.32), seg=(18, 8))
        mi = obj_from_bm('shark_mouth_lo', bm); set_material(mi, m_mouth)
        bm = bmesh.new()
        for sgn in (-1, 1): tube(bm, [V((sgn * 0.32, 4.6, -1.42)), V((sgn * 0.42, 6.0, -1.36)), V((sgn * 0.28, 7.2, -1.42))], [0.55, 0.6, 0.38], flat=0.5, seg=(14, 8))
        tg = obj_from_bm('shark_tongue', bm); set_material(tg, m_tongue); solid(tg, 0.04, gt)
        # 목구멍: 안쪽으로 좁아지는 어두운 굴(입을 벌리면 끝이 안 보이는 검붉은 어둠)
        bm = bmesh.new()
        for k in range(7): yk = 4.7 - k * 0.45; r = 1.5 - k * 0.14; ell(bm, (0, yk, -1.15 + k * 0.05), (r, 0.5, r * 0.62), seg=(16, 8))
        th = obj_from_bm('shark_throat', bm); set_material(th, m_throat)
        return up, lo, mo, mi, tg, th

    def eye_parts():
        """눈: 젖은 검은 안구 + 청회색 홍채 고리 + 눈꺼풀 테(살갗 주름)."""
        bm = bmesh.new(); bi = bmesh.new()
        for e in eyes:
            ell(bm, e, (0.26, 0.26, 0.26), seg=(18, 12))
            sg = 1 if e.x > 0 else -1; nrm = V((sg, 0.25, 0.1)).normalized()
            ell(bi, e + nrm * 0.21, (0.17, 0.17, 0.035), basis_from(nrm, up=V((0, 1, 0))), seg=(18, 6))
        o = obj_from_bm('shark_eyes', bm); set_material(o, m_eye)
        ir = obj_from_bm('shark_iris', bi); set_material(ir, m_iris)
        bm = bmesh.new()
        for e in eyes:
            sg = 1 if e.x > 0 else -1
            ring = [e + V((sg * 0.12, 0.3 * math.cos(a), 0.3 * math.sin(a) * 0.85)) for a in np.linspace(0, 2 * math.pi, 17)]
            tube(bm, ring, [0.07] * len(ring), seg=(8, 6))
        lid = obj_from_bm('shark_lids', bm); set_material(lid, m_skin)
        return o, ir, lid

    def jaw_lod(li):
        j = copy_obj(jaw, f'shark_jaw{li}'); decimate(j, [9000, 1400][li]); shade_smooth(j.data); box_uv(j.data, 0.45)
        set_colors(j.data, lambda c, nr: shark_color(c, nr)); set_material(j, m_skin); return j

    def shark_color(c, nr):
        # 위 짙은 청회색 → 옆선 → 배 흰색(카운터셰이딩), 경계는 물결
        wave = 0.25 * noise.noise(V((c.x * 0.4, c.y * 0.6, 0))) + 0.08 * math.sin(c.y * 2.1)
        belly = smooth(-0.2, 0.35, -(c.z - (-0.6 + wave)) / 1.5 + (-nr.z) * 0.4)
        top = V((0.19, 0.22, 0.25)); side = V((0.34, 0.37, 0.4)); wht = V((0.86, 0.85, 0.82))
        col = top.lerp(side, smooth(-0.6, 0.4, -nr.z)).lerp(wht, belly)
        mott = 0.86 + 0.14 * noise.noise(c * 0.9) + 0.06 * noise.noise(c * 3.3)
        col = col * mott
        for (a, b, wd) in SCARS:
            dd = seg_d(c, a, b)
            if dd < wd * 2.0: col = col.lerp(V((0.78, 0.6, 0.58)), 0.75 * (1 - dd / (wd * 2.0)))
        for e in eyes:
            de = (c - e).length
            if de < 0.55: col = col * (0.5 + 0.5 * de / 0.55)
        if abs(c.x) > 1.3 and -1.5 < c.z < 1.3:
            for gy in gills:
                if abs(c.y - (gy - 0.12 * c.z)) < 0.05: col = col * 0.45
        if c.y > 4.6 and c.z < -0.5 and abs(c.x) < 1.9: col = col.lerp(V((0.7, 0.62, 0.6)), 0.25)
        # 입 속(파낸 굴의 벽 · 아래턱 안쪽): 젖은 붉은 살 → 목구멍 쪽으로 검붉게
        q1 = ((c.x / 1.86) ** 2 + ((c.y - 5.5) / 3.15) ** 2 + ((c.z + 1.75) / 1.25) ** 2)
        q2 = ((c.x / 1.52) ** 2 + ((c.y - 3.6) / 1.75) ** 2 + ((c.z + 1.6) / 1.0) ** 2)
        floor = c.y > 4.4 and c.z > -1.95 and c.z < -1.2 and abs(c.x) < 1.55 and nr.z > 0.3
        if q1 < 1.0 or q2 < 1.0 or floor:
            deep = smooth(7.5, 3.0, c.y)
            flesh = V((0.62, 0.1, 0.11)).lerp(V((0.08, 0.01, 0.015)), deep) * (0.85 + 0.25 * noise.noise(c * 4.0))
            return (flesh.x, flesh.y, flesh.z)
        # 잔흉터(긁힌 선) 무작위
        s = noise.noise(V((c.x * 0.2, c.y * 4.0, c.z * 0.2)))
        if s > 0.62: col = col.lerp(V((0.7, 0.68, 0.66)), (s - 0.62) * 2.2)
        return (col.x, col.y, col.z)

    extras = []
    for li in range(2):
        tu, tl = teeth_parts(5 if li == 0 else 2, 7 if li == 0 else 2)
        gu, gl, mo, mi, tg, th = gum_parts([5000, 900][li])
        ey, ir, lid = eye_parts()
        ex = [(jaw_lod(li), 'jaw'), (tu, 'head'), (tl, 'jaw'), (gu, 'head'), (gl, 'jaw'), (mo, 'head'), (mi, 'jaw'), (tg, 'jaw'), (th, 'head'), (ey, 'head'), (ir, 'head'), (lid, 'head')]
        extras.append(ex)
    bpy.data.objects.remove(jaw, do_unlink=True)

    lods = finish_lods('Shark', body, extras, arm, SHARK_BONES, [60000, 9000], 0.45, shark_color, m_skin, body_only=tuple(b[0] for b in SHARK_BONES if b[0] != 'jaw'))
    # 미리보기: 입을 크게 벌린 자세(게임의 평소 자세와 같게)
    jb = arm.pose.bones['jaw']; jb.rotation_mode = 'XYZ'; jb.rotation_euler = (math.radians(-32), 0, 0)
    finalize(arm, lods, out, 'shark.glb', prev, 'shark', [((15, 22, 6), (0, 3, 0)), ((0, 16, -2.2), (0, 4.0, -1.7)), ((-4.5, 11, -0.6), (-1.0, 6.6, 0.0))])

# ======================================================================================================================
# 2) 초거대 바위 골렘 — 키 약 17 m. 풍화된 돌(리지 노이즈) · 균열(Voronoi 경계) · 이끼(윗면) · 가슴의 빛나는 심장.
# ======================================================================================================================
GOLEM_BONES = [
    ('hips', (0, 0, 6.2), (0, 0.1, 8.2), None),
    ('spine', (0, 0.1, 8.2), (0, 0.8, 11.0), 'hips'),
    ('head', (0, 1.8, 12.0), (0, 3.6, 12.6), 'spine'),
    ('armL', (-5.4, 0.6, 11.6), (-6.6, 1.2, 7.8), 'spine'), ('foreL', (-6.6, 1.2, 7.8), (-6.8, 2.2, 4.0), 'armL'), ('fistL', (-6.8, 2.2, 4.0), (-6.9, 2.8, 2.0), 'foreL'),
    ('armR', (5.4, 0.6, 11.6), (6.6, 1.2, 7.8), 'spine'), ('foreR', (6.6, 1.2, 7.8), (6.8, 2.2, 4.0), 'armR'), ('fistR', (6.8, 2.2, 4.0), (6.9, 2.8, 2.0), 'foreR'),
    ('thighL', (-2.2, 0, 6.0), (-2.8, 0.8, 3.4), 'hips'), ('shinL', (-2.8, 0.8, 3.4), (-2.9, 0.2, 0.9), 'thighL'),
    ('thighR', (2.2, 0, 6.0), (2.8, 0.8, 3.4), 'hips'), ('shinR', (2.8, 0.8, 3.4), (2.9, 0.2, 0.9), 'thighR'),
]
HEART = V((0, 3.15, 10.6))

def build_golem(out, prev):
    reset_scene()
    n = 2048   # 고해상: 2048² 색 + 노멀
    F1, F2 = tex_cells(n, 70, 21)
    crack = np.clip(1 - (F2 - F1) * 60, 0, 1) ** 2                       # 큰 균열
    F1b, F2b = tex_cells(n, 420, 22)
    crack2 = np.clip(1 - (F2b - F1b) * 150, 0, 1) ** 2 * 0.5              # 잔금
    chip = np.clip(F1b * 14, 0, 1) ** 0.5                                 # 깨진 면(조각마다 볼록)
    grain = tex_fbm(n, 0.9, 23); lump = tex_fbm(n, 1.8, 24); micro = tex_fbm(n, 0.4, 26)
    yy = np.mgrid[0:n, 0:n][0] / n
    strata = 0.5 + 0.5 * np.sin((yy * 18 + lump * 2.2) * 2 * math.pi)        # 퇴적 결(가로 줄무늬)
    pits = (tex_fbm(n, 0.05, 27) > 0.88).astype(float)                    # 풍화 구멍
    lich = np.clip((tex_fbm(n, 1.2, 28) - 0.62) * 6, 0, 1)                # 지의류 얼룩
    h = lump * 0.55 + grain * 0.2 + micro * 0.12 + chip * 0.18 + strata * 0.08 - crack * 0.75 - crack2 * 0.45 - pits * 0.3
    v = (0.74 + 0.2 * grain + 0.08 * micro + 0.06 * strata - 0.5 * crack - 0.22 * crack2 - 0.25 * pits)[..., None]
    alb = v * np.array([1.0, 0.98, 0.94])
    alb = alb * (1 - lich[..., None] * 0.6) + lich[..., None] * 0.6 * np.array([0.78, 0.8, 0.55]) * v   # 연둣빛 지의류
    speck = (tex_fbm(n, 0.2, 25) > 0.82)[..., None] * 0.12
    A = make_image('golem_albedo', alb + speck); N = make_image('golem_normal', height_to_normal(h, 16.0), True)
    m_rock = material('golem_rock', rough=0.92, albedo=A, normal=N, nstrength=1.4)
    nm_ = 1024
    mf = tex_fbm(nm_, 0.6, 29); mb = tex_fbm(nm_, 1.6, 30); tuft = (tex_fbm(nm_, 0.15, 31) > 0.6).astype(float)
    hm = mf * 0.5 + mb * 0.3 + tuft * 0.25
    Am = make_image('golem_moss_albedo', (0.55 + 0.45 * mf + 0.15 * tuft)[..., None] * np.array([0.42, 0.62, 0.22]) + (mb[..., None] - 0.5) * np.array([0.12, 0.05, -0.02]))
    Nm = make_image('golem_moss_normal', height_to_normal(hm, 20.0), True)
    m_moss = material('golem_moss', rough=1.0, albedo=Am, normal=Nm, nstrength=1.5)
    m_lava = material('golem_lava', base=(1.0, 0.35, 0.05), rough=0.6, emit=(1.0, 0.38, 0.06), emit_k=3.0)
    m_core = material('golem_core', base=(1.0, 0.55, 0.15), rough=0.2, emit=(1.0, 0.5, 0.12), emit_k=6.0)
    m_eye = material('golem_eye', base=(1.0, 0.6, 0.2), rough=0.3, emit=(1.0, 0.55, 0.15), emit_k=5.0)
    arm = make_armature('Golem', GOLEM_BONES)
    rnd = random.Random(3)

    bm = bmesh.new()
    ell(bm, (0, 0, 6.6), (3.3, 2.3, 1.9)); ell(bm, (0, 0.2, 8.7), (3.1, 2.4, 1.9))
    ell(bm, (0, 0.9, 11.0), (4.7, 3.3, 3.0)); ell(bm, (0, -0.6, 11.8), (3.6, 2.6, 2.4))     # 가슴 + 등 혹
    ell(bm, (0, 2.6, 12.25), (1.55, 1.55, 1.35)); ell(bm, (0, 3.3, 11.9), (1.1, 0.9, 0.7))  # 머리(어깨 사이로 푹 숙임) + 턱
    # 얼굴 조각: 툭 튀어나온 눈썹뼈 · 넓적한 코 · 광대 · 각진 턱
    ell(bm, (0, 3.72, 12.82), (1.3, 0.5, 0.36), basis_from(V((0, 1, 0.15))))
    ell(bm, (0, 4.02, 12.25), (0.32, 0.42, 0.5)); ell(bm, (0, 4.12, 12.0), (0.42, 0.3, 0.2))
    for sg in (-1, 1):
        ell(bm, (sg * 0.85, 3.62, 12.05), (0.5, 0.42, 0.34)); ell(bm, (sg * 0.7, 3.55, 11.45), (0.55, 0.55, 0.4))
    for sg in (-1, 1):
        ell(bm, (sg * 5.3, 0.6, 12.0), (2.2, 2.1, 2.0))
        tube(bm, [(sg * 5.6, 0.6, 11.6), (sg * 6.6, 1.2, 7.8)], [1.65, 1.35], step=0.5)
        tube(bm, [(sg * 6.6, 1.2, 7.8), (sg * 6.8, 2.2, 4.0)], [1.45, 1.75], step=0.5)
        ell(bm, (sg * 6.9, 2.6, 2.6), (2.0, 1.9, 1.8))
        tube(bm, [(sg * 2.2, 0, 6.0), (sg * 2.8, 0.8, 3.4)], [1.75, 1.5], step=0.5)
        tube(bm, [(sg * 2.8, 0.8, 3.4), (sg * 2.9, 0.2, 0.9)], [1.5, 1.75], step=0.5)
        ell(bm, (sg * 2.9, 0.9, 0.55), (1.8, 2.4, 0.8))
    # 덧붙은 바위 덩이(실루엣을 거칠게)
    for _ in range(46):
        bn = rnd.choice(GOLEM_BONES); a, b = V(bn[1]), V(bn[2]); p = a.lerp(b, rnd.random())
        d = V((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.3, 1))).normalized()
        rr = rnd.uniform(0.6, 1.3) * (1.6 if bn[0] in ('spine', 'hips') else 1.0)
        ell(bm, p + d * (1.3 if bn[0] not in ('spine',) else 2.6), (rr, rr * rnd.uniform(0.7, 1.2), rr * rnd.uniform(0.6, 1.0)), basis_from(d))
    body = obj_from_bm('golem_body', bm)
    remesh(body, 0.085, 0.45, 3)

    def carve(c, nr):
        d = 0.45 * (noise.ridged_multi_fractal(c * 0.22, 0.9, 2.1, 4, 1.0, 2.0) - 1.0) * 0.5
        d += 0.12 * noise.noise(c * 0.9) + 0.045 * noise.noise(c * 3.1) + 0.018 * noise.noise(c * 7.5)
        d += 0.07 * (abs(math.sin(c.z * 2.6 + 0.8 * noise.noise(c * 0.4))) - 0.6)                 # 퇴적 층 턱(가로 결)
        cd, cp = noise.voronoi(c * 0.9, distance_metric='DISTANCE')                              # 떨어져 나간 조각 면(평평하게 깎인 자리)
        d -= 0.06 * smooth(0.25, 0.6, cd[0])
        if c.y > 3.3 and c.z > 11.0 and abs(c.x) < 1.6:                                         # 얼굴: 눈구멍 · 입 홈
            for sg in (-1, 1):
                e_ = (c - V((sg * 0.55, 3.95, 12.45))).length
                if e_ < 0.55: d -= 0.22 * (1 - e_ / 0.55)
            mz = abs(c.z - 11.62); mx = abs(c.x)
            if mz < 0.12 and mx < 0.75: d -= 0.18 * (1 - mz / 0.12) * (1 - (mx / 0.75) ** 4)
        dist, pts = noise.voronoi(c * 0.28, distance_metric='DISTANCE')
        e = dist[1] - dist[0]
        if e < 0.12: d -= 0.32 * (1 - e / 0.12) ** 1.5
        # 심장 자리: 가슴 앞을 사발 모양으로 판다
        # 얼굴: 무거운 눈썹 뼈 · 깊은 눈구멍 · 부서진 콧등 · 쩍 갈라진 입 · 뺨의 깊은 주름
        f = c - V((0, 2.6, 12.25))
        if f.y > 0.4 and f.length < 2.3:
            fr = smooth(0.4, 1.2, f.y)
            d += 0.32 * fr * math.exp(-((f.z - 0.42) / 0.16) ** 2) * smooth(1.4, 0.6, abs(f.x))                         # 눈썹 뼈
            for sg in (-1, 1): d -= 0.38 * fr * math.exp(-(((f.x - sg * 0.55) / 0.3) ** 2 + ((f.z - 0.2) / 0.2) ** 2))     # 눈구멍
            d += 0.42 * fr * math.exp(-((f.x / 0.2) ** 2)) * smooth(0.4, 0.05, f.z) * smooth(-0.3, -0.05, f.z)              # 콧등
            d -= 0.4 * fr * math.exp(-((f.z + 0.36 + 0.08 * math.cos(f.x * 3)) / 0.09) ** 2) * smooth(1.0, 0.5, abs(f.x))  # 입(갈라진 틈)
            for sg in (-1, 1):
                for kf in range(3): d -= 0.08 * fr * math.exp(-((f.x - sg * (0.75 + 0.12 * kf) - 0.25 * sg * f.z) / 0.05) ** 2) * smooth(0.3, -0.2, f.z)   # 뺨 주름
            d += 0.05 * noise.noise(c * 6.0) * fr
        q = c - HEART; rxz = math.hypot(q.x, q.z)
        if rxz < 2.0 and q.y > -1.6: d -= max(0.0, (c.y - (HEART.y - 0.9 + 0.55 * (rxz / 2.0) ** 2)) * 0.9) * (1 - rxz / 2.0) ** 0.5
        return d
    displace(body, carve)

    def golem_color(c, nr):
        base = V((0.55, 0.52, 0.48)) * (0.8 + 0.3 * noise.noise(c * 0.35)) + V((0.06, 0.04, 0.0)) * noise.noise(c * 1.4)
        dist, pts = noise.voronoi(c * 0.28, distance_metric='DISTANCE'); e = dist[1] - dist[0]
        if e < 0.12: base = base * (0.35 + 0.65 * e / 0.12)
        # 이끼: 윗면 + 노이즈
        moss = smooth(0.25, 0.7, nr.z) * smooth(-0.1, 0.35, noise.fractal(c * 0.45, 0.8, 2.0, 3))
        base = base.lerp(V((0.16, 0.27, 0.08)) * (0.8 + 0.4 * noise.noise(c * 2.5)), min(0.92, moss))
        # 물때·녹 자국: 아래로 흐른 줄
        streak = noise.noise(V((c.x * 1.6, c.y * 1.6, c.z * 0.15)))
        if streak > 0.4 and nr.z < 0.3: base = base.lerp(V((0.3, 0.22, 0.14)), (streak - 0.4) * 0.8)
        # 심장 둘레는 그을음 + 달아오름
        hd = (c - HEART).length
        if hd < 4.0: base = base.lerp(V((0.12, 0.07, 0.05)), 0.5 * (1 - hd / 4.0))
        return (base.x, base.y, base.z)

    def lava_faces(o, li):
        me = o.data
        if len(me.materials) < 2: me.materials.append(m_lava)
        idx = []
        for p in me.polygons:
            c = p.center; hd = (c - HEART).length
            dist, pts = noise.voronoi(c * 0.28, distance_metric='DISTANCE'); e = dist[1] - dist[0]
            if (hd < 5.5 and e < 0.022 * (1.6 - hd / 5.5)) or (hd < 1.7 and c.y < HEART.y + 0.1): p.material_index = 1
            elif c.y > 3.6 and abs(c.z - 11.62) < 0.07 and abs(c.x) < 0.6: p.material_index = 1      # 입 틈 안쪽이 달아오름
        me.update()

    def extras_for(li):
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2 if li == 0 else 1, radius=1.05, matrix=Matrix.Translation(HEART + V((0, -0.2, 0))))
        for v in bm.verts: v.co = HEART + (v.co - HEART) * (0.85 + 0.3 * random.random())   # 깎인 수정 같은 각
        if li == 0:   # 심장 둘레 수정 결정(빛나는 가시)
            r3 = random.Random(5)
            for k in range(14):
                d = V((r3.uniform(-1, 1), r3.uniform(0.1, 1.0), r3.uniform(-1, 1))).normalized()
                cone(bm, HEART + d * 0.7, HEART + d * r3.uniform(1.5, 2.1), r3.uniform(0.12, 0.22), sides=5, rings=2)
        core = obj_from_bm(f'golem_core{li}', bm); set_material(core, m_core)
        bm = bmesh.new()
        for sg in (-1, 1): ell(bm, (sg * 0.55, 3.86, 12.42), (0.3, 0.12, 0.13), seg=(14, 8) if li == 0 else (10, 6))
        if li == 0:   # 이마의 빛나는 룬 홈(세 줄) — 눈과 같은 빛
            for pts in (((-0.6, 4.06, 13.08), (-0.2, 4.12, 13.25), (0.2, 4.12, 13.25), (0.6, 4.06, 13.08)), ((0, 4.12, 13.3), (0, 4.08, 13.6)), ((-0.25, 4.08, 13.5), (0.25, 4.08, 13.5))):
                tube(bm, pts, [0.05] * len(pts), step=0.5, seg=(8, 6))
        eye = obj_from_bm(f'golem_eye{li}', bm); set_material(eye, m_eye)
        # 심장을 감싼 바위 갈비(우리처럼 빛이 틈으로 새어 나온다)
        bm = bmesh.new()
        for zz in ((HEART.z - 1.0, HEART.z, HEART.z + 1.0) if li == 0 else (HEART.z - 0.8, HEART.z + 0.8)):
            tube(bm, [(-1.9, HEART.y - 0.6, zz - 0.15), (-1.0, HEART.y + 0.55, zz), (0.0, HEART.y + 0.75, zz + 0.05), (1.0, HEART.y + 0.55, zz), (1.9, HEART.y - 0.6, zz - 0.15)],
                 [0.3, 0.2, 0.17, 0.2, 0.3], step=0.9, seg=(9, 6) if li == 0 else (6, 4))
        ribs = obj_from_bm(f'golem_ribs{li}', bm); set_material(ribs, m_rock)
        bm = bmesh.new(); r3 = random.Random(17)
        for k in range(11 if li == 0 else 5):
            x = -0.8 + 1.6 * k / (10 if li == 0 else 4); up = k % 2 == 0
            b0 = V((x, 3.98 - 0.15 * abs(x), 11.98 if up else 11.8))
            cone(bm, b0, b0 + V((r3.uniform(-0.04, 0.04), 0.05, -0.2 if up else 0.2)) * r3.uniform(0.9, 1.5), r3.uniform(0.07, 0.11), sides=4, rings=1)
        tth = obj_from_bm(f'golem_teeth{li}', bm); set_material(tth, m_rock)
        # 등·어깨에 튀어나온 바위 결정
        bm = bmesh.new(); r2 = random.Random(9)
        for k in range(18 if li == 0 else 8):
            sg = r2.choice((-1, 1)); base = V((sg * r2.uniform(0.5, 5.6), r2.uniform(-2.6, 0.2), r2.uniform(11.2, 13.4)))
            tip = base + V((sg * r2.uniform(0.2, 1.4), r2.uniform(-1.8, -0.4), r2.uniform(1.2, 2.8)))
            cone(bm, base, tip, r2.uniform(0.35, 0.7), sides=5, rings=2)
        sh = obj_from_bm(f'golem_shards{li}', bm); set_material(sh, m_rock)
        # 이끼 덩이: 윗면(어깨·머리·팔 윗면·등)에 납작한 방석 + 어깨에서 늘어진 이끼 가닥
        bm = bmesh.new(); r4 = random.Random(17)
        for (pp, nn) in (moss_spots if li == 0 else moss_spots[::4]):
            s_ = r4.uniform(0.35, 0.8)
            ell(bm, pp + nn * 0.04, (s_ * r4.uniform(1.0, 1.8), s_ * 0.26, s_ * r4.uniform(1.0, 1.8)), basis_from(nn), seg=(9, 5) if li == 0 else (6, 3))   # 법선 쪽으로 납작
        if li == 0:
            for k in range(22):
                sg = r4.choice((-1, 1)); a0 = V((sg * r4.uniform(3.6, 6.4), r4.uniform(-0.6, 1.8), r4.uniform(12.0, 13.2)))
                L = r4.uniform(1.0, 2.6)
                tube(bm, [a0, a0 + V((r4.uniform(-0.2, 0.2), r4.uniform(0.0, 0.3), -L * 0.5)), a0 + V((r4.uniform(-0.3, 0.3), r4.uniform(0.0, 0.4), -L))], [0.12, 0.08, 0.03], step=0.7, seg=(6, 4))
        moss = obj_from_bm(f'golem_moss{li}', bm); set_material(moss, m_moss); shade_smooth(moss.data)
        set_colors(moss.data, lambda c, nr: (lambda v: (0.75 + 0.25 * v, 0.8 + 0.2 * v, 0.7 + 0.2 * v))(noise.noise(c * 1.3)))
        return [(core, 'spine'), (eye, 'head'), (sh, 'spine'), (ribs, 'spine'), (tth, 'head'), (moss, tuple(b[0] for b in GOLEM_BONES))]

    # 이끼 놓을 자리: 고해상 몸 표면에서 위를 보는 곳(얼굴·심장 앞은 피한다)
    co_ = verts_np(body.data); nr_ = normals_np(body.data); rs = np.random.default_rng(12)
    cand = [i for i in rs.permutation(len(co_))[:20000] if nr_[i][2] > 0.55 and noise.fractal(V(co_[i]) * 0.45, 0.8, 2.0, 3) > 0.05
            and not (co_[i][1] > 2.4 and co_[i][2] < 13.4 and abs(co_[i][0]) < 2.2)]
    moss_spots = [(V(co_[i]), V(nr_[i])) for i in cand[:160]]
    lods = finish_lods('Golem', body, [extras_for(0), extras_for(1)], arm, GOLEM_BONES, [80000, 12000], 0.3, golem_color, m_rock, post_lod=lava_faces)
    finalize(arm, lods, out, 'golem.glb', prev, 'golem', [((14, 26, 11), (0, 0, 8)), ((-6, 9, 11), (0, 3, 10.5)), ((0.8, 7.2, 13.0), (0, 3.0, 12.1))])

# ======================================================================================================================
# 3) 초거대 반천사·반악마 — 키 약 15 m, 날개폭 약 34 m. 왼쪽 깃털 날개 · 오른쪽 박쥐 날개, 후광(오른쪽은 깨짐) · 뿔, 갑옷(왼 금빛 · 오른 검은 쇠).
# ======================================================================================================================
SERAPH_BONES = [
    ('hips', (0, 0, 6.6), (0, 0, 8.5), None),
    ('chest', (0, 0, 8.5), (0, 0.1, 12.0), 'hips'),
    ('head', (0, 0.1, 12.3), (0, 0.3, 14.4), 'chest'),
    ('armL', (-3.0, 0, 11.4), (-3.9, 0.6, 8.8), 'chest'), ('foreL', (-3.9, 0.6, 8.8), (-4.2, 1.6, 6.4), 'armL'),
    ('armR', (3.0, 0, 11.4), (3.9, 0.6, 8.8), 'chest'), ('foreR', (3.9, 0.6, 8.8), (4.2, 1.6, 6.4), 'armR'),
    ('wingL1', (-1.2, -1.1, 11.4), (-7.0, -2.0, 14.5), 'chest'), ('wingL2', (-7.0, -2.0, 14.5), (-15.5, -2.8, 12.6), 'wingL1'),
    ('wingR1', (1.2, -1.1, 11.4), (7.0, -2.0, 14.5), 'chest'), ('wingR2', (7.0, -2.0, 14.5), (10.5, -2.6, 15.4), 'wingR1'),
    ('thighL', (-1.1, 0, 7.0), (-1.3, 0.5, 3.8), 'hips'), ('shinL', (-1.3, 0.5, 3.8), (-1.35, -0.3, 0.8), 'thighL'),
    ('thighR', (1.1, 0, 7.0), (1.3, 0.5, 3.8), 'hips'), ('shinR', (1.3, 0.5, 3.8), (1.35, -0.3, 0.8), 'thighR'),
]
FINGERS = [V((17.5, -3.0, 15.2)), V((16.4, -3.2, 10.6)), V((12.6, -3.0, 6.6)), V((8.0, -2.5, 6.0))]
WRIST_R = V((10.5, -2.6, 15.4))

def build_seraph(out, prev):
    reset_scene()
    n = 1024
    g = tex_fbm(n, 1.0, 31); lump = tex_fbm(n, 1.9, 32)
    # 긁힌 자국(갑옷) — 짧은 직선 무작위
    scr = np.zeros((n, n)); rng = np.random.default_rng(33)
    for _ in range(900):
        x0, y0 = rng.integers(0, n, 2); ang = rng.random() * math.pi; L = rng.integers(10, 70)
        for t in range(L):
            x = int(x0 + math.cos(ang) * t) % n; y = int(y0 + math.sin(ang) * t) % n; scr[y, x] = 1
    F1, F2 = tex_cells(n, 260, 34)
    vein = np.clip(1 - (F2 - F1) * 70, 0, 1) ** 2
    h = lump * 0.5 + g * 0.2 - scr * 0.25 - vein * 0.25
    alb = (0.85 + 0.15 * g - 0.12 * scr - 0.18 * vein)[..., None] * np.array([1, 1, 1])
    A = make_image('seraph_albedo', alb); N = make_image('seraph_normal', height_to_normal(h, 5.0), True)
    # 깃털 텍스처(가운데 깃대 + 비스듬한 깃가지)
    # 깃털 1024: 깃대 + 촘촘한 깃가지(비스듬) + 깃가지 사이 갈라짐 + 끝 쪽 솜털, 가장자리 투명감(어둡게)
    fk = 1024; yy, xx = np.mgrid[0:fk, 0:fk] / fk
    ax = np.abs(xx - 0.5)
    split = tex_fbm(fk, 1.4, 35, lo=3, hi=30)
    barb = 0.5 + 0.5 * np.sin((yy * 240 + ax * 150 + split * 9) * math.pi * 2)
    gap = (np.sin((yy * 9 + ax * 6 + split * 3) * math.pi * 2) > 0.93).astype(float)
    rach = np.exp(-((xx - 0.5) / 0.008) ** 2)
    down = smooth_np = np.clip((0.12 - yy) / 0.12, 0, 1)
    fh = barb * 0.35 + rach * 0.9 - gap * 0.5 + down * tex_fbm(fk, 0.4, 36) * 0.4
    falb = np.clip(0.9 + 0.08 * barb - 0.3 * gap - 0.3 * (ax > 0.46) - 0.12 * ax + 0.05 * rach, 0, 1)[..., None] * np.array([1, 0.985, 0.95])
    FA = make_image('feather_albedo', falb); FN = make_image('feather_normal', height_to_normal(fh, 5.0), True)
    # 갑옷 문양 1024: 덩굴 소용돌이(아라베스크) 음각 + 테두리 띠 + 긁힘
    ak = 1024; ay, axx = np.mgrid[0:ak, 0:ak] / ak * math.pi * 2
    swirl = np.sin(axx * 6 + 2.2 * np.sin(ay * 6)) * np.sin(ay * 6 + 2.2 * np.sin(axx * 6))
    eng = np.exp(-(swirl / 0.09) ** 2) + np.exp(-((np.sin(ay * 3) - 0.97) / 0.02) ** 2) * 0.8
    scr2 = scr[:ak, :ak] if scr.shape[0] >= ak else np.tile(scr, (2, 2))[:ak, :ak]
    ah = lump[:ak, :ak] * 0.3 - eng * 0.6 - scr2 * 0.2
    aalb = (0.92 + 0.08 * g[:ak, :ak] - 0.45 * eng - 0.1 * scr2)[..., None] * np.array([1, 1, 1])
    AA = make_image('armor_albedo', aalb); AN = make_image('armor_normal', height_to_normal(ah, 7.0), True)
    # 악마 비늘 1024: 겹친 비늘(Voronoi) — 가운데 볼록 · 테두리 홈 · 끝이 밝은 각질
    S1, S2 = tex_cells(1024, 900, 37)
    sc_h = np.clip(1 - S1 * 38, 0, 1) ** 0.7 - np.clip(1 - (S2 - S1) * 160, 0, 1) * 0.6
    sc_alb = np.stack([0.32 + 0.25 * sc_h, 0.07 + 0.05 * sc_h, 0.06 + 0.04 * sc_h], -1) * (0.85 + 0.2 * tex_fbm(1024, 1.0, 38))[..., None]
    SA = make_image('scale_albedo', sc_alb); SN = make_image('scale_normal', height_to_normal(sc_h, 9.0), True)
    m_skin = material('seraph_skin', rough=0.55, albedo=A, normal=N, nstrength=0.8)
    m_gold = material('armor_gold', base=(0.95, 0.78, 0.42), rough=0.3, metal=0.85, albedo=AA, normal=AN, nstrength=1.5)
    m_iron = material('armor_iron', base=(0.16, 0.15, 0.16), rough=0.42, metal=0.8, albedo=AA, normal=AN, nstrength=1.5)
    m_scale = material('demon_scale', base=(1, 1, 1), rough=0.38, albedo=SA, normal=SN, nstrength=1.6)
    m_tooth = material('seraph_teeth', base=(0.9, 0.86, 0.74), rough=0.25)
    m_sclera = material('seraph_sclera', base=(0.85, 0.8, 0.74), rough=0.15)
    m_feather = material('feather', base=(1, 1, 1), rough=0.7, albedo=FA, normal=FN, nstrength=0.8, double=True)
    m_mem = material('membrane', base=(0.3, 0.06, 0.06), rough=0.6, albedo=A, normal=N, nstrength=1.0, emit=(0.35, 0.03, 0.0), emit_k=0.25, double=True)
    m_bone = material('horn', base=(0.08, 0.06, 0.06), rough=0.35, albedo=A, normal=N, nstrength=1.2)
    m_halo = material('halo', base=(1.0, 0.86, 0.5), rough=0.3, emit=(1.0, 0.85, 0.45), emit_k=5.0)
    m_eyeL = material('eye_holy', base=(1, 0.95, 0.8), emit=(1, 0.92, 0.7), emit_k=8.0)
    m_eyeR = material('eye_hell', base=(1, 0.2, 0.05), emit=(1, 0.18, 0.03), emit_k=8.0)
    m_ember = material('ember', base=(1, 0.3, 0.05), emit=(1, 0.32, 0.05), emit_k=3.5)
    arm = make_armature('Seraph', SERAPH_BONES)

    bm = bmesh.new()
    ell(bm, (0, 0, 7.1), (1.95, 1.35, 1.3)); ell(bm, (0, 0.05, 8.7), (1.55, 1.1, 1.3)); ell(bm, (0, 0.1, 10.6), (2.6, 1.6, 1.75))
    ell(bm, (0, 0.2, 12.15), (0.72, 0.7, 0.8)); ell(bm, (0, 0.35, 13.45), (0.85, 1.0, 1.1)); ell(bm, (0, 0.95, 13.05), (0.55, 0.45, 0.5))   # 목 · 머리 · 턱
    for sg in (-1, 1):
        ell(bm, (sg * 2.85, 0, 11.6), (1.05, 1.0, 1.0))
        tube(bm, [(sg * 3.1, 0, 11.3), (sg * 3.9, 0.6, 8.8)], [0.78, 0.6])
        tube(bm, [(sg * 3.9, 0.6, 8.8), (sg * 4.2, 1.6, 6.6)], [0.62, 0.45])
        ell(bm, (sg * 4.25, 1.9, 6.1), (0.42, 0.32, 0.58))
        tube(bm, [(sg * 1.1, 0, 7.0), (sg * 1.3, 0.5, 3.8)], [1.0, 0.75])
        tube(bm, [(sg * 1.3, 0.5, 3.8), (sg * 1.35, -0.3, 0.9)], [0.75, 0.5])
        ell(bm, (sg * 1.35, 0.25, 0.55), (0.45, 0.9, 0.35))
        # 날개 팔(뼈대 위 살)
        tube(bm, [(sg * 1.2, -1.1, 11.4), (sg * 7.0, -2.0, 14.5)], [0.6, 0.38])
    tube(bm, [V((-7.0, -2.0, 14.5)), V((-15.5, -2.8, 12.6))], [0.38, 0.18])
    tube(bm, [WRIST_R + V((-3.5, 0.6, -0.9)), WRIST_R], [0.38, 0.3])
    for f in FINGERS: tube(bm, [WRIST_R, f], [0.24, 0.07], step=0.6, seg=(10, 8))
    body = obj_from_bm('seraph_body', bm)
    remesh(body, 0.045, 0.5, 4)
    def carve(c, nr):
        d = 0.02 * noise.noise(c * 2.2)
        if c.x > 0.15:   # 악마 쪽: 갈라진 피부 · 힘줄
            dist, pts = noise.voronoi(c * 0.9, distance_metric='DISTANCE'); e = dist[1] - dist[0]
            if e < 0.08: d -= 0.05 * (1 - e / 0.08)
            d += 0.04 * noise.ridged_multi_fractal(c * 0.7, 0.9, 2.0, 3, 1.0, 2.0) * 0.3
        # 복근 · 가슴 근육 굴곡
        if 8.0 < c.z < 11.8 and c.y > 0.6: d += 0.06 * math.cos(c.x * 2.6) * math.cos((c.z - 8) * 2.4) * smooth(0.6, 1.2, c.y)
        # 얼굴: 눈썹 뼈 · 깊은 눈두덩 · 콧날 · 광대 · 입술 · 이마 주름(악마 쪽은 찡그린 주름이 깊다)
        f = c - V((0, 0.35, 13.45))
        if f.y > 0.35 and f.length < 1.5:
            fr = smooth(0.35, 0.85, f.y); dem = 1.0 + 0.8 * smooth(-0.05, 0.1, f.x)
            d += 0.09 * fr * math.exp(-((f.z - 0.32) / 0.07) ** 2) * smooth(0.65, 0.2, abs(f.x)) * dem          # 눈썹 뼈
            for sg in (-1, 1): d -= 0.08 * fr * math.exp(-(((f.x - sg * 0.33) / 0.15) ** 2 + ((f.z - 0.15) / 0.1) ** 2))   # 눈두덩
            d += 0.11 * fr * math.exp(-((f.x / 0.07) ** 2)) * smooth(0.25, 0.05, f.z) * smooth(-0.22, -0.05, f.z)          # 콧날
            d += 0.06 * fr * math.exp(-((f.x / 0.12) ** 2 + ((f.z + 0.2) / 0.06) ** 2))                                  # 콧망울
            for sg in (-1, 1): d += 0.06 * fr * math.exp(-(((f.x - sg * 0.48) / 0.14) ** 2 + ((f.z + 0.05) / 0.12) ** 2))   # 광대
            d += 0.04 * fr * math.exp(-((f.z + 0.36) / 0.035) ** 2) * smooth(0.25, 0.1, abs(f.x))                         # 윗입술
            d -= 0.05 * fr * math.exp(-((f.z + 0.42) / 0.018) ** 2) * smooth(0.24, 0.12, abs(f.x))                        # 입술 사이 선
            d += 0.035 * fr * math.exp(-((f.z + 0.48) / 0.035) ** 2) * smooth(0.22, 0.08, abs(f.x))                       # 아랫입술
            for kf in range(3): d -= 0.018 * fr * dem * math.exp(-((f.z - 0.48 - 0.07 * kf - 0.03 * math.cos(f.x * 5)) / 0.012) ** 2) * smooth(0.5, 0.2, abs(f.x))   # 이마 주름
            for sg in (-1, 1): d -= 0.02 * fr * dem * math.exp(-((f.x - sg * (0.17 + 0.25 * (-0.15 - f.z))) / 0.015) ** 2) * smooth(0.0, -0.1, f.z) * smooth(-0.45, -0.3, f.z)   # 팔자 주름
        return d
    displace(body, carve)
    def skin_col(c, nr):
        edge = 0.3 * noise.noise(V((c.y * 0.6, c.z * 0.6, 0.0))) + 0.1 * math.sin(c.z * 3.0)
        k = smooth(-0.15, 0.15, c.x + edge)
        holy = V((0.88, 0.84, 0.78)) * (0.9 + 0.1 * noise.noise(c * 1.5))
        dist, pts = noise.voronoi(c * 0.9, distance_metric='DISTANCE'); e = dist[1] - dist[0]
        hell = V((0.2, 0.05, 0.045)) * (0.8 + 0.3 * noise.noise(c * 1.2))
        if e < 0.05: hell = V((0.55, 0.12, 0.02))
        if c.x < 0 and noise.noise(c * 1.1) > 0.5: holy = holy * 0.85 + V((0.1, 0.1, 0.12))   # 대리석 결
        col = holy.lerp(hell, k)
        return (col.x, col.y, col.z)

    def armor(li):
        parts = []
        for side, mat in ((-1, m_gold), (1, m_iron)):
            bm = bmesh.new(); seg = (24, 14) if li == 0 else (12, 8)
            # 가슴판(반쪽씩) — 겹친 판 세 장
            for k, (z, s) in enumerate(((11.0, 1.0), (10.1, 0.92), (9.2, 0.8))):
                ell(bm, (side * 1.1, 0.95 - k * 0.08, z), (1.45 * s, 0.75, 0.62), seg=seg)
            # 어깨 갑옷: 겹친 판 3장
            for k in range(3):
                ell(bm, (side * (3.0 + k * 0.15), 0.0, 12.0 - k * 0.48), (1.35 - k * 0.12, 1.25 - k * 0.1, 0.55), seg=seg)
            # 팔뚝 · 정강이 보호대
            tube(bm, [(side * 3.95, 0.7, 8.6), (side * 4.18, 1.5, 6.9)], [0.72, 0.58], seg=(16, 10) if li == 0 else (10, 6))
            tube(bm, [(side * 1.32, 0.55, 3.6), (side * 1.36, -0.1, 1.3)], [0.86, 0.62], seg=(16, 10) if li == 0 else (10, 6))
            ell(bm, (side * 1.3, 0.85, 3.85), (0.7, 0.55, 0.62), seg=seg)  # 무릎 갑옷
            # 허리 아래 tasset 판
            for k in range(3):
                a = (k - 1) * 0.5; ell(bm, (side * (0.7 + k * 0.55), 1.0 - k * 0.35, 6.3), (0.62, 0.22, 0.9), basis_from(V((math.sin(a) * side, math.cos(a), 0))), seg=seg)
            o = obj_from_bm(f'armor{side}_{li}', bm); set_material(o, mat); solid(o, 0.05, [9000, 1800][li], 2)
            parts.append((o, ('chest', 'hips', 'armL', 'armR', 'foreL', 'foreR', 'thighL', 'thighR', 'shinL', 'shinR')))
        # 악마 쪽 갑옷 이음매의 불씨
        bm = bmesh.new()
        for z in (10.55, 9.65): tube(bm, [(0.3, 1.55, z), (2.3, 1.05, z - 0.1)], [0.06, 0.05], seg=(8, 6))
        o = obj_from_bm(f'ember{li}', bm); set_material(o, m_ember); solid(o, 0.03, 600, 1); parts.append((o, 'chest'))
        return parts

    def head_bits(li):
        parts = []
        # 후광: 고리 + 빛살, 오른쪽 1/4 은 깨져 없음
        bm = bmesh.new(); cen = V((0, -0.95, 14.3)); R0 = 1.75
        for i in range(64 if li == 0 else 32):
            a = i / (64 if li == 0 else 32) * 2 * math.pi
            if 0.2 < a < 1.05: continue   # 깨진 자리(오른쪽 위)
            p = cen + V((math.cos(a) * R0, 0, math.sin(a) * R0))
            ell(bm, p, (0.12, 0.12, 0.12), seg=(8, 6))
            if i % 4 == 0: cone(bm, p, cen + V((math.cos(a) * (R0 + 0.75), 0, math.sin(a) * (R0 + 0.75))), 0.07, sides=4, rings=1)
        o = obj_from_bm(f'halo{li}', bm); set_material(o, m_halo); solid(o, 0.035, [4000, 900][li], 2); parts.append((o, 'head'))
        # 뿔: 오른쪽 큰 숫양 뿔(뒤로 말림) · 왼쪽 부러진 짧은 뿔
        bm = bmesh.new()
        pts = [V((0.5, 0.35, 14.1))]
        for k in range(1, 9):
            t = k / 8; a = t * 3.6
            pts.append(V((0.5 + 0.55 * t + 0.3 * math.sin(a), 0.35 - 1.1 * math.sin(a) * 0.8, 14.1 + 1.1 * (1 - math.cos(a)) * 0.9 + 0.4 * t)))
        for k in range(len(pts) - 1):
            r0 = 0.36 * (1 - k / 8) + 0.03; r1 = 0.36 * (1 - (k + 1) / 8) + 0.03
            tube(bm, [pts[k], pts[k + 1]], [r0, r1], step=0.5, seg=(10, 8))
        cone(bm, V((-0.5, 0.35, 14.1)), V((-0.85, 0.0, 14.75)), 0.26, sides=7, rings=3)
        # 악마 손톱
        for f in range(4): cone(bm, V((4.25 + 0.12 * (f - 1.5), 2.15, 5.7)), V((4.3 + 0.15 * (f - 1.5), 2.6, 5.0)), 0.07, sides=4, rings=2, bend=V((0, 0.2, 0)))
        o = obj_from_bm(f'horn{li}', bm); set_material(o, m_bone); solid(o, 0.03, [3500, 800][li], 2); parts.append((o, ('head', 'foreR')))
        sq = (16, 10) if li == 0 else (8, 6)
        bm = bmesh.new()
        for sg in (-1, 1): ell(bm, (sg * 0.33, 1.13, 13.6), (0.13, 0.07, 0.085), seg=sq)    # 흰자(눈두덩 안에 박힘)
        osc = obj_from_bm(f'sclera{li}', bm); set_material(osc, m_sclera); parts.append((osc, 'head'))
        bm = bmesh.new(); ell(bm, (-0.33, 1.2, 13.6), (0.065, 0.02, 0.065), seg=sq); oL = obj_from_bm(f'eyeL{li}', bm); set_material(oL, m_eyeL); parts.append((oL, 'head'))   # 빛나는 금빛 홍채
        bm = bmesh.new(); ell(bm, (0.33, 1.2, 13.6), (0.07, 0.02, 0.07), seg=sq)
        oR = obj_from_bm(f'eyeR{li}', bm); set_material(oR, m_eyeR); parts.append((oR, 'head'))
        bm = bmesh.new(); ell(bm, (0.33, 1.222, 13.6), (0.013, 0.01, 0.055), seg=(8, 6)); ell(bm, (-0.33, 1.222, 13.6), (0.025, 0.01, 0.025), seg=(8, 6))
        op = obj_from_bm(f'pupil{li}', bm); set_material(op, m_bone); parts.append((op, 'head'))   # 오른눈 세로 동공(악마) · 왼눈 둥근 동공
        # 악마 쪽 입가: 드러난 송곳니 두 개 + 작은 이 줄
        bm = bmesh.new()
        for (x, L) in ((0.1, 0.16), (0.2, 0.13)): cone(bm, V((x, 1.3, 13.02)), V((x + 0.01, 1.33, 12.86 - L * 0.3)), 0.035, sides=6, rings=3)
        for k in range(6): x = -0.15 + 0.05 * k; ell(bm, (x, 1.31, 13.03), (0.022, 0.012, 0.03), seg=(6, 4))
        ot = obj_from_bm(f'fang{li}', bm); set_material(ot, m_tooth); parts.append((ot, 'head'))
        return parts

    def feather_wing(li):
        bm = bmesh.new(); uvs = []
        sh, el, tip = V((-1.2, -1.1, 11.4)), V((-7.0, -2.0, 14.5)), V((-15.5, -2.8, 12.6))
        rows = [(16, 6.4, 4.0, 1.0, 0.0), (18, 5.0, 3.4, 0.75, 0.08), (20, 3.6, 2.4, 0.5, 0.16), (24, 2.4, 1.6, 0.25, 0.24), (28, 1.4, 1.0, 0.1, 0.32), (32, 0.8, 0.6, 0.0, 0.4)] if li == 0 else [(9, 6.4, 4.0, 1.0, 0.0), (10, 3.6, 2.5, 0.4, 0.15), (12, 1.8, 1.2, 0.0, 0.3)]
        def wing_pt(t):   # 어깨(0) → 팔꿈치(0.45) → 끝(1)
            return sh.lerp(el, t / 0.45) if t < 0.45 else el.lerp(tip, (t - 0.45) / 0.55)
        fid = 0
        for (cnt, Lmax, Lmin, spread, back) in rows:
            for i in range(cnt):
                t = 0.06 + 0.94 * i / (cnt - 1)
                p = wing_pt(t) + V((0, -0.12 - back, -back * 0.6))
                L = lerp(Lmin, Lmax, t) * (1.0 if spread > 0.9 else 1.0)
                # 깃털은 아래로, 끝으로 갈수록 바깥으로 벌어진다
                dirv = V((-0.15 - spread * 0.85 * t * t, -0.25, -1.0)).normalized()
                w = 0.32 + 0.22 * (L / Lmax)
                R = basis_from(dirv, up=V((0, 1, 0)))
                c = p + dirv * (L * 0.5)
                verts = []
                nu, nv = 5, 9
                for jv in range(nv + 1):
                    v = jv / nv
                    for iu in range(nu + 1):
                        u = iu / nu
                        wid = w * math.sin(math.pi * max(0.02, min(0.98, v * 0.92 + 0.04))) ** 0.6
                        q = R @ V(((u - 0.5) * 2 * wid, (v - 0.5) * L, 0.06 * math.sin(math.pi * u) - 0.25 * v * v * spread * 0.3))
                        verts.append(bm.verts.new(c + q)); uvs.append((u, v))
                for jv in range(nv):
                    for iu in range(nu):
                        a = jv * (nu + 1) + iu
                        bm.faces.new((verts[a], verts[a + 1], verts[a + nu + 2], verts[a + nu + 1]))
                fid += 1
        o = obj_from_bm(f'featherwing{li}', bm)
        me = o.data; uvl = me.uv_layers.new(name='UVMap'); co_uv = np.array(uvs, dtype=np.float32)
        loops_uv = np.zeros(len(me.loops) * 2, dtype=np.float32)
        for li_, lp in enumerate(me.loops): loops_uv[li_ * 2:li_ * 2 + 2] = co_uv[lp.vertex_index]
        uvl.data.foreach_set('uv', loops_uv)
        set_colors(me, lambda c, nr: (lambda k: (k, k, k * 0.97))(0.8 + 0.2 * smooth(13.0, 9.0, c.z)))   # 끝은 살짝 회색
        set_material(o, m_feather); shade_smooth(me)
        return (o, ('wingL1', 'wingL2', 'chest'))

    def bat_membrane(li):
        bm = bmesh.new()
        anchors = [WRIST_R + V((-3.5, 0.6, -0.9))] + FINGERS + [V((1.7, -1.0, 7.6))]
        # 손목 → 각 손가락 끝 사이를 부채꼴로: 패널마다 격자(가운데가 처지고 뒤 가장자리는 오목)
        pts_chain = [WRIST_R + V((-3.5, 0.6, -0.9))] + FINGERS + [V((1.7, -1.0, 7.6))]
        nr_, nt_ = (10, 8) if li == 0 else (5, 4)
        for k in range(len(FINGERS)):
            A0 = FINGERS[k] if k < len(FINGERS) else None
        lines = [(WRIST_R, FINGERS[0]), (WRIST_R, FINGERS[1]), (WRIST_R, FINGERS[2]), (WRIST_R, FINGERS[3]), (V((2.0, -1.1, 11.0)), V((1.7, -1.0, 7.6)))]
        for k in range(len(lines) - 1):
            (a0, a1), (b0, b1) = lines[k], lines[k + 1]
            grid = []
            for j in range(nt_ + 1):
                t = j / nt_; row = []
                for i in range(nr_ + 1):
                    s = i / nr_
                    pa = a0.lerp(a1, t); pb = b0.lerp(b1, t)
                    p = pa.lerp(pb, s)
                    sag = 0.9 * math.sin(math.pi * s) * (0.4 + t)          # 뒤로 처짐(바람 받는 막)
                    scallop = 1.2 * math.sin(math.pi * s) * t ** 3           # 뒤 가장자리 오목
                    p = p + V((0, -sag, 0)) + (p - (a0.lerp(b0, s))).normalized() * (-scallop)
                    row.append(bm.verts.new(p))
                grid.append(row)
            for j in range(nt_):
                for i in range(nr_):
                    bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
        o = obj_from_bm(f'membrane{li}', bm); set_material(o, m_mem); shade_smooth(o.data)
        set_colors(o.data, lambda c, nr: (lambda v: (0.75 + 0.25 * v, 0.7 + 0.2 * v, 0.7 + 0.2 * v))(noise.noise(c * 0.8)))
        return (o, ('wingR1', 'wingR2', 'chest'))

    extras = []
    for li in range(2):
        extras.append(armor(li) + head_bits(li) + [feather_wing(li), bat_membrane(li)])
    def scale_faces(o, li):   # 악마 쪽(오른쪽) 피부 · 날개 팔은 비늘 재질
        me = o.data
        if len(me.materials) < 2: me.materials.append(m_scale)
        for p in me.polygons:
            c = p.center
            if c.x + 0.25 * noise.noise(V((c.y * 0.6, c.z * 0.6, 0.0))) > 0.2 and not (c.z > 12.6 and c.y > 0.6 and c.x < 0.75): p.material_index = 1
        me.update()
    lods = finish_lods('Seraph', body, extras, arm, SERAPH_BONES, [56000, 8000], 0.5, skin_col, m_skin, post_lod=scale_faces)
    finalize(arm, lods, out, 'seraph.glb', prev, 'seraph', [((6, 34, 10), (0, 0, 9.5)), ((-14, 22, 13), (-4, 0, 11)), ((0.6, 5.2, 13.55), (0, 0.6, 13.45))])

# ----------------------------------------------------------------------------------------------------------------------
def finalize(arm, lods, out, fname, prev, tag, shots):
    os.makedirs(out, exist_ok=True)
    export(os.path.join(out, fname), [arm] + lods)
    if prev:
        for m in bpy.data.materials:   # 미리보기 전용: 꼭짓점 색 × 텍스처 (three.js 가 glb 에서 하는 것과 같게)
            if not m.node_tree: continue
            nt = m.node_tree; bs = nt.nodes.get('Principled BSDF')
            if not bs: continue
            ca = nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name = 'Col'
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs['Factor'].default_value = 1.0
            src = bs.inputs['Base Color'].links[0].from_socket if bs.inputs['Base Color'].links else None
            if src: nt.links.new(src, mix.inputs[6])
            else: mix.inputs[6].default_value = bs.inputs['Base Color'].default_value
            nt.links.new(ca.outputs['Color'], mix.inputs[7]); nt.links.new(mix.outputs[2], bs.inputs['Base Color'])
        render(prev, tag, shots, [lods[0]], lods[1:])

def render(prev, tag, shots, show, hide):
    os.makedirs(prev, exist_ok=True)
    scene = bpy.context.scene
    try: scene.render.engine = 'BLENDER_EEVEE'
    except Exception: scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y = 1000, 700
    scene.render.image_settings.file_format = 'JPEG'
    w = bpy.data.worlds.new('w'); scene.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.03, 0.04, 0.08, 1); bg.inputs[1].default_value = 1.0
    tmp = []
    def light(kind, e, col, loc=None, rot=None):
        o = bpy.data.objects.new('l', bpy.data.lights.new('l', kind)); o.data.energy = e; o.data.color = col
        if loc: o.location = loc
        if rot: o.rotation_euler = rot
        scene.collection.objects.link(o); tmp.append(o)
    light('SUN', 3.5, (0.75, 0.82, 1.0), rot=(math.radians(55), math.radians(15), math.radians(-30)))
    light('SUN', 1.4, (1.0, 0.6, 0.35), rot=(math.radians(70), 0, math.radians(150)))
    for o in hide: o.hide_render = True
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam; tmp.append(cam)
    fl = bpy.data.objects.new('flash', bpy.data.lights.new('flash', 'POINT')); fl.data.energy = 0; scene.collection.objects.link(fl); tmp.append(fl)
    for i, (cp, tp) in enumerate(shots):
        d0 = (V(tp) - V(cp)).length; fl.location = V(cp); fl.data.energy = 40 * d0 * d0; fl.data.shadow_soft_size = 1.0   # 카메라 쪽 보조광(입 속 · 얼굴 근접)
        cam.location = V(cp); d = V(tp) - cam.location; cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = 35
        scene.render.filepath = os.path.join(prev, f'blender_{tag}_{i}.jpg')
        bpy.ops.render.render(write_still=True)
    for o in hide: o.hide_render = False
    for o in tmp: bpy.data.objects.remove(o, do_unlink=True)

if __name__ == '__main__':
    what, out, prev = parse_args()
    B = {'shark': build_shark, 'golem': build_golem, 'seraph': build_seraph}
    for k in (list(B) if what == 'all' else [what]):
        B[k](out, prev)
