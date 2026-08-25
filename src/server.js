const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const Router = require('./router');
const api = require('./api');
const db = require('./db');
const auth = require('./auth');
const { runImport } = require('./import');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.ico': 'image/x-icon'
};

const router = new Router();
api.register(router);

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  // Защита от выхода за пределы public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(400).end('Bad request');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-фолбэк: неизвестные пути отдаём как index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveUpload(req, res, pathname) {
  // /uploads/<taskId>/<filename> — только для вошедших пользователей
  const user = auth.currentUser(req);
  if (!user) return res.writeHead(401).end('Требуется вход в систему');

  const rel = pathname.replace(/^\/uploads\//, '');
  const filePath = path.join(UPLOADS_DIR, rel);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.writeHead(400).end('Bad request');

  fs.readFile(filePath, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

db.ensureLoaded();

// При каждом запуске подтягиваем/обновляем данные из data/import/*.json (контрагенты,
// регулярный ассортимент, долги) — если файлы есть. Новых контрагентов и пользователей
// создаём один раз; расчётные поля (ассортимент/долг) обновляем при каждом запуске,
// а вручную исправленные карточки (адрес/телефон и т.п.) не трогаем.
const importResult = runImport();
if (importResult.usersCreated) {
  console.log(`Первый запуск: создана команда (администратор + супервайзер + агенты).`);
  console.log('ВАЖНО: смените пароли после первого входа (раздел «Команда»).');
}
if (importResult.clientsCreated || importResult.clientsUpdated) {
  console.log(`Импорт данных: новых контрагентов — ${importResult.clientsCreated}, обновлено (ассортимент/долг) — ${importResult.clientsUpdated}.`);
}
if (importResult.extraAgentsAdded) {
  console.log(`Добавлено новых торговых агентов: ${importResult.extraAgentsAdded} (Батаева/Жанара/Анастасия).`);
}

// Миграция старых данных под новую схему (см. api.js) — безопасно запускать
// при каждом старте, после первого раза она ничего не делает.
api.migrateLegacyTaskStages();
api.migrateClientDefaults();

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    const match = router.match(req.method, pathname);
    if (!match) {
      api.sendJson(res, 404, { error: 'Метод/маршрут не найден' });
      return;
    }
    Promise.resolve(match.handler(req, res, match.params)).catch((err) => {
      console.error(err);
      if (!res.headersSent) api.sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    });
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    return serveUpload(req, res, pathname);
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`CRM запущена: http://localhost:${PORT}`);
});
