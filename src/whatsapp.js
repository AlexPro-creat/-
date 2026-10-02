// Фаза 43 (02.10.2026): привязка переписки WhatsApp к клиентам.
//
// Каждый торговый агент подключает СВОЙ номер как «связанное устройство»
// (WhatsApp → Настройки → Связанные устройства → Привязать устройство → QR из CRM).
// CRM только ЧИТАЕТ сообщения личных чатов этого номера и ничего не отправляет.
// Группы, статусы и каналы игнорируются.
//
// Хранение — на постоянном диске (src/paths.js → /var/data/whatsapp):
//   auth/<agentId>/        ключи подключения (если удалить — нужно сканировать QR заново)
//   messages/<agentId>.jsonl  сообщения, по одному JSON в строке (дописываются в конец)
//   lid/<agentId>.json      соответствие «скрытый идентификатор WhatsApp (LID) → номер»
//
// Сопоставление с клиентом — по последним 9 цифрам номера (кыргызские номера
// пишутся и как 0555…, и как +996555…), плюс ручные привязки client.waPhones.
//
// Библиотека подключения (@whiskeysockets/baileys) ставится через npm на Render
// (Build Command: npm install). Если её нет — CRM работает как раньше, а во вкладке
// WhatsApp видно, что модуль не установлен.

const fs = require('fs');
const path = require('path');
const { PERSIST_DIR } = require('./paths');

const WA_DIR = path.join(PERSIST_DIR, 'whatsapp');
const AUTH_DIR = path.join(WA_DIR, 'auth');
const MSG_DIR = path.join(WA_DIR, 'messages');
const LID_DIR = path.join(WA_DIR, 'lid');
const MEDIA_DIR = path.join(WA_DIR, 'media');

// Вложения (02.10.2026): фото, голосовые/аудио, документы, видео скачиваются на диск.
// Один файл — не больше MEDIA_MAX_FILE; вся папка — не больше MEDIA_CAP_TOTAL
// (при превышении удаляются самые старые файлы, сама переписка остаётся).
const MEDIA_MAX_FILE = 15 * 1024 * 1024;
const MEDIA_CAP_TOTAL = 1200 * 1024 * 1024;
const MEDIA_PRUNE_TO = 1000 * 1024 * 1024;
const MEDIA_TYPES = { image: 'imageMessage', audio: 'audioMessage', video: 'videoMessage', document: 'documentMessage' };

let db = null;

// ---- библиотека ----
let lib = null;          // { baileys, QRCode, logger }
let libError = null;
let libLoading = null;

function silentLogger() {
  const l = {
    level: 'silent',
    child() { return l; },
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    isLevelEnabled() { return false; }
  };
  return l;
}

async function loadLib() {
  if (lib) return lib;
  if (libLoading) return libLoading;
  libLoading = (async () => {
    try {
      const modB = await import('@whiskeysockets/baileys');
      const baileys = Object.assign({}, modB.default || {}, modB);
      if (typeof baileys.makeWASocket !== 'function') {
        const d = modB.default;
        baileys.makeWASocket = typeof d === 'function' ? d : (d && typeof d.default === 'function' ? d.default : null);
      }
      if (typeof baileys.makeWASocket !== 'function') throw new Error('makeWASocket не найден в библиотеке');
      const modQ = await import('qrcode');
      const QRCode = modQ.default && modQ.default.toDataURL ? modQ.default : modQ;
      let logger = silentLogger();
      try { const pino = require('pino'); logger = pino({ level: 'silent' }); } catch (e) { /* хватит заглушки */ }
      lib = { baileys, QRCode, logger };
      libError = null;
      return lib;
    } catch (e) {
      libError = 'Библиотека WhatsApp не установлена на сервере. В настройках Render (Settings → Build Command) впишите «npm install» и сделайте Manual Deploy. (' + e.message + ')';
      libLoading = null;
      return null;
    }
  })();
  return libLoading;
}

// ---- номера ----
function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 9) return null;
  return d.slice(-9);
}

