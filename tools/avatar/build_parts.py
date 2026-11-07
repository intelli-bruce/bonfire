"""
커스텀 아바타 부품(머리카락·후드·코트·치마·부츠) 절차적 모델링 → bf/kit/assets/custom/parts.glb

실행:  blender -b --factory-startup --python tools/avatar/build_parts.py -- [--out bf/kit/assets/custom/parts.glb] [--preview <폴더>]

- 순수 bpy/bmesh. 외부 에셋·유료 모델 없음. 만든 것은 전부 이 스크립트(= CC0 로 공개 가능한 절차적 모델)입니다.
- 좌표는 Kenney Mini Characters 의 모델 좌표(발=y0, 머리 상자 x±0.16 · y0.34~0.66 · z±0.16, 앞=+Z, T 자세)로 적는다(함수 G 가 Blender 로 변환).
  JS(bf/kit/custom-avatar.js)가 부품의 뼈(머리·몸통·다리)에 맞춰 뼈 좌표로 바꿔 붙인다.
- 색: 재질을 쓰지 않는다. 면마다 UV 를 Kenney colormap(8x4 칸, 아래 두 줄이 팔레트)의 한 칸 오른쪽 그라데이션 열에 찍는다.
  위를 보는 면은 칸의 위쪽(밝게), 아래를 보는 면은 아래쪽(어둡게). 칸 (3,0)=짙은 회색은 JS 가 색을 안 바꾸는 디테일(끈·단추·밑창)이다.
  나머지 색은 게임에서 팔레트 색(머리·상의·하의·신발)으로 칠한다.
- 이름 규칙(= bf/kit/appearance.js 의 PART_BONE/PART_ROLE): hair_* → 머리 뼈, top_*/bottom_* → 몸통 뼈, shoe_boot_L/R → 왼/오른 다리 뼈.
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix

HAIR_CELL = (3, 6)     # (행, 열)
TOP_CELL = (2, 2)
BOTTOM_CELL = (2, 5)
SHOE_CELL = (2, 3)
DARK_CELL = (3, 0)

def G(x, y, z):
    """모델 좌표(x 오른쪽, y 위, z 앞) → Blender(Z 위, -Y 앞)."""
    return Vector((x, -z, y))

CONV = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))   # 모델 → Blender 변환 행렬

def rot_model(rx=0.0, ry=0.0, rz=0.0):
    return (Matrix.Rotation(math.radians(rz), 4, 'Z') @ Matrix.Rotation(math.radians(ry), 4, 'Y') @ Matrix.Rotation(math.radians(rx), 4, 'X'))

class Part:
    def __init__(self, name, cell):
        self.name, self.cell = name, cell
        self.bm = bmesh.new()
        self.layer = self.bm.loops.layers.uv.new('UV')
        self.cl = self.bm.faces.layers.int.new('cell')   # 면마다 팔레트 칸(행*8+열); 레이어는 면을 만들기 전에 만들어 둔다

    def _add(self, bm_tmp, mat, cell, bevel=0.0, smooth=True, taper=None):
        """bm_tmp 의 지오메트리(모델 좌표, 원점 중심)를 mat 로 옮겨 이 파트에 합친다."""
        if taper:   # 위쪽 점들을 (sx, sz) 만큼 줄인다(치마 단면)
            for v in bm_tmp.verts:
                if v.co.y > 0:
                    v.co.x *= taper[0]; v.co.z *= taper[1]
        if bevel > 0:
            bmesh.ops.bevel(bm_tmp, geom=bm_tmp.edges[:], offset=bevel, segments=1, profile=0.6, affect='EDGES')
        bmesh.ops.transform(bm_tmp, matrix=CONV @ mat, verts=bm_tmp.verts)
        bmesh.ops.recalc_face_normals(bm_tmp, faces=bm_tmp.faces)
        mesh = bpy.data.meshes.new('tmp')
        bm_tmp.to_mesh(mesh); bm_tmp.free()
        self.bm.from_mesh(mesh)
        n0 = len(self.bm.faces) - len(mesh.polygons)
        self.bm.faces.ensure_lookup_table()
        for f in self.bm.faces[n0:]:
            f.smooth = smooth
            f[self.cl] = cell[0] * 8 + cell[1]
        bpy.data.meshes.remove(mesh)

    def box(self, c, s, bevel=0.012, rot=(0, 0, 0), cell=None, taper=None):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts: v.co.x *= s[0]; v.co.y *= s[1]; v.co.z *= s[2]
        self._add(bm, Matrix.Translation(Vector(c)) @ rot_model(*rot), cell or self.cell, bevel, taper=taper)

    def ellipsoid(self, c, r, subdiv=2, rot=(0, 0, 0), cell=None):
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
        for v in bm.verts: v.co.x *= r[0]; v.co.y *= r[1]; v.co.z *= r[2]
        self._add(bm, Matrix.Translation(Vector(c)) @ rot_model(*rot), cell or self.cell)

    def cone(self, c, r1, r2, h, verts=5, rot=(0, 0, 0), cell=None):
        """밑면 중심 c, 위로(모델 +Y) 높이 h. r2 = 윗반지름."""
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=r1, radius2=r2, depth=h)
        axis = Matrix.Rotation(math.radians(-90), 4, 'X')   # bmesh 의 +Z 축 → 모델 +Y
        self._add(bm, Matrix.Translation(Vector(c)) @ rot_model(*rot) @ Matrix.Translation(Vector((0, h / 2, 0))) @ axis, cell or self.cell, 0.0)

    def build(self, scene_col):
        bm = self.bm
        cl = self.cl
        uv = self.layer
        for f in bm.faces:
            cy, cx = divmod(f[cl], 8)
            # 모델 좌표 법선: Blender(x, y, z) → 모델(x, z, -y)
            nx, ny, nz = f.normal.x, f.normal.z, -f.normal.y
            fv = 0.5 - 0.4 * ny                       # 위 0.10(밝음) … 아래 0.90(어두움)
            fu = 0.62 + 0.18 * (nx * 0.5 + 0.5)       # 오른쪽 그라데이션 열 안에서 살짝만 흔든다
            u = (cx + fu) / 8.0
            v = 1.0 - (cy + fv) / 4.0                 # Blender UV 는 아래가 0 (glTF 는 위가 0)
            for loop in f.loops:
                loop[uv].uv = (u, v)
        mesh = bpy.data.meshes.new(self.name)
        bm.to_mesh(mesh); bm.free()
        obj = bpy.data.objects.new(self.name, mesh)
        scene_col.objects.link(obj)
        return obj

# ----------------------------------------------------------------------------------------------------------------------
# 머리카락: 머리 상자(x±0.16, y0.34~0.66, z±0.16)보다 0.015 큰 모자 모양 껍질 + 스타일별 덩어리
def cap(p, top=0.08, back_low=0.40, side_low=0.54, thick=0.035):
    """윗면·뒤·옆머리: 이마(y0.51 눈 위)까지 내려오는 앞머리는 윗면이 앞쪽 z0.175 까지 덮는다."""
    p.box((0, 0.665, -0.004), (0.355, top, 0.345), 0.02)   # 앞은 얼굴(z0.16)보다 0.008 만 튀어나와 모자챙처럼 보이지 않게
    hb = 0.65 - back_low
    p.box((0, back_low + hb / 2, -0.1675), (0.355, hb, thick), 0.014)
    sh = 0.655 - side_low
    for sx in (1, -1):
        p.box((sx * 0.1675, side_low + sh / 2, -0.01), (thick, sh, 0.33), 0.012)

def build_hairs(col):
    out = []
    # 짧게 깎은
    p = Part('hair_crop', HAIR_CELL); cap(p, top=0.055, back_low=0.50, side_low=0.58, thick=0.03); out.append(p.build(col))
    # 단발: 턱선 길이, 옆으로 뺨을 가림
    p = Part('hair_bob', HAIR_CELL); cap(p, back_low=0.37, side_low=0.40)
    for sx in (1, -1): p.box((sx * 0.1725, 0.52, 0.04), (0.035, 0.26, 0.16), 0.012)
    p.box((0, 0.40, -0.19), (0.37, 0.08, 0.05), 0.02)
    out.append(p.build(col))
    # 긴 생머리: 어깨 아래까지
    p = Part('hair_long', HAIR_CELL); cap(p, back_low=0.20, side_low=0.30)
    p.box((0, 0.40, -0.19), (0.38, 0.40, 0.045), 0.018)
    for sx in (1, -1):
        p.box((sx * 0.175, 0.47, 0.01), (0.035, 0.34, 0.20), 0.012)
        p.box((sx * 0.175, 0.33, 0.04), (0.035, 0.12, 0.10), 0.01, cell=HAIR_CELL)
    out.append(p.build(col))
    # 포니테일: 뒤통수 위쪽에서 묶여 내려옴
    p = Part('hair_pony', HAIR_CELL); cap(p, back_low=0.47, side_low=0.52)
    p.box((0, 0.615, -0.205), (0.09, 0.06, 0.07), 0.015, cell=DARK_CELL)   # 머리끈
    p.box((0, 0.50, -0.26), (0.11, 0.30, 0.10), 0.03, rot=(-8, 0, 0))
    p.box((0, 0.335, -0.275), (0.09, 0.08, 0.08), 0.02, rot=(-8, 0, 0))
    out.append(p.build(col))
    # 양갈래
    p = Part('hair_twin', HAIR_CELL); cap(p, back_low=0.47, side_low=0.50)
    for sx in (1, -1):
        p.box((sx * 0.215, 0.615, -0.04), (0.07, 0.06, 0.08), 0.015, cell=DARK_CELL)   # 머리끈
        p.box((sx * 0.245, 0.47, -0.04), (0.095, 0.30, 0.11), 0.03, rot=(0, 0, -sx * 8))
        p.box((sx * 0.262, 0.30, -0.04), (0.08, 0.07, 0.09), 0.02, rot=(0, 0, -sx * 8))
    out.append(p.build(col))
    # 뾰족 머리
    p = Part('hair_spiky', HAIR_CELL); cap(p, top=0.06, back_low=0.50, side_low=0.58, thick=0.03)
    for (x, z, tx, tz, h) in ((0, 0.0, 0, 0, 0.17), (0.095, 0.05, 14, -14, 0.14), (-0.095, 0.05, 14, 14, 0.14), (0.09, -0.09, -14, -12, 0.13), (-0.09, -0.09, -14, 12, 0.13), (0, 0.11, 22, 0, 0.12)):
        p.cone((x, 0.69, z), 0.07, 0.008, h, 4, rot=(tx, 0, tz))
    out.append(p.build(col))
    # 아프로: 얼굴(z0.16) 앞으로 안 튀어나오게 뒤로 민 타원체
    p = Part('hair_afro', HAIR_CELL)
    p.ellipsoid((0, 0.605, -0.055), (0.265, 0.235, 0.225), 2)
    out.append(p.build(col))
    # 모히칸
    p = Part('hair_mohawk', HAIR_CELL); cap(p, top=0.04, back_low=0.52, side_low=0.60, thick=0.025)
    p.box((0, 0.735, -0.015), (0.06, 0.13, 0.30), 0.022)
    p.box((0, 0.78, 0.07), (0.05, 0.09, 0.10), 0.02)
    p.box((0, 0.745, -0.17), (0.05, 0.12, 0.07), 0.02, rot=(18, 0, 0))
    out.append(p.build(col))
    return out

# 상의 부품(몸통 뼈에 붙는다): 몸통 상자 x±0.13 · y0.18~0.34 · z-0.14~0.08
def build_tops(col):
    out = []
    p = Part('top_hood', TOP_CELL)
    p.box((0, 0.335, -0.115), (0.27, 0.11, 0.085), 0.03)                       # 목 뒤에 접힌 모자
    for sx in (1, -1): p.box((sx * 0.125, 0.335, -0.02), (0.05, 0.065, 0.20), 0.02)   # 어깨를 따라 내려오는 목깃
    p.box((0, 0.325, -0.14), (0.17, 0.07, 0.04), 0.015)
    out.append(p.build(col))
    p = Part('top_pocket', TOP_CELL)
    p.box((0, 0.215, 0.087), (0.15, 0.07, 0.022), 0.01)                        # 배 앞 주머니
    for sx in (1, -1): p.box((sx * 0.032, 0.285, 0.088), (0.014, 0.075, 0.014), 0.005, cell=DARK_CELL)   # 모자 끈
    out.append(p.build(col))
    p = Part('top_coat', TOP_CELL)
    p.box((0, 0.125, -0.135), (0.32, 0.14, 0.075), 0.02)                       # 코트 뒤 자락
    for sx in (1, -1):
        p.box((sx * 0.148, 0.125, -0.03), (0.05, 0.14, 0.20), 0.02)             # 옆 자락(앞은 열림)
        p.box((sx * 0.115, 0.335, 0.075), (0.06, 0.075, 0.035), 0.012, rot=(-8, 0, sx * 14))   # 앞 깃
        p.box((sx * 0.128, 0.335, -0.03), (0.05, 0.06, 0.22), 0.018)
    p.box((0, 0.35, -0.125), (0.28, 0.07, 0.07), 0.02)                         # 뒷깃
    for yy in (0.27, 0.215): p.box((0, yy, 0.088), (0.03, 0.03, 0.014), 0.006, cell=DARK_CELL)   # 단추
    out.append(p.build(col))
    return out

# 하의: 치마(몸통 뼈) — 허리띠(y0.18~0.21)에서 무릎 위(y0.07)까지 퍼지는 사다리꼴
def build_bottoms(col):
    p = Part('bottom_skirt', BOTTOM_CELL)
    p.box((0, 0.135, -0.03), (0.44, 0.13, 0.42), 0.012, taper=(0.68, 0.70))
    p.box((0, 0.081, -0.03), (0.445, 0.014, 0.425), 0.006)
    return [p.build(col)]

# 부츠: 정강이 상자(x 0.01~0.16, y0.03~0.13)와 발 상자(x 0.02~0.15, y0~0.09)를 감싼다
def build_boots(col):
    out = []
    for name, sx in (('shoe_boot_L', 1), ('shoe_boot_R', -1)):
        p = Part(name, SHOE_CELL)
        p.box((sx * 0.085, 0.085, -0.03), (0.175, 0.17, 0.225), 0.022)          # 목
        p.box((sx * 0.085, 0.052, 0.015), (0.16, 0.105, 0.26), 0.022)            # 발
        p.box((sx * 0.085, 0.168, -0.03), (0.185, 0.026, 0.235), 0.01, cell=DARK_CELL)   # 윗단
        p.box((sx * 0.085, 0.008, 0.015), (0.165, 0.016, 0.265), 0.006, cell=DARK_CELL)  # 밑창
        out.append(p.build(col))
    return out

# ----------------------------------------------------------------------------------------------------------------------
def look_at(cam, target):
    d = target - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

def render_previews(outdir):
    """파트 검수용: 머리 상자 + 몸 상자를 임시로 두고 스타일별로 앞/뒤/옆에서 찍는다(게임에는 안 들어간다)."""
    os.makedirs(outdir, exist_ok=True)
    scene = bpy.context.scene
    try: scene.render.engine = 'BLENDER_EEVEE'
    except Exception: scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y = 900, 600
    w = bpy.data.worlds.new('w'); scene.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = (0.25, 0.27, 0.36, 1); bg.inputs[1].default_value = 1.0
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 3.0; sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35)); scene.collection.objects.link(sun)
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'POINT')); fill.data.energy = 200; fill.location = G(-0.8, 0.8, 1.2); scene.collection.objects.link(fill)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scene.collection.objects.link(cam); scene.camera = cam
    mat = bpy.data.materials.new('dummy'); mat.use_nodes = True; mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.9, 0.55, 0.3, 1)
    skin = bpy.data.materials.new('skin'); skin.use_nodes = True; skin.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.9, 0.7, 0.55, 1)
    body = bpy.data.materials.new('body'); body.use_nodes = True; body.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.35, 0.45, 0.7, 1)
    def block(c, s, m):
        bpy.ops.mesh.primitive_cube_add(size=1, location=G(*c)); o = bpy.context.object
        o.scale = (s[0], s[2], s[1]); o.data.materials.append(m); return o
    block((0, 0.50, 0), (0.32, 0.32, 0.32), skin)     # 머리
    block((0, 0.26, -0.03), (0.26, 0.16, 0.22), body)  # 몸통
    for sx in (1, -1):
        block((sx * 0.085, 0.09, -0.03), (0.13, 0.18, 0.16), body)   # 다리
        block((sx * 0.30, 0.28, 0.0), (0.16, 0.10, 0.11), body)      # 팔
    shots = {'front': ((0, 0.52, 1.55), (0, 0.38, 0)), 'back': ((0.0, 0.52, -1.55), (0, 0.38, 0)), 'side': ((1.55, 0.50, 0.0), (0, 0.38, 0)), 'low34': ((0.9, 0.25, 0.9), (0, 0.22, 0))}
    for o in [o for o in bpy.data.objects if o.name.startswith(('hair_', 'top_', 'bottom_', 'shoe_'))]:
        o.data.materials.append(mat)
    for name, (cp, tp) in shots.items():
        cam.data.lens = 50; cam.location = G(*cp); look_at(cam, G(*tp))
        scene.render.filepath = os.path.join(outdir, f'parts_{name}.png')
        bpy.ops.render.render(write_still=True)
    # 스타일 하나씩 켜 보기: 이름 단위 사진(앞·뒤)
    parts = [o for o in bpy.data.objects if o.name.startswith(('hair_', 'top_', 'bottom_', 'shoe_'))]
    for o in parts: o.hide_render = True
    for o in parts:
        o.hide_render = False
        cam.data.lens = 55
        tgt = (0, 0.48, 0) if o.name.startswith('hair_') else (0, 0.20, 0)
        for nm, cp in (('f', (0.6, 0.62, 1.2)), ('b', (-0.6, 0.62, -1.2))):
            cam.location = G(*cp); look_at(cam, G(*tgt))
            scene.render.filepath = os.path.join(outdir, f'{o.name}_{nm}.png')
            bpy.ops.render.render(write_still=True)
        o.hide_render = True

def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[argv.index('--out') + 1] if '--out' in argv else 'bf/kit/assets/custom/parts.glb'
    prev = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.context.scene.collection
    objs = build_hairs(col) + build_tops(col) + build_bottoms(col) + build_boots(col)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    for o in bpy.context.selected_objects: o.select_set(False)
    kw = dict(filepath=out, export_format='GLB', use_selection=False, export_apply=False, export_animations=False,
              export_yup=True, export_materials='NONE', export_cameras=False, export_lights=False, export_normals=True)
    bpy.ops.export_scene.gltf(**kw)
    print(f'wrote {out} {os.path.getsize(out) // 1024} KB, {len(objs)} parts, {sum(len(o.data.polygons) for o in objs)} faces')
    if prev: render_previews(prev)

if __name__ == '__main__':
    main()
