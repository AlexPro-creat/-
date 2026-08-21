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

function agentUserMap() {
  const map = {};
  db.all('users').filter((u) => u.role === 'agent').forEach((u) => { map[norm(u.name)] = u; });
  return map;
}

function computeAssortment(rawItems) {
  if (!rawItems || !rawItems.length) return [];
  const latestMonth = rawItems.reduce((latest, it) => {
    const li = MONTH_ORDER.indexOf(latest);
    const ci = MONTH_ORDER.indexOf(it.last_month);
    return ci > li ? it.last_month : latest;
  }, rawItems[0].last_month);
  return rawItems.map((it) => ({
    product: it.product,
    monthsCount: it.months_count,
    lastMonth: it.last_month,
    avgQty: it.avg_qty,
    // Товар был регулярным, но в последнем доступном месяце его не покупали — риск "отвала".
    // Ограничение: данные о продажах помесячные, а не по датам, поэтому это приближение
    // к правилу «не заказывал 14+ дней», а не точный расчёт по дням.
    atRisk: it.last_month !== latestMonth
  }));
}

function runImport() {
  db.ensureLoaded();

  const createdAgents = ensureTeam();
  const usersCreated = !!createdAgents;
  const agentsByName = agentUserMap();
  const adminUser = db.all('users').find((u) => u.role === 'admin');

  const contractors = loadJson('agents_clients.json') || [];
  const assortmentMap = loadJson('regular_assortment.json') || {};
  const debts = loadJson('debts.json') || [];

  const debtByName = {};
  debts.forEach((d) => { debtByName[norm(d.client_name)] = d; });

  const assortmentByName = {};
  Object.keys(assortmentMap).forEach((k) => { assortmentByName[norm(k)] = assortmentMap[k]; });

  let clientsCreated = 0;
  let clientsUpdated = 0;
  const now = new Date().toISOString();

  contractors.forEach((c) => {
    const key = norm(c.name);
    const assortmentRaw = assortmentByName[key];
    const debt = debtByName[key];
    const owner = agentsByName[norm(c.agent)] || adminUser;

    let existing = db.all('clients').find((cl) => norm(cl.name) === key);

    const computedFields = {
      regularAssortment: computeAssortment(assortmentRaw),
      debtAmount: debt ? debt.debt_amount : 0,
      debtOverdue: debt ? !!debt.is_overdue : false,
      debtAsOf: debt ? (debt.payment_date || null) : null
    };

    if (!existing) {
      db.insert('clients', {
        name: c.name,
        pointType: c.point_type || '',
        address: c.address || '',
        phone: c.phone || '',
        contactName: c.contact_name || '',
        visitDay: c.visit_day || '',
        contractStatus: c.contract_status || 'неизвестно',
        paymentMethod: '',
        notes: c.note_from_import || '',
        ownerId: owner ? owner.id : adminUser.id,
        isOffRoute: false,
        pendingApproval: false,
        createdAt: now,
        ...computedFields
      });
      clientsCreated++;
    } else {
      db.update('clients', existing.id, computedFields);
      clientsUpdated++;
    }
  });

  return { usersCreated, clientsCreated, clientsUpdated };
}

module.exports = { runImport };
