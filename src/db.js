// Простое файловое хранилище на JSON. Без внешних зависимостей.
// Подходит для небольшой команды (десятки пользователей, тысячи записей).
// Все операции синхронные — для CRM с несколькими одновременными пользователями этого достаточно.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function emptyState() {
  return {
    counters: { users: 0, clients: 0, tasks: 0 },
    users: [],
    clients: [],
    tasks: [],
    sessions: {}
  };
}

let state = null;

function ensureLoaded() {
  if (state) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    state = emptyState();
    persist();
    return;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = Object.assign(emptyState(), JSON.parse(raw));
  } catch (err) {
    console.error('Не удалось прочитать data/db.json, создаю новую базу:', err.message);
    // Бэкапим повреждённый файл, чтобы не потерять данные безвозвратно
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now()); } catch (e) {}
    state = emptyState();
    persist();
  }
}

function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE); // атомарная замена файла
}

function nextId(collection) {
  ensureLoaded();
  state.counters[collection] = (state.counters[collection] || 0) + 1;
  return state.counters[collection];
}

// ---- Универсальные CRUD-хелперы ----

function all(collection) {
  ensureLoaded();
  return state[collection];
}

function find(collection, id) {
  ensureLoaded();
  return state[collection].find((r) => r.id === Number(id));
}

function insert(collection, record) {
  ensureLoaded();
  const row = Object.assign({ id: nextId(collection) }, record);
  state[collection].push(row);
  persist();
  return row;
}

function update(collection, id, patch) {
  ensureLoaded();
  const row = find(collection, id);
  if (!row) return null;
  Object.assign(row, patch);
  persist();
  return row;
}

function remove(collection, id) {
  ensureLoaded();
  const idx = state[collection].findIndex((r) => r.id === Number(id));
  if (idx === -1) return false;
  state[collection].splice(idx, 1);
  persist();
  return true;
}

// ---- Сессии (хранятся в базе, чтобы переживать перезапуск сервера) ----

function createSession(token, userId, expiresAt) {
  ensureLoaded();
  state.sessions[token] = { userId, expiresAt };
  persist();
}

function getSession(token) {
  ensureLoaded();
  const s = state.sessions[token];
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    delete state.sessions[token];
    persist();
    return null;
  }
  return s;
}

function deleteSession(token) {
  ensureLoaded();
  if (state.sessions[token]) {
    delete state.sessions[token];
    persist();
  }
}

module.exports = {
  ensureLoaded,
  all,
  find,
  insert,
  update,
  remove,
  createSession,
  getSession,
  deleteSession
};
