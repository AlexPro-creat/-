// Импорт/обновление реальных данных: контрагенты трёх торговых агентов,
// регулярный ассортимент (по продажам за 7 месяцев) и задолженность.
// Источник — файлы data/import/*.json (я готовлю их из выгрузок с Google Диска).
//
// Логика безопасного повторного импорта (при каждом запуске сервера, в т.ч. после
// редеплоя с обновлёнными файлами):
//  - Пользователи (админ/супервайзер/агенты) создаются только один раз, если их ещё нет.
//  - Новый контрагент из файла, которого ещё нет в базе (по нормализованному имени) — создаётся.
//  - У уже существующего контрагента НЕ трогаем вручную заполняемые поля (адрес/телефон/
//    контактное лицо/день визита/договор/оплата/ответственный) — их мог поправить админ.
//  - Регулярный ассортимент и задолженность обновляются всегда — это "срез на дату".

const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const IMPORT_DIR = path.join(__dirname, '..', 'data', 'import');
const MONTH_ORDER = ['февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август'];

function loadJson(name) {
  const p = path.join(IMPORT_DIR, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`Не удалось прочитать ${name}:`, e.message);
    return null;
  }
}

function norm(s) {
  return (s || '').toString().trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

// Нормализация номера телефона: ведущий 0, если его нет (и номер не в формате
// +996...), убрать все пробелы внутри номера. Несколько номеров через "/" —
// каждый нормализуется отдельно. Используется и здесь (при создании нового
// клиента импортом), и в migrateClientDefaults (api.js) — для уже существующих.
function normalizePhone(phone) {
  if (!phone) return phone;
  return phone.split('/').map((part) => {
    let p = part.replace(/\s+/g, '').trim();
    if (p && !p.startsWith('0') && !p.startsWith('+')) p = '0' + p;
    return p;
  }).filter(Boolean).join(' / ');
}

function ensureTeam() {
  if (db.all('users').length > 0) return false;

  db.insert('users', {
    name: 'Администратор', email: 'admin@cosmedica.local',
    passwordHash: auth.hashPassword('admin123'), role: 'admin', createdAt: new Date().toISOString()
  });
  db.insert('users', {
    name: 'Александр', email: 'alexandr@cosmedica.local',
    passwordHash: auth.hashPassword('super123'), role: 'supervisor', createdAt: new Date().toISOString()
  });
  const agentDefs = [
    { name: 'Нагима', email: 'nagima@cosmedica.local' },
    { name: 'Татьяна', email: 'tatiana@cosmedica.local' },
    { name: 'Альбина', email: 'albina@cosmedica.local' }
  ];
  const agents = {};
  agentDefs.forEach((a) => {
    const u = db.insert('users', {
      name: a.name, email: a.email,
      passwordHash: auth.hashPassword('agent123'), role: 'agent', createdAt: new Date().toISOString()
    });
    agents[a.name] = u;
  });
  return agents;
}

// Фаза 6 (доп.): три новых торговых агента (Батаева регион, Жанара (магазины),
// Анастасия — с Фазы 22 отображается как "Бегимай", логин/почта не менялись),
// добавлены после того, как пользователь прислал ссылки на их таблицы на Google
// Диске. В отличие от ensureTeam() (который создаёт всю команду только на пустой
// базе), эта функция идемпотентна и безопасна на КАЖДОМ старте сервера — добавляет
// только тех агентов из списка, которых ещё нет.
//
// Фаза 22 (08.09.2026): проверка "уже есть?" переведена с имени на email. Раньше
// сверяли по имени — это ломалось при переименовании агента (см. migrateAgentRenames()
// в api.js, которая переименовывает "Анастасия" → "Бегимай" на уже развёрнутых
// базах): если бы сверка на существование здесь всё ещё шла по имени "Бегимай", а
// миграция переименования почему-либо выполнилась ПОСЛЕ этой функции (порядок сейчас
// зафиксирован в server.js: migrateAgentRenames() строго до runImport()), сверка не
// нашла бы совпадения и создала бы вторую, дублирующую запись агента с тем же email.
// Email — стабильный идентификатор, не меняется при переименовании, поэтому сверка
// по нему безопасна независимо от порядка миграций — это дополнительная страховка
// поверх исправленного порядка вызовов, а не замена ему.
function ensureExtraAgents() {
  const existingEmails = new Set(db.all('users').filter((u) => u.role === 'agent').map((u) => (u.email || '').toLowerCase()));
  const extraAgentDefs = [
    { name: 'Батаева', email: 'bataeva@cosmedica.local' },
    { name: 'Жанара', email: 'zhanara@cosmedica.local' },
    { name: 'Бегимай', email: 'anastasia@cosmedica.local' }
  ];
  let added = 0;
  extraAgentDefs.forEach((a) => {
    if (existingEmails.has(a.email.toLowerCase())) return;
    db.insert('users', {
      name: a.name, email: a.email,
      passwordHash: auth.hashPassword('agent123'), role: 'agent', createdAt: new Date().toISOString()
    });
    added++;
  });
  return added;
}

function agentUserMap() {
  const map = {};
  db.all('users').filter((u) => u.role === 'agent').forEach((u) => { map[norm(u.name)] = u; });
  return map;
}

// Остаток на складе для позиции ассортимента — по точному совпадению нормализованного
// названия товара с data/import/stock.json (выгрузка "Актуальные остатки склада").
// Пользователь явно упростил задачу до "поставь кол-во из таблицы к номенклатуре",
// без какого-либо распределения остатка между конкурирующими клиентами — просто lookup.
// Ограничение: названия товаров в файлах продаж обрезаны до 70 символов (так исторически
// выгружались из 1С), поэтому часть позиций (~11% по проверке) не находит пару в остатках
// и остаётся без stockQty (не путать с "остаток = 0" — это именно "нет данных").
function attachStock(item, stockByName) {
  const hit = stockByName[norm(item.product)];
  return {
    ...item,
    stockQty: hit ? hit.qty : null,
    stockUnit: hit ? hit.unit : null
  };
}

// Артикул товара (Фаза 20) — из прайс-листов поставщика (data/import/articles.json,
// построен из 5 присланных прайсов: Чистовье/EPICA/Kapous(+Studio/HY)/Перчатки/Прочие ТД КМ —
// см. articles.json и context-brief.md за 04.09.2026). Тот же принцип lookup по
// точному совпадению нормализованного названия, что и у остатков (attachStock выше);
// прайса на 5-й бренд (AV/ES/PRO/MS, декоративная косметика) пользователь не прислал,
// поэтому эти позиции (и часть с обрезанными/неточными названиями) остаются без
// артикула — покрытие по факту ~83% товарных строк, проверено при подключении.
function attachSku(item, articlesByName) {
  const sku = articlesByName[norm(item.product)] || null;
  return { ...item, sku };
}

// Регулярный ассортимент (правило с 02.09.2026, Фаза 18): товар куплен в
// ОБОИХ последних 2 месяцах окна (последних 6 закрытых месяцев из тех, что
// реально есть в данных — сейчас март-август) И минимум в 4 из этих 6 месяцев.
// Готовые списки (data/import/regular_assortment.json / test_assortment.json)
// уже посчитаны по этому правилу заранее (см. crm-mvp-status.md/Фаза 18) —
// здесь только подмешиваем остаток склада. atRisk («недопродано») сюда
// больше НЕ прибивается гвоздями при импорте — считается динамически при
// каждой отдаче клиента (см. computeAtRisk() в api.js), сверяя этот же
// список regularAssortment с currentMonthItems («продажи текущего месяца»,
// отдельный поток данных) — так «недопродано» обновляется сразу при
// подгрузке свежего среза текущего месяца, не дожидаясь пересборки всего
// ассортимента.
function computeAssortment(rawItems, stockByName, articlesByName) {
  if (!rawItems || !rawItems.length) return [];
  return rawItems.map((it) => attachSku(attachStock({
    product: it.product,
    brand: it.brand || 'Прочее',
    category: it.category || null,
    monthsCount: it.months_count,
    lastMonth: it.last_month,
    avgQty: it.avg_qty,
    revenue: it.revenue || 0,
    margin: it.margin || 0
  }, stockByName), articlesByName));
}

// "Тестовый ассортимент" — товары, купленные хотя бы раз в окне последних 6
// закрытых месяцев, но не прошедшие правило регулярного (не куплен в обоих
// последних 2 месяцах, либо куплен меньше чем в 4 из 6) — комплементарная
// часть того же расчёта, см. комментарий у computeAssortment() выше.
function computeTestAssortment(rawItems, stockByName, articlesByName) {
  if (!rawItems || !rawItems.length) return [];
  return rawItems.map((it) => attachSku(attachStock({
    product: it.product,
    brand: it.brand || 'Прочее',
    category: it.category || null,
    monthsCount: it.months_count,
    lastMonth: it.last_month,
    avgQty: it.avg_qty,
    revenue: it.revenue || 0,
    margin: it.margin || 0
  }, stockByName), articlesByName));
}

function runImport() {
  db.ensureLoaded();
  // Импорт делает сотни insert/update подряд (по контрагенту на строку) — без
  // пакетного режима каждый вызов писал бы на диск ВЕСЬ файл базы (db.js persist()),
  // что при текущем объёме данных (ассортимент/акции/помесячные срезы) ощутимо
  // замедляет каждый перезапуск сервера. beginBatch()/endBatch() сводят это к
  // одной записи на диск в конце — поведение insert/update/remove не меняется.
  db.beginBatch();
  try {
    return runImportBody();
  } finally {
    db.endBatch();
  }
}

function runImportBody() {
  const createdAgents = ensureTeam();
  const usersCreated = !!createdAgents;
  const extraAgentsAdded = ensureExtraAgents();
  const agentsByName = agentUserMap();
  const adminUser = db.all('users').find((u) => u.role === 'admin');

  const contractors = loadJson('agents_clients.json') || [];
  const assortmentMap = loadJson('regular_assortment.json') || {};
  const testAssortmentMap = loadJson('test_assortment.json') || {};
  const debts = loadJson('debts.json') || [];
  // stock.json уже хранит ключи в нормализованном виде (см. build_stock в gdrive-data) —
  // достаточно нормализовать название товара при поиске, сам файл не перестраиваем.
  const stockByName = loadJson('stock.json') || {};
  // Артикул товара (Фаза 20) — уже хранится в articles.json в нормализованном виде
  // (см. attachSku выше), сам файл не перестраиваем при импорте.
  const articlesByName = loadJson('articles.json') || {};
  const promotionsMap = loadJson('promotions.json') || {};
  // Список правок после Фазы 6.1: "постоянный клиент" больше не завязан на
  // regularAssortment (конкретный товар в >=4 из 7 мес.) — теперь это "были
  // покупки (любой ассортимент) 3 последних месяца подряд". Источник —
  // active_months.json (по каждому клиенту — месяцы, где была хотя бы одна
  // покупка, из тех же сырых файлов продаж, что и regular/test assortment).
  const activeMonthsMap = loadJson('active_months.json') || {};
  // Сумма продаж и товарные строки ТОЛЬКО за текущий месяц (август) — для
  // дашборда агента (сумма за месяц вместо суммы за 7 мес., топ по брендам).
  const currentMonthMap = loadJson('current_month_sales.json') || {};
  // По каждому клиенту и каждому месяцу — построчный ассортимент (см. build_assortment_by_month.py
  // в gdrive-data). Нужно для фильтра "по месяцам" в вкладке "Отчёты" (у супервайзера/админа) —
  // 7-месячная агрегация (regular/testAssortment) не хранит разбивку по отдельным месяцам.
  const monthlyAssortmentMap = loadJson('assortment_by_month.json') || {};

  const debtByName = {};
  debts.forEach((d) => { debtByName[norm(d.client_name)] = d; });

  const assortmentByName = {};
  Object.keys(assortmentMap).forEach((k) => { assortmentByName[norm(k)] = assortmentMap[k]; });

  const testAssortmentByName = {};
  Object.keys(testAssortmentMap).forEach((k) => { testAssortmentByName[norm(k)] = testAssortmentMap[k]; });

  const promotionsByName = {};
  Object.keys(promotionsMap).forEach((k) => { promotionsByName[norm(k)] = promotionsMap[k]; });

  const activeMonthsByName = {};
  Object.keys(activeMonthsMap).forEach((k) => { activeMonthsByName[norm(k)] = activeMonthsMap[k]; });

  const currentMonthByName = {};
  Object.keys(currentMonthMap).forEach((k) => { currentMonthByName[norm(k)] = currentMonthMap[k]; });

  const monthlyAssortmentByName = {};
  Object.keys(monthlyAssortmentMap).forEach((k) => { monthlyAssortmentByName[norm(k)] = monthlyAssortmentMap[k]; });

  // Последние 3 месяца из скользящего 7-месячного окна (сейчас: июнь/июль/август).
  const last3Months = MONTH_ORDER.slice(-3);
  function isRegularByLast3Months(activeMonths) {
    if (!activeMonths || !activeMonths.length) return false;
    return last3Months.every((m) => activeMonths.includes(m));
  }

  let clientsCreated = 0;
  let clientsUpdated = 0;
  const now = new Date().toISOString();
  // ID клиентов, реально задетых циклом ниже (найдены среди contractors по имени+владельцу,
  // либо созданы заново) — используется дальше для очистки "осиротевших" карточек.
  const touchedClientIds = new Set();

  contractors.forEach((c) => {
    const key = norm(c.name);
    const assortmentRaw = assortmentByName[key];
    const testAssortmentRaw = testAssortmentByName[key];
    const debt = debtByName[key];
    const promotions = promotionsByName[key] || [];
    const owner = agentsByName[norm(c.agent)] || adminUser;
    const activeMonths = activeMonthsByName[key] || [];
    const currentMonth = currentMonthByName[key] || null;
    // Артикул (Фаза 20) подмешиваем и сюда — тот же lookup, что и в
    // regular/testAssortment, чтобы раздел "Последние продажи" тоже его показывал.
    const monthlyAssortmentRaw = monthlyAssortmentByName[key] || {};
    const monthlyAssortment = {};
    Object.keys(monthlyAssortmentRaw).forEach((m) => {
      monthlyAssortment[m] = (monthlyAssortmentRaw[m] || []).map((it) => attachSku(it, articlesByName));
    });

    // Совпадение ищем в пределах ТОГО ЖЕ агента (owner), а не по всей базе —
    // иначе общие для нескольких агентов ярлыки вроде «Частное лицо»/«Частники»
    // (разные реальные клиенты у разных агентов) схлопывались бы в одну карточку
    // первого встретившегося агента (найдено и исправлено 27.08.2026).
    const ownerId = owner ? owner.id : adminUser.id;
    let existing = db.all('clients').find((cl) => norm(cl.name) === key && cl.ownerId === ownerId);

    const computedFields = {
      regularAssortment: computeAssortment(assortmentRaw, stockByName, articlesByName),
      testAssortment: computeTestAssortment(testAssortmentRaw, stockByName, articlesByName),
      debtAmount: debt ? debt.debt_amount : 0,
      debtOverdue: debt ? !!debt.is_overdue : false,
      debtAsOf: debt ? (debt.payment_date || null) : null,
      // "Акции" (Фаза 6, п.15) — кто что брал по акциям склада/магазина за текущий срез
      // (Загрузка_акции_25.08.xlsx). Как и ассортимент/долг, пересчитывается при каждом
      // импорте целиком — это срез на дату, а не ручное поле.
      promotions,
      // "Постоянный клиент" (новая логика после Фазы 6.1) — покупки 3 последних
      // месяца подряд, независимо от товара. activeMonths хранится целиком —
      // пригодится, если пользователь попросит другой порог месяцев позже.
      activeMonths,
      isRegularClient: isRegularByLast3Months(activeMonths),
      currentMonthRevenue: currentMonth ? currentMonth.revenue : 0,
      currentMonthItems: currentMonth ? currentMonth.items : [],
      // Ассортимент по месяцам { 'февраль': [...], ... } — только для отчёта "по месяцам".
      monthlyAssortment
    };

    if (!existing) {
      const inserted = db.insert('clients', {
        name: c.name,
        pointType: c.point_type || '',
        address: c.address || '',
        phone: normalizePhone(c.phone || ''),
        contactName: c.contact_name || '',
        visitDay: c.visit_day || '',
        contractStatus: c.contract_status || 'неизвестно',
        paymentMethod: '',
        discountTerms: c.discount_terms || '',
        salesPlan: Number(c.sales_plan) || 0,
        notes: c.note_from_import || '',
        ownerId: owner ? owner.id : adminUser.id,
        isOffRoute: false,
        pendingApproval: false,
        createdAt: now,
        ...computedFields
      });
      clientsCreated++;
      touchedClientIds.add(inserted.id);
    } else {
      db.update('clients', existing.id, computedFields);
      clientsUpdated++;
      touchedClientIds.add(existing.id);
    }
  });

  // Обнуляем currentMonthRevenue/currentMonthItems у карточек, которых цикл выше НЕ
  // затронул ("осиротевшие" клиенты — не входят в agents_clients.json вообще: созданы
  // вручную через UI либо остались от ручных сверок прошлых фаз, например Фазы 10/11).
  // Важно: сверяем по touchedClientIds (реально обновлённые записи), а НЕ по имени —
  // currentMonthByName матчит только по имени без учёта владельца, поэтому у карточки
  // с тем же именем, что и у чужого контрагента (например общее "Частное лицо" у
  // нескольких агентов), currentMonthByName[key] был бы непустым, хотя ЭТУ конкретную
  // карточку (другой ownerId) цикл выше не трогал — обнуление по имени такую карточку
  // бы пропустило. Раньше баг был незаметен, потому что withFreshCurrentMonth() обнулял
  // currentMonth* у ВСЕХ клиентов в ответах API, пока CURRENT_MONTH_DATA_STALE_FROM не
  // наступил; как только флаг "протухания" снимается, такие карточки показывают чужие
  // устаревшие суммы как текущие. Найдено и исправлено при загрузке среза за
  // 01.09-07.09.26 (Фаза 22).
  db.beginBatch();
  try {
    db.all('clients').forEach((c) => {
      if (!touchedClientIds.has(c.id) && ((c.currentMonthRevenue || 0) !== 0 || (c.currentMonthItems || []).length)) {
        db.update('clients', c.id, { currentMonthRevenue: 0, currentMonthItems: [] });
      }
    });
  } finally {
    db.endBatch();
  }

  return { usersCreated, extraAgentsAdded, clientsCreated, clientsUpdated };
}

module.exports = { runImport, normalizePhone, MONTH_ORDER };

