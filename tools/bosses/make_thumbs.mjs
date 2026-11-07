// node tools/bosses/make_thumbs.mjs [--kinds spider,shark] [--port 8765] [--open]
// 보스 선택 창 썸네일(bf/thumbs/<종류>.jpg, 256×256) 생성기. 보스 모델(bf/*.glb·*.js)이 바뀌면 다시 돌린다.
// 이 스크립트는 저장소 루트를 정적 서버로 열고(127.0.0.1) 주소를 출력한다. 그 주소를 브라우저(Aside 등 WebGL 되는 창)에서 열면
// tools/bosses/thumbs.html 이 게임과 같은 로더·조명으로 실제 모델을 그려 JPEG 로 올리고, 이 서버가 bf/thumbs/ 에 저장한 뒤 끝낸다.
// 사양(종류·카메라)은 tools/bosses/thumb-spec.js. 로컬 확인만 할 땐 서버 없이 thumbs.html?boss=demon 을 아무 정적 서버로 열면 미리보기만 나온다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { THUMB_SPEC, THUMB_SIZE } from './thumb-spec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'bf', 'thumbs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const kinds = String(arg('kinds', Object.keys(THUMB_SPEC).join(','))).split(',').filter(Boolean);
const bad = kinds.filter((k) => !THUMB_SPEC[k]);
if (bad.length) { console.error('모르는 종류: ' + bad.join(', ') + ' (가능: ' + Object.keys(THUMB_SPEC).join(', ') + ')'); process.exit(2); }
const port = Number(arg('port', 8765));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.txt': 'text/plain' };
const got = new Set();
let failMsg = '';

// JPEG 헤더에서 가로·세로를 읽어 정사각 256 인지 확인한다(잘못 올라온 파일은 저장 안 함).
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

const server = http.createServer({ maxHeaderSize: 262144 }, (req, res) => {   // localhost 는 포트가 달라도 쿠키를 공유해 브라우저 요청 헤더가 16KB 기본 상한을 넘을 수 있음
  if (process.env.THUMBS_LOG) console.log(req.method, req.url);
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/__thumb') {
    const kind = url.searchParams.get('kind');
    if (!kinds.includes(kind)) { res.writeHead(400).end('kind'); return; }
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks), sz = jpegSize(buf);
      if (!sz || sz.w !== THUMB_SIZE || sz.h !== THUMB_SIZE) { res.writeHead(422).end('jpeg ' + THUMB_SIZE + 'x' + THUMB_SIZE); console.error(`거부: ${kind} (${sz ? sz.w + 'x' + sz.h : 'JPEG 아님'})`); return; }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, kind + '.jpg'), buf);
      got.add(kind); console.log(`저장: bf/thumbs/${kind}.jpg (${buf.length} B)`);
      res.writeHead(200).end('ok');
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__done') {
    failMsg = url.searchParams.get('fail') || '';
    res.writeHead(200).end('ok');
    setTimeout(() => { server.close(); process.exit(failMsg || got.size !== kinds.length ? 1 : 0); }, 100);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep) || file.includes(path.sep + '.git' + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : data);
  });
});
server.on('clientError', (e, sock) => { if (process.env.THUMBS_LOG) console.log('clientError', e.code, e.message); sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.on('error', (e) => { console.error('서버 오류: ' + e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  const addr = `http://127.0.0.1:${port}/tools/bosses/thumbs.html?save=1&boss=${kinds.join(',')}`;
  console.log('이 주소를 WebGL 되는 브라우저(Aside)에서 여세요. 끝나면 저절로 종료됩니다.\n' + addr);
  if (arg('open', false)) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [addr], { stdio: 'ignore', detached: true }).unref();
});
