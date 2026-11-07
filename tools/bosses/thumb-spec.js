// 보스 선택 창 썸네일 사양: 종류 → 모듈·카메라. tools/bosses/thumbs.html(렌더)과 tools/bossmodal.test.mjs(검사)가 같이 쓴다.
// 새 보스를 index.html 의 #bossPick 에 추가하면 여기에도 한 줄을 넣고 `node tools/bosses/make_thumbs.mjs` 를 다시 돌린다.
// cam/look 은 보스 지역 좌표(m): x 오른쪽 · y 위 · z 앞(보스가 바라보는 쪽, tools/bosses/viewer.html 의 C 표와 같은 규약).
export const THUMB_SIZE = 256;   // 정사각 픽셀(카드에서는 72px, 고해상도 화면 대비 3배 이상)
export const THUMB_SPEC = {
  spider:    { mod: 'spider',    cam: [20, 12, 60], look: [0, 6, 0], fov: 38 },
  shark:     { mod: 'bosses',    cam: [13, 6, 25], look: [0, 1.5, 0], fov: 40 },
  golem:     { mod: 'bosses',    cam: [12, 12, 36], look: [0, 9, 0], fov: 38 },
  seraph:    { mod: 'bosses',    cam: [8, 12, 46], look: [0, 10, 0], fov: 40 },
  demon:     { mod: 'bosses',    cam: [8, 11, 36], look: [0, 9.8, 0], fov: 38 },
  commander: { mod: 'commander', cam: [6, 8, 27], look: [0, 7.2, 0], fov: 38 },
  hydra:     { mod: 'hydra',     cam: [12, 13, 52], look: [0, 9, 0], fov: 40 },
};