// Все номера из строки телефона клиента ("0555123456 / 0700 11 22 33, +996 777…").
function phoneKeysFromString(s) {
  if (!s) return [];
  const keys = [];
  String(s).split(/[\/,;]|\s{2,}/).forEach((part) => {
    const k = phoneKey(part);
    if (k && !keys.includes(k)) keys.push(k);
  });
  return keys;
}

function clientKeys(c) {
  const keys = phoneKeysFromString(c.phone);
  (c.waPhones || []).forEach((k) => { if (k && !keys.includes(k)) keys.push(k); });
  return keys;
}

// key → [clientId...] (по всем клиентам, кроме удалённых)
function buildClientIndex() {
  const idx = new Map();
  db.all('clients').forEach((c) => {
    clientKeys(c).forEach((k) => {
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(c.id);
    });
  });
  return idx;
}

function displayKey(key) {
  if (!key) return '';
  if (key.startsWith('lid:')) return 'скрытый номер';
  return '+996 ' + key.slice(0, 3) + ' ' + key.slice(3, 6) + ' ' + key.slice(6);
}

// ---- хранилище сообщений ----
// msgs: agentId → { ids:Set, byKey: Map(key → [rec]) }
const store = new Map();
const lidMaps = new Map(); // agentId → { lidNumber: phoneDigits }

function agentStore(agentId) {
  if (!store.has(agentId)) store.set(agentId, { ids: new Set(), byKey: new Map(), count: 0, lastAt: 0 });
  return store.get(agentId);
}

function addToMemory(rec) {
  const s = agentStore(rec.a);
  if (s.ids.has(rec.id)) return false;
  s.ids.add(rec.id);
  if (!s.byKey.has(rec.k)) s.byKey.set(rec.k, []);
  s.byKey.get(rec.k).push(rec);
  s.count++;
  if (rec.t > s.lastAt) s.lastAt = rec.t;
  return true;
}

function loadMessages() {
  if (!fs.existsSync(MSG_DIR)) return;
  fs.readdirSync(MSG_DIR).filter((f) => f.endsWith('.jsonl')).forEach((f) => {
    const lines = fs.readFileSync(path.join(MSG_DIR, f), 'utf8').split('\n');
    lines.forEach((line) => {
      if (!line.trim()) return;
      try { addToMemory(JSON.parse(line)); } catch (e) { /* битая строка — пропускаем */ }
    });
  });
  store.forEach((s) => s.byKey.forEach((arr) => arr.sort((a, b) => a.t - b.t)));
}

function saveRecords(agentId, recs) {
  const fresh = recs.filter(addToMemory);
  if (!fresh.length) return [];
  fs.mkdirSync(MSG_DIR, { recursive: true });
  fs.appendFileSync(path.join(MSG_DIR, agentId + '.jsonl'), fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const s = agentStore(agentId);
  new Set(fresh.map((r) => r.k)).forEach((k) => s.byKey.get(k).sort((a, b) => a.t - b.t));
  return fresh;
}

function lidMap(agentId) {
  if (!lidMaps.has(agentId)) {
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(LID_DIR, agentId + '.json'), 'utf8')); } catch (e) {}
    lidMaps.set(agentId, m);
  }
  return lidMaps.get(agentId);
}

function rememberLid(agentId, lidJid, pnJid) {
  if (!lidJid || !pnJid) return;
  const lid = String(lidJid).split('@')[0].split(':')[0];
  const pn = String(pnJid).split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!lid || pn.length < 9) return;
  const m = lidMap(agentId);
  if (m[lid] === pn) return;
  m[lid] = pn;
  try {
    fs.mkdirSync(LID_DIR, { recursive: true });
    fs.writeFileSync(path.join(LID_DIR, agentId + '.json'), JSON.stringify(m), 'utf8');
  } catch (e) {}
}

// Из любого объекта события вытаскиваем пары «…@lid» ↔ «…@s.whatsapp.net».
function learnPairs(agentId, obj) {
  if (!obj || typeof obj !== 'object') return;
  let lid = null, pn = null;
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (typeof v !== 'string') return;
    if (v.endsWith('@lid')) lid = v;
    else if (v.endsWith('@s.whatsapp.net')) pn = v;
  });
  if (!pn && typeof obj.phoneNumber === 'string') pn = obj.phoneNumber + (obj.phoneNumber.includes('@') ? '' : '@s.whatsapp.net');
  if (lid && pn) rememberLid(agentId, lid, pn);
}

