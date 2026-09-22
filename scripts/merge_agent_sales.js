// Слияние файла "Анализ <Агент>.xls" (выгрузка продаж за текущий месяц по одному
// агенту, накопительным итогом с начала месяца) в data/import/current_month_sales.json.
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
// ВАЖНЫЕ ПРАВИЛА (все — по прямым решениям пользователя в этом проекте, см.
// README.md/context-brief.md "Фаза 25/31/38" за подробностями и прецедентами):
//
// 1. "Последний файл побеждает" — итог агента должен показывать РОВНО то, что в
//    его последнем файле, а не накопление поверх более старых частичных
//    импортов. Поэтому мы не просто накладываем новые записи поверх старых, а
//    ещё и ОЧИЩАЕМ (удаляем ключ из current_month_sales.json) те клиенты этого
//    агента, которых В НОВОМ ФАЙЛЕ нет — НО ТОЛЬКО если это имя уникально для
//    агента (никакой другой агент в agents_clients.json не делит это же имя).
//    Общие имена (см. п.2) трогать нельзя — их очистка задела бы чужого агента.
//
// 2. current_month_sales.json матчится по имени клиента БЕЗ учёта агента
//    (см. src/import.js: currentMonthByName). Поэтому у клиентов с именем,
//    которое встречается у НЕСКОЛЬКИХ агентов (например задвоенные "Студия
//    Vivienne Lashes" у Альбины/Бегимай, или до Фазы 31 — общее "Частное
//    лицо"), нельзя просто писать под исходным именем: одно число уйдёт сразу
//    всем однофамильцам. Такие случаи решаются через ALIASES ниже — сначала
//    переименованием карточки нужного агента на уникальное имя (Фаза 31, УЖЕ
//    сделано для "Частное лицо" у всех 6 агентов), затем прописыванием алиаса
//    "как называется в файле агента" -> "под каким ключом писать".
//
// 3. Если клиент из файла реально принадлежит (в agents_clients.json) ДРУГОМУ
//    агенту, и пользователь подтвердил не переназначать карточку — сумму всё
//    равно нужно засчитать этому агенту в общий итог. Решение (Фаза 25) —
//    техническая карточка-корректировка "Корректировка отгрузки <Агент>
//    (клиент закреплён за <Другой>)", заведённая в agents_clients.json за
//    ЭТИМ агентом; алиас в ALIASES ниже перенаправляет сумму именно туда,
//    а не в карточку реального владельца (которую руками не трогаем — так
//    сохраняется её собственный итог нетронутым, ценой сознательного
//    задвоения суммы в общекомандном итоге супервайзера, что пользователем
//    уже принято как компромисс в Фазе 25).
//
// Персональные алиасы по каждому агенту живут в
// data/import/client_name_aliases.json — правь их там, не здесь, когда
// появится новый похожий случай; сам скрипт остаётся общим.

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

function buildProductLookup(currentMonth) {
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
  Object.values(currentMonth).forEach((c) => feed(c.items || []));
  return lookup;
}

