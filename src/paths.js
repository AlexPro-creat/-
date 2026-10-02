// Где хранятся изменяемые данные (база db.json и вложения uploads/) — Фаза 42, 01.10.2026.
// На Render подключён постоянный диск /var/data (2 ГБ): всё, что пишется туда,
// переживает деплои. Порядок выбора: переменная окружения DATA_DIR → /var/data,
// если такая папка есть (диск Render) → папка data/ в проекте (локальный запуск).
// Статичные файлы импорта (data/import/*.json) остаются в проекте — они приходят с кодом.
const fs = require('fs');
const path = require('path');

function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try {
    if (fs.existsSync('/var/data') && fs.statSync('/var/data').isDirectory()) {
      fs.accessSync('/var/data', fs.constants.W_OK);
      return '/var/data';
    }
  } catch (e) { /* нет диска или нет прав — работаем в папке проекта */ }
  return path.join(__dirname, '..', 'data');
}

const PERSIST_DIR = pickDataDir();
const DB_FILE = path.join(PERSIST_DIR, 'db.json');
const UPLOADS_DIR = path.join(PERSIST_DIR, 'uploads');
// Файлы, которые загружаются через панель (долги) — тоже на постоянном диске.
const OVERRIDES_DIR = path.join(PERSIST_DIR, 'import-overrides');

module.exports = { PERSIST_DIR, DB_FILE, UPLOADS_DIR, OVERRIDES_DIR };
