"""
보스 디테일 베이크(Blender) — 고해상 스컬프트 → 저해상 면으로 노멀 · AO · 곡률 맵을 굽는다.

예전 노멀 맵은 numpy 높이장 미분(height_to_normal)이라 평평했다. 여기서는 텍스처 묶음(노멀 맵 하나 = 묶음 하나)마다
  1) 반복(타일) 되는 고해상 높이장(근육 결 · 비늘 · 바위 조각 · 흉터 · 주름 …)을 만들고 기존 색 텍스처의 명암(고역)을 섞어 무늬와 맞춘 뒤,
  2) 실제 지오메트리(3×3 타일보다 조금 넓은 촘촘한 격자, 최대 1024 분할/타일)를 그만큼 밀어 올려 스컬프트 메시를 만들고,
  3) Cycles 로 평평한 저해상 면(UV 0..1)에 선택→활성(selected-to-active) 베이크: 노멀(탄젠트 공간) · AO · 곡률(Pointiness 방출)
  4) 색 = 색 × 곡률(골 어둡게 · 모서리 밝게) × AO(약하게), ORM = (R AO, G 기존 러프니스 또는 1, B 1) 로 합친다.
게임 모델(LOD0/LOD1) 지오메트리 · UV 는 그대로라 삼각형 수가 변하지 않는다. 타일 경계는 이음매가 없다(높이장 · 격자 모두 감싸기).

실행(직접 부르지 않고 tools/bosses/detail_pack.mjs 가 부른다):
  blender -b --factory-startup --python tools/bosses/sculpt_bake.py -- --spec <work>/spec.json
spec.json = [{ name, res, recipe, albedo?: png 경로, rough?: png 경로, seed }], 결과는 같은 폴더에
  <name>_n.png · <name>_alb.png · <name>_orm.png (+ 미리보기용 _ao.png · _curv.png)
"""
import bpy, sys, os, json, math, time
import numpy as np

# ----------------------------------------------------------------------------------------------------------------------
# 반복되는 잡음
# ----------------------------------------------------------------------------------------------------------------------
def fbm(n, beta, seed, lo=2, hi=None, aniso=(1.0, 1.0)):
    rng = np.random.default_rng(seed)
    F = np.fft.fft2(rng.standard_normal((n, n)))
    fx = np.fft.fftfreq(n)[:, None] * n * aniso[0]; fy = np.fft.fftfreq(n)[None, :] * n * aniso[1]
    f = np.sqrt(fx * fx + fy * fy); f[0, 0] = 1
    amp = f ** (-beta); amp[f < lo] = 0
    if hi: amp[f > hi] = 0
    h = np.real(np.fft.ifft2(F * amp))
    return (h - h.min()) / max(1e-9, h.max() - h.min())

def cells(n, count, seed, jitter=1.0):
    """감싸는 보로노이: F1, F2 (타일 단위 거리). 격자 칸마다 점 하나 → 빠르다."""
    rng = np.random.default_rng(seed)
    g = max(1, int(round(math.sqrt(count))))
    off = 0.5 + (rng.random((g, g, 2)) - 0.5) * jitter            # 칸 안 점 위치(칸 단위)
    yy, xx = (np.mgrid[0:n, 0:n] + 0.5) / n * g                    # 칸 단위 좌표
    cy = np.floor(yy).astype(int); cx = np.floor(xx).astype(int)
    F1 = np.full((n, n), 9.0); F2 = np.full((n, n), 9.0); ID = np.zeros((n, n), dtype=np.int32)
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            ky = cy + oy; kx = cx + ox; my = ky % g; mx = kx % g
            py = ky + off[my, mx, 0]; px = kx + off[my, mx, 1]
            d = np.hypot(yy - py, xx - px)
            closer = d < F1
            F2 = np.where(closer, F1, np.minimum(F2, d)); ID = np.where(closer, my * g + mx, ID); F1 = np.minimum(F1, d)
    return F1, F2, ID      # 칸 크기 1 기준