function isPersonalJid(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@c.us'));
}

function chatKeyFor(agentId, key) {
  const jid = key.remoteJid;
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) return phoneKey(jid.split('@')[0].split(':')[0]);
  // @lid — ищем настоящий номер
  const alt = [key.remoteJidAlt, key.senderPn, key.participantPn, key.participantAlt].find((x) => typeof x === 'string' && x.includes('@s.whatsapp.net'));
  if (alt) { rememberLid(agentId, jid, alt); return phoneKey(alt.split('@')[0].split(':')[0]); }
  const lid = jid.split('@')[0].split(':')[0];
  const pn = lidMap(agentId)[lid];
  if (pn) return phoneKey(pn);
  return 'lid:' + lid;
}

function unwrap(m) {
  let msg = m;
  for (let i = 0; i < 5 && msg; i++) {
    const inner = (msg.ephemeralMessage && msg.ephemeralMessage.message)
      || (msg.viewOnceMessage && msg.viewOnceMessage.message)
      || (msg.viewOnceMessageV2 && msg.viewOnceMessageV2.message)
      || (msg.viewOnceMessageV2Extension && msg.viewOnceMessageV2Extension.message)
      || (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message)
      || (msg.editedMessage && msg.editedMessage.message);
    if (!inner) break;
    msg = inner;
  }
  return msg;
}

// → { ty, x } или null (служебные сообщения, реакции и т.п. не храним)
function extractContent(message) {
  const m = unwrap(message);
  if (!m) return null;
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;
  if (typeof m.conversation === 'string' && m.conversation) return { ty: 'text', x: m.conversation };
  if (m.extendedTextMessage) return { ty: 'text', x: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { ty: 'image', x: '[Фото]' + (m.imageMessage.caption ? ' ' + m.imageMessage.caption : '') };
  if (m.videoMessage) return { ty: 'video', x: '[Видео]' + (m.videoMessage.caption ? ' ' + m.videoMessage.caption : '') };
  if (m.audioMessage) return { ty: 'audio', x: m.audioMessage.ptt ? '[Голосовое сообщение]' : '[Аудио]' };
  if (m.documentMessage) return { ty: 'document', x: '[Документ] ' + (m.documentMessage.fileName || m.documentMessage.title || '') + (m.documentMessage.caption ? ' — ' + m.documentMessage.caption : '') };
  if (m.stickerMessage) return { ty: 'sticker', x: '[Стикер]' };
  if (m.locationMessage || m.liveLocationMessage) return { ty: 'location', x: '[Геолокация]' };
  if (m.contactMessage) return { ty: 'contact', x: '[Контакт] ' + (m.contactMessage.displayName || '') };
  if (m.contactsArrayMessage) return { ty: 'contact', x: '[Контакты]' };
  if (m.pollCreationMessage || m.pollCreationMessageV3) return { ty: 'poll', x: '[Опрос] ' + ((m.pollCreationMessage || m.pollCreationMessageV3).name || '') };
  if (m.buttonsResponseMessage) return { ty: 'text', x: m.buttonsResponseMessage.selectedDisplayText || '' };
  if (m.listResponseMessage) return { ty: 'text', x: m.listResponseMessage.title || '' };
  if (m.templateMessage || m.buttonsMessage || m.interactiveMessage) return { ty: 'text', x: '[Сообщение с кнопками]' };
  return null;
}

function tsOf(v) {
  if (v == null) return Math.floor(Date.now() / 1000);
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v === 'object' && 'low' in v) return v.low >>> 0;
  return Number(v) || Math.floor(Date.now() / 1000);
}

