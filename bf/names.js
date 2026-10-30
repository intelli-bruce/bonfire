// names.js — first-come nickname claims over public MQTT retained messages + WebCrypto (ECDSA P-256).
//
// No server, no database. Each browser holds an ECDSA keypair (localStorage 'bonfire.key').
// A claim is a retained message on  <prefix>names/<hex sha256(norm)>  :
//   {v:1, nick, pub:{kty,crv,x,y}, t, sig: base64(ECDSA-SHA256 raw r||s over "claim|"+norm+"|"+t)}
// Presence proof: {np: norm, ns: base64 sig over "pres|"+id+"|"+norm}, checked against the registered pub.
//
// HONEST LIMITS (public broker = anyone can write any topic):
//  - Anyone can overwrite or delete a retained claim. A signature only proves "this record was made by the
//    holder of key K"; it cannot prove K was first, because `t` is self-asserted and can be back-dated.
//  - Mitigations here: (1) trust-on-first-use — once a client has seen a valid record (kept in memory and in
//    localStorage 'bonfire.names'), a record with a different key replaces it only during a short settle
//    window (SETTLE_MS, to resolve genuine simultaneous claims by earliest t, tie = smaller pub); after that
//    the first-seen record is sticky. (2) The owner's browser stays subscribed to its own name and republishes
//    its record whenever it sees it overwritten or deleted.
//  - Residual risk: a client that has never seen the name, while the owner is offline, sees whatever record is
//    currently retained — an attacker who overwrote it is then accepted as the owner by that fresh client.
//    Different brokers can also hold different records (split brain). Homoglyphs across scripts (Latin "a" vs
//    Cyrillic "а") are not folded. This is first-come social etiquette, not authentication.
//  - A peer's id + presence signature (np, ns) are public on the broker, so anyone can replay them under that id
//    (a "puppet" showing a verified name). Etiquette, not authentication.

const DEFAULT_PREFIX = 'brx-bonfire-v1/';
const KEY_STORE = 'bonfire.key';
const CACHE_STORE = 'bonfire.names';
const CLAIM_WAIT_MS = 1500;      // wait for an existing retained record before claiming
const REREAD_MS = 800;           // after publishing, wait then re-read
const REREAD_WAIT_MS = 600;      // how long to listen after the re-read subscribe
const LOOKUP_WAIT_MS = 1500;     // verifyPeer: wait for a retained record
const SETTLE_MS = 10000;         // window in which an earlier-t record from another key may still win
const MAX_PAYLOAD = 2048;
const MAX_LEN = 20;
const T_MIN = 1672531200000;     // 2023-01-01: reject absurd timestamps
const T_FUTURE_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const RESERVED = ['순례자', '나그네', '나', 'admin', '관리자', '신부님', '운영자', 'system', 'moderator'];

