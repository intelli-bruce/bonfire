// node tools/bossmodal.test.mjs — 보스 선택 창(#bossPick) 회귀 검사: 한 덩어리 모달(덮개·창 안 스크롤·z-index)과 카드 썸네일(7종·정사각 JPEG·사양 일치).
// 실제 배치(넘침·겹침 없음)는 화면으로 본다: tools/bosses/preview/modal_desktop.png · modal_mobile.png.
import fs from 'node:fs';
import { THUMB_SPEC, THUMB_SIZE } from './bosses/thumb-spec.js';

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (!cond) { fails++; console.error('FAIL', msg); } };
const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const rule = (sel) => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}')); return m ? m[1] : ''; };

// 1) 마크업: 덮개 = 대화상자(aria-modal) 하나, 안에 창(.bp-card) → 머리 · 안내 · 스크롤 목록
const pickHtml = html.slice(html.indexOf('<div id="bossPick"'), html.indexOf('<div id="bossIntro"'));
ok(/<div id="bossPick" role="dialog" aria-modal="true"/.test(pickHtml) && !/<div id="bossPick"[^>]*class="[^"]*hud/.test(pickHtml), 'bossPick is a modal dialog, not a corner .hud box');
ok(/class="bp-card"/.test(pickHtml) && /class="bp-list"/.test(pickHtml), 'card window and scroll list exist');
for (const id of ['bossCount', 'bossClear', 'bossClose', 'bossNote']) ok(pickHtml.includes(`id="${id}"`), `#${id} exists`);

// 2) CSS: 화면 전체 덮개 + 반투명 배경, 창은 화면 안에 맞고 목록만 스크롤, 카드는 창 안에 맞음
const back = rule('#bossPick'), card = rule('#bossPick .bp-card'), list = rule('#bossPick .bp-list'), item = rule('#bossPick .bp-list .btn');
ok(/position:\s*fixed/.test(back) && /inset:\s*0/.test(back), 'backdrop covers the whole screen');
const a = back.match(/background:\s*rgba\([^)]*,\s*([\d.]+)\)/); ok(a && Number(a[1]) >= 0.7, 'backdrop is translucent enough that text behind does not show through');
ok(/backdrop-filter:\s*blur/.test(back), 'backdrop blurs what is behind');
ok(/max-height:\s*100%/.test(card) && /overflow:\s*hidden/.test(card) && /min-height:\s*0/.test(card), 'card window never grows past the screen');
ok(/width:\s*min\(\d+px,\s*100%\)/.test(card), 'card width fits the screen (min(Npx, 100%))');
ok(/overflow-y:\s*auto/.test(list) && /min-height:\s*0/.test(list) && /flex:\s*1 1 auto/.test(list), 'only the list scrolls inside the window');
ok(/box-sizing:\s*border-box/.test(item) && /width:\s*100%/.test(item) && /minmax\(0,\s*1fr\)/.test(item) && /white-space:\s*normal/.test(item), 'cards fit the window width and wrap their text');
ok(/@media \(max-width: 480px\)[^\n]*#bossPick/.test(css), 'narrow-screen rule exists');

// 3) 겹침 방지: 모달 z-index 가 다른 HUD(무기 칸·채팅·보스 HP·꺼짐 안내 …)보다 높고 입장 화면·셔터·토스트보다는 낮다
const z = (sel) => { const m = rule(sel).match(/z-index:\s*(\d+)/); return m ? Number(m[1]) : null; };
const zPick = z('#bossPick');
ok(zPick !== null && zPick > Math.max(...['#wslots', '#bossHp', '#downMsg', '#setPanel', '#bossIntro', '#tools'].map((s) => z(s) || 10), 10), 'modal is above the weapon slots, chat and other HUD');
ok(zPick < z('#flash') && zPick < z('#shotToast'), 'modal stays below the shutter flash and photo toast');

// 4) 닫기: 버튼 · 덮개 클릭 · Esc
ok(/\$\('bossClose'\)\.addEventListener\('click'/.test(html), 'close button handler');
ok(/ev\.target === \$\('bossPick'\)/.test(html), 'backdrop click closes');
ok(/e\.key === 'Escape' && !\$\('bossPick'\)\.hidden/.test(html), 'Escape closes');

// 5) 썸네일: 카드의 종류 = 썸네일 사양 = 파일. 파일은 정사각 THUMB_SIZE JPEG
const kinds = [...pickHtml.matchAll(/data-kind="(\w+)"/g)].map((m) => m[1]);
ok(kinds.length === 7, `seven boss cards (got ${kinds.length})`);
ok(JSON.stringify([...kinds].sort()) === JSON.stringify(Object.keys(THUMB_SPEC).sort()), 'card kinds match tools/bosses/thumb-spec.js');
function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
for (const k of kinds) {
  const cardHtml = (pickHtml.match(new RegExp(`<button[^>]*data-kind="${k}"[^>]*>[\\s\\S]*?</button>`)) || [''])[0];
  const img = cardHtml.match(/<img[^>]*src="([^"]+)"[^>]*>/);
  ok(img && img[1] === `bf/thumbs/${k}.jpg`, `${k}: card shows bf/thumbs/${k}.jpg`);
  ok(img && /width="72"/.test(img[0]) && /height="72"/.test(img[0]) && /alt=""/.test(img[0]), `${k}: thumbnail has fixed 72px box (no layout shift) and empty alt (name is next to it)`);
  ok(img && cardHtml.indexOf('<img') < cardHtml.indexOf('<b>'), `${k}: thumbnail sits left of the name`);
  const f = new URL(`bf/thumbs/${k}.jpg`, root);
  ok(fs.existsSync(f), `${k}: thumbnail file exists`);
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f), sz = jpegSize(buf);
  ok(sz && sz.w === THUMB_SIZE && sz.h === THUMB_SIZE, `${k}: thumbnail is a ${THUMB_SIZE}x${THUMB_SIZE} JPEG (got ${sz ? sz.w + 'x' + sz.h : 'not JPEG'})`);
  ok(buf.length > 4000 && buf.length < 120000, `${k}: thumbnail size is sane (${buf.length} B; a blank render is tiny)`);
}
for (const k of Object.keys(THUMB_SPEC)) {
  const s = THUMB_SPEC[k];
  ok(['spider', 'bosses', 'commander', 'hydra'].includes(s.mod) && s.cam.length === 3 && s.look.length === 3 && s.fov > 10 && s.fov < 90, `${k}: thumb spec is well formed`);
}
ok(fs.existsSync(new URL('tools/bosses/thumbs.html', root)) && fs.existsSync(new URL('tools/bosses/make_thumbs.mjs', root)), 'thumbnail generator files exist');

console.log(fails ? `${fails} of ${n} checks FAILED` : `bossmodal: ${n} checks OK`);
process.exit(fails ? 1 : 0);