function toRecord(agentId, msg) {
  if (!msg || !msg.key || !isPersonalJid(msg.key.remoteJid)) return null;
  const c = extractContent(msg.message);
  if (!c) return null;
  const k = chatKeyFor(agentId, msg.key);
  if (!k) return null;
  return {
    id: msg.key.id,
    a: agentId,
    k,
    me: !!msg.key.fromMe,
    t: tsOf(msg.messageTimestamp),
    x: String(c.x || '').slice(0, 4000),
    ty: c.ty,
    n: msg.key.fromMe ? '' : (msg.pushName || ''),
    ...mediaMeta(msg.message, c.ty)
  };
}

// ---- вложения ----
function extFor(mime, fileName) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf'
  };
  if (map[m]) return map[m];
  const fx = fileName && String(fileName).match(/\.([A-Za-z0-9]{1,6})$/);
  if (fx) return fx[1].toLowerCase();
  return 'bin';
}

function mediaMeta(message, ty) {
  const field = MEDIA_TYPES[ty];
  if (!field) return {};
  const m = unwrap(message);
  const node = m && m[field];
  if (!node) return {};
  const size = tsOf(node.fileLength) || 0;
  const out = { mt: node.mimetype || '', ext: extFor(node.mimetype, node.fileName), sz: size };
  if (node.fileName) out.fn = String(node.fileName).slice(0, 200);
  if (ty === 'audio' && node.seconds) out.sec = Number(node.seconds) || 0;
  return out;
}

function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, ''); }
function mediaFile(rec) {
  if (!rec || !rec.ext) return null;
  return path.join(MEDIA_DIR, String(rec.a), safeId(rec.id) + '.' + rec.ext);
}
function hasMediaFile(rec) {
  const f = mediaFile(rec);
  return !!(f && fs.existsSync(f));
}

let mediaTotal = null;
function mediaUsage() {
  if (mediaTotal !== null) return mediaTotal;
  mediaTotal = 0;
  try {
    fs.readdirSync(MEDIA_DIR).forEach((d) => {
      const dir = path.join(MEDIA_DIR, d);
      fs.readdirSync(dir).forEach((f) => { try { mediaTotal += fs.statSync(path.join(dir, f)).size; } catch (e) {} });
    });
  } catch (e) {}
  return mediaTotal;
}

function pruneMedia() {
  if (mediaUsage() <= MEDIA_CAP_TOTAL) return;
  const files = [];
  try {
    fs.readdirSync(MEDIA_DIR).forEach((d) => {
      const dir = path.join(MEDIA_DIR, d);
      fs.readdirSync(dir).forEach((f) => {
        try { const st = fs.statSync(path.join(dir, f)); files.push({ p: path.join(dir, f), t: st.mtimeMs, s: st.size }); } catch (e) {}
      });
    });
  } catch (e) {}
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (mediaTotal <= MEDIA_PRUNE_TO) break;
    try { fs.unlinkSync(f.p); mediaTotal -= f.s; } catch (e) {}
  }
  console.log('WhatsApp: место под вложения превысило лимит — удалены самые старые файлы.');
}

// Очередь скачивания: по одному файлу за раз, чтобы не раздувать память.
const mediaQueue = [];
let mediaBusy = false;

function enqueueMedia(agentId, msg, rec) {
  if (!rec || !rec.ext || !MEDIA_TYPES[rec.ty]) return;
  if (rec.sz && rec.sz > MEDIA_MAX_FILE) return;
  if (hasMediaFile(rec)) return;
  mediaQueue.push({ agentId, msg, rec });
  if (mediaQueue.length > 2000) mediaQueue.splice(0, mediaQueue.length - 2000);
  runMediaQueue();
}

async function runMediaQueue() {
  if (mediaBusy) return;
  mediaBusy = true;
  try {
    while (mediaQueue.length) {
      const job = mediaQueue.shift();
      const c = conns.get(job.agentId);
      if (!lib || !lib.baileys.downloadMediaMessage) continue;
      try {
        const buf = await lib.baileys.downloadMediaMessage(job.msg, 'buffer', {}, {
          logger: lib.logger,
          reuploadRequest: c && c.sock && c.sock.updateMediaMessage ? c.sock.updateMediaMessage : undefined
        });
        if (!buf || !buf.length || buf.length > MEDIA_MAX_FILE) continue;
        const f = mediaFile(job.rec);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, buf);
        mediaUsage();
        mediaTotal += buf.length;
        pruneMedia();
      } catch (e) {
        // старые вложения из истории WhatsApp может уже не отдать — просто пропускаем
      }
    }
  } finally {
    mediaBusy = false;
  }
}