// copied from cathedral.html (INVIS/cleanText), extended with Hangul fillers, CGJ, variation selectors, braille blank
const INVIS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ue000-\uf8ff]/g;
const INVIS2 = /[\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\ufe00-\ufe0f]|\udb40[\udc00-\udfff]/g;
function cleanText(s, max) { return typeof s === 'string' ? s.replace(INVIS, '').trim().slice(0, max) : ''; }

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  ok: null,
  get(k) { try { return globalThis.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { globalThis.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
};
function storageWorks() {
  if (store.ok !== null) return store.ok;
  try { const k = '__names_probe'; globalThis.localStorage.setItem(k, '1'); globalThis.localStorage.removeItem(k); store.ok = true; } catch (e) { store.ok = false; }
  return store.ok;
}

// ---------- state ----------
let A = null;                 // adapter
let prefix = DEFAULT_PREFIX;
let me = null;                // {priv: CryptoKey, pub: {kty,crv,x,y}, pubStr}
let mePromise = null;
let mine = null;              // {norm, nick, rec}
const reg = new Map();        // norm -> {rec, pubStr, firstSeen}
const hashToNorm = new Map(); // hex -> norm (for topics we know)
const keyCache = new Map();   // pubStr -> CryptoKey (verify)
const presOk = new Map();     // `${id}|${np}|${ns}` -> pubStr that verified
const presBad = new Map();    // same key -> expiry ms
const lookups = new Map();    // norm -> Promise
const waiters = new Set();    // fns called on every accepted registry change
const presSigned = new Map(); // id -> {np, ns}  (once per session)
const lastRepub = new Map();  // norm -> ms
let lookupBudget = { t: 0, n: 0 };
let rawBudget = { t: 0, n: 0 };   // onRaw: all topics, per second
let sigBudget = { t: 0, n: 0 };   // verifyPeer: signature checks per second
const rawTopic = new Map();       // hex -> {t,n}

// ---------- helpers ----------
function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
function unb64(s) {
  if (typeof s !== 'string' || s.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } catch (e) { return null; }
}
async function sha256hex(s) {
  const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(s)));
  let o = ''; for (const b of h) o += b.toString(16).padStart(2, '0'); return o;
}
const B64URL32 = /^[A-Za-z0-9_-]{43}$/;
function pubShape(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.kty !== undefined && p.kty !== 'EC') return null;
  if (p.crv !== undefined && p.crv !== 'P-256') return null;
  if (typeof p.x !== 'string' || typeof p.y !== 'string' || !B64URL32.test(p.x) || !B64URL32.test(p.y)) return null;
  return { kty: 'EC', crv: 'P-256', x: p.x, y: p.y };
}
const pubStrOf = (p) => p.x + '.' + p.y;
async function verifyKey(pub) {
  const ps = pubStrOf(pub);
  let k = keyCache.get(ps);
  if (k) return k;
  k = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, ext: true }, ALG, false, ['verify']);
  if (keyCache.size > 500) keyCache.delete(keyCache.keys().next().value);
  keyCache.set(ps, k);
  return k;
}
async function verifySig(pub, msg, sigB64) {
  try {
    const sig = unb64(sigB64);
    if (!sig || sig.length !== 64) return false;
    return await subtle.verify(SIG, await verifyKey(pub), sig, enc.encode(msg));
  } catch (e) { return false; }
}
function topicFor(hex) { return prefix + 'names/' + hex; }

// ---------- normalize ----------
function cleanDisplay(s) {
  if (typeof s !== 'string' || s.length > 200) return '';
  let t;
  try { t = s.normalize('NFKC'); } catch (e) { return ''; }
  t = t.replace(INVIS, '').replace(INVIS2, '').replace(/\s+/g, ' ').trim();
  return t;
}
export function normalizeNick(s) {
  try {
    const t = cleanDisplay(s).toLowerCase();
    const n = [...t].length;
    return n >= 1 && n <= MAX_LEN ? t : '';
  } catch (e) { return ''; }
}
const RESERVED_N = new Set(RESERVED.map((r) => normalizeNick(r)));

// ---------- identity ----------
async function loadKeys() {
  const raw = store.get(KEY_STORE);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      const pub = pubShape(j && j.pub);
      if (pub && j.priv && j.priv.kty === 'EC' && j.priv.crv === 'P-256' && j.priv.x === pub.x && j.priv.y === pub.y && typeof j.priv.d === 'string') {
        const priv = await subtle.importKey('jwk', j.priv, ALG, false, ['sign']);
        return { priv, pub, pubStr: pubStrOf(pub), persisted: true };
      }
    } catch (e) { /* fall through: regenerate */ }
  }
  const kp = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  const pub = pubShape({ x: privJwk.x, y: privJwk.y });
  const priv = await subtle.importKey('jwk', privJwk, ALG, false, ['sign']);
  const persisted = storageWorks() && store.set(KEY_STORE, JSON.stringify({ priv: { kty: 'EC', crv: 'P-256', x: privJwk.x, y: privJwk.y, d: privJwk.d }, pub }));
  return { priv, pub, pubStr: pubStrOf(pub), persisted };
}
function ensureKeys() {
  if (me) return Promise.resolve(me);
  if (!mePromise) mePromise = loadKeys().then((k) => (me = k)).catch(() => { mePromise = null; return null; });
  return mePromise;
}
async function sign(msg) { return b64(await subtle.sign(SIG, me.priv, enc.encode(msg))); }

