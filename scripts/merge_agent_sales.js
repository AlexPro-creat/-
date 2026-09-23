// Слияние файла "Анализ <Агент>.xls" (выгрузка продаж за текущий месяц по одному
// агенту, накопительным итогом с начала месяца) в data/import/agent_sales.json (срез агента целиком).
//
// Это НЕ часть работающего сервера — ручной инструмент обслуживания, запускается
// самим Клодом при получении нового файла от пользователя (нет UI для загрузки
// текущих продаж, в отличие от долгов — см. src/debtLedger.js/api.js). Раньше эта
// логика писалась каждый раз заново одноразовым скриптом в /tmp и терялась между
// сессиями; вынесена сюда постоянным файлом по просьбе пользователя (Фаза 38,
// 22.09.2026 — "запиши в константы"), чтобы правила запоминались один раз.
//
// Использование:
//   node scripts/merge_agent_sales.js "Бегимай" /tmp/analiz_begimai.xlsx
//
// Файл должен быть уже сконвертирован в .xlsx (LibreOffice: soffice --headless
// --convert-to xlsx), т.к. наш ридер (src/fileTable.js) не читает старый бинарный
// .xls/.xlsb — см. XLSB_ERROR/XLS_ERROR там же.
//
// Формат исходного файла (стандартная выгрузка "Анализ <Агент>"): первая строка —
// период, вторая — ФИО агента, дальше таблица "Контрагент/Номенклатура | Адрес |
// Количество | Сумма", где ЖИРНАЯ строка — клиент (итоги по нему), обычные строки
// под ней — товарные позиции, а между товарными позициями — служебные строки
// "Реализация NNNN (дата)", которые нужно игнорировать. Наш ридер жирность не
// сохраняет, поэтому тип строки определяется по соседям: если СЛЕДУЮЩАЯ строка
// начинается с "Реализация" — эта строка товарная, иначе — клиент.
//
// ПРАВИЛО (Фаза 39, 23.09.2026, прямое указание пользователя): «сумма
// выполнения берётся по срезу, а уже по клиентам раскидывается как надо».
//   - Файл агента ЦЕЛИКОМ заменяет его срез в data/import/agent_sales.json
//     (total = «Итого» файла — это и есть факт агента на дашборде).
//   - Раскладка строк по карточкам клиентов делается при старте сервера
//     (src/agentSales.js): свой агент → другие агенты. Технические карточки-
//     «корректировки» (Фазы 25/38) больше не нужны.
//   - Скрипт печатает короткую сверку «сумма продаж N, по клиентам M» и список
//     клиентов без карточки — если есть расхождение, коротко сообщить
//     пользователю, он уточнит (новых клиентов заводим только по его ответу).
//
// Алиасы имён (как клиент назван в файле агента → имя карточки) — в
// data/import/client_name_aliases.json.

const fs = require('fs');
const path = require('path');
const { parseTableFile } = require('../src/fileTable');

const ROOT = path.join(__dirname, '..');
const IMPORT_DIR = path.join(ROOT, 'data', 'import');

function norm(s) {
  return (s || '').toString().trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(IMPORT_DIR, name), 'utf8'));
}

function parseAgentFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const rows = parseTableFile(path.basename(filePath), buf);
  const headerIdx = rows.findIndex((r) => (r[0] || '').trim() === 'Контрагент/Номенклатура');
  if (headerIdx === -1) throw new Error('Заголовок "Контрагент/Номенклатура" не найден — не тот формат файла?');
  const itogoIdx = rows.findIndex((r) => (r[0] || '').trim() === 'Итого');
  if (itogoIdx === -1) throw new Error('Строка "Итого" не найдена');
  const dataRows = rows.slice(headerIdx + 1, itogoIdx).filter((r) => r[0] && r[0].trim());
  const itogoQty = Number(rows[itogoIdx][2]) || 0;
  const itogoSum = Number(rows[itogoIdx][3]) || 0;

  const n = dataRows.length;
  const rowType = new Array(n);
  for (let i = 0; i < n; i++) {
    if ((dataRows[i][0] || '').trim().startsWith('Реализация')) rowType[i] = 'R';
  }
  for (let i = 0; i < n; i++) {
    if (rowType[i]) continue;
    rowType[i] = (i + 1 < n && rowType[i + 1] === 'R') ? 'P' : 'C';
  }

  const clients = {}; // исходное имя из файла -> {qty, revenue, items:[{product,qty,revenue}]}
  const clientOrder = [];
  let current = null;
  const unexplained = [];
  for (let i = 0; i < n; i++) {
    const t = rowType[i];
    const name = (dataRows[i][0] || '').trim();
    const qty = Number(dataRows[i][2]) || 0;
    const revenue = Number(dataRows[i][3]) || 0;
    if (t === 'C') {
      current = { items: [] };
      clients[name] = current;
      clientOrder.push(name);
    } else if (t === 'P') {
      if (!current) { unexplained.push(name); continue; }
      current.items.push({ product: name, qty, revenue });
    }
  }

  const totalQty = clientOrder.reduce((s, k) => s + clients[k].items.reduce((s2, it) => s2 + it.qty, 0), 0);
  const totalSum = clientOrder.reduce((s, k) => s + clients[k].items.reduce((s2, it) => s2 + it.revenue, 0), 0);

  return { clients, clientOrder, itogoQty, itogoSum, totalQty, totalSum, unexplained };
}

