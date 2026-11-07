"""
보스 고급 마감 도구(대악마 · 대검 지휘관 · 히드라 전용) — build_bosses.py 의 기존 보스(상어·골렘·반천사)는 건드리지 않는다.

- bake_ao(objs)      : Cycles 로 앰비언트 오클루전(AO)을 꼭짓점 색에 굽고 기존 색('Col')에 곱한다. 겨드랑이·비늘 사이·판금 이음매·
                       입 안이 실제로 어두워져, 공용 로더의 평평한 회색 자가발광 없이도 형태가 읽힌다(glTF 꼭짓점 색으로 들어감).
- rough_image(h)     : 높이(스컬프트 결) → 러프니스 맵(Non-Color). 골은 거칠고 솟은 곳은 매끈(닳은 광택).
- add_rough(mat, im) : Principled 의 Roughness 에 맵의 G 채널을 잇는다 → glTF metallicRoughness 텍스처로 내보내진다.
- cloth_drape(o, ..) : 천 시뮬레이션(Cloth)으로 윗변을 고정하고 중력 · 바람 · 난류를 몇십 프레임 돌려 자연스러운 주름을 굳힌다.
- hair_cards(...)    : 털 다발을 가는 띠 카드(양면, 뿌리→끝으로 가늘어지고 휘어짐) 묶음으로 만든다.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector as V

def bake_ao(objs, samples=12, dist=1.6, strength=0.7, floor=0.3):
    sc = bpy.context.scene
    prev_engine = sc.render.engine
    sc.render.engine = 'CYCLES'
    try: sc.cycles.device = 'CPU'
    except Exception: pass
    sc.cycles.samples = samples
    try: sc.world.light_settings.distance = dist
    except Exception: pass
    for o in objs:
        me = o.data
        if 'Col' not in me.color_attributes: continue
        ao = me.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
        me.color_attributes.active_color = ao
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        try:
            bpy.ops.object.bake(type='AO', target='VERTEX_COLORS', use_clear=True, margin=0)
        except Exception as e:
            print('[hq] AO bake failed', o.name, e); me.color_attributes.remove(ao); me.color_attributes.active_color = me.color_attributes['Col']; continue
        n = len(me.vertices)
        a = np.empty(n * 4, dtype=np.float32); me.color_attributes['AO'].data.foreach_get('color', a); a = a.reshape(-1, 4)
        c = np.empty(n * 4, dtype=np.float32); me.color_attributes['Col'].data.foreach_get('color', c); c = c.reshape(-1, 4)
        ao = a[:, :1] / max(1e-3, float(np.percentile(a[:, 0], 85)))   # 겹친 부품 속 때문에 전체가 어두워지지 않게 정규화
        k = floor + (1 - floor) * np.clip(ao, 0, 1) ** 0.8          # 완전 검정은 막는다
        k = 1 - strength * (1 - k)
        c[:, :3] *= k
        me.color_attributes['Col'].data.foreach_set('color', c.reshape(-1))
        me.color_attributes.remove(me.color_attributes['AO'])
        me.color_attributes.active_color = me.color_attributes['Col']
        try: me.color_attributes.render_color_index = me.color_attributes.active_color_index
        except Exception: pass
        print(f'[hq] AO baked {o.name} mean={float(k.mean()):.3f}')
    sc.render.engine = prev_engine

def rough_image(name, h, lo, hi):
    from build_bosses import make_image
    h = (h - h.min()) / max(1e-6, float(h.max() - h.min()))
    r = lo + (hi - lo) * (1 - h)
    return make_image(name, np.stack([r, r, r], axis=-1), non_color=True)

def add_rough(mat, img):
    nt = mat.node_tree; bs = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
    try: t.image.colorspace_settings.name = 'Non-Color'
    except Exception: pass
    sp = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(t.outputs['Color'], sp.inputs['Color'])
    nt.links.new(sp.outputs['Green'], bs.inputs['Roughness'])
    return mat

def cloth_drape(o, pin, frames=24, wind=(0, -1, 0), wind_k=60.0, turb=25.0, seed=3):
    """pin(co) → 0..1 고정 세기. 시뮬 뒤 모디파이어를 적용해 모양을 굳힌다(움직임은 게임에서 뼈+스프링으로)."""
    sc = bpy.context.scene
    g = o.vertex_groups.new(name='pin')
    for v in o.data.vertices:
        w = pin(v.co)
        if w > 0: g.add([v.index], float(w), 'REPLACE')
    m = o.modifiers.new('cloth', 'CLOTH')
    cs = m.settings; cs.vertex_group_mass = 'pin'; cs.quality = 6; cs.mass = 0.5; cs.tension_stiffness = 40; cs.bending_stiffness = 2.0
    cs.air_damping = 3.0
    m.point_cache.frame_start = 1; m.point_cache.frame_end = frames
    fields = []
    for kind, k, loc in (('WIND', wind_k, (0, 6, 6)), ('TURBULENCE', turb, (0, -2, 6))):
        f = bpy.data.objects.new(kind, None); sc.collection.objects.link(f)
        bpy.context.view_layer.objects.active = f
        f.location = loc
        bpy.ops.object.forcefield_toggle()
        f.field.type = kind; f.field.strength = k
        if kind == 'WIND': f.rotation_euler = V(wind).to_track_quat('Z', 'Y').to_euler()
        else: f.field.size = 2.0; f.field.seed = seed
        fields.append(f)
    for fr in range(1, frames + 1): sc.frame_set(fr)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear(); old = o.data; o.data = me; bpy.data.meshes.remove(old)
    o.vertex_groups.clear()
    for f in fields: bpy.data.objects.remove(f, do_unlink=True)
    sc.frame_set(1)
    print(f'[hq] cloth drape {o.name} frames={frames}')
    return o

def hair_cards(bm, roots, rnd, cards_per_lock=6, segs=5, width=0.11):
    """roots: [(base, tip, bend, radius)] 다발마다. 다발 하나 = 카드 cards_per_lock 장, 뿌리 굵고 끝 가늘게 휘어진 띠."""
    for (base, tip, bend, rad) in roots:
        for _ in range(cards_per_lock):
            off = V((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))) * rad
            b0 = base + off; t0 = tip + off * 1.6 + V((rnd.uniform(-0.2, 0.2), rnd.uniform(-0.2, 0.2), rnd.uniform(-0.25, 0.1)))
            d = (t0 - b0); L = d.length
            if L < 1e-3: continue
            side = d.cross(V((0, 0, 1)))
            if side.length < 1e-3: side = V((1, 0, 0))
            side.normalize(); side = side * math.cos(rnd.uniform(0, math.pi)) + d.normalized().cross(side) * math.sin(rnd.uniform(0, math.pi))
            prev = None
            for i in range(segs + 1):
                u = i / segs
                p = b0 + d * u + bend * (u * u) + V((0, 0, -0.15 * L * u * u))
                w = width * (1 - 0.85 * u) * rnd.uniform(0.7, 1.3)
                a = bm.verts.new(p - side * w); c = bm.verts.new(p + side * w)
                if prev: bm.faces.new((prev[0], prev[1], c, a))
                prev = (a, c)
