// Прямая выгрузка строк в Google Таблицу — без единой npm-библиотеки.
// Используется для автовыгрузки "провальных" задач воронки продажи (см. api.js).
//
// Как включить (когда будут готовы данные от пользователя):
// 1. Создать сервис-аккаунт в Google Cloud Console, включить Google Sheets API.
// 2. Скачать JSON-ключ сервис-аккаунта.
// 3. Открыть доступ (редактор) к нужной Google Таблице для email сервис-аккаунта
//    (он выглядит как ...@...iam.gserviceaccount.com).
// 4. Положить файл data/google-sheets-config.json (см. пример ниже, сам файл
//    в .gitignore — секреты в репозиторий не попадают):
//    {
//      "clientEmail": "xxx@yyy.iam.gserviceaccount.com",
//      "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
//      "spreadsheetId": "1AbCдлинный_ID_из_ссылки_на_таблицу",
//      "sheetName": "Провалы"
//    }
// Пока файла нет — функция тихо ничего не делает (не ломает основной поток).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'google-sheets-config.json');

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!raw.clientEmail || !raw.privateKey || !raw.spreadsheetId) return null;
    return raw;
  } catch (e) {
    console.error('google-sheets-config.json: ошибка чтения —', e.message);
    return null;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildSignedJwt(config) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: config.clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(config.privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return unsigned + '.' + signature;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(config) {
  const jwt = buildSignedJwt(config);
  const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt);
  const result = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  if (!result.access_token) throw new Error('Не удалось получить access_token: ' + JSON.stringify(result));
  return result.access_token;
}

// Добавляет одну строку в конец листа. rowValues — простой массив значений.
async function appendRow(rowValues) {
  const config = loadConfig();
  if (!config) return { skipped: true, reason: 'Настройка Google Sheets ещё не выполнена (нет data/google-sheets-config.json)' };
  try {
    const accessToken = await getAccessToken(config);
    const range = encodeURIComponent((config.sheetName || 'Лист1') + '!A1');
    const body = JSON.stringify({ values: [rowValues] });
    const result = await httpsRequest({
      hostname: 'sheets.googleapis.com',
      path: `/v4/spreadsheets/${config.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
    return { ok: true, result };
  } catch (e) {
    console.error('Ошибка выгрузки в Google Таблицу:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { appendRow, loadConfig };