// ---------- known-claims cache (memory + localStorage) ----------
function loadCache() {
  const raw = store.get(CACHE_STORE);
  if (!raw || raw.length > 400000) return;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || j.p !== prefix || !j.r || typeof j.r !== 'object') return;
    for (const [norm, e] of Object.entries(j.r)) {
      if (!e || typeof e !== 'object' || typeof e.h !== 'string') continue;
      // records are re-verified lazily: store them as "unverified" and verify on first use
      reg.set(norm, { rec: e.rec, pubStr: null, firstSeen: Number(e.f) || 0, unverified: true, h: e.h });
      hashToNorm.set(e.h, norm);
    }
  } catch (e) { /* ignore corrupt cache */ }
}
let saveTimer = null;
function saveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const ents = [...reg.entries()].filter(([, e]) => e.h).sort((a, b) => b[1].firstSeen - a[1].firstSeen).slice(0, CACHE_MAX);
    const r = {};
    for (const [norm, e] of ents) r[norm] = { rec: e.rec, f: e.firstSeen, h: e.h };
    store.set(CACHE_STORE, JSON.stringify({ p: prefix, r }));
  }, 300);
}

// Validate an untrusted record against its topic hash. Returns {rec, pubStr, norm} or null.
async function validate(hex, rec) {
  try {
    if (!rec || typeof rec !== 'object' || rec.v !== 1 || typeof rec.nick !== 'string' || typeof rec.sig !== 'string') return null;
    const t = rec.t;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < T_MIN || t > Date.now() + T_FUTURE_MS) return null;
    const pub = pubShape(rec.pub);
    if (!pub) return null;
    const nick = cleanDisplay(rec.nick);
    const norm = normalizeNick(nick);
    if (!norm || nick !== rec.nick || RESERVED_N.has(norm)) return null;
    if ((await sha256hex(norm)) !== hex) return null;
    if (!(await verifySig(pub, 'claim|' + norm + '|' + t, rec.sig))) return null;
    return { rec: { v: 1, nick, pub, t, sig: rec.sig }, pubStr: pubStrOf(pub), norm };
  } catch (e) { return null; }
}
const beats = (a, b) => a.rec.t < b.rec.t || (a.rec.t === b.rec.t && a.pubStr < b.pubStr);

async function resolveCached(norm) {
  const cur = reg.get(norm);
  if (!cur || !cur.unverified) return cur || null;
  const v = await validate(cur.h, cur.rec);
  if (!v || v.norm !== norm) { if (reg.get(norm) === cur) reg.delete(norm); return null; }
  if (reg.get(norm) === cur) { cur.rec = v.rec; cur.pubStr = v.pubStr; cur.unverified = false; }
  return reg.get(norm);
}

// Offer a validated record to the local registry. Returns true if it is (now) the accepted record.
async function offer(hex, v) {
  const norm = v.norm;
  hashToNorm.set(hex, norm);
  let cur = await resolveCached(norm);
  const now = Date.now();
  if (!cur) {
    reg.set(norm, { rec: v.rec, pubStr: v.pubStr, firstSeen: now, h: hex });
    saveCache(); notify(); return true;
  }
  if (cur.pubStr === v.pubStr) return true;
  if (now - cur.firstSeen < SETTLE_MS && beats(v, cur)) {
    reg.set(norm, { rec: v.rec, pubStr: v.pubStr, firstSeen: cur.firstSeen, h: hex });
    saveCache(); notify(); return true;
  }
  // rejected: if the accepted record is ours, heal the retained copy
  if (me && cur.pubStr === me.pubStr) republish(norm, cur.rec, hex);
  return false;
}
function notify() { for (const f of [...waiters]) { try { f(); } catch (e) { /* ignore */ } } }
function waitFor(pred, ms) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; waiters.delete(check); clearTimeout(tm); resolve(v); };
    const check = () => { try { if (pred()) fin(true); } catch (e) { /* ignore */ } };
    const tm = setTimeout(() => fin(false), ms);
    waiters.add(check); check();
  });
}

function republish(norm, rec, hex) {
  const now = Date.now();
  if (now - (lastRepub.get(norm) || 0) < 3000) return;
  lastRepub.set(norm, now);
  pub(topicFor(hex), JSON.stringify(rec));
}