function buildProductLookup(slices) {
  const regular = loadJson('regular_assortment.json');
  const test = loadJson('test_assortment.json');
  const lookup = {};
  function feed(items) {
    (items || []).forEach((it) => {
      const key = norm(it.product);
      if (!key) return;
      if (!lookup[key]) lookup[key] = { brand: it.brand || null, category: it.category || null };
    });
  }
  Object.values(regular).forEach(feed);
  Object.values(test).forEach(feed);
  Object.keys(slices).forEach((k) => {
    if (slices[k] && Array.isArray(slices[k].clients)) slices[k].clients.forEach((c) => feed(c.items));
  });
  return lookup;
}

// Бренд по префиксу — то же правило, что во всём проекте (Фаза 14), для товаров,
// которых ещё нет в справочниках.
function brandByPrefix(product) {
  const p = norm(product);
  if (p.startsWith('e ')) return 'EPICA';
  if (p.startsWith('hy ')) return 'Kapous';
  if (p.startsWith('s ')) return 'Studio';
  if (/^(av|es|pro|ms) /.test(p)) return 'AV/ES/PRO/MS';
  if (p.includes('epica')) return 'EPICA';
  if (p.includes('kapous')) return 'Kapous';
  if (!/^[a-z]/.test(p)) return 'Чистовье';
  return 'Прочее';
}

function main() {
  const [, , agentName, filePath, period, asOf] = process.argv;
  if (!agentName || !filePath) {
    console.error('Использование: node scripts/merge_agent_sales.js "<Агент>" <путь-к-xlsx> ["01.09–25.09.26"] [2026-09-25]');
    process.exit(1);
  }

  const parsed = parseAgentFile(filePath);
  console.log(`Клиентов в файле: ${parsed.clientOrder.length}`);
  console.log(`Итого (из файла): qty=${parsed.itogoQty} sum=${parsed.itogoSum}`);
  const sumOk = parsed.totalQty === parsed.itogoQty && parsed.totalSum === parsed.itogoSum;
  console.log(`Сумма по товарным строкам: qty=${parsed.totalQty} sum=${parsed.totalSum} ${sumOk ? 'OK' : 'РАСХОЖДЕНИЕ'}`);
  if (parsed.unexplained.length) console.log('Товарные строки без клиента:', JSON.stringify(parsed.unexplained));

  const slicesPath = path.join(IMPORT_DIR, 'agent_sales.json');
  const slices = loadJson('agent_sales.json');
  const lookup = buildProductLookup(slices);
  let byPrefix = 0;

  const clients = parsed.clientOrder.map((rawName) => {
    const items = parsed.clients[rawName].items.map((it) => {
      const found = lookup[norm(it.product)];
      if (!found) byPrefix++;
      return {
        product: it.product,
        brand: found && found.brand ? found.brand : brandByPrefix(it.product),
        category: found ? found.category : null,
        qty: it.qty,
        revenue: it.revenue
      };
    });
    return { name: rawName, revenue: items.reduce((s, it) => s + it.revenue, 0), items };
  });

  const prev = slices[agentName] || {};
  slices[agentName] = {
    period: period || prev.period || '',
    asOf: asOf || new Date().toISOString().slice(0, 10),
    // Факт агента = «Итого» файла (правило пользователя).
    total: parsed.itogoSum,
    qty: parsed.itogoQty,
    clients
  };
  fs.writeFileSync(slicesPath, JSON.stringify(slices, null, 1) + '\n');
  console.log(`Срез ${agentName} записан: total=${parsed.itogoSum}, клиентов=${clients.length}, бренд по префиксу у ${byPrefix} строк`);

  // Предварительная сверка раскладки по карточкам из agents_clients.json
  // (на сервере раскладка идёт по всем карточкам базы, включая заведённые
  // агентами вручную — там может найтись больше).
  const contractors = loadJson('agents_clients.json');
  const aliases = (() => { try { return loadJson('client_name_aliases.json')[agentName] || {}; } catch (e) { return {}; } })();
  const own = new Set(contractors.filter((c) => c.agent === agentName).map((c) => norm(c.name)));
  const other = {};
  contractors.forEach((c) => { if (c.agent !== agentName) (other[norm(c.name)] = other[norm(c.name)] || []).push(c.agent); });
  let distributed = 0;
  const toOthers = [];
  const missing = [];
  clients.forEach((c) => {
    const t = norm(aliases[c.name] ? aliases[c.name].target : c.name);
    if (own.has(t)) distributed += c.revenue;
    else if (other[t]) { distributed += c.revenue; toOthers.push(`${c.name} → ${other[t].join('/')} (${c.revenue})`); }
    else missing.push(`${c.name} (${c.revenue})`);
  });
  console.log(`Сверка: сумма продаж ${parsed.itogoSum}, по клиентам ${distributed}`);
  if (toOthers.length) console.log('На карточки других агентов:\n  ' + toOthers.join('\n  '));
  if (missing.length) console.log('Нет карточки:\n  ' + missing.join('\n  '));
}

main();