function saveWithMedia(agentId, msgs) {
  const pairs = msgs.map((m) => ({ m, r: toRecord(agentId, m) })).filter((x) => x.r);
  if (!pairs.length) return;
  const fresh = new Set(saveRecords(agentId, pairs.map((x) => x.r)));
  pairs.forEach((x) => { if (fresh.has(x.r)) enqueueMedia(agentId, x.m, x.r); });
}

// ---- подключения ----
// agentId → { sock, gen, status, qr, phone, note, since, manualStop, attempts, timer }
const conns = new Map();

function conn(agentId) {
  if (!conns.has(agentId)) conns.set(agentId, { sock: null, gen: 0, status: 'off', qr: null, phone: null, note: '', since: null, manualStop: false, attempts: 0, timer: null });
  return conns.get(agentId);
}

function authPath(agentId) { return path.join(AUTH_DIR, String(agentId)); }
function hasAuth(agentId) { return fs.existsSync(path.join(authPath(agentId), 'creds.json')); }

function wipeAuth(agentId) {
  try { fs.rmSync(authPath(agentId), { recursive: true, force: true }); } catch (e) {}
}

function stopSocket(c) {
  if (c.timer) { clearTimeout(c.timer); c.timer = null; }
  if (c.sock) {
    const s = c.sock;
    c.sock = null;
    try { s.ev.removeAllListeners && s.ev.removeAllListeners(); } catch (e) {}
    try { s.end(undefined); } catch (e) {}
  }
}