// ---------- adapter wrappers ----------
async function sub(topic) { try { await A.subscribe(topic); return true; } catch (e) { return false; } }
async function unsub(topic) { try { if (A.unsubscribe) await A.unsubscribe(topic); } catch (e) { /* ignore */ } }
function pub(topic, s) { try { const r = A.publish(topic, s, { retain: true }); if (r && r.catch) r.catch(() => {}); return true; } catch (e) { return false; } }
function online() { try { return !A.online || A.online() !== false; } catch (e) { return true; } }

const echoes = new Set();      // hex topics where we saw our own record come back
function onRaw(topic, payload) {
  try {
    if (typeof topic !== 'string') return;
    const base = prefix + 'names/';
    if (!topic.startsWith(base)) return;
    const hex = topic.slice(base.length);
    if (!/^[0-9a-f]{64}$/.test(hex)) return;
    let s = payload;
    if (s && typeof s !== 'string') { if (s.length > MAX_PAYLOAD) return; s = dec.decode(s); }
    if (typeof s !== 'string' || s.length > MAX_PAYLOAD) return;
    if (!s) { // retained deletion
      const norm = hashToNorm.get(hex), cur = norm && reg.get(norm);
      if (cur && me && cur.pubStr === me.pubStr) republish(norm, cur.rec, hex);
      return;
    }
    const now = Date.now();           // budget before any crypto: 10/s global, 3/s per topic
    if (now - rawBudget.t > 1000) rawBudget = { t: now, n: 0 };
    if (++rawBudget.n > 10) return;
    let tb = rawTopic.get(hex);
    if (!tb || now - tb.t > 1000) { if (rawTopic.size > 500) rawTopic.clear(); tb = { t: now, n: 0 }; rawTopic.set(hex, tb); }
    if (++tb.n > 3) return;
    let rec; try { rec = JSON.parse(s); } catch (e) { return; }
    validate(hex, rec).then((v) => {
      if (!v) return;
      if (me && v.pubStr === me.pubStr) echoes.add(hex);
      return offer(hex, v);
    }).catch(() => {});
  } catch (e) { /* never throw into the MQTT client */ }
}

// ---------- API ----------
export async function initNames(adapter) {
  try {
    if (!adapter || typeof adapter.subscribe !== 'function' || typeof adapter.publish !== 'function' || typeof adapter.onMessage !== 'function') return;
    if (!subtle) return;
    A = adapter;
    if (typeof adapter.prefix === 'string' && /^[\w\-./]{1,80}\/$/.test(adapter.prefix)) prefix = adapter.prefix;
    reg.clear(); hashToNorm.clear(); loadCache();
    adapter.onMessage(onRaw);
    ensureKeys();
  } catch (e) { /* never throw */ }
}

export async function claimNick(display) {
  try {
    const nick = cleanDisplay(display);
    const norm = normalizeNick(nick);
    if (!norm || [...nick].length > MAX_LEN) return { status: 'invalid', reason: '1~20자 이름이 필요합니다' };
    if (RESERVED_N.has(norm)) return { status: 'reserved', reason: '쓸 수 없는 이름입니다' };
    if (!subtle) return { status: 'unsupported', reason: 'crypto unavailable' };
    if (!A || !online()) return { status: 'offline', reason: 'not connected' };
    const k = await ensureKeys();
    if (!k) return { status: 'offline', reason: 'crypto unavailable' };
    const hex = await sha256hex(norm);
    hashToNorm.set(hex, norm);
    const topic = topicFor(hex);
    if (!(await sub(topic))) return { status: 'offline', reason: 'subscribe failed' };

    // 1) existing record? (cached or retained)
    const existing = () => { const c = reg.get(norm); return c && !c.unverified ? c : null; };
    await resolveCached(norm);
    if (!existing()) await waitFor(() => !!existing(), CLAIM_WAIT_MS);
    let cur = existing();
    const persistNote = k.persisted ? undefined : 'storage-unavailable: claim lasts this session only';
    if (cur && cur.pubStr !== k.pubStr) { await unsub(topic); return { status: 'taken', reason: 'already claimed' }; }

    if (cur && cur.pubStr === k.pubStr) {           // reclaim
      pub(topic, JSON.stringify(cur.rec));            // refresh retained copy (no-op if identical)
      mine = { norm, nick: cur.rec.nick, rec: cur.rec, hex };
      return persistNote ? { status: 'ok', nick: cur.rec.nick, reason: persistNote } : { status: 'ok', nick: cur.rec.nick };
    }

    // 2) publish our claim
    const t = Date.now();
    const rec = { v: 1, nick, pub: k.pub, t, sig: await sign('claim|' + norm + '|' + t) };
    const v = await validate(hex, rec);
    if (!v) return { status: 'invalid', reason: 'self-check failed' };
    echoes.delete(hex);
    await offer(hex, v);
    if (!pub(topic, JSON.stringify(rec))) { reg.delete(norm); return { status: 'offline', reason: 'publish failed' }; }

    // 3) re-read: stay subscribed (live competitors arrive), then re-subscribe to fetch the retained copy
    await sleep(REREAD_MS);
    await sub(topic);
    await waitFor(() => echoes.has(hex), REREAD_WAIT_MS);
    cur = existing();
    if (!cur || cur.pubStr !== k.pubStr) { await unsub(topic); return { status: 'taken', reason: 'lost race' }; }
    if (!echoes.has(hex)) { reg.delete(norm); saveCache(); await unsub(topic); return { status: 'offline', reason: 'claim not confirmed by broker' }; }
    mine = { norm, nick, rec, hex };               // keep subscribed: heal overwrites
    return persistNote ? { status: 'ok', nick, reason: persistNote } : { status: 'ok', nick };
  } catch (e) {
    return { status: 'offline', reason: 'error: ' + ((e && e.message) || e) };
  }
}