function main() {
  const [, , agentName, filePath] = process.argv;
  if (!agentName || !filePath) {
    console.error('Использование: node scripts/merge_agent_sales.js "<Агент>" <путь-к-xlsx>');
    process.exit(1);
  }

  const parsed = parseAgentFile(filePath);
  console.log(`Клиентов в файле: ${parsed.clientOrder.length}`);
  console.log(`Итого (из файла): qty=${parsed.itogoQty} sum=${parsed.itogoSum}`);
  const sumOk = parsed.totalQty === parsed.itogoQty && parsed.totalSum === parsed.itogoSum;
  console.log(`Сумма по товарным строкам: qty=${parsed.totalQty} sum=${parsed.totalSum} ${sumOk ? 'OK' : 'MISMATCH!'}`);
  if (!sumOk) {
    console.error('Сумма не сошлась с "Итого" файла — остановлено, проверь файл вручную.');
    process.exit(1);
  }
  if (parsed.unexplained.length) {
    console.log('Товарные строки без клиента (пропущены):', JSON.stringify(parsed.unexplained));
  }

  const contractors = loadJson('agents_clients.json');
  const aliasesAll = (() => {
    try { return loadJson('client_name_aliases.json'); } catch (e) { return {}; }
  })();
  const aliases = aliasesAll[agentName] || {};

  // Имена, которые встречаются больше чем у одного агента в agents_clients.json —
  // их нельзя молча "очищать при отсутствии в новом файле" (задело бы другого
  // агента). Список считаем по ВСЕЙ базе, не только по этому агенту.
  const nameOwners = {};
  contractors.forEach((c) => {
    const k = norm(c.name);
    if (!nameOwners[k]) nameOwners[k] = new Set();
    nameOwners[k].add(c.agent);
  });
  function isSharedName(name) {
    const owners = nameOwners[norm(name)];
    return owners && owners.size > 1;
  }

  const currentPath = path.join(IMPORT_DIR, 'current_month_sales.json');
  const currentMonth = loadJson('current_month_sales.json');
  const existingByNorm = {};
  Object.keys(currentMonth).forEach((k) => { existingByNorm[norm(k)] = k; });

  const productLookup = buildProductLookup(currentMonth);
  let matchedProducts = 0;
  const unmatchedProducts = [];

  // ---- Шаг 1: "последний файл побеждает" — чистим ключи, которые принадлежат
  // ТОЛЬКО этому агенту (уникальное имя) и не встречаются в новом файле. ----
  const fileNamesNorm = new Set(parsed.clientOrder.map((n) => norm(aliases[n] ? aliases[n].target : n)));
  const agentOwnClients = contractors.filter((c) => c.agent === agentName);
  let cleared = 0;
  agentOwnClients.forEach((c) => {
    if (isSharedName(c.name)) return; // общее имя с другим агентом — не трогаем
    const nk = norm(c.name);
    if (fileNamesNorm.has(nk)) return; // есть в новом файле — будет перезаписано ниже
    if (existingByNorm[nk] !== undefined) {
      delete currentMonth[existingByNorm[nk]];
      delete existingByNorm[nk];
      cleared++;
    }
  });
  console.log(`Очищено (было в базе за ${agentName}, нет в новом файле, имя уникально): ${cleared}`);

  // ---- Шаг 2: применяем данные файла (с учётом алиасов) ----
  let overwritten = 0, added = 0;
  parsed.clientOrder.forEach((rawName) => {
    const alias = aliases[rawName];
    const targetName = alias ? alias.target : rawName;
    const items = parsed.clients[rawName].items.map((it) => {
      const key = norm(it.product);
      const found = productLookup[key];
      if (found) matchedProducts++; else unmatchedProducts.push(it.product);
      return {
        product: it.product,
        brand: found ? found.brand : null,
        category: found ? found.category : null,
        qty: it.qty,
        revenue: it.revenue
      };
    });
    const revenue = items.reduce((s, it) => s + it.revenue, 0);
    const nk = norm(targetName);
    const existingKey = existingByNorm[nk];
    if (existingKey) {
      currentMonth[existingKey] = { revenue, items };
      overwritten++;
    } else {
      currentMonth[targetName] = { revenue, items };
      existingByNorm[nk] = targetName;
      added++;
    }
  });

  console.log(`Товарных строк: ${matchedProducts + unmatchedProducts.length} matched: ${matchedProducts} unmatched: ${unmatchedProducts.length}`);
  if (unmatchedProducts.length) console.log('Unmatched products:', JSON.stringify(unmatchedProducts, null, 2));
  console.log(`Перезаписано ключей: ${overwritten}, добавлено новых: ${added}`);
  console.log('Итого ключей в current_month_sales.json:', Object.keys(currentMonth).length);

  fs.writeFileSync(currentPath, JSON.stringify(currentMonth, null, 2) + '\n');
  console.log('Записано в', currentPath);
}

main();