async function connect(agentId) {
  agentId = Number(agentId);
  const L = await loadLib();
  const c = conn(agentId);
  if (!L) { c.status = 'error'; c.note = libError; return c; }
  const { baileys, QRCode, logger } = L;
  stopSocket(c);
  c.manualStop = false;
  c.gen++;
  const gen = c.gen;
  c.status = 'connecting';
  c.qr = null;
  c.note = '';
  fs.mkdirSync(authPath(agentId), { recursive: true });

  let sock;
  try {
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authPath(agentId));
    let version;
    try { if (baileys.fetchLatestBaileysVersion) version = (await baileys.fetchLatestBaileysVersion()).version; } catch (e) {}
    const opts = {
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['CRM Cosmedeca', 'Chrome', '1.0'],
      markOnlineOnConnect: false,   // чтобы у агента на телефоне продолжали приходить уведомления
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
      shouldIgnoreJid: (jid) => !isPersonalJid(jid)
    };
    if (version) opts.version = version;
    sock = baileys.makeWASocket(opts);
    // CRM никогда не ставит «прочитано» (синие галочки): сообщения остаются
    // непрочитанными на телефоне агента, пока он сам их не откроет.
    sock.readMessages = async () => {};
    c.sock = sock;
    const alive = () => c.gen === gen;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (!alive()) return;
      if (u.qr) {
        try { c.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }); } catch (e) { c.qr = null; c.note = 'Не удалось нарисовать QR: ' + e.message; }
        c.status = 'qr';
      }
      if (u.connection === 'open') {
        c.status = 'connected';
        c.qr = null;
        c.note = '';
        c.attempts = 0;
        c.since = new Date().toISOString();
        const me = sock.user && sock.user.id ? String(sock.user.id).split('@')[0].split(':')[0] : null;
        c.phone = me;
        if (sock.user) learnPairs(agentId, { a: sock.user.id, b: sock.user.lid });
        // Держим CRM «не в сети»: тогда WhatsApp шлёт только «неактивные» отчёты о
        // доставке, а уведомления и непрочитанные продолжают приходить на телефон.
        try { if (sock.sendPresenceUpdate) sock.sendPresenceUpdate('unavailable').catch(() => {}); } catch (e) {}
        console.log(`WhatsApp: агент #${agentId} подключён (${me || 'номер не определён'})`);
      }
      if (u.connection === 'close') {
        const err = u.lastDisconnect && u.lastDisconnect.error;
        const code = err && err.output ? err.output.statusCode : (err && err.statusCode);
        const R = baileys.DisconnectReason || {};
        c.sock = null;
        c.qr = null;
        if (c.manualStop) { c.status = 'off'; return; }
        if (code === (R.loggedOut || 401)) {
          wipeAuth(agentId);
          c.status = 'off';
          c.note = 'Устройство отвязано на телефоне — чтобы подключить снова, нажмите «Подключить» и отсканируйте QR.';
          console.log(`WhatsApp: агент #${agentId} — отвязан на телефоне`);
          return;
        }
        if (code === (R.connectionReplaced || 440)) {
          c.status = 'off';
          c.note = 'Подключение перехвачено другим сеансом CRM. Нажмите «Подключить» ещё раз.';
          return;
        }
        if (code === (R.forbidden || 403)) {
          c.status = 'off';
          c.note = 'WhatsApp отказал в доступе (номер ограничен или заблокирован).';
          console.log(`WhatsApp: агент #${agentId} — 403 forbidden`);
          return;
        }
        const registered = !!(state.creds && (state.creds.registered || state.creds.me));
        if (!registered && code !== (R.restartRequired || 515)) {
          c.status = 'off';
          c.note = 'QR не был отсканирован вовремя. Нажмите «Подключить» и отсканируйте новый код.';
          return;
        }
        // обрыв связи / перезапуск после сканирования — переподключаемся
        c.status = 'connecting';
        const delay = code === (R.restartRequired || 515) ? 500 : Math.min(60000, 5000 * Math.pow(2, c.attempts));
        c.attempts++;
        c.timer = setTimeout(() => { if (alive()) connect(agentId).catch((e) => console.error('WhatsApp reconnect', e)); }, delay);
      }
    });

    sock.ev.on('messages.upsert', (ev) => {
      if (!alive()) return;
      try {
        const msgs = (ev && ev.messages) || [];
        msgs.forEach((m) => m && m.key && learnPairs(agentId, m.key));
        saveWithMedia(agentId, msgs);
      } catch (e) { console.error('WhatsApp messages.upsert', e); }
    });

    sock.ev.on('messaging-history.set', (ev) => {
      if (!alive()) return;
      try {
        (ev.contacts || []).forEach((x) => learnPairs(agentId, x));
        (ev.chats || []).forEach((x) => learnPairs(agentId, x));
        saveWithMedia(agentId, ev.messages || []);
      } catch (e) { console.error('WhatsApp history', e); }
    });

    const onContacts = (list) => { if (alive()) (list || []).forEach((x) => learnPairs(agentId, x)); };
    sock.ev.on('contacts.upsert', onContacts);
    sock.ev.on('contacts.update', onContacts);
    sock.ev.on('chats.upsert', onContacts);
    sock.ev.on('lid-mapping.update', (x) => { if (alive()) (Array.isArray(x) ? x : [x]).forEach((p) => learnPairs(agentId, p)); });
  } catch (e) {
    c.status = 'error';
    c.note = 'Ошибка подключения: ' + e.message;
    console.error('WhatsApp connect', e);
  }
  return c;
}

async function disconnect(agentId, logout) {
  agentId = Number(agentId);
  const c = conn(agentId);
  c.manualStop = true;
  c.gen++;
  if (logout && c.sock && typeof c.sock.logout === 'function') {
    try { await c.sock.logout(); } catch (e) {}
  }
  stopSocket(c);
  if (logout) { wipeAuth(agentId); c.phone = null; }
  c.status = 'off';
  c.qr = null;
  c.note = logout ? 'Отключено. Переписка, сохранённая ранее, остаётся в CRM.' : 'Приостановлено.';
  return c;
}

function statusOf(agentId) {
  const c = conn(agentId);
  const s = agentStore(agentId);
  return {
    status: c.status,
    qr: c.status === 'qr' ? c.qr : null,
    phone: c.phone,
    note: c.note,
    since: c.since,
    linked: hasAuth(agentId),
    msgCount: s.count,
    lastAt: s.lastAt ? new Date(s.lastAt * 1000).toISOString() : null
  };
}