export async function signPresence(id) {
  try {
    if (!mine || !me || typeof id !== 'string' || !id || id.length > 64) return null;
    const c = presSigned.get(id);
    if (c && c.np === mine.norm) return c;
    const out = { np: mine.norm, ns: await sign('pres|' + id + '|' + mine.norm) };
    presSigned.set(id, out);
    return out;
  } catch (e) { return null; }
}

async function lookup(norm) {
  const got = await resolveCached(norm);
  if (got) return got;
  if (!A) return null;
  if (lookups.has(norm)) return lookups.get(norm);
  const now = Date.now();
  if (now - lookupBudget.t > 10000) lookupBudget = { t: now, n: 0 };
  if (++lookupBudget.n > 30) return null;
  const p = (async () => {
    const hex = await sha256hex(norm);
    hashToNorm.set(hex, norm);
    const topic = topicFor(hex);
    if (!(await sub(topic))) return null;
    await waitFor(() => { const c = reg.get(norm); return c && !c.unverified; }, LOOKUP_WAIT_MS);
    if (!mine || mine.norm !== norm) await unsub(topic);
    return reg.get(norm) || null;
  })().catch(() => null).finally(() => lookups.delete(norm));
  lookups.set(norm, p);
  return p;
}

export async function verifyPeer(id, display, np, ns) {
  try {
    if (typeof id !== 'string' || !id || id.length > 64 || typeof np !== 'string' || typeof ns !== 'string' || ns.length > 200) return null;
    const norm = normalizeNick(np);
    if (!norm || norm !== np || normalizeNick(display) !== norm) return null;
    const key = id + '|' + np + '|' + ns;
    const bad = presBad.get(key);
    if (bad && bad > Date.now()) return null;
    const ok = presOk.get(key);
    const cur0 = reg.get(norm);
    if (ok && cur0 && !cur0.unverified && cur0.pubStr === ok) return cur0.rec.nick;
    const cur = await lookup(norm);
    if (!cur || cur.unverified) { presBad.set(key, Date.now() + 15000); trimMap(presBad); return null; }
    const now = Date.now();           // retry later: no presBad when over budget
    if (now - sigBudget.t > 1000) sigBudget = { t: now, n: 0 };
    if (++sigBudget.n > 20) return null;
    if (await verifySig(cur.rec.pub, 'pres|' + id + '|' + norm, ns)) {
      presOk.set(key, cur.pubStr); trimMap(presOk);
      return cur.rec.nick;
    }
    presBad.set(key, Date.now() + 60000); trimMap(presBad);
    return null;
  } catch (e) { return null; }
}
function trimMap(m) { if (m.size > 1000) m.delete(m.keys().next().value); }

export function myNick() { return mine ? mine.nick : ''; }
