// Срезы продаж текущего месяца по агентам (Фаза 39, 23.09.2026).
//
// ПРАВИЛО ПОЛЬЗОВАТЕЛЯ: «сумма выполнения берётся по срезу, а уже по клиентам
// раскидывается как надо». То есть:
//   1. Факт агента за текущий месяц = «Итого» из его ПОСЛЕДНЕГО файла
//      «Анализ <Агент>» (поле total в data/import/agent_sales.json). Не сумма по
//      карточкам клиентов агента — чужие/общие/не найденные клиенты на факт
//      агента больше не влияют.
//   2. Строки файла по клиентам раскладываются на карточки по имени: сначала
//      среди клиентов ЭТОГО агента, затем среди клиентов других агентов
//      (карточка другого агента получает сумму в «Продано в этом месяце», а в
//      факт идёт агенту, который продал). Если одно имя у нескольких чужих
//      агентов — берём первую карточку и помечаем в проверке.
//   3. Если сумма разложенного по карточкам не равна «Итого» — расхождение
//      сохраняется в проверке (agentSalesCheck) и показывается коротко:
//      «сумма продаж N, по клиентам M». Ничего не подгоняем.
//
// Это заменило прежнюю схему current_month_sales.json (ключ = имя клиента без
// агента) и технические карточки-«корректировки» (Фазы 25/38).

const fs = require('fs');
const path = require('path');

const IMPORT_DIR = path.join(__dirname, '..', 'data', 'import');

function norm(s) {
  return (s || '').toString().trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function loadSlices() {
  const p = path.join(IMPORT_DIR, 'agent_sales.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = {};
    Object.keys(raw).forEach((k) => {
      if (k.startsWith('_') || k === 'month') return;
      if (raw[k] && Array.isArray(raw[k].clients)) out[k] = raw[k];
    });
    return out;
  } catch (e) {
    console.error('Не удалось прочитать agent_sales.json:', e.message);
    return {};
  }
}

function loadAliases() {
  const p = path.join(IMPORT_DIR, 'client_name_aliases.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

// clients — все карточки из базы; usersById — {id: user}.
// Возвращает { byClientId: {id: {revenue, items}}, check: {agent: {...}}, agents: {agent: {...}} }
function distribute(slices, clients, users) {
  const aliasesAll = loadAliases();
  const agentIdByName = {};
  users.forEach((u) => { if (u.role === 'agent') agentIdByName[norm(u.name)] = u.id; });
  const cardsByName = {};
  clients.forEach((c) => {
    const k = norm(c.name);
    (cardsByName[k] = cardsByName[k] || []).push(c);
  });

  const byClientId = {};
  const check = {};
  const agents = {};

  Object.keys(slices).forEach((agentName) => {
    const slice = slices[agentName];
    const agentId = agentIdByName[norm(agentName)] || null;
    const aliases = aliasesAll[agentName] || {};
    let distributed = 0;
    const unmatched = [];
    const toOtherAgents = [];
    const ambiguous = [];
    const flatItems = [];

    slice.clients.forEach((entry) => {
      const alias = aliases[entry.name];
      const target = alias ? alias.target : entry.name;
      const items = (entry.items || []).map((it) => ({ ...it }));
      items.forEach((it) => flatItems.push(it));
      const revenue = Number(entry.revenue) || items.reduce((s, it) => s + (it.revenue || 0), 0);
      const cards = cardsByName[norm(target)] || [];
      let card = cards.find((c) => c.ownerId === agentId && !c.closed);
      if (!card) card = cards.find((c) => c.ownerId === agentId);
      if (!card && cards.length) {
        card = cards[0];
        if (cards.length > 1) ambiguous.push(entry.name);
        toOtherAgents.push({ name: entry.name, revenue, ownerId: card.ownerId });
      }
      if (!card) { unmatched.push({ name: entry.name, revenue }); return; }
      distributed += revenue;
      const acc = byClientId[card.id] || (byClientId[card.id] = { revenue: 0, items: [] });
      acc.revenue += revenue;
      items.forEach((it) => {
        acc.items.push(card.ownerId === agentId ? it : { ...it, soldBy: agentName });
      });
    });

    const total = Number(slice.total) || 0;
    check[agentName] = {
      period: slice.period || '',
      asOf: slice.asOf || null,
      total,
      distributed,
      diff: total - distributed,
      unmatched,
      toOtherAgents,
      ambiguous
    };
    agents[agentName] = {
      agentId,
      period: slice.period || '',
      asOf: slice.asOf || null,
      total,
      qty: Number(slice.qty) || 0,
      items: flatItems
    };
  });

  return { byClientId, check, agents };
}

module.exports = { loadSlices, distribute, norm };