def blur(h, sigma_px):
    n = h.shape[0]
    fx = np.fft.fftfreq(n)[:, None]; fy = np.fft.fftfreq(n)[None, :]
    G = np.exp(-2 * (math.pi ** 2) * (sigma_px ** 2) * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(h) * G))

def norm01(h):
    lo, hi = np.percentile(h, 1), np.percentile(h, 99)
    return np.clip((h - lo) / max(1e-9, hi - lo), 0, 1)

def scars(n, seed, count, width):
    """감싸는 직선 흉터(골). 0..1, 1 = 흉터 바닥."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n] / n
    out = np.zeros((n, n))
    for _ in range(count):
        a = rng.random(2); b = a + (rng.random(2) - 0.5) * rng.uniform(0.25, 0.6)
        w = width * rng.uniform(0.6, 1.4)
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                A = a + (ox, oy); B = b + (ox, oy); ab = B - A; l2 = ab.dot(ab)
                t = np.clip(((xx - A[0]) * ab[0] + (yy - A[1]) * ab[1]) / l2, 0, 1)
                d = np.hypot(xx - (A[0] + t * ab[0]), yy - (A[1] + t * ab[1]))
                taper = np.sin(t * math.pi) ** 0.5
                out = np.maximum(out, np.clip(1 - d / (w * (0.3 + 0.7 * taper) + 1e-9), 0, 1) ** 1.5)
    return out

def strands(n, seed, freq, warp):
    yy, xx = np.mgrid[0:n, 0:n] / n
    w = fbm(n, 1.4, seed, lo=1, hi=16)
    ph = (xx * freq + w * warp) * 2 * math.pi
    s = 0.5 + 0.5 * np.sin(ph)
    s = s ** 2.2 * (0.6 + 0.4 * fbm(n, 1.0, seed + 1, lo=4))
    return s

# 무늬마다 높이장(0..1 근처) — n: 해상도, lum: 기존 색 명암 고역(0..1, 없으면 0.5)
def recipe(kind, n, lum, seed):
    R = lambda k: seed * 31 + k
    if kind == 'scale':        # 비늘/방패비늘: 볼록한 비늘 + 비늘 사이 홈 + 비늘마다 높이 차 + 오래된 흉터
        F1, F2, ID = cells(n, 2304, R(1), 0.85)
        dome = np.clip(1 - F1 * 1.35, 0, 1) ** 0.6
        groove = np.clip(1 - (F2 - F1) * 7, 0, 1) ** 2
        per = (np.random.default_rng(R(2)).random(ID.max() + 1) * 0.35)[ID]
        h = dome * (0.65 + per) - groove * 0.55 + fbm(n, 1.6, R(3), lo=2) * 0.25 - scars(n, R(4), 3, 0.012) * 0.6
    elif kind == 'chitin':     # 키틴 판: 크고 평평한 판 + 모서리 경사 + 잔 구멍
        F1, F2, ID = cells(n, 196, R(1), 0.9)
        plate = np.clip((F2 - F1) * 3.2, 0, 1) ** 0.45
        pits = np.clip(1 - cells(n, 9000, R(2), 1.0)[0] * 2.4, 0, 1) ** 3
        h = plate * 0.8 + fbm(n, 1.8, R(3), lo=2) * 0.25 - pits * 0.25 - scars(n, R(4), 2, 0.008) * 0.4
    elif kind == 'rock':       # 바위 조각: 깨진 면(조각마다 기울기) + 깊은 균열 + 잔금 + 풍화
        F1, F2, ID = cells(n, 144, R(1), 1.0)
        rng = np.random.default_rng(R(2)); tilt = rng.normal(0, 1, (ID.max() + 1, 2)); off = rng.random(ID.max() + 1)
        yy, xx = np.mgrid[0:n, 0:n] / n
        facet = (tilt[ID, 0] * np.sin(xx * 2 * math.pi * 12) * 0.08 + tilt[ID, 1] * np.cos(yy * 2 * math.pi * 12) * 0.08) + off[ID] * 0.4
        crack = np.clip(1 - (F2 - F1) * 9, 0, 1) ** 1.5
        f1b, f2b, _ = cells(n, 1600, R(3), 1.0)
        crack2 = np.clip(1 - (f2b - f1b) * 14, 0, 1) ** 2
        chip = np.clip(F1 * 1.6, 0, 1) ** 0.4
        h = facet + chip * 0.35 - crack * 0.9 - crack2 * 0.3 + fbm(n, 1.5, R(4), lo=3) * 0.35
    elif kind == 'muscle':     # 근육 결(한 방향으로 늘인 큰 굴곡) + 결 따라 잔주름 + 모공 + 흉터
        bulge = fbm(n, 2.4, R(1), lo=1, hi=10, aniso=(1.0, 0.35))
        yy, xx = np.mgrid[0:n, 0:n] / n
        warp = fbm(n, 1.6, R(2), lo=1, hi=12)
        fiber = 0.5 + 0.5 * np.sin((xx * 90 + warp * 9) * 2 * math.pi)
        wr = 0.5 + 0.5 * np.sin((yy * 34 + warp * 5 + bulge * 3) * 2 * math.pi)
        wrinkle = (wr ** 6) * np.clip((0.6 - bulge) * 2.5, 0, 1)            # 접히는 골(굴곡 사이)에 주름이 모인다
        pores = np.clip(1 - cells(n, 14000, R(3), 1.0)[0] * 2.8, 0, 1) ** 3
        h = bulge * 1.0 + fiber * 0.06 - wrinkle * 0.35 - pores * 0.12 - scars(n, R(4), 3, 0.01) * 0.7
    elif kind == 'membrane':   # 막 · 잇몸 · 입 속: 솟은 핏줄 + 잔주름 + 부드러운 굴곡
        F1, F2, _ = cells(n, 100, R(1), 1.0)
        vein = np.clip(1 - (F2 - F1) * 10, 0, 1) ** 2
        f1, f2, _ = cells(n, 900, R(2), 1.0)
        vein2 = np.clip(1 - (f2 - f1) * 16, 0, 1) ** 2
        yy, xx = np.mgrid[0:n, 0:n] / n
        wr = 0.5 + 0.5 * np.sin((yy * 48 + fbm(n, 1.5, R(3), lo=1, hi=10) * 6) * 2 * math.pi)
        h = fbm(n, 2.2, R(4), lo=1, hi=12) * 0.7 + vein * 0.45 + vein2 * 0.18 - wr ** 5 * 0.2
    elif kind == 'strand':     # 털 · 갈기 · 깃털 · 이끼: 결 방향 가는 줄 다발
        h = strands(n, R(1), 120, 7) * 0.6 + strands(n, R(2), 47, 4) * 0.35 + fbm(n, 1.8, R(3), lo=2) * 0.3
    elif kind == 'moss':       # 이끼 덩이: 둥근 덩이 + 잔털
        F1, _, ID = cells(n, 400, R(1), 1.0)
        clump = np.clip(1 - F1 * 1.2, 0, 1) ** 0.7 * (0.6 + 0.4 * (np.random.default_rng(R(2)).random(ID.max() + 1))[ID])
        h = clump * 0.8 + strands(n, R(3), 160, 10) * 0.25 + fbm(n, 1.4, R(4), lo=4) * 0.2
    elif kind == 'metal':      # 두드린 판금: 얕은 망치 자국 + 긁힘 + 녹 구멍
        F1, _, _ = cells(n, 900, R(1), 1.0)
        dent = -(np.clip(1 - F1 * 1.1, 0, 1) ** 2)
        scr = scars(n, R(2), 26, 0.0016)
        pits = np.clip(1 - cells(n, 6000, R(3), 1.0)[0] * 3, 0, 1) ** 4
        h = dent * 0.35 - scr * 0.5 - pits * 0.3 + fbm(n, 2.0, R(4), lo=1, hi=8) * 0.3
    elif kind == 'cloth':      # 천: 날실·씨실 짜임 + 주름
        yy, xx = np.mgrid[0:n, 0:n] / n
        k = 160
        weave = (0.5 + 0.5 * np.sin(xx * k * 2 * math.pi)) * (0.5 + 0.5 * np.sign(np.sin(yy * k * math.pi))) + \
                (0.5 + 0.5 * np.sin(yy * k * 2 * math.pi)) * (0.5 - 0.5 * np.sign(np.sin(yy * k * math.pi)))
        fold = fbm(n, 2.4, R(1), lo=1, hi=8, aniso=(0.3, 1.0))
        h = weave * 0.18 + fold * 1.0 + fbm(n, 1.5, R(2), lo=8) * 0.08
    elif kind == 'horn':       # 뿔: 가로 고리 마디 + 세로 갈라짐
        yy, xx = np.mgrid[0:n, 0:n] / n
        w = fbm(n, 1.6, R(1), lo=1, hi=10)
        ring = 0.5 + 0.5 * np.sin((yy * 22 + w * 2.5) * 2 * math.pi)
        split = strands(n, R(2), 60, 3)
        h = ring ** 1.5 * 0.7 - split * 0.25 + fbm(n, 1.7, R(3), lo=2) * 0.25
    else:                      # 'bone' 이빨 · 뼈: 잔 구멍 + 금 + 결
        f1, f2, _ = cells(n, 400, R(1), 1.0)
        crack = np.clip(1 - (f2 - f1) * 18, 0, 1) ** 3
        pits = np.clip(1 - cells(n, 5000, R(2), 1.0)[0] * 2.6, 0, 1) ** 3
        h = fbm(n, 1.9, R(3), lo=1) * 0.7 + strands(n, R(4), 30, 2) * 0.12 - crack * 0.45 - pits * 0.3
    h = norm01(h)
    return norm01(h * 0.78 + lum * 0.22)       # 기존 색 무늬(고역)와 맞물리게

# 무늬마다 높이 폭(타일=1 기준)과 곡률·AO 를 색에 얹는 세기
STYLE = {
    'scale':    dict(amp=0.010, cav=0.42, edge=0.22, ao=0.30),
    'chitin':   dict(amp=0.012, cav=0.38, edge=0.28, ao=0.30),
    'rock':     dict(amp=0.030, cav=0.50, edge=0.30, ao=0.38),
    'muscle':   dict(amp=0.018, cav=0.34, edge=0.14, ao=0.30),
    'membrane': dict(amp=0.012, cav=0.30, edge=0.16, ao=0.26),
    'strand':   dict(amp=0.006, cav=0.36, edge=0.18, ao=0.26),
    'moss':     dict(amp=0.016, cav=0.36, edge=0.18, ao=0.30),
    'metal':    dict(amp=0.004, cav=0.30, edge=0.30, ao=0.20),
    'cloth':    dict(amp=0.020, cav=0.34, edge=0.14, ao=0.30),
    'horn':     dict(amp=0.012, cav=0.38, edge=0.24, ao=0.30),
    'bone':     dict(amp=0.006, cav=0.36, edge=0.20, ao=0.26),
}

# ----------------------------------------------------------------------------------------------------------------------
# Blender
# ----------------------------------------------------------------------------------------------------------------------
def clear():
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for x in list(c): c.remove(x)

def load_px(path, n=None):
    im = bpy.data.images.load(path)
    im.colorspace_settings.name = 'Non-Color'
    if n and (im.size[0] != n or im.size[1] != n): im.scale(n, n)
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32); im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)[..., :3].astype(np.float64)    # 아래 줄이 0 (Blender 이미지 = UV 공간)

def save_px(path, rgb, quality=None):
    h, w = rgb.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=False, float_buffer=False)
    im.colorspace_settings.name = 'Non-Color'
    px = np.ones((h, w, 4), dtype=np.float32); px[..., :3] = np.clip(rgb, 0, 1)
    im.pixels.foreach_set(px.reshape(-1))
    im.filepath_raw = path
    im.file_format = 'JPEG' if path.endswith('.jpg') else 'PNG'
    sc = bpy.context.scene
    sc.render.image_settings.file_format = im.file_format
    sc.render.image_settings.color_mode = 'RGB'
    if quality: sc.render.image_settings.quality = quality
    im.save_render(path, scene=sc)
    if path.endswith('.png') and not path.endswith(('_ao.png', '_curv.png', '_tmp.png')):   # 대체 경로(JPEG) 판도 함께
        sc.render.image_settings.file_format = 'JPEG'; sc.render.image_settings.quality = 82   # build_bosses.export 의 JPEG 품질과 같게
        im.save_render(path[:-4] + '.jpg', scene=sc)
    bpy.data.images.remove(im)

def grid_mesh(name, H, amp, g, margin=0.125):
    """[−margin, 1+margin]² 의 촘촘한 격자, z = 높이장(감싸기 이중선형 표본) × amp."""
    n = H.shape[0]
    m = int(round(g * (1 + 2 * margin)))
    t = np.linspace(-margin, 1 + margin, m + 1)
    X, Y = np.meshgrid(t, t, indexing='xy')                       # Y = 행 = v
    fx = (X * n) % n; fy = (Y * n) % n
    x0 = np.floor(fx).astype(int); y0 = np.floor(fy).astype(int); ax = fx - x0; ay = fy - y0
    x1 = (x0 + 1) % n; y1 = (y0 + 1) % n
    Z = (H[y0, x0] * (1 - ax) * (1 - ay) + H[y0, x1] * ax * (1 - ay) + H[y1, x0] * (1 - ax) * ay + H[y1, x1] * ax * ay)
    Z = (Z - 0.5) * amp
    co = np.stack([X, Y, Z], -1).reshape(-1, 3).astype(np.float32)
    idx = np.arange((m + 1) * (m + 1)).reshape(m + 1, m + 1)
    q = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1).reshape(-1)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(co)); me.vertices.foreach_set('co', co.reshape(-1))
    nq = m * m
    me.loops.add(nq * 4); me.loops.foreach_set('vertex_index', q.astype(np.int32))
    me.polygons.add(nq); me.polygons.foreach_set('loop_start', np.arange(0, nq * 4, 4, dtype=np.int32))
    me.update(calc_edges=True); me.validate()
    me.polygons.foreach_set('use_smooth', np.ones(nq, dtype=bool)); me.update()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    return o

def low_plane():
    me = bpy.data.meshes.new('low')
    me.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name='UVMap')
    for i, c in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]): uv.data[i].uv = c
    o = bpy.data.objects.new('low', me); bpy.context.scene.collection.objects.link(o)
    return o

def bake_target(low, n, name):
    mat = bpy.data.materials.new('low_' + name); mat.use_nodes = True
    nt = mat.node_tree
    img = bpy.data.images.new(name, n, n, alpha=False, float_buffer=True); img.colorspace_settings.name = 'Non-Color'
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img; nt.nodes.active = t
    low.data.materials.clear(); low.data.materials.append(mat)
    return img

def high_material(high):
    mat = bpy.data.materials.new('high'); mat.use_nodes = True; nt = mat.node_tree
    out = nt.nodes['Material Output']; geo = nt.nodes.new('ShaderNodeNewGeometry')
    em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(geo.outputs['Pointiness'], em.inputs['Color'])
    mix = nt.nodes.new('ShaderNodeAddShader')
    nt.links.new(nt.nodes['Principled BSDF'].outputs[0], mix.inputs[0]); nt.links.new(em.outputs[0], mix.inputs[1])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    high.data.materials.append(mat)

def bake(kind, low, high, n, amp, ao_dist, samples=1):
    sc = bpy.context.scene
    img = bake_target(low, n, kind)
    sc.cycles.samples = samples
    bk = sc.render.bake
    bk.use_selected_to_active = True; bk.use_cage = False
    bk.cage_extrusion = amp * 1.2; bk.max_ray_distance = amp * 2.5; bk.margin = 0
    if kind == 'NORMAL': bk.normal_space = 'TANGENT'; bk.normal_r = 'POS_X'; bk.normal_g = 'POS_Y'; bk.normal_b = 'POS_Z'
    if kind == 'AO': sc.world.light_settings.distance = ao_dist
    bpy.ops.object.select_all(action='DESELECT'); high.select_set(True); low.select_set(True)
    bpy.context.view_layer.objects.active = low
    t0 = time.time()
    bpy.ops.object.bake(type=kind, use_clear=True, margin=0)
    px = np.empty(n * n * 4, dtype=np.float32); img.pixels.foreach_get(px)
    print(f'[bake] {kind} {n}px {time.time() - t0:.1f}s', flush=True)
    bpy.data.images.remove(img)
    return px.reshape(n, n, 4)[..., :3].astype(np.float64)

def do_set(s, work):
    t0 = time.time()
    clear()
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try: sc.cycles.device = 'CPU'
    except Exception: pass
    if sc.world is None: sc.world = bpy.data.worlds.new('w')
    n = int(s['res']); kind = s['recipe']; st = STYLE[kind]
    alb = load_px(s['albedo'], n) if s.get('albedo') else None
    if alb is not None:
        lum = alb @ np.array([0.299, 0.587, 0.114])
        lum = norm01(lum - blur(lum, n / 48))                     # 고역만(큰 얼룩 · 색 구분은 높이로 쓰지 않는다)
    else:
        lum = np.full((n, n), 0.5)
    H = recipe(kind, n, lum, int(s.get('seed', 1)))
    g = min(n, 1024)
    amp = st['amp']
    high = grid_mesh('high', H, amp, g); high_material(high)
    low = low_plane()
    nrm = bake('NORMAL', low, high, n, amp, 0)
    ao = bake('AO', low, high, n, amp, amp * 5, samples=48)[..., 0]
    curv = bake('EMIT', low, high, n, amp, 0)[..., 0]
    # 곡률: 0.5 = 평면, 위 = 볼록(모서리), 아래 = 오목(골)
    c = curv - np.median(curv); c = c / max(1e-9, np.percentile(np.abs(c), 97))
    c = blur(c, 0.6)
    cav = np.clip(-c, 0, 1); edge = np.clip(c, 0, 1)
    ao = np.clip(ao / max(1e-6, np.percentile(ao, 92)), 0, 1)
    nm = s['name']
    save_px(os.path.join(work, nm + '_n.png'), nrm)
    save_px(os.path.join(work, nm + '_ao.png'), np.repeat(ao[..., None], 3, -1))
    save_px(os.path.join(work, nm + '_curv.png'), np.repeat((0.5 + 0.5 * np.clip(c, -1, 1))[..., None], 3, -1))
    if alb is not None:
        k = (1 - st['cav'] * cav) * (1 + st['edge'] * edge) * (1 - st['ao'] * (1 - ao))
        na = int(s.get('albedoRes', n))
        out = alb * k[..., None]
        if na != n:   # 색 원래 해상도로 되돌린다
            save_px(os.path.join(work, nm + '_tmp.png'), out); out = load_px(os.path.join(work, nm + '_tmp.png'), na); os.remove(os.path.join(work, nm + '_tmp.png'))
        save_px(os.path.join(work, nm + '_alb.png'), out)
    no = min(n, 1024)
    rough = load_px(s['rough'], no)[..., 1] if s.get('rough') else np.ones((no, no))
    if no != n:
        save_px(os.path.join(work, nm + '_tmp.png'), np.repeat(ao[..., None], 3, -1)); ao_s = load_px(os.path.join(work, nm + '_tmp.png'), no)[..., 0]; os.remove(os.path.join(work, nm + '_tmp.png'))
    else: ao_s = ao
    save_px(os.path.join(work, nm + '_orm.png'), np.stack([ao_s, rough, np.ones_like(rough)], -1))
    print(f'[set] {nm} {kind} {n}px grid={g} done {time.time() - t0:.1f}s', flush=True)

if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    spec = argv[argv.index('--spec') + 1]
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else None
    work = os.path.dirname(os.path.abspath(spec))
    for s in json.load(open(spec)):
        if only and s['name'] not in only: continue
        do_set(s, work)
