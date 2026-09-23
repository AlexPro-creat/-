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
const agentSales = require('./agentSales');

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

  // Планы по брендам (Фаза 37, 21.09.2026) — по просьбе пользователя, прописаны
  // статично из его файла "Проекция продажи сентябрь на 04.09 123.xlsx" (разбивка
  // EPICA/Kapous/Остальное по каждому ТП). "Статично" значит: значения живут
  // только в этом JSON-файле в репозитории (не в БД, не редактируются через
  // интерфейс) — применяются к агентам заново при КАЖДОМ старте сервера, поэтому
  // переживают сброс базы при передеплое (в отличие от user.monthlyPlan, который
  // хранится в БД и стирается вместе с ней, пока не подключён постоянный диск).
  // Меняются только когда пользователь явно попросит новую задачу на изменение —
  // тогда правим data/import/brand_plans.json и пересобираем.
  // Общий "План (мес.)" (Фаза 37.1, 21.09.2026) — пользователь увидел на дашборде
  // "план не задан" у всех агентов, т.к. это отдельное поле (user.monthlyPlan,
  // задаётся вручную на странице «Команда» через /api/users/:id/plan) — оно НЕ
  // связано с планами по брендам выше и никогда не заполнялось. Чтобы не заставлять
  // вручную дублировать те же цифры, общий план на агента теперь = сумма его же
  // EPICA+Kapous+Остальное из того же файла — считается из brandPlansMap ниже и
  // применяется так же статично (каждый старт сервера), как и planPlans по брендам.
  // Если понадобится завести план, отличающийся от простой суммы по брендам —
  // это отдельная задача (например, флаг "не перезаписывать вручную заданное").
  const brandPlansMap = loadJson('brand_plans.json') || {};
  Object.keys(brandPlansMap).forEach((agentName) => {
    const agent = agentsByName[norm(agentName)];
    if (!agent) return;
    const buckets = brandPlansMap[agentName];
    const totalPlan = Object.values(buckets).reduce((s, v) => s + (Number(v) || 0), 0);
    db.update('users', agent.id, { brandPlans: buckets, monthlyPlan: totalPlan });
  });

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
  // С Фазы 39 (23.09.2026) продажи текущего месяца живут в agent_sales.json
  // (срезы ПО АГЕНТАМ) и раскладываются по карточкам ПОСЛЕ цикла ниже — см.
  // src/agentSales.js и блок «Раскладка срезов» в конце runImportBody().
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

  // Постоянные переназначения карточек между агентами (Фаза 39,
  // data/import/client_reassignments.json) — до сопоставления ниже, чтобы на
  // живой базе карточка сменила агента, а не задвоилась.
  const reassign = (loadJson('client_reassignments.json') || {}).moves || [];
  reassign.forEach((m) => {
    const from = agentsByName[norm(m.from)];
    const to = agentsByName[norm(m.to)];
    if (!from || !to) return;
    const card = db.all('clients').find((cl) => norm(cl.name) === norm(m.name) && cl.ownerId === from.id);
    const already = db.all('clients').find((cl) => norm(cl.name) === norm(m.name) && cl.ownerId === to.id);
    if (card && !already) db.update('clients', card.id, { ownerId: to.id });
  });

  contractors.forEach((c) => {
    const key = norm(c.name);
    const assortmentRaw = assortmentByName[key];
    const testAssortmentRaw = testAssortmentByName[key];
    const debt = debtByName[key];
    const promotions = promotionsByName[key] || [];
    const owner = agentsByName[norm(c.agent)] || adminUser;
    const activeMonths = activeMonthsByName[key] || [];
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

  // ---- Раскладка срезов продаж по агентам (Фаза 39, 23.09.2026) ----
  // Факт агента = «Итого» его последнего файла; строки по клиентам ложатся на
  // карточки по имени (свой агент → другие агенты), см. src/agentSales.js.
  // Карточки, которым ничего не досталось, обнуляются — это заменило прежнюю
  // «очистку осиротевших карточек» (Фаза 22) и current_month_sales.json.
  // Технические карточки-«корректировки» (Фазы 25/38) больше не нужны —
  // удаляем их, если к ним не привязано ни одной задачи.
  db.beginBatch();
  let salesResult;
  try {
    const tasks = db.all('tasks');
    db.all('clients')
      .filter((c) => /^Корректировка отгрузки /.test(c.name || '') && !tasks.some((t) => t.clientId === c.id))
      .forEach((c) => db.remove('clients', c.id));

    salesResult = agentSales.distribute(agentSales.loadSlices(), db.all('clients'), db.all('users'));
    db.all('clients').forEach((c) => {
      const got = salesResult.byClientId[c.id];
      const revenue = got ? got.revenue : 0;
      const items = got ? got.items : [];
      if ((c.currentMonthRevenue || 0) !== revenue || JSON.stringify(c.currentMonthItems || []) !== JSON.stringify(items)) {
        db.update('clients', c.id, { currentMonthRevenue: revenue, currentMonthItems: items });
      }
    });
    db.setSetting('agentSales', salesResult.agents);
    db.setSetting('agentSalesCheck', salesResult.check);
  } finally {
    db.endBatch();
  }
  Object.entries(salesResult.check).forEach(([agent, ch]) => {
    if (ch.diff !== 0 || ch.unmatched.length) {
      console.log(`Срез ${agent}: сумма продаж ${ch.total}, по клиентам ${ch.distributed}` + (ch.unmatched.length ? `, не найдены карточки: ${ch.unmatched.map((u) => u.name).join('; ')}` : ''));
    }
  });

  return { usersCreated, extraAgentsAdded, clientsCreated, clientsUpdated };
}

module.exports = { runImport, normalizePhone, MONTH_ORDER };

