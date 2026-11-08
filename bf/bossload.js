// bf/bossload.js — 보스 GLB 공용 로더: KTX2(Basis) 판을 먼저, 못 쓰면 JPEG 판.
//
//   const g = await loadBossGlb(ctx, 'shark.glb')   // ctx: { baseUrl, renderer?, dracoPath?, basisPath?, ktx2? }
//
// 보스마다 두 파일이 있다(tools/bosses/detail_pack.mjs 가 만든다):
//   <boss>.ktx2.glb — 텍스처가 KTX2(ETC1S, KHR_texture_basisu 필수). GPU 압축 형식 그대로 올라가 VRAM 이 RGBA8 의 1/4 이하.
//   <boss>.glb      — 같은 텍스처의 JPEG 판(대체). 렌더러가 없거나, GPU 압축 형식(ASTC · BC7 · BC1 · ETC2 · ETC1 · PVRTC)이 하나도 없거나,
//                     ctx.ktx2 === false 이거나, KTX2 판 로드가 실패하면 이쪽을 읽는다.
// 로더(Draco 디코더 · Basis 트랜스코더 워커)는 보스끼리 하나를 같이 쓴다(8마리 소환해도 워커가 늘지 않는다).
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/';
let shared = null;

export const ktx2Name = (file) => file.replace(/\.glb$/i, '.ktx2.glb');

// KTX2Loader.detectSupport 결과(workerConfig)에 GPU 압축 형식이 하나라도 있나
export function gpuFormatOk(cfg) {
  return !!(cfg && (cfg.astcSupported || cfg.bptcSupported || cfg.dxtSupported || cfg.etc2Supported || cfg.etc1Supported || cfg.pvrtcSupported));
}

function loaders(ctx) {
  if (shared) return shared;
  shared = (async () => {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const dr = new DRACOLoader(); dr.setDecoderPath(ctx.dracoPath || CDN + 'draco/gltf/');
    const jpg = new GLTFLoader(); jpg.setDRACOLoader(dr);
    let ktx = null, why = 'no renderer';
    if (ctx.ktx2 === false) why = 'off';
    else if (ctx.renderer) {
      try {
        const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
        const k = new KTX2Loader().setTranscoderPath(ctx.basisPath || CDN + 'basis/').detectSupport(ctx.renderer);
        if (gpuFormatOk(k.workerConfig)) { ktx = new GLTFLoader(); ktx.setDRACOLoader(dr); ktx.setKTX2Loader(k); why = ''; }
        else { why = 'no GPU texture format'; k.dispose(); }
      } catch (e) { why = e && e.message; }
    }
    if (!ktx) console.info('[bonfire] boss textures: JPEG (' + why + ')');
    return { jpg, ktx };
  })();
  return shared;
}

export async function loadBossGlb(ctx, file) {
  const L = await loaders(ctx);
  const get = (ld, f) => new Promise((res, rej) => ld.load(new URL(f, ctx.baseUrl).href, res, undefined, rej));
  if (L.ktx) {
    try { const g = await get(L.ktx, ktx2Name(file)); g.userData = { ...(g.userData || {}), tex: 'ktx2' }; return g; }
    catch (e) { console.warn('[bonfire] KTX2 boss load failed → JPEG', file, e && e.message); }
  }
  const g = await get(L.jpg, file); g.userData = { ...(g.userData || {}), tex: 'jpeg' }; return g;
}