// ---- выборки для API ----
function messagesForClient(client, agentFilter) {
  const keys = clientKeys(client);
  const out = [];
  store.forEach((s, agentId) => {
    if (agentFilter && agentId !== agentFilter) return;
    keys.forEach((k) => (s.byKey.get(k) || []).forEach((r) => out.push(r)));
  });
  out.sort((a, b) => a.t - b.t);
  return { keys, messages: out };
}

function unmatchedChats(agentFilter) {
  const idx = buildClientIndex();
  const out = [];
  store.forEach((s, agentId) => {
    if (agentFilter && agentId !== agentFilter) return;
    s.byKey.forEach((arr, k) => {
      if (idx.has(k) || !arr.length) return;
      const last = arr[arr.length - 1];
      const named = arr.slice().reverse().find((r) => r.n);
      out.push({
        key: k,
        display: displayKey(k),
        agentId,
        name: named ? named.n : '',
        count: arr.length,
        lastAt: new Date(last.t * 1000).toISOString(),
        lastText: (last.me ? 'Вы: ' : '') + last.x.slice(0, 120)
      });
    });
  });
  out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  return out;
}

function chatMessages(agentId, key) {
  const s = store.get(Number(agentId));
  return s && s.byKey.get(key) ? s.byKey.get(key).slice() : [];
}

// Сводка «по клиентам»: clientId → { count, lastAt } — для отметки в таблице.
function clientSummary(agentFilter) {
  const idx = buildClientIndex();
  const out = {};
  store.forEach((s, agentId) => {
    if (agentFilter && agentId !== agentFilter) return;
    s.byKey.forEach((arr, k) => {
      (idx.get(k) || []).forEach((cid) => {
        const o = out[cid] || (out[cid] = { count: 0, lastAt: 0 });
        o.count += arr.length;
        const t = arr[arr.length - 1].t;
        if (t > o.lastAt) o.lastAt = t;
      });
    });
  });
  return out;
}

function init(database) {
  db = database;
  try { loadMessages(); } catch (e) { console.error('WhatsApp: не удалось прочитать сохранённые сообщения', e); }
  // Автоподключение тех, кто уже сканировал QR (ключи лежат на диске).
  let pending = [];
  try { pending = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR).map(Number).filter((id) => id && hasAuth(id)) : []; } catch (e) {}
  if (pending.length) {
    loadLib().then((L) => {
      if (!L) { console.log('WhatsApp: ' + libError); return; }
      pending.forEach((id, i) => setTimeout(() => connect(id).catch((e) => console.error(e)), 2000 * i));
      console.log(`WhatsApp: переподключаю агентов: ${pending.join(', ')}`);
    });
  } else {
    loadLib().then((L) => { if (!L) console.log('WhatsApp: модуль не установлен (Build Command: npm install).'); });
  }
}

// Для выдачи в API: добавляем признак «файл скачан» (hm) к сообщениям с вложением.
function withMediaFlags(list) {
  return list.map((r) => (r.ext ? Object.assign({}, r, { hm: hasMediaFile(r) }) : r));
}

// Путь к файлу вложения по агенту и id сообщения (для отдачи через API).
function mediaForMessage(agentId, msgId) {
  const s = store.get(Number(agentId));
  if (!s) return null;
  const id = safeId(msgId);
  for (const arr of s.byKey.values()) {
    const r = arr.find((x) => x.id === id);
    if (r) { const f = mediaFile(r); return f && fs.existsSync(f) ? { file: f, mime: r.mt || 'application/octet-stream', name: r.fn || (id + '.' + r.ext) } : null; }
  }
  return null;
}

module.exports = {
  withMediaFlags, mediaForMessage,
  init, connect, disconnect, statusOf, loadLib,
  libStatus: () => ({ ok: !!lib, error: lib ? null : libError }),
  messagesForClient, unmatchedChats, chatMessages, clientSummary,
  phoneKey, phoneKeysFromString, displayKey,
  // для тестов
  _toRecord: toRecord, _saveRecords: saveRecords
};
