// Задачник для торговых агентов — фронтенд на чистом JS, без сборки и фреймворков.

const state = {
  user: null,
  stages: [],
  saleStages: [],
  waitlistStages: [],
  waitlistTags: [],
  taskTags: [],
  paymentMethods: [],
  contractStatuses: [],
  pointTypes: [],
  clients: [],
  tasks: [],
  users: [],
  supervisorMeetings: [],
  view: 'dashboard',
  stats: null,
  clientFilters: { visitDay: '', pointType: '', paymentMethod: '', ownerId: '', promo: '', onlyRegular: false, onlyDebt: false, onlyShortfall: false, onlyPromotions: false, onlyDiscount: false, showClosed: false, search: '' },
  clientSort: { key: null, dir: -1 },
  taskTagFilter: new Set(),
  waitlistTagFilter: new Set(),
  calendar: { mode: 'month', date: new Date() },
  clientBulkMode: false,
  clientBulkSelected: new Set(),
  taskBulkMode: false,
  taskBulkSelected: new Set(),
  // Правка 31.08.2026 (п.2): по умолчанию открывается первая вкладка после
  // смены порядка — «Воронка продаж» (была — «Визиты»).
  taskTypeView: 'sale',
  ratingSelectedMonths: new Set(),
  // Фаза 15, п.5: фильтр по месяцам для карточки "Продано всего" на дашборде
  // агента — пусто = все 7 месяцев (как раньше), иначе — выбранные месяцы.
  salesAllMonthsSelected: new Set()
};

// Единственный "активный" (ещё не завершённый) этап — раньше их было три
// (new/in_progress/waiting), теперь "Новая задача" и "Лист ожидания" убраны
// с доски (см. api.js), остался только "В работе".
const ACTIVE_STAGES = ['in_progress'];

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
// Месяцы, за которые есть данные о продажах, и последний из них — приходят с
// сервера через /api/me (state.salesMonths, заполняется в boot() из MONTH_ORDER,
// src/import.js) — единственный источник правды, чтобы список месяцев не пришлось
// синхронизировать руками в двух местах. ВАЖНО (01.09.2026): специально НЕ
// вычисляется из текущей календарной даты (new Date()) — последний доступный
// месяц выгрузки остаётся "август", даже когда реальный календарь уже в сентябре
// и далее, пока пользователь не пришлёт новую выгрузку продаж. Все места на
// дашборде, подписанные раньше как "(этот месяц)"/"текущий месяц" (карточки
// "Продано", "Топ по брендам", "Выполнение плана"), теперь называют месяц явно
// (через latestSalesMonth()), чтобы не создавать впечатление "живых" цифр за
// месяц, который по факту ещё не выгружен.
function latestSalesMonth() {
  const months = state.salesMonths || [];
  return months[months.length - 1] || '';
}

// Воронка "звонок → встреча → сделка/провал" — параллельный тип задач (taskType: 'sale'),
// не пересекается с обычными визитными задачами. Финальные этапы требуют аудиозаписи
// встречи + пояснения (проверяется на сервере, тут — только для UI-подсказок).
const SALE_FINAL_STAGES_CLIENT = ['deal', 'fail'];
const SALE_ACTIVE_STAGES_CLIENT = ['call', 'meeting'];
const WAITLIST_ACTIVE_STAGES_CLIENT = ['waiting', 'invoiced'];
// Активна ли задача (не закрыта), независимо от типа воронки — используется
// для клиентского пересчёта карточек дашборда при фильтре по агенту (см. dashCardValue).
function isTaskActiveClient(t) {
  if (t.taskType === 'sale') return SALE_ACTIVE_STAGES_CLIENT.includes(t.stage);
  if (t.taskType === 'waitlist') return WAITLIST_ACTIVE_STAGES_CLIENT.includes(t.stage);
  return ACTIVE_STAGES.includes(t.stage);
}

// ---------- Утилита запросов к API ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка запроса');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function apiUpload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || 'Ошибка загрузки файла');
  return data;
}

function fmtMoney(n) { return Number(n || 0).toLocaleString('ru-RU') + ' сом'; }
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  if (!day) return d;
  return `${day}.${m}.${y}`;
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- Поле ввода даты с годом в 2 цифры (ДД.ММ.ГГ) ----------
// Хранение и передача на сервер — в прежнем формате ISO (YYYY-MM-DD),
// меняется только то, как год отображается пользователю при вводе.
function isoToShortDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!d) return '';
  return `${d}.${m}.${(y || '').slice(-2)}`;
}
function shortDisplayToIso(disp) {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*$/.exec(disp || '');
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  d = pad2(Number(d)); mo = pad2(Number(mo));
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}`;
}
let _dateFieldSeq = 0;
function dateFieldHTML(opts) {
  const { name, id, value, required, disabled } = opts || {};
  const hiddenId = id || `df-${name}-${++_dateFieldSeq}`;
  return `
    <span class="date-field">
      <input type="hidden" name="${name}" id="${hiddenId}" value="${value || ''}" ${required ? 'data-required="1"' : ''}>
      <input type="text" class="date-display-input" inputmode="numeric" placeholder="ДД.ММ.ГГ" maxlength="8"
             value="${isoToShortDisplay(value)}" data-for="${hiddenId}" ${disabled ? 'disabled' : ''} autocomplete="off">
      <button type="button" class="date-pick-btn" data-for="${hiddenId}" ${disabled ? 'disabled' : ''} title="Выбрать дату">📅</button>
    </span>`;
}
function _dateFieldSync(hiddenInput) {
  const wrap = hiddenInput.closest('.date-field');
  const textInput = wrap && wrap.querySelector('.date-display-input');
  if (textInput) textInput.value = isoToShortDisplay(hiddenInput.value);
}
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('date-display-input')) return;
  const hidden = document.getElementById(e.target.dataset.for);
  if (!hidden) return;
  const iso = shortDisplayToIso(e.target.value);
  if (iso) { hidden.value = iso; e.target.classList.remove('invalid'); }
  else if (e.target.value.trim()) e.target.classList.add('invalid');
  else { hidden.value = ''; e.target.classList.remove('invalid'); }
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.date-pick-btn');
  if (btn) { e.preventDefault(); if (btn.disabled) return; openMiniDatePicker(btn); return; }
  const openPopup = document.querySelector('.mini-date-picker');
  if (openPopup && !openPopup.contains(e.target) && !(e.target.closest && e.target.closest('.date-pick-btn'))) openPopup.remove();
});
function openMiniDatePicker(anchorBtn) {
  const existing = document.querySelector('.mini-date-picker');
  if (existing) existing.remove();
  const hidden = document.getElementById(anchorBtn.dataset.for);
  if (!hidden) return;
  const base = hidden.value ? new Date(hidden.value) : new Date();
  const view = { y: base.getFullYear(), m: base.getMonth() };
  const pop = el('<div class="mini-date-picker"></div>');
  const rect = anchorBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = `${rect.bottom + 4}px`;
  pop.style.left = `${Math.max(4, rect.left - 200)}px`;
  document.body.appendChild(pop);
  function draw() {
    const todayKey = toDateKey(new Date());
    const selKey = hidden.value || '';
    const startDate = startOfWeek(new Date(view.y, view.m, 1));
    let html = `
      <div class="mdp-header">
        <button type="button" class="mdp-nav" data-dir="-1">‹</button>
        <span>${MONTH_LABELS[view.m]} ${view.y}</span>
        <button type="button" class="mdp-nav" data-dir="1">›</button>
      </div>
      <div class="mdp-grid">
        ${WEEKDAY_LABELS.map((w) => `<div class="mdp-wd">${w}</div>`).join('')}
    `;
    for (let i = 0; i < 42; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const key = toDateKey(d);
      const outside = d.getMonth() !== view.m;
      html += `<div class="mdp-cell ${outside ? 'mdp-outside' : ''} ${key === todayKey ? 'mdp-today' : ''} ${key === selKey ? 'mdp-selected' : ''}" data-key="${key}">${d.getDate()}</div>`;
    }
    html += '</div>';
    pop.innerHTML = html;
    pop.querySelectorAll('.mdp-nav').forEach((btnEl) => btnEl.addEventListener('click', () => {
      const dir = Number(btnEl.dataset.dir);
      view.m += dir;
      if (view.m < 0) { view.m = 11; view.y--; }
      if (view.m > 11) { view.m = 0; view.y++; }
      draw();
    }));
    pop.querySelectorAll('.mdp-cell').forEach((c) => c.addEventListener('click', () => {
      hidden.value = c.dataset.key;
      _dateFieldSync(hidden);
      pop.remove();
    }));
  }
  draw();
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function isStaff() { return state.user.role === 'admin' || state.user.role === 'supervisor'; }
function isAdmin() { return state.user.role === 'admin'; }

function clientById(id) { return state.clients.find((c) => c.id === id); }
function userName(id) { const u = state.users.find((u) => u.id === id); return u ? u.name : '—'; }
function roleLabel(r) { return { admin: 'администратор', supervisor: 'супервайзер', agent: 'торговый агент' }[r] || r; }

// ---------- Вход / выход ----------

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    await api('POST', '/api/login', { email, password });
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.reload();
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  render();
}

// ---------- Загрузка данных ----------

async function loadAll() {
  const [clientsRes, tasksRes, usersRes, statsRes, supMeetingsRes] = await Promise.all([
    api('GET', '/api/clients'),
    api('GET', '/api/tasks'),
    api('GET', '/api/users'),
    api('GET', '/api/stats'),
    api('GET', '/api/supervisor-meetings')
  ]);
  state.clients = clientsRes.clients;
  state.tasks = tasksRes.tasks;
  state.stages = tasksRes.stages;
  state.saleStages = tasksRes.saleStages || [];
  state.waitlistStages = tasksRes.waitlistStages || [];
  state.waitlistTags = tasksRes.waitlistTags || state.waitlistTags;
  state.users = usersRes.users;
  state.stats = statsRes;
  state.supervisorMeetings = supMeetingsRes.meetings || [];
  updateNavBadges();
}

function updateNavBadges() {
  const tasksBadge = document.getElementById('badge-tasks');
  const clientsBadge = document.getElementById('badge-clients');
  const s = state.stats;
  if (tasksBadge) {
    const n = s ? s.overdueTasksCount : 0;
    tasksBadge.textContent = n || '';
    tasksBadge.style.display = n ? 'inline-flex' : 'none';
  }
  if (clientsBadge) {
    const n = s && isStaff() ? (s.pendingApprovalCount || 0) + (s.pendingClosureCount || 0) : 0;
    clientsBadge.textContent = n || '';
    clientsBadge.style.display = n ? 'inline-flex' : 'none';
  }
}

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.stages = me.stages;
    state.saleStages = me.saleStages || [];
    state.waitlistStages = me.waitlistStages || [];
    state.waitlistTags = me.waitlistTags || [];
    state.paymentMethods = me.paymentMethods;
    state.contractStatuses = me.contractStatuses;
    state.pointTypes = me.pointTypes || [];
    state.taskTags = me.taskTags || [];
    // Правка 01.09.2026: реальная текущая дата (для шапки) + признак того, что
    // данные о продажах/акциях за текущий месяц ещё не загружены (сервер сам
    // решает это по факту календаря, см. withFreshCurrentMonth в src/api.js).
    state.serverDate = me.serverDate ? new Date(me.serverDate) : new Date();
    state.salesMonths = me.salesMonths || [];
    state.latestSalesMonth = me.latestSalesMonth || '';
    state.currentMonthDataFresh = me.currentMonthDataFresh !== false;
    state.stockAsOf = me.stockAsOf || '';
  } catch (e) {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-screen').style.display = 'none';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('user-name').textContent = `${state.user.name} (${roleLabel(state.user.role)})`;
  // Правка 01.09.2026: видимая текущая дата в шапке — чтобы было явно понятно,
  // на какой момент считаются "текущий месяц"/"на сегодня" показатели.
  const todayEl = document.getElementById('today-date');
  if (todayEl) todayEl.textContent = 'Сегодня: ' + new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  document.getElementById('team-tab').style.display = isAdmin() ? '' : 'none';
  document.getElementById('myday-tab').style.display = state.user.role === 'agent' ? '' : 'none';
  document.getElementById('reports-tab').style.display = isStaff() ? '' : 'none';
  await loadAll();
  render();
  setupNotifications();
}

// ---------- Рендер по вкладкам ----------

function render() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (state.view === 'dashboard') return renderDashboard(content);
  if (state.view === 'clients') return renderClients(content);
  if (state.view === 'tasks') return renderTasks(content);
  if (state.view === 'calendar') return renderCalendar(content);
  if (state.view === 'myday') return renderMyDay(content);
  if (state.view === 'reports') return renderReports(content);
  if (state.view === 'team') return renderTeam(content);
}

// ---------- Ссылки: позвонить / открыть карту ----------

// Ссылка WhatsApp — по номеру телефона (kg-номера, как правило, набраны без
// кода страны в наших данных: "0555..." → +996555... для wa.me).
function waLink(phone) {
  if (!phone) return '';
  let digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('0')) digits = '996' + digits.slice(1);
  if (!digits) return '';
  return `<a class="wa-link" target="_blank" rel="noopener" href="https://wa.me/${digits}" onclick="event.stopPropagation()" title="Написать в WhatsApp">🟢</a>`;
}

function telLink(phone, label) {
  if (!phone) return escapeHtml(label !== undefined ? label : '—');
  const digits = phone.replace(/[^\d+]/g, '');
  return `<a class="tel-link" href="tel:${digits}" onclick="event.stopPropagation()">${escapeHtml(label !== undefined ? label : phone)}</a> ${waLink(phone)}`;
}

function mapsLink(address) {
  if (!address) return '';
  return `<a class="maps-link" target="_blank" rel="noopener" href="https://2gis.kg/bishkek/search/${encodeURIComponent(address)}" onclick="event.stopPropagation()">📍 Карта</a>`;
}

// Фаза 15, п.12: поле "Соцсети/WhatsApp" переименовано в "Instagram" (WhatsApp
// у клиента и так есть автоматически — иконка рядом с телефоном, см. waLink()
// внутри telLink(), это отдельная фича и её не трогаем). Значение может быть
// голым username, "@username" или уже готовой ссылкой — приводим к рабочей
// ссылке на профиль в любом случае, не заставляя пользователя вводить URL самому.
function instagramLink(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  let handle = raw.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/, '');
  const url = /^https?:\/\//i.test(raw) ? raw : `https://instagram.com/${handle}`;
  return `<a class="maps-link" target="_blank" rel="noopener" href="${escapeAttr(url)}" onclick="event.stopPropagation()">📷 ${escapeHtml(raw)}</a>`;
}

// ---------- Аватар сотрудника ----------

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}

function avatarHtml(userId, size) {
  const u = state.users.find((u) => u.id === userId);
  const px = size || 24;
  if (u && u.avatarUrl) {
    return `<img src="${u.avatarUrl}" class="avatar" style="width:${px}px;height:${px}px" title="${escapeHtml(u.name)}">`;
  }
  return `<span class="avatar avatar-fallback" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.4)}px" title="${escapeHtml(u ? u.name : '')}">${escapeHtml(initials(u ? u.name : ''))}</span>`;
}

function agentTag(userId) {
  return `<span class="agent-tag">${avatarHtml(userId, 20)}<span>${escapeHtml(userName(userId))}</span></span>`;
}

// ---------- Дашборд ----------

function renderTopBrandTable(brandLabel, items, colorantsExcluded) {
  if (!items || !items.length) return `<h3 style="margin:12px 0 6px">${escapeHtml(brandLabel)}</h3><div class="muted" style="font-size:13px">Нет продаж по этому бренду в этом месяце.</div>`;
  return `
    <h3 style="margin:12px 0 6px">${escapeHtml(brandLabel)}${colorantsExcluded ? ' <span class="muted" style="font-weight:400;font-size:12px">(без красителей и оксидов)</span>' : ''}</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Товар</th><th>Шт (месяц)</th><th>Выручка</th></tr></thead>
        <tbody>
          ${items.map((p) => `<tr><td>${escapeHtml(p.product)}</td><td>${Math.round(p.qty * 100) / 100}</td><td>${fmtMoney(p.revenue)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// Пересчёт значения одной карточки дашборда супервайзера/админа с учётом фильтра
// по агенту — на уже загруженных на клиенте state.clients/state.tasks (эти списки
// для admin/supervisor и так содержат всех клиентов/все задачи, см. scoped() в api.js).
function dashCardValue(key, agentId, paymentMethod) {
  const aid = agentId ? Number(agentId) : null;
  let clientsF = aid ? state.clients.filter((c) => c.ownerId === aid) : state.clients;
  if (paymentMethod) clientsF = clientsF.filter((c) => (c.paymentMethod || '') === paymentMethod);
  const tasksF = aid ? state.tasks.filter((t) => t.assigneeId === aid) : state.tasks;
  const today = new Date().toISOString().slice(0, 10);
  switch (key) {
    case 'clientsCount': return String(clientsF.length);
    case 'todayTasksCount': return String(tasksF.filter((t) => isTaskActiveClient(t) && t.dueDate === today).length);
    case 'overdueTasksCount': return String(tasksF.filter((t) => isTaskActiveClient(t) && t.dueDate && t.dueDate < today).length);
    case 'atRiskClientsCount': return String(clientsF.filter((c) => riskCount(c) > 0).length);
    case 'totalDebt': return fmtMoney(clientsF.reduce((s, c) => s + (c.debtAmount || 0), 0));
    default: return '';
  }
}
function agentFilterSelectHTML(cardKey) {
  const agents = state.users.filter((u) => u.role === 'agent');
  return `
    <select class="card-agent-filter" data-card="${cardKey}" onclick="event.stopPropagation()">
      <option value="">Все агенты</option>
      ${agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
    </select>`;
}
function paymentMethodFilterSelectHTML(cardKey) {
  return `
    <select class="card-payment-filter" data-card="${cardKey}" onclick="event.stopPropagation()">
      <option value="">Все формы оплаты</option>
      ${state.paymentMethods.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join('')}
    </select>`;
}
function wireCardAgentFilters(root) {
  function recompute(card) {
    const agentSel = card.querySelector('.card-agent-filter');
    const paySel = card.querySelector('.card-payment-filter');
    const numEl = card.querySelector('.num');
    const key = (agentSel || paySel).dataset.card;
    if (numEl) numEl.textContent = dashCardValue(key, agentSel ? agentSel.value : '', paySel ? paySel.value : '');
  }
  root.querySelectorAll('.card-agent-filter, .card-payment-filter').forEach((sel) => {
    sel.addEventListener('change', () => recompute(sel.closest('.stat-card')));
  });
}

async function renderDashboard(content) {
  const stats = await api('GET', '/api/stats');
  content.appendChild(el(`
    <div>
      ${!state.currentMonthDataFresh ? `
      <div class="notice notice-warn" style="margin-bottom:14px">
        Нет новых данных о продажах и акциях за текущий месяц — последний присланный реестр за
        <b>${escapeHtml(capitalize(state.latestSalesMonth))}</b>. Показатели «текущий месяц» ниже (продано,
        акции, выполнение плана) показывают 0 — это ожидаемо, а не ошибка. Они обновятся, как только
        придёт новая выгрузка продаж за текущий месяц.
      </div>` : ''}
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${stats.clientsCount}</div><div class="label">Клиентов</div>${isStaff() ? agentFilterSelectHTML('clientsCount') : ''}</div>
        <div class="stat-card"><div class="num">${stats.todayTasksCount}</div><div class="label">Задач на сегодня</div>${isStaff() ? agentFilterSelectHTML('todayTasksCount') : ''}</div>
        <div class="stat-card"><div class="num">${stats.overdueTasksCount}</div><div class="label">Просроченных задач</div>${isStaff() ? agentFilterSelectHTML('overdueTasksCount') : ''}</div>
        <div class="stat-card stat-card-alert"><div class="num">${stats.atRiskClientsCount}</div><div class="label">Клиентов «недопродано»</div>${isStaff() ? agentFilterSelectHTML('atRiskClientsCount') : ''}</div>
        <div class="stat-card"><div class="num">${fmtMoney(stats.totalDebt)}</div><div class="label">Общий долг</div>${isStaff() ? agentFilterSelectHTML('totalDebt') + paymentMethodFilterSelectHTML('totalDebt') : ''}</div>
        ${isStaff() && stats.teamTotals ? `<div class="stat-card"><div class="num">${stats.teamTotals.totalTasks}</div><div class="label">Всего задач по команде (в работе: ${stats.teamTotals.open})</div></div>` : ''}
        ${isStaff() ? `<div class="stat-card"><div class="num">${stats.pendingApprovalCount}</div><div class="label">Новых точек на согласовании</div></div>` : ''}
        ${isStaff() && stats.pendingClosureCount ? `<div class="stat-card"><div class="num">${stats.pendingClosureCount}</div><div class="label">Заявок на закрытие точки</div></div>` : ''}
        ${isStaff() && stats.newMastersCount ? `<div class="stat-card"><div class="num">${stats.newMastersCount}</div><div class="label">Новых мастеров (не просмотрено)</div></div>` : ''}
      </div>

      ${stats.agentDashboard ? `
      <div class="panel">
        <h2>Мои показатели</h2>
        <div class="agent-metric-grid">
          <div class="stat-card"><div class="num">${fmtMoney(stats.agentDashboard.salesTotalThisMonth)}</div><div class="label">Продано (${capitalize(latestSalesMonth())})</div></div>
          <div class="stat-card"><div class="num">${stats.agentDashboard.clientsBoughtThisMonth}/${stats.agentDashboard.clientsNotBoughtThisMonth}</div><div class="label">Купили / не купили в этом месяце</div></div>
          <div class="stat-card"><div class="num">${stats.agentDashboard.callsToday}</div><div class="label">Звонков сегодня</div></div>
          <div class="stat-card"><div class="num">${stats.agentDashboard.meetingsToday}</div><div class="label">Встреч сегодня</div></div>
          <div class="stat-card"><div class="num">${stats.agentDashboard.doneTasksToday}</div><div class="label">Выполнено сегодня</div></div>
          <div class="stat-card"><div class="num">${stats.agentDashboard.overdueTasksCount}</div><div class="label">Просрочено</div></div>
          <div class="stat-card">
            <div class="num">${stats.agentDashboard.promotionsClientsCount}</div>
            <div class="label">Клиентов с акциями (${stats.agentDashboard.promotionsItemsCount} поз., на сумму ${fmtMoney(stats.agentDashboard.promotionsSumTotal)})</div>
          </div>
          <div class="stat-card" id="sales-all-months-card" title="По умолчанию — сумма за все 7 месяцев; фильтр ниже сужает до выбранных">
            <div class="num" id="sales-all-months-num">${fmtMoney(stats.agentDashboard.salesTotalAllMonths)}</div>
            <div class="label" id="sales-all-months-label">Продано всего (7 мес.) <button type="button" class="link-btn" id="sales-by-client-toggle" style="font-size:12px">по клиентам ▾</button></div>
          </div>
        </div>
        <div class="assort-brand-filter" id="sales-all-months-bar" style="margin:8px 0">
          <button type="button" class="brand-chip ${!state.salesAllMonthsSelected.size ? 'active' : ''}" data-month="all">Все месяцы (7 мес)</button>
          ${(state.salesMonths || []).map((m) => `<button type="button" class="brand-chip ${state.salesAllMonthsSelected.has(m) ? 'active' : ''}" data-month="${escapeAttr(m)}">${escapeHtml(capitalize(m))}</button>`).join('')}
        </div>
        <div id="sales-by-client-panel" class="assort-panel" style="display:none">
          <div class="muted" style="font-size:12px;margin-bottom:6px" id="sales-by-client-hint">Формат: клиент / сумма за 7 месяцев.</div>
          <div style="max-height:260px;overflow:auto" id="sales-by-client-list">
            ${stats.agentDashboard.salesByClientAllMonths.map((r) => `<div>${escapeHtml(r.clientName)} / ${fmtMoney(r.revenue)}</div>`).join('')}
          </div>
        </div>
        <button type="button" class="assort-btn" id="top-brands-toggle">🏆 Топ-10 по брендам (${capitalize(latestSalesMonth())})</button>
        <div class="assort-panel" id="top-brands-panel" style="display:none">
          ${renderTopBrandTable('Kapous', stats.agentDashboard.topByBrand.Kapous, true)}
          ${renderTopBrandTable('EPICA', stats.agentDashboard.topByBrand.EPICA, true)}
          ${renderTopBrandTable('Чистовье', stats.agentDashboard.topByBrand.Чистовье, false)}
        </div>
      </div>` : ''}

      ${stats.teamTasksToday ? `
      <div class="panel">
        <h2>Задачи на день по команде</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Агент</th><th>Задач сегодня</th><th>Выполнено</th><th>Не выполнено</th></tr></thead>
            <tbody>
              ${stats.teamTasksToday.map((a) => `
                <tr>
                  <td>${agentTag(a.agentId)}</td>
                  <td>${a.total}</td>
                  <td>${a.done}</td>
                  <td>${a.notDone ? `<span class="badge badge-overdue">${a.notDone}</span>` : '0'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

      <div class="panel">
        <h2>Клиенты на сегодня</h2>
        <div class="mini-card-grid" id="today-kanban"></div>
      </div>

      <div class="panel">
        <h2>Клиенты на сегодня с задолженностью</h2>
        ${stats.todayClientsWithDebt.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Клиент</th><th>Ответственный</th><th>Долг</th></tr></thead>
            <tbody>
              ${stats.todayClientsWithDebt.map((c) => `
                <tr>
                  <td>${escapeHtml(c.name)}</td>
                  <td>${agentTag(c.ownerId)}</td>
                  <td><span class="badge ${c.debtOverdue ? 'badge-overdue' : 'badge-pay'}">${fmtMoney(c.debtAmount)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>` : '<div class="empty-state">Сегодня нет визитов к клиентам с долгом.</div>'}
      </div>

      <div class="panel">
        <h2>Просроченные задачи</h2>
        ${stats.overdueTasks.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Задача</th><th>Клиент</th><th>Ответственный</th><th>Срок</th><th>Этап</th></tr></thead>
            <tbody>
              ${stats.overdueTasks.map((t) => `
                <tr>
                  <td>${escapeHtml(t.title)}</td>
                  <td>${escapeHtml(clientById(t.clientId) ? clientById(t.clientId).name : '—')}</td>
                  <td>${agentTag(t.assigneeId)}</td>
                  <td>${fmtDate(t.dueDate)}</td>
                  <td>${escapeHtml(stageLabel(t.stage))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>` : '<div class="empty-state">Просроченных задач нет.</div>'}
      </div>

      ${stats.byAgent ? `
      <div class="panel">
        <h2>Выполнение по агентам</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Агент</th><th>Всего задач</th><th>В работе</th><th>Выполнено</th><th>Не выполнено</th><th>% выполнения</th><th>Долг клиентов</th></tr></thead>
            <tbody>
              ${stats.byAgent.map((a) => `
                <tr>
                  <td>${agentTag(a.agentId)}</td>
                  <td>${a.totalTasks}</td>
                  <td>${a.open}</td>
                  <td>${a.done}</td>
                  <td>${a.notDone}</td>
                  <td>${a.completionRate === null ? '—' : a.completionRate + '%'}</td>
                  <td>${fmtMoney(a.totalDebt)}</td>
                </tr>
              `).join('')}
              <tr>
                <td><strong>Итого по команде</strong></td>
                <td><strong>${stats.teamTotals.totalTasks}</strong></td>
                <td><strong>${stats.teamTotals.open}</strong></td>
                <td><strong>${stats.teamTotals.done}</strong></td>
                <td><strong>${stats.teamTotals.notDone}</strong></td>
                <td>—</td>
                <td><strong>${fmtMoney(stats.byAgent.reduce((s, a) => s + (a.totalDebt || 0), 0))}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>` : ''}

      ${stats.salesPerformance ? `
      <div class="panel">
        <h2>Выполнение плана (сом) <select class="card-agent-filter" id="perf-agent-filter"><option value="">Все агенты</option>${state.users.filter((u) => u.role === 'agent').map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select></h2>
        <div class="agent-metric-grid" id="perf-stat-cards"></div>
        <div class="table-wrap" style="margin-top:10px">
          <table>
            <thead><tr><th>Бренд</th><th>Выручка (${capitalize(latestSalesMonth())})</th></tr></thead>
            <tbody id="perf-brand-tbody"></tbody>
          </table>
        </div>
      </div>` : ''}

      ${stats.promotionsSummary ? `
      <div class="panel">
        <h2>🎁 Акции (вся команда)</h2>
        <div class="agent-metric-grid">
          <div class="stat-card"><div class="num">${stats.promotionsSummary.clientsCount}</div><div class="label">Клиентов с акциями</div></div>
          <div class="stat-card"><div class="num">${stats.promotionsSummary.itemsCount}</div><div class="label">Позиций по акциям</div></div>
          <div class="stat-card"><div class="num">${fmtMoney(stats.promotionsSummary.sumTotal)}</div><div class="label">Сумма по акциям</div></div>
        </div>
        <div class="table-wrap" style="margin-top:10px">
          <table>
            <thead><tr><th>Агент</th><th>Клиентов с акциями</th><th>Позиций</th><th>Сумма</th></tr></thead>
            <tbody>
              ${stats.promotionsSummary.byAgent.map((a) => `
                <tr>
                  <td>${agentTag(a.agentId)}</td>
                  <td>${a.clientsCount}</td>
                  <td>${a.itemsCount}</td>
                  <td>${fmtMoney(a.sumTotal)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}

      ${stats.noTaskThisWeek ? `
      <div class="panel">
        <h2>Клиенты без задачи на этой неделе <span class="col-sum">· ${stats.noTaskThisWeek.length}</span> <select class="card-agent-filter" id="notask-agent-filter"><option value="">Все агенты</option>${state.users.filter((u) => u.role === 'agent').map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select></h2>
        <div id="notask-table-wrap">
        ${stats.noTaskThisWeek.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Клиент</th><th>День визита</th><th>Ответственный</th></tr></thead>
            <tbody>
              ${stats.noTaskThisWeek.slice(0, 30).map((c) => `
                <tr>
                  <td>${escapeHtml(c.name)}</td>
                  <td>${escapeHtml(c.visitDay)}</td>
                  <td>${agentTag(c.ownerId)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ${stats.noTaskThisWeek.length > 30 ? `<div class="muted" style="margin-top:6px;font-size:12px">Показаны первые 30 из ${stats.noTaskThisWeek.length}.</div>` : ''}
        ` : '<div class="empty-state">На всех клиентов с днём визита на этой неделе задачи уже созданы.</div>'}
        </div>
      </div>` : ''}

      ${stats.clientRating ? `
      <div class="panel">
        <h2>Рейтинг клиентов (выручка / маржа / активные месяцы) <select class="card-agent-filter" id="rating-agent-filter"><option value="">Все агенты</option>${state.users.filter((u) => u.role === 'agent').map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select></h2>
        <div class="assort-brand-filter" id="rating-month-bar" style="margin-bottom:10px">
          <button type="button" class="brand-chip ${!state.ratingSelectedMonths.size ? 'active' : ''}" data-month="all">Все месяцы (7 мес)</button>
          ${(state.salesMonths || []).map((m) => `<button type="button" class="brand-chip ${state.ratingSelectedMonths.has(m) ? 'active' : ''}" data-month="${escapeAttr(m)}">${escapeHtml(capitalize(m))}</button>`).join('')}
        </div>
        <div id="rating-table-wrap">
        ${stats.clientRating.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Клиент</th><th>Агент</th><th>Выручка (7 мес)</th><th>Маржа</th><th>% маржи</th><th>Активных мес.</th></tr></thead>
            <tbody>
              ${stats.clientRating.slice(0, 30).map((r) => `
                <tr>
                  <td>${escapeHtml(r.clientName)}</td>
                  <td>${escapeHtml(r.agentName)}</td>
                  <td>${fmtMoney(r.revenue)}</td>
                  <td>${fmtMoney(r.margin)}</td>
                  <td>${r.marginPct}%</td>
                  <td>${r.activeMonths}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="muted" style="margin-top:6px;font-size:12px">Маржа считается из тех же файлов продаж (себестоимость/стоимость построчно).</div>
        ` : '<div class="empty-state">Пока нет данных о продажах для рейтинга.</div>'}
        </div>
      </div>` : ''}
    </div>
  `));

  if (stats.agentDashboard) {
    wireToggle('top-brands-toggle', 'top-brands-panel');
    wireToggle('sales-by-client-toggle', 'sales-by-client-panel');
  }
  if (isStaff()) wireCardAgentFilters(content);

  // Фаза 15, п.5: фильтр по месяцам для карточки "Продано всего" — та же
  // логика/UI, что и в "Рейтинге клиентов" (computeMonthlyRating выше), но
  // проще (только сумма + разбивка по клиентам, без маржи). При "Все месяцы"
  // (по умолчанию) используем готовую сумму с сервера (regularAssortment +
  // testAssortment за все 7 мес., см. salesTotalAllMonths в src/api.js), при
  // выборе конкретных месяцев считаем из client.monthlyAssortment на клиенте.
  function computeSalesForMonths(months) {
    if (!months.length) {
      return state.clients
        .map((c) => {
          const items = [...(c.regularAssortment || []), ...(c.testAssortment || [])];
          return { clientId: c.id, clientName: c.name, revenue: items.reduce((s, it) => s + (it.revenue || 0), 0) };
        })
        .filter((r) => r.revenue > 0)
        .sort((a, b) => b.revenue - a.revenue);
    }
    return state.clients
      .map((c) => {
        const items = months.flatMap((m) => (c.monthlyAssortment && c.monthlyAssortment[m]) || []);
        return { clientId: c.id, clientName: c.name, revenue: items.reduce((s, it) => s + (it.revenue || 0), 0) };
      })
      .filter((r) => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);
  }
  function renderSalesAllMonthsPanel() {
    const bar = document.getElementById('sales-all-months-bar');
    if (!bar) return;
    const months = Array.from(state.salesAllMonthsSelected);
    const rows = computeSalesForMonths(months);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    const label = months.length ? months.map((m) => capitalize(m)).join(' + ') : `${(state.salesMonths || []).length || 7} мес.`;
    document.getElementById('sales-all-months-num').textContent = fmtMoney(total);
    document.getElementById('sales-all-months-label').innerHTML = `Продано всего (${label}) <button type="button" class="link-btn" id="sales-by-client-toggle" style="font-size:12px">по клиентам ▾</button>`;
    document.getElementById('sales-by-client-hint').textContent = `Формат: клиент / сумма за ${months.length ? label.toLowerCase() : 'все 7 месяцев'}.`;
    document.getElementById('sales-by-client-list').innerHTML = rows.map((r) => `<div>${escapeHtml(r.clientName)} / ${fmtMoney(r.revenue)}</div>`).join('') || '<div class="muted">Нет продаж за выбранный период.</div>';
    wireToggle('sales-by-client-toggle', 'sales-by-client-panel');
  }
  if (stats.agentDashboard) {
    const salesMonthsBar = document.getElementById('sales-all-months-bar');
    salesMonthsBar.querySelectorAll('.brand-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const m = chip.dataset.month;
        if (m === 'all') state.salesAllMonthsSelected.clear();
        else if (state.salesAllMonthsSelected.has(m)) state.salesAllMonthsSelected.delete(m);
        else state.salesAllMonthsSelected.add(m);
        salesMonthsBar.querySelectorAll('.brand-chip').forEach((c) => {
          c.classList.toggle('active', c.dataset.month === 'all' ? state.salesAllMonthsSelected.size === 0 : state.salesAllMonthsSelected.has(c.dataset.month));
        });
        renderSalesAllMonthsPanel();
      });
    });
  }

  // ---- Правки 31.08.2026: фильтры по агенту, реагирующие на state.clients уже
  // загруженный на клиенте (та же логика, что и dashCardValue/wireCardAgentFilters
  // выше, но для панелей с таблицами, а не одиночных чисел карточки). ----

  function renderPerf() {
    const sel = document.getElementById('perf-agent-filter');
    if (!sel) return;
    const aid = sel.value ? Number(sel.value) : null;
    const clientsF = aid ? state.clients.filter((c) => c.ownerId === aid) : state.clients;
    const planTotal = clientsF.reduce((s, c) => s + (c.salesPlan || 0), 0);
    const actualTotal = clientsF.reduce((s, c) => s + (c.currentMonthRevenue || 0), 0);
    const pct = planTotal ? Math.round((actualTotal / planTotal) * 100) : null;
    document.getElementById('perf-stat-cards').innerHTML = `
      <div class="stat-card"><div class="num">${fmtMoney(planTotal)}</div><div class="label">План (${capitalize(latestSalesMonth())})</div></div>
      <div class="stat-card"><div class="num">${fmtMoney(actualTotal)}</div><div class="label">Факт (${capitalize(latestSalesMonth())})</div></div>
      <div class="stat-card"><div class="num">${pct === null ? '—' : pct + '%'}</div><div class="label">Выполнение</div></div>
    `;
    const byBrandMap = {};
    clientsF.forEach((c) => {
      (c.currentMonthItems || []).forEach((it) => {
        const b = it.brand || 'Прочее';
        byBrandMap[b] = (byBrandMap[b] || 0) + (it.revenue || 0);
      });
    });
    const rows = Object.entries(byBrandMap).map(([brand, revenue]) => ({ brand, revenue })).sort((a, b) => b.revenue - a.revenue);
    document.getElementById('perf-brand-tbody').innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${escapeHtml(r.brand)}</td><td>${fmtMoney(r.revenue)}</td></tr>`).join('')
      : '<tr><td colspan="2" class="muted">Нет продаж в этом месяце.</td></tr>';
  }
  if (stats.salesPerformance) {
    renderPerf();
    document.getElementById('perf-agent-filter').addEventListener('change', renderPerf);
  }

  function renderNoTaskFiltered() {
    const sel = document.getElementById('notask-agent-filter');
    if (!sel) return;
    const aid = sel.value ? Number(sel.value) : null;
    const list = aid ? stats.noTaskThisWeek.filter((c) => c.ownerId === aid) : stats.noTaskThisWeek;
    const wrap = document.getElementById('notask-table-wrap');
    wrap.innerHTML = list.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Клиент</th><th>День визита</th><th>Ответственный</th></tr></thead>
          <tbody>
            ${list.slice(0, 30).map((c) => `
              <tr>
                <td>${escapeHtml(c.name)}</td>
                <td>${escapeHtml(c.visitDay)}</td>
                <td>${agentTag(c.ownerId)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${list.length > 30 ? `<div class="muted" style="margin-top:6px;font-size:12px">Показаны первые 30 из ${list.length}.</div>` : ''}
    ` : '<div class="empty-state">На всех клиентов с днём визита на этой неделе задачи уже созданы.</div>';
  }
  if (stats.noTaskThisWeek) {
    document.getElementById('notask-agent-filter').addEventListener('change', renderNoTaskFiltered);
  }

  // Правка 01.09.2026 (п.1 надиктованного списка): фильтр по месяцам в «Рейтинге
  // клиентов». По умолчанию («Все месяцы») — как раньше, берём готовый 7-месячный
  // расчёт с сервера (stats.clientRating). При выборе одного/нескольких месяцев —
  // пересчитываем выручку/маржу на клиенте прямо в браузере из client.monthlyAssortment
  // (те же данные, что уже использует помесячный отчёт в «Отчётах», п.6 Фазы 11) —
  // без похода на сервер, по аналогии с остальными фильтрами на этом дашборде.
  // ВАЖНО: у месяца «август» маржа всегда будет 0 — в присланных 31.08.2026 финальных
  // файлах продаж за август нет себестоимости (см. Фазу 10/11) — это ограничение
  // исходных данных, не ошибка подсчёта.
  function computeMonthlyRating(months) {
    return state.clients.map((c) => {
      const items = months.flatMap((m) => (c.monthlyAssortment && c.monthlyAssortment[m]) || []);
      const revenue = items.reduce((s, it) => s + (it.revenue || 0), 0);
      const margin = items.reduce((s, it) => s + (it.margin || 0), 0);
      const monthsWithSales = months.filter((m) => ((c.monthlyAssortment && c.monthlyAssortment[m]) || []).length > 0).length;
      const owner = state.users.find((u) => u.id === c.ownerId);
      return {
        clientId: c.id, ownerId: c.ownerId, clientName: c.name, agentName: owner ? owner.name : '',
        revenue, margin, marginPct: revenue ? Math.round((margin / revenue) * 100) : 0, activeMonths: monthsWithSales
      };
    }).filter((r) => r.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 50);
  }

  function renderRatingFiltered() {
    const sel = document.getElementById('rating-agent-filter');
    if (!sel) return;
    const aid = sel.value ? Number(sel.value) : null;
    const months = Array.from(state.ratingSelectedMonths);
    const useMonths = months.length > 0;
    let list = useMonths ? computeMonthlyRating(months) : stats.clientRating;
    if (aid) {
      list = list.filter((r) => (useMonths ? r.ownerId === aid : (clientById(r.clientId) && clientById(r.clientId).ownerId === aid)));
    }
    const revenueHeader = useMonths ? (months.length === 1 ? `Выручка (${capitalize(months[0])})` : 'Выручка (за выбр. мес.)') : 'Выручка (7 мес)';
    const activeHeader = useMonths ? 'Мес. с продажами (из выбр.)' : 'Активных мес.';
    const wrap = document.getElementById('rating-table-wrap');
    wrap.innerHTML = list.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Клиент</th><th>Агент</th><th>${revenueHeader}</th><th>Маржа</th><th>% маржи</th><th>${activeHeader}</th></tr></thead>
          <tbody>
            ${list.slice(0, 30).map((r) => `
              <tr>
                <td>${escapeHtml(r.clientName)}</td>
                <td>${escapeHtml(r.agentName)}</td>
                <td>${fmtMoney(r.revenue)}</td>
                <td>${fmtMoney(r.margin)}</td>
                <td>${r.marginPct}%</td>
                <td>${r.activeMonths}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${useMonths && months.includes('август')
        ? '<div class="muted" style="margin-top:6px;font-size:12px">За август маржа показана как 0 — в присланных файлах продаж за август нет данных о себестоимости (есть только количество и сумма).</div>'
        : '<div class="muted" style="margin-top:6px;font-size:12px">Маржа считается из тех же файлов продаж (себестоимость/стоимость построчно).</div>'}
    ` : '<div class="empty-state">Нет данных о продажах за выбранный период.</div>';
  }
  if (stats.clientRating) {
    document.getElementById('rating-agent-filter').addEventListener('change', renderRatingFiltered);
    const ratingMonthBar = document.getElementById('rating-month-bar');
    ratingMonthBar.querySelectorAll('.brand-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const m = chip.dataset.month;
        if (m === 'all') state.ratingSelectedMonths.clear();
        else if (state.ratingSelectedMonths.has(m)) state.ratingSelectedMonths.delete(m);
        else state.ratingSelectedMonths.add(m);
        ratingMonthBar.querySelectorAll('.brand-chip').forEach((c) => {
          c.classList.toggle('active', c.dataset.month === 'all' ? state.ratingSelectedMonths.size === 0 : state.ratingSelectedMonths.has(c.dataset.month));
        });
        renderRatingFiltered();
      });
    });
  }

  const todayKanban = document.getElementById('today-kanban');
  if (!stats.todayTasks.length) {
    todayKanban.appendChild(el('<div class="empty-state">На сегодня задач нет.</div>'));
  }
  stats.todayTasks.forEach((t) => {
    const client = clientById(t.clientId);
    const card = el(`
      <div class="deal-card deal-card-mini">
        <div class="deal-title">${escapeHtml(client ? client.name : t.title)}</div>
        <div class="deal-client">${agentTag(t.assigneeId)}</div>
        ${t.report ? '<span class="report-check" title="Отчёт заполнен">✓ отчёт</span>' : ''}
      </div>
    `);
    card.addEventListener('click', () => openTaskModal(t));
    todayKanban.appendChild(card);
  });
}

// ---------- Клиенты ----------

const VISIT_DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function riskCount(c) { return (c.regularAssortment || []).filter((p) => p.atRisk).length; }

function filteredClients() {
  const f = state.clientFilters;
  let list = state.clients.filter((c) => {
    if (c.closed && !(isStaff() && f.showClosed)) return false;
    if (f.visitDay && c.visitDay !== f.visitDay) return false;
    if (f.pointType && (c.pointType || '') !== f.pointType) return false;
    if (f.paymentMethod && (c.paymentMethod || '') !== f.paymentMethod) return false;
    if (f.onlyRegular && !c.isRegularClient) return false;
    if (f.onlyDebt && !(c.debtAmount > 0)) return false;
    if (f.onlyShortfall && !riskCount(c)) return false;
    if (f.onlyPromotions && !(c.promotions || []).length) return false;
    if (f.onlyDiscount && !(c.discountTerms || '').trim()) return false;
    if (f.ownerId && c.ownerId !== Number(f.ownerId)) return false;
    if (f.promo && !(c.promotions || []).some((p) => p.promo === f.promo)) return false;
    if (f.search) {
      const q = f.search.trim().toLowerCase();
      const hay = `${c.name} ${c.phone || ''} ${c.contactName || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const { key, dir } = state.clientSort;
  if (key) {
    const sortVal = (c) => {
      if (key === 'debt') return c.debtAmount || 0;
      if (key === 'route') return c.routeNumber == null ? Infinity : c.routeNumber;
      return riskCount(c);
    };
    list = list.slice().sort((a, b) => (sortVal(a) - sortVal(b)) * dir);
  }
  return list;
}

function sortArrow(key) {
  if (state.clientSort.key !== key) return '';
  return state.clientSort.dir === 1 ? ' ▲' : ' ▼';
}

// В исходной выгрузке долгов (data/import/debts.json) у части клиентов вместо
// даты буквально стоит текст "Нет данных" (сама выгрузка так размечена) — для
// таких показывать "— на Нет данных" бессмысленно, поэтому проверяем, похоже
// ли значение на настоящую дату (ДД.ММ или ДД.ММ.ГГГГ), прежде чем его показывать.
function debtAsOfLabel(c) {
  if (!c.debtAsOf || !/^\d{1,2}[.,]\d{1,2}/.test(c.debtAsOf.trim())) return '';
  return c.debtAsOf.trim();
}

function daysOverdueText(c) {
  if (!c.debtOverdue || !c.debtAmount) return '';
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((c.debtAsOf || '').trim());
  if (!m) return '';
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days > 0 ? `просрочено ${days} дн.` : '';
}

function exportClientsCsv(list) {
  const headers = ['Название', 'Телефон', 'Адрес', 'Контактное лицо', 'Тип точки', 'Маршрут №', 'План', 'Продано', 'Долг', 'Недопродано', 'День визита', 'Ответственный'];
  const rows = list.map((c) => [c.name, c.phone || '', c.address || '', c.contactName || '', c.pointType || '', c.routeNumber != null ? c.routeNumber : '', c.salesPlan || 0, c.currentMonthRevenue || 0, c.debtAmount || 0, riskCount(c), c.visitDay || '', userName(c.ownerId)]);
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `клиенты-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderClients(content) {
  // Фаза 19: "тип точки" стал фиксированным списком из 8 категорий (см.
  // state.pointTypes, приходит с сервера через /api/me) — раньше здесь
  // вычислялся динамический список из фактических значений клиентов,
  // но теперь после миграции значения и так только из этого набора.
  const pointTypes = state.pointTypes;
  const promoNames = Array.from(new Set(state.clients.flatMap((c) => (c.promotions || []).map((p) => p.promo)))).sort();
  const f = state.clientFilters;
  const filtersActive = f.visitDay || f.pointType || f.paymentMethod || f.ownerId || f.promo || f.onlyRegular || f.onlyDebt || f.onlyShortfall || f.onlyPromotions || f.onlyDiscount || f.showClosed || f.search;
  const bulk = state.clientBulkMode;
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Клиенты</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${state.user.role === 'supervisor' ? '<button type="button" class="btn-secondary" id="export-csv-btn">Экспорт в CSV</button>' : ''}
          ${isStaff() ? `<button type="button" class="btn-secondary ${bulk ? 'active' : ''}" id="bulk-mode-btn">${bulk ? 'Отменить выбор' : 'Выбрать несколько'}</button>` : ''}
          <button class="btn-primary" id="add-client-btn">+ Новый клиент</button>
        </div>
      </div>
      <div class="filter-bar">
        <input type="text" id="filter-search" placeholder="Поиск: название, телефон, контакт..." value="${escapeAttr(f.search)}" style="max-width:220px">
        <select id="filter-visitDay">
          <option value="">День недели: все</option>
          ${VISIT_DAYS.map((d) => `<option value="${d}" ${f.visitDay === d ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <select id="filter-pointType">
          <option value="">Тип точки: все</option>
          ${pointTypes.map((p) => `<option value="${escapeAttr(p)}" ${f.pointType === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <select id="filter-paymentMethod">
          <option value="">Способ оплаты: все</option>
          ${state.paymentMethods.map((p) => `<option value="${p}" ${f.paymentMethod === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <label class="filter-check"><input type="checkbox" id="filter-onlyRegular" ${f.onlyRegular ? 'checked' : ''}> Постоянный клиент</label>
        <label class="filter-check"><input type="checkbox" id="filter-onlyDebt" ${f.onlyDebt ? 'checked' : ''}> Есть задолженность</label>
        <label class="filter-check"><input type="checkbox" id="filter-onlyShortfall" ${f.onlyShortfall ? 'checked' : ''}> Не добрал</label>
        <label class="filter-check"><input type="checkbox" id="filter-onlyPromotions" ${f.onlyPromotions ? 'checked' : ''}> Есть акции</label>
        <select id="filter-promo">
          <option value="">Акция: любая</option>
          ${promoNames.map((p) => `<option value="${escapeAttr(p)}" ${f.promo === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <label class="filter-check"><input type="checkbox" id="filter-onlyDiscount" ${f.onlyDiscount ? 'checked' : ''}> Со скидкой/особыми условиями</label>
        ${isStaff() ? `<select id="filter-ownerId">
          <option value="">Агент: все</option>
          ${state.users.filter((u) => u.role === 'agent').map((u) => `<option value="${u.id}" ${String(f.ownerId) === String(u.id) ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
        </select>` : ''}
        ${isStaff() ? `<label class="filter-check"><input type="checkbox" id="filter-showClosed" ${f.showClosed ? 'checked' : ''}> Показать закрытые</label>` : ''}
        ${filtersActive ? '<button type="button" class="link-btn" id="filter-reset">Сбросить</button>' : ''}
      </div>
      ${bulk ? `<div class="filter-bar" id="bulk-bar">
        <span class="muted" style="font-size:13px">Выбрано: <span id="bulk-count">0</span></span>
        <select id="bulk-owner-select">
          <option value="">Переназначить агенту...</option>
          ${state.users.filter((u) => u.role === 'agent').map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}
        </select>
        <button type="button" class="btn-secondary" id="bulk-reassign-btn">Применить</button>
      </div>` : ''}
      <div class="table-wrap">
        <table>
          <thead><tr>
            ${bulk ? '<th></th>' : ''}
            <th class="sticky-col">Название</th>
            <th>Номер телефона</th>
            <th>Адрес</th>
            <th>Контактное лицо</th>
            <th>Тип точки</th>
            <th class="sortable" data-sort="route">Маршрут №${sortArrow('route')}</th>
            <th>План</th>
            <th>Продано (${escapeHtml(capitalize(latestSalesMonth()))})</th>
            <th class="sortable" data-sort="debt">Долг${sortArrow('debt')}</th>
            <th class="sortable" data-sort="risk">Недопродано${sortArrow('risk')}</th>
          </tr></thead>
          <tbody id="clients-tbody"></tbody>
        </table>
      </div>
    </div>
  `));
  document.getElementById('add-client-btn').addEventListener('click', () => openClientModal());
  const exportBtn = document.getElementById('export-csv-btn');
  if (exportBtn) exportBtn.addEventListener('click', () => exportClientsCsv(filteredClients()));
  const bulkModeBtn = document.getElementById('bulk-mode-btn');
  if (bulkModeBtn) bulkModeBtn.addEventListener('click', () => { state.clientBulkMode = !state.clientBulkMode; state.clientBulkSelected = new Set(); render(); });

  document.getElementById('filter-search').addEventListener('input', (e) => { state.clientFilters.search = e.target.value; render(); });
  document.getElementById('filter-visitDay').addEventListener('change', (e) => { state.clientFilters.visitDay = e.target.value; render(); });
  document.getElementById('filter-pointType').addEventListener('change', (e) => { state.clientFilters.pointType = e.target.value; render(); });
  document.getElementById('filter-paymentMethod').addEventListener('change', (e) => { state.clientFilters.paymentMethod = e.target.value; render(); });
  document.getElementById('filter-onlyRegular').addEventListener('change', (e) => { state.clientFilters.onlyRegular = e.target.checked; render(); });
  document.getElementById('filter-onlyDebt').addEventListener('change', (e) => { state.clientFilters.onlyDebt = e.target.checked; render(); });
  document.getElementById('filter-onlyShortfall').addEventListener('change', (e) => { state.clientFilters.onlyShortfall = e.target.checked; render(); });
  document.getElementById('filter-onlyPromotions').addEventListener('change', (e) => { state.clientFilters.onlyPromotions = e.target.checked; render(); });
  document.getElementById('filter-promo').addEventListener('change', (e) => { state.clientFilters.promo = e.target.value; render(); });
  document.getElementById('filter-onlyDiscount').addEventListener('change', (e) => { state.clientFilters.onlyDiscount = e.target.checked; render(); });
  const ownerSel = document.getElementById('filter-ownerId');
  if (ownerSel) ownerSel.addEventListener('change', (e) => { state.clientFilters.ownerId = e.target.value; render(); });
  const showClosedCb = document.getElementById('filter-showClosed');
  if (showClosedCb) showClosedCb.addEventListener('change', (e) => { state.clientFilters.showClosed = e.target.checked; render(); });
  const resetBtn = document.getElementById('filter-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    state.clientFilters = { visitDay: '', pointType: '', paymentMethod: '', ownerId: '', promo: '', onlyRegular: false, onlyDebt: false, onlyShortfall: false, onlyPromotions: false, onlyDiscount: false, showClosed: false, search: '' };
    render();
  });
  content.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.clientSort.key === k) state.clientSort.dir *= -1;
      else { state.clientSort.key = k; state.clientSort.dir = -1; }
      render();
    });
  });
  const bulkReassignBtn = document.getElementById('bulk-reassign-btn');
  if (bulkReassignBtn) bulkReassignBtn.addEventListener('click', async () => {
    const ownerId = document.getElementById('bulk-owner-select').value;
    if (!ownerId) return alert('Выберите агента');
    if (!state.clientBulkSelected.size) return alert('Не выбрано ни одного клиента');
    await api('POST', '/api/clients/bulk-reassign', { ids: Array.from(state.clientBulkSelected), ownerId });
    state.clientBulkMode = false;
    state.clientBulkSelected = new Set();
    await loadAll();
    render();
  });

  const tbody = document.getElementById('clients-tbody');
  const list = filteredClients();
  if (!list.length) {
    tbody.appendChild(el(`<tr><td colspan="${bulk ? 11 : 10}"><div class="empty-state">${state.clients.length ? 'Ничего не найдено по выбранным фильтрам.' : 'Пока нет клиентов. Добавьте первого.'}</div></td></tr>`));
    return;
  }
  list.forEach((c) => {
    const risk = riskCount(c);
    const overdueDays = daysOverdueText(c);
    const row = el(`
      <tr class="${c.closed ? 'row-closed' : ''}">
        ${bulk ? `<td><input type="checkbox" class="bulk-check" data-id="${c.id}" ${state.clientBulkSelected.has(c.id) ? 'checked' : ''}></td>` : ''}
        <td class="sticky-col open-client" title="Двойной клик — открыть карточку">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.closed ? '<span class="badge badge-offroute">закрыта</span>' : ''}
          ${c.closureRequested ? '<span class="badge badge-pending">на закрытие</span>' : ''}
          ${c.pendingApproval ? '<span class="badge badge-pending">на согласовании</span>' : ''}
          ${c.isOffRoute ? '<span class="badge badge-offroute">вне маршрута</span>' : ''}
          ${(c.promotions || []).length ? '<span class="badge badge-promo" title="Есть акции">🎁 акции</span>' : ''}
        </td>
        <td>${telLink(c.phone)}</td>
        <td>${escapeHtml(c.address || '—')} ${mapsLink(c.address)}</td>
        <td>${escapeHtml(c.contactName || '—')}</td>
        <td>${escapeHtml(c.pointType || '—')}</td>
        <td>${c.routeNumber != null ? escapeHtml(String(c.routeNumber)) : '—'}</td>
        <td>${c.salesPlan ? fmtMoney(c.salesPlan) : '—'}</td>
        <td>${c.currentMonthRevenue ? fmtMoney(c.currentMonthRevenue) : '—'}</td>
        <td>${c.debtAmount ? `<span class="badge ${c.debtOverdue ? 'badge-overdue' : 'badge-pay'}" title="${escapeAttr([overdueDays, debtAsOfLabel(c) ? 'на ' + debtAsOfLabel(c) : ''].filter(Boolean).join(', '))}">${fmtMoney(c.debtAmount)}</span>` : '—'}</td>
        <td>${risk ? `<span class="badge badge-overdue">${risk} недопродано</span>` : '—'}</td>
      </tr>
    `);
    row.querySelector('.open-client').addEventListener('dblclick', () => openClientModal(c));
    const cb = row.querySelector('.bulk-check');
    if (cb) cb.addEventListener('change', () => {
      if (cb.checked) state.clientBulkSelected.add(c.id); else state.clientBulkSelected.delete(c.id);
      const countEl = document.getElementById('bulk-count');
      if (countEl) countEl.textContent = state.clientBulkSelected.size;
    });
    tbody.appendChild(row);
  });
}

function fieldRow(label, value, locked) {
  return `<div class="field"><span class="k">${label}${locked ? ' <span class="lock" title="Редактирует только администратор или супервайзер">🔒</span>' : ''}</span><span class="v">${value}</span></div>`;
}

// ---------- "Давно не был" — последний визит по клиенту ----------

function clientTasksSorted(clientId) {
  return state.tasks.filter((t) => t.clientId === clientId).slice().sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
}

function lastVisitInfo(client) {
  const tasks = clientTasksSorted(client.id);
  if (!tasks.length) return { html: 'визитов ещё не было', stale: !!client.visitDay };
  const last = tasks[0];
  const days = Math.floor((Date.now() - new Date(last.dueDate).getTime()) / 86400000);
  const stale = days > 21;
  return { html: `${fmtDate(last.dueDate)} (${days} дн. назад)`, stale };
}

// ---------- Заметки/звонки по клиенту ----------

function notesListHtml(notes) {
  return (notes || []).length ? notes.map((n) => `
    <div class="history-row" data-note="${n.id}">
      <div class="muted">${fmtDateTime(n.createdAt)} · ${escapeHtml(userName(n.authorId))} ${isStaff() ? `<button type="button" class="icon-btn del-note" data-id="${n.id}">✕</button>` : ''}</div>
      <div>${escapeHtml(n.text)}</div>
    </div>
  `).join('') : '<div class="muted">Заметок пока нет.</div>';
}

function renderContactNotes(client) {
  return `
    <div class="assort-panel">
      <h3>Заметки / звонки</h3>
      <form id="note-form" class="note-form">
        <textarea name="text" placeholder="Например: звонил(а), не ответил" style="min-height:44px"></textarea>
        <button type="submit" class="btn-secondary">Добавить</button>
      </form>
      <div id="notes-list">${notesListHtml(client.contactNotes)}</div>
    </div>
  `;
}

function wireContactNotes(clientId) {
  const form = document.getElementById('note-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = form.querySelector('textarea[name=text]').value.trim();
    if (!text) return;
    const res = await api('POST', `/api/clients/${clientId}/notes`, { text });
    const client = clientById(clientId);
    if (client) client.contactNotes = res.client.contactNotes;
    document.getElementById('notes-list').innerHTML = notesListHtml(res.client.contactNotes);
    form.reset();
    wireContactNoteDeletes(clientId);
  });
  wireContactNoteDeletes(clientId);
}

function wireContactNoteDeletes(clientId) {
  document.querySelectorAll('.del-note').forEach((btn) => {
    btn.onclick = async () => {
      const res = await api('DELETE', `/api/clients/${clientId}/notes/${btn.dataset.id}`);
      const client = clientById(clientId);
      if (client) client.contactNotes = res.client.contactNotes;
      document.querySelector(`[data-note="${btn.dataset.id}"]`).remove();
    };
  });
}

// ---------- Мастера точки ----------

function mastersListHtml(masters) {
  return (masters || []).length ? masters.map((m) => `
    <div class="master-card" data-master="${m.id}">
      <div>
        <div class="name">${escapeHtml(m.name)} ${m.isNew ? '<span class="badge badge-amber">новый</span>' : ''}</div>
        <div class="spec">${escapeHtml(m.specialization || '—')} ${m.phone ? '· ' + telLink(m.phone) : ''}</div>
      </div>
      ${isStaff() ? `<button type="button" class="icon-btn del-master" data-id="${m.id}">✕</button>` : ''}
    </div>
  `).join('') : '<div class="muted">Мастера пока не добавлены.</div>';
}

function renderMastersSection(client) {
  return `
    <div class="assort-panel">
      <h3>Мастера точки</h3>
      <div id="masters-list">${mastersListHtml(client.masters)}</div>
      <form id="master-form" class="note-form" style="margin-top:8px">
        <input name="name" placeholder="ФИО мастера" required>
        <input name="specialization" placeholder="Специализация (парикмахер, косметолог...)">
        <input name="phone" placeholder="Телефон">
        <button type="submit" class="btn-secondary">+ Добавить мастера</button>
      </form>
    </div>
  `;
}

function wireMastersSection(clientId) {
  const form = document.getElementById('master-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name || !data.name.trim()) return;
    const res = await api('POST', `/api/clients/${clientId}/masters`, data);
    const client = clientById(clientId);
    if (client) client.masters = res.client.masters;
    document.getElementById('masters-list').innerHTML = mastersListHtml(res.client.masters);
    form.reset();
    wireMasterDeletes(clientId);
  });
  wireMasterDeletes(clientId);
}

function wireMasterDeletes(clientId) {
  document.querySelectorAll('.del-master').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Удалить мастера?')) return;
      const res = await api('DELETE', `/api/clients/${clientId}/masters/${btn.dataset.id}`);
      const client = clientById(clientId);
      if (client) client.masters = res.client.masters;
      document.querySelector(`[data-master="${btn.dataset.id}"]`).remove();
    };
  });
}

// ---------- "Точка закрыта" ----------

function renderClosureBlock(client) {
  if (client.closed) {
    return `<p class="note-pending">Точка закрыта${isStaff() ? '' : ''}</p>${isStaff() ? '<button type="button" class="btn-secondary" id="reopen-client">Открыть заново</button>' : ''}`;
  }
  if (client.closureRequested) {
    if (isStaff()) {
      return `<p class="note-pending">Точку предлагают закрыть (${escapeHtml(userName(client.closureRequestedBy))}) — подтвердить?</p>
        <button type="button" class="btn-secondary" id="confirm-closure">Подтвердить закрытие</button>
        <button type="button" class="btn-secondary" id="reject-closure">Отклонить</button>`;
    }
    return `<p class="note-pending">Заявка на закрытие точки отправлена — ждём подтверждения.</p>`;
  }
  return `<button type="button" class="btn-secondary" id="request-closure">Точка закрыта</button>`;
}

function wireClosureBlock(clientId) {
  const reload = async () => { await loadAll(); closeModal(); render(); };
  const reqBtn = document.getElementById('request-closure');
  if (reqBtn) reqBtn.addEventListener('click', async () => {
    if (!confirm('Отправить заявку на закрытие точки?')) return;
    await api('POST', `/api/clients/${clientId}/request-closure`);
    await reload();
  });
  const confirmBtn = document.getElementById('confirm-closure');
  if (confirmBtn) confirmBtn.addEventListener('click', async () => { await api('POST', `/api/clients/${clientId}/confirm-closure`); await reload(); });
  const rejectBtn = document.getElementById('reject-closure');
  if (rejectBtn) rejectBtn.addEventListener('click', async () => { await api('POST', `/api/clients/${clientId}/reject-closure`); await reload(); });
  const reopenBtn = document.getElementById('reopen-client');
  if (reopenBtn) reopenBtn.addEventListener('click', async () => { await api('POST', `/api/clients/${clientId}/reopen`); await reload(); });
}

async function openClientModal(client) {
  const isEdit = !!client;
  const isOwner = isEdit && client.ownerId === state.user.id;
  // Фаза 15, п.4: раньше полную редактируемую форму видел только админ/
  // супервайзер, агент — read-only вид (см. ветку ниже). Пользователь явно
  // попросил дать агентам возможность редактировать ВСЕ поля своих клиентов —
  // теперь ответственный агент тоже получает полную форму, как и админ/
  // супервайзер (владелец клиента и так гарантирован API-скоупингом —
  // агенту в state.clients в принципе попадают только его клиенты).
  const canEditCore = isStaff() || isOwner;

  const ownerOptions = state.users.filter((u) => u.role === 'agent' || u.role === undefined);

  const lastVisit = isEdit ? lastVisitInfo(client) : null;

  const canEditContact = isOwner && !!state.user.canEditClientContact;

  // Быстрое создание задачи по любой из 3 воронок прямо из карточки клиента.
  const taskButtonsHtml = isEdit ? `
    <div class="filter-bar" style="margin:8px 0">
      <span class="muted" style="font-size:13px">Создать задачу:</span>
      <button type="button" class="btn-secondary" id="quick-task-visit">Визит</button>
      <button type="button" class="btn-secondary" id="quick-task-sale">Продажа</button>
      <button type="button" class="btn-secondary" id="quick-task-waitlist">Лист ожидания</button>
    </div>` : '';

  let bodyHtml;
  if (isEdit && !canEditCore) {
    // Просмотр для агента: карточка + доступное редактирование заметок
    // (+ адрес/телефон/конт.лицо, если администратор выдал такое разрешение — см. «Команда»).
    bodyHtml = `
      <h2>${escapeHtml(client.name)}</h2>
      ${client.pendingApproval ? '<p class="note-pending">Точка на согласовании у администратора</p>' : ''}
      ${taskButtonsHtml}
      ${renderClosureBlock(client)}
      <div class="panel-inline">
        ${fieldRow('Тип точки', escapeHtml(client.pointType || '—'), true)}
        ${canEditContact ? '' : fieldRow('Адрес', `${escapeHtml(client.address || '—')} ${mapsLink(client.address)}`, true)}
        ${canEditContact ? '' : fieldRow('Телефон', telLink(client.phone), true)}
        ${canEditContact ? '' : fieldRow('Контактное лицо', escapeHtml(client.contactName || '—'), true)}
        ${fieldRow('День визита', escapeHtml(client.visitDay || '—'), true)}
        ${fieldRow('Работает по договору', escapeHtml(client.contractStatus), true)}
        ${fieldRow('Способ оплаты', escapeHtml(client.paymentMethod || 'не указан'), true)}
        ${fieldRow('Скидка / условия оплаты', escapeHtml(client.discountTerms || '—'), true)}
        ${fieldRow('План продаж (мес.)', client.salesPlan ? `${fmtMoney(client.salesPlan)} (факт за ${capitalize(latestSalesMonth())}: ${fmtMoney(client.currentMonthRevenue || 0)}${!state.currentMonthDataFresh ? ' — нет данных за текущий месяц' : ''})` : '—', true)}
        ${fieldRow('Ответственный', escapeHtml(userName(client.ownerId)), true)}
        ${fieldRow('Задолженность', client.debtAmount ? fmtMoney(client.debtAmount) + (client.debtOverdue ? ' (просрочка)' : '') + (debtAsOfLabel(client) ? ` — на ${escapeHtml(debtAsOfLabel(client))}` : '') : 'нет', true)}
        ${fieldRow('Последний визит', `<span class="${lastVisit.stale ? 'stale-visit' : ''}">${lastVisit.html}</span>`, true)}
        ${fieldRow('Особенности приёма', escapeHtml(client.orderWindow || '—'), true)}
        ${fieldRow('Номер маршрута', client.routeNumber != null ? String(client.routeNumber) : '—', true)}
        ${fieldRow('Instagram', client.socialContact ? instagramLink(client.socialContact) : '—', true)}
        ${fieldRow('Удобное время звонка', escapeHtml(client.bestCallTime || '—'), true)}
        ${fieldRow('ФИО ЛПР', escapeHtml(client.decisionMakerName || '—'), true)}
        ${fieldRow('Особые пожелания', escapeHtml(client.specialRequests || '—'), true)}
      </div>
      <form id="client-form">
        ${canEditContact ? `
        <label>Адрес ${client.address ? mapsLink(client.address) : ''}</label>
        <input name="address" value="${escapeAttr(client.address)}">
        <div class="field-row">
          <div><label>Телефон ${client.phone ? telLink(client.phone) : ''}</label><input name="phone" value="${escapeAttr(client.phone)}"></div>
          <div><label>Контактное лицо</label><input name="contactName" value="${escapeAttr(client.contactName)}"></div>
        </div>` : ''}
        <label>Заметки</label>
        <textarea name="notes">${escapeHtml(client.notes || '')}</textarea>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancel-modal">Закрыть</button>
          <button type="submit" class="btn-primary">Сохранить${canEditContact ? '' : ' заметки'}</button>
        </div>
      </form>
      ${renderMastersSection(client)}
      ${renderAssortmentSection(client)}
      ${renderTestAssortmentSection(client)}
      ${renderRecentSalesSection(client)}
      ${renderPromotionsSection(client)}
      ${renderContactNotes(client)}
      <div id="history-section" class="assort-panel"><h3>История визитов</h3><div class="muted">Загрузка…</div></div>
    `;
  } else {
    bodyHtml = `
      <h2>${isEdit ? 'Контрагент' : 'Новый контрагент'}</h2>
      ${taskButtonsHtml}
      <form id="client-form">
        <label>Название *</label>
        <input name="name" required value="${client ? escapeAttr(client.name) : ''}">
        <div class="field-row">
          <div><label>Тип точки</label>
            <select name="pointType">
              <option value="">не указан</option>
              ${state.pointTypes.map((p) => `<option value="${escapeAttr(p)}" ${client && client.pointType === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </select>
          </div>
          <div><label>День визита</label>
            <select name="visitDay">
              <option value="">—</option>
              ${VISIT_DAYS.map((d) => `<option value="${d}" ${client && client.visitDay === d ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
        </div>
        <label>Адрес ${client && client.address ? mapsLink(client.address) : ''}</label>
        <input name="address" value="${client ? escapeAttr(client.address) : ''}">
        <div class="field-row">
          <div><label>Телефон ${client && client.phone ? telLink(client.phone, '📞') : ''}</label><input name="phone" value="${client ? escapeAttr(client.phone) : ''}"></div>
          <div><label>Контактное лицо</label><input name="contactName" value="${client ? escapeAttr(client.contactName) : ''}"></div>
        </div>
        <div class="field-row">
          <div><label>Работает по договору</label>
            <select name="contractStatus">
              ${state.contractStatuses.map((s) => `<option value="${s}" ${client && client.contractStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div><label>Способ оплаты</label>
            <select name="paymentMethod">
              <option value="">не указан</option>
              ${state.paymentMethods.map((p) => `<option value="${p}" ${client && client.paymentMethod === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
        </div>
        <label>Скидка / условия оплаты</label>
        <input name="discountTerms" value="${client ? escapeAttr(client.discountTerms || '') : ''}" placeholder="Например: -10%, нал/безнал">
        <label>План продаж на клиента (сум/мес.)</label>
        <input type="number" min="0" step="1" name="salesPlan" value="${client && client.salesPlan ? client.salesPlan : ''}" placeholder="Например: 50000">

        ${isStaff() ? `<label>Ответственный агент</label>
          <select name="ownerId">
            ${ownerOptions.map((u) => `<option value="${u.id}" ${client && client.ownerId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
          </select>` : ''}
        <label>Особенности приёма (день/время, только для сведения)</label>
        <input name="orderWindow" value="${client ? escapeAttr(client.orderWindow || '') : ''}" placeholder="Например: заявки только вт/чт, 10:00–13:00">
        <div class="field-row">
          <div><label>Номер маршрута (для порядка посещения)</label><input type="number" min="0" step="1" name="routeNumber" value="${client && client.routeNumber != null ? client.routeNumber : ''}" placeholder="Например: 3"></div>
          <div><label>Instagram ${client && client.socialContact ? instagramLink(client.socialContact) : ''}</label><input name="socialContact" value="${client ? escapeAttr(client.socialContact || '') : ''}" placeholder="@handle или ссылка на профиль"></div>
        </div>
        <div class="field-row">
          <div><label>Удобное время звонка</label><input name="bestCallTime" value="${client ? escapeAttr(client.bestCallTime || '') : ''}"></div>
          <div><label>ФИО ЛПР (если отличается)</label><input name="decisionMakerName" value="${client ? escapeAttr(client.decisionMakerName || '') : ''}"></div>
        </div>
        <label>Особые пожелания</label>
        <input name="specialRequests" value="${client ? escapeAttr(client.specialRequests || '') : ''}">
        <label>Заметки</label>
        <textarea name="notes">${client ? escapeHtml(client.notes || '') : ''}</textarea>
        ${isEdit ? `<div class="muted" style="font-size:13px;margin-top:6px">Последний визит: <span class="${lastVisit.stale ? 'stale-visit' : ''}">${lastVisit.html}</span></div>` : ''}
        <div class="modal-actions">
          ${isEdit && isStaff() ? '<button type="button" class="btn-secondary" id="delete-client">Удалить</button>' : ''}
          ${isEdit && client.pendingApproval && isStaff() ? '<button type="button" class="btn-secondary" id="approve-client">Одобрить точку</button>' : ''}
          <button type="button" class="btn-secondary btn-cancel-muted" id="cancel-modal">Отмена</button>
          <button type="submit" class="btn-primary">Сохранить</button>
        </div>
      </form>
      ${isEdit ? renderClosureBlock(client) : ''}
      ${isEdit ? renderMastersSection(client) : ''}
      ${isEdit ? renderAssortmentSection(client) : ''}
      ${isEdit ? renderTestAssortmentSection(client) : ''}
      ${isEdit ? renderRecentSalesSection(client) : ''}
      ${isEdit ? renderPromotionsSection(client) : ''}
      ${isEdit ? renderContactNotes(client) : ''}
      ${isEdit ? '<div id="history-section" class="assort-panel"><h3>История визитов</h3><div class="muted">Загрузка…</div></div>' : ''}
    `;
  }

  openModal(bodyHtml, async (form) => {
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      if (client) await api('PUT', `/api/clients/${client.id}`, data);
      else await api('POST', '/api/clients', data);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.duplicate) {
        const d = err.data.duplicate;
        const ok = confirm(`Похоже, такой контрагент уже есть:\n«${d.name}», ${d.address || 'без адреса'}, ${d.phone || 'без телефона'}\n\nВсё равно добавить как новый?`);
        if (!ok) return;
        data.force = true;
        await api('POST', '/api/clients', data);
      } else {
        throw err;
      }
    }
    await loadAll();
    closeModal();
    render();
  });

  // Закрытие карточки клиента свайпом вправо (мобильные тач-жесты).
  wireSwipeToClose(document.querySelector('#modal-root .modal'), closeModal);

  const delBtn = document.getElementById('delete-client');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Удалить контрагента? Связанные задачи останутся, но потеряют ссылку на него.')) return;
    await api('DELETE', `/api/clients/${client.id}`);
    await loadAll();
    closeModal();
    render();
  });

  const approveBtn = document.getElementById('approve-client');
  if (approveBtn) approveBtn.addEventListener('click', async () => {
    await api('POST', `/api/clients/${client.id}/approve`);
    await loadAll();
    closeModal();
    render();
  });

  const quickTaskVisitBtn = document.getElementById('quick-task-visit');
  if (quickTaskVisitBtn) quickTaskVisitBtn.addEventListener('click', () => { closeModal(); openTaskModal(null, 'visit', client.id); });
  const quickTaskSaleBtn = document.getElementById('quick-task-sale');
  if (quickTaskSaleBtn) quickTaskSaleBtn.addEventListener('click', () => { closeModal(); openTaskModal(null, 'sale', client.id); });
  const quickTaskWaitlistBtn = document.getElementById('quick-task-waitlist');
  if (quickTaskWaitlistBtn) quickTaskWaitlistBtn.addEventListener('click', () => { closeModal(); openTaskModal(null, 'waitlist', client.id); });

  if (isEdit) {
    wireAssortmentToggle(client.id);
    wireToggle(`promo-toggle-${client.id}`, `promo-panel-${client.id}`);
    wireContactNotes(client.id);
    wireClosureBlock(client.id);
    wireMastersSection(client.id);
    loadClientHistory(client.id);
  }
}

// "Акции" (Фаза 6, п.15) — что клиент брал по текущим акциям склада/магазина
// (Загрузка_акции_25.08.xlsx). Срез на дату импорта, пересчитывается целиком при
// каждом обновлении данных — раздел просто показывает список, без ручного редактирования.
function renderPromotionsSection(client) {
  const items = client.promotions || [];
  if (!items.length) return '';
  return `
    <button type="button" class="assort-btn" id="promo-toggle-${client.id}">🎁 Акции (${items.length}, на ${fmtMoney(items.reduce((s, p) => s + (p.sum || 0), 0))})</button>
    <div class="assort-panel" id="promo-panel-${client.id}" style="display:none">
      ${items.map((p) => `<div class="promo-row"><span>${escapeHtml(p.promo)}</span><span class="promo-qty">${formatQty(p.qty)} шт · ${fmtMoney(p.sum || 0)}</span></div>`).join('')}
    </div>
  `;
}

// Остаток на складе (stockQty) — подтягивается импортом из выгрузки "Актуальные
// остатки" (data/import/stock.json) по точному совпадению названия товара; null
// значит "нет данных" (товар не нашёлся в выгрузке остатков), это НЕ то же самое,
// что "остаток 0" — поэтому пустое значение просто не показываем, а не пишем "0".
function stockBadgeHtml(p) {
  if (p.stockQty === undefined || p.stockQty === null) return '';
  const low = p.stockQty <= 0;
  // Правка 01.09.2026: явно показываем дату среза остатков (в отличие от продаж/
  // акций, остатки НЕ обнуляются при смене месяца — это снимок на дату, а не поток).
  const asOfTitle = state.stockAsOf ? `Остаток на складе (снято на ${escapeAttr(state.stockAsOf)})` : 'Остаток на складе';
  return `<span class="stock-badge${low ? ' stock-badge-empty' : ''}" title="${asOfTitle}">📦 ${formatQty(p.stockQty)} ${escapeHtml(p.stockUnit || 'шт')}</span>`;
}
function formatQty(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

// Артикул товара (Фаза 20) — из справочника номенклатуры, сопоставляется по
// названию товара при импорте (см. src/import.js, articleByName). Не у всех
// товаров он находится (обрезанные/неточные названия в файлах продаж — то же
// ограничение, что и у сопоставления остатков, см. Фазу 6.1) — тогда бейдж
// просто не показывается, а не пишется "нет данных" на каждой строке.
function skuBadgeHtml(p) {
  if (!p.sku) return '';
  return `<span class="sku-badge" title="Артикул">#${escapeHtml(p.sku)}</span> `;
}

function assortRow(p) {
  return `
    <div class="assort-row">
      <span>${skuBadgeHtml(p)}${escapeHtml(p.product)} <span class="brand-badge">${escapeHtml(p.brand || 'Прочее')}</span> ${stockBadgeHtml(p)}</span>
      <span class="freq">${p.monthsCount} из 6 посл. мес · ~${p.avgQty} шт/мес · посл.: ${p.lastMonth}</span>
    </div>
  `;
}

// "Последние продажи" (Фаза 20) — по просьбе пользователя показывает последние
// поставки клиенту. Настоящих номеров/дат отдельных накладных в исходных данных
// нет (проверено — только помесячные суммы по товару в client.monthlyAssortment,
// без разбивки на конкретные документы), поэтому используется согласованный с
// пользователем аналог: последние 3 месяца из тех, где у клиента были продажи,
// с товарами/кол-вом/ценой по каждому. Если позже появится реальная выгрузка с
// номерами/датами документов — эту функцию нужно будет переписать под неё.
function renderRecentSalesSection(client) {
  const monthly = client.monthlyAssortment || {};
  const monthsWithSales = (state.salesMonths || []).filter((m) => (monthly[m] || []).length > 0);
  const last3 = monthsWithSales.slice(-3).reverse(); // от новых к старым
  if (!last3.length) return '';
  return `
    <button type="button" class="assort-btn" id="recent-sales-toggle-${client.id}">🧾 Последние продажи</button>
    <div class="assort-panel" id="recent-sales-panel-${client.id}" style="display:none">
      <div class="muted" style="font-size:12px;margin-bottom:6px">Точных номеров и дат накладных в данных нет — показаны товары за последние ${last3.length} мес. с продажами (не обязательно подряд).</div>
      ${last3.map((m) => {
        const items = monthly[m] || [];
        const total = items.reduce((s, it) => s + (it.revenue || 0), 0);
        return `
          <div class="recent-sale-month">
            <div class="recent-sale-month-heading">${capitalize(m)} — ${fmtMoney(total)}</div>
            ${items.map((it) => `
              <div class="assort-row">
                <span>${skuBadgeHtml(it)}${escapeHtml(it.product)} <span class="brand-badge">${escapeHtml(it.brand || 'Прочее')}</span></span>
                <span class="freq">${formatQty(it.qty)} шт · ${fmtMoney(it.qty ? it.revenue / it.qty : 0)}/шт · ${fmtMoney(it.revenue || 0)}</span>
              </div>
            `).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Фильтр по бренду/категории — общий для регулярного, тестового и "не добрал"
// списков, чтобы можно было быстро отделить, скажем, только красители Kapous,
// когда готовишь коммерческое предложение. Правка 02.09.2026: добавлен отдельный
// переключатель "Убрать краски/оксиды" — прячет эту группу из списка независимо
// от того, какой бренд выбран (в т.ч. можно убрать их из "Все" — общего реестра).
function brandFilterBarHtml(items, groupId) {
  const brands = Array.from(new Set(items.map((p) => p.brand || 'Прочее')));
  return `
    <div class="assort-brand-filter" data-group="${groupId}">
      <button type="button" class="brand-chip active" data-brand="all">Все</button>
      ${brands.map((b) => `<button type="button" class="brand-chip" data-brand="${escapeAttr(b)}">${escapeHtml(b)}</button>`).join('')}
      <button type="button" class="brand-chip" data-brand="colorants">Красители/оксиды</button>
      <label class="colorant-exclude-toggle"><input type="checkbox" class="exclude-colorants-cb" data-group="${groupId}"> Убрать краски/оксиды</label>
    </div>
  `;
}

function filterAssortItems(items, brand, excludeColorants) {
  let out = items;
  if (brand && brand !== 'all') {
    out = brand === 'colorants' ? out.filter(isColorantItem) : out.filter((p) => (p.brand || 'Прочее') === brand);
  }
  if (excludeColorants) out = out.filter((p) => !isColorantItem(p));
  return out;
}

function renderAssortmentSection(client) {
  const items = client.regularAssortment || [];
  if (!items.length) return '';
  return `
    <button type="button" class="assort-btn" id="assort-toggle-${client.id}">🛒 Регулярный ассортимент (${items.length})</button>
    <div class="assort-panel" id="assort-panel-${client.id}" style="display:none">
      ${brandFilterBarHtml(items, `assort-${client.id}`)}
      <div id="assort-body-${client.id}"></div>
    </div>
  `;
}

// Тестовый ассортимент — товары, купленные хотя бы раз, но не дотянувшие до
// регулярного (разовые/пробные покупки). Отдельный список от регулярного ассортимента.
function renderTestAssortmentSection(client) {
  const items = client.testAssortment || [];
  if (!items.length) return '';
  return `
    <button type="button" class="assort-btn assort-btn-test" id="test-assort-toggle-${client.id}">🧪 Тестовый ассортимент (${items.length})</button>
    <div class="assort-panel" id="test-assort-panel-${client.id}" style="display:none">
      ${brandFilterBarHtml(items, `test-assort-${client.id}`)}
      <div id="test-assort-body-${client.id}"></div>
    </div>
  `;
}

// Краски и оксиды — отдельная видимая группа внутри регулярного/тестового
// ассортимента (по просьбе пользователя), а не просто пункт фильтра по бренду.
// В разделе "риск отвала" (не добрал) такого разделения нет — там остаётся
// единый список, как раньше.
function isColorantItem(p) { return p.category === 'Краситель' || p.category === 'Оксид'; }

function renderGroupedAssort(items) {
  if (!items.length) return '<div class="muted" style="font-size:13px;padding:4px 0">Нет позиций по этому фильтру.</div>';
  const colorants = items.filter(isColorantItem);
  const others = items.filter((p) => !isColorantItem(p));
  return `
    ${others.length ? others.map(assortRow).join('') : ''}
    ${colorants.length ? `
      <div class="assort-group-heading">🎨 Краски и оксиды</div>
      ${colorants.map(assortRow).join('')}
    ` : ''}
  `;
}

function renderAssortBody(items, brand, mode, excludeColorants) {
  const filtered = filterAssortItems(items, brand, excludeColorants);
  if (mode === 'regular') {
    const normal = filtered.filter((p) => !p.atRisk);
    const risky = filtered.filter((p) => p.atRisk);
    return `
      ${normal.length ? renderGroupedAssort(normal) : '<div class="muted" style="font-size:13px;padding:4px 0">Нет позиций по этому фильтру.</div>'}
      ${risky.length ? `
        <div class="assort-risk-heading">⚠️ Недопродано — ещё не покупали в текущем месяце</div>
        ${risky.map(assortRow).join('')}
      ` : ''}
    `;
  }
  return renderGroupedAssort(filtered);
}

function wireBrandFilter(groupId, items, bodyElId, mode) {
  const bar = document.querySelector(`.assort-brand-filter[data-group="${groupId}"]`);
  const body = document.getElementById(bodyElId);
  if (!bar || !body) return;
  let currentBrand = 'all';
  const excludeCb = bar.querySelector('.exclude-colorants-cb');
  body.innerHTML = renderAssortBody(items, currentBrand, mode, false);
  bar.querySelectorAll('.brand-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      currentBrand = chip.dataset.brand;
      bar.querySelectorAll('.brand-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      body.innerHTML = renderAssortBody(items, currentBrand, mode, excludeCb && excludeCb.checked);
    });
  });
  // "Убрать краски/оксиды" (02.09.2026) — независимый переключатель, сочетается
  // с любым выбранным брендом (в т.ч. с "Все" — прячет их из общего реестра).
  if (excludeCb) {
    excludeCb.addEventListener('change', () => {
      body.innerHTML = renderAssortBody(items, currentBrand, mode, excludeCb.checked);
    });
  }
}

// Скрипты, вставленные через innerHTML/template, браузер не выполняет —
// поэтому переключатели ассортимента навешиваются явным addEventListener
// после того, как модалка реально попала в DOM (см. вызовы в openClientModal/openTaskModal).
function wireToggle(btnId, panelId) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
}
function wireAssortmentToggle(clientId) {
  const client = clientById(clientId);
  wireToggle(`assort-toggle-${clientId}`, `assort-panel-${clientId}`);
  wireToggle(`test-assort-toggle-${clientId}`, `test-assort-panel-${clientId}`);
  wireToggle(`recent-sales-toggle-${clientId}`, `recent-sales-panel-${clientId}`);
  if (client) {
    wireBrandFilter(`assort-${clientId}`, client.regularAssortment || [], `assort-body-${clientId}`, 'regular');
    wireBrandFilter(`test-assort-${clientId}`, client.testAssortment || [], `test-assort-body-${clientId}`, 'test');
  }
}

async function loadClientHistory(clientId) {
  const box = document.getElementById('history-section');
  if (!box) return;
  try {
    const res = await api('GET', `/api/clients/${clientId}/history`);
    if (!res.tasks.length) {
      box.innerHTML = '<h3>История визитов</h3><div class="muted">Задач по этому клиенту ещё не было.</div>';
      return;
    }
    box.innerHTML = '<h3>История визитов</h3>' + res.tasks.map((t) => `
      <div class="history-row">
        <div><strong>${stageLabel(t.stage)}</strong> — ${escapeHtml(t.title)}</div>
        <div class="muted">${fmtDateTime(t.updatedAt || t.createdAt)} · ${escapeHtml(userName(t.assigneeId))}</div>
        ${t.comment ? `<div class="comment">${escapeHtml(t.comment)}</div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    box.innerHTML = '<h3>История визитов</h3><div class="muted">Не удалось загрузить.</div>';
  }
}

function stageLabel(key) {
  const s = state.stages.find((s) => s.key === key);
  return s ? s.label : key;
}

// ---------- Задачи (доска) ----------

function taskTagBadges(t) {
  return (t.tags || []).map((tag) => `<span class="badge tag-badge">${escapeHtml(tag)}</span>`).join(' ');
}

function renderTasks(content) {
  const bulk = state.taskBulkMode;
  // Правка 31.08.2026 (п.2): порядок воронок — продажи → лист ожидания → визиты
  // (был: визиты → продажи → лист ожидания); по умолчанию открывается первая — продажи.
  const typeView = state.taskTypeView || 'sale';
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Задачи по клиентам</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${isStaff() && typeView === 'visit' ? `<button type="button" class="btn-secondary ${bulk ? 'active' : ''}" id="task-bulk-mode-btn">${bulk ? 'Отменить выбор' : 'Выбрать несколько'}</button>` : ''}
          ${isStaff() ? `
            <a class="btn-secondary" href="/api/tasks/export" download>⬇ Выгрузить задачи в файл</a>
            <button type="button" class="btn-secondary" id="task-import-btn">⬆ Загрузить задачи из файла</button>
            <input type="file" id="task-import-input" accept=".json" style="display:none">
          ` : ''}
          <button class="btn-primary" id="add-task-btn">+ Новая задача</button>
        </div>
      </div>
      <div class="filter-bar">
        <button type="button" class="btn-secondary ${typeView === 'sale' ? 'active' : ''}" id="task-type-sale-btn">Воронка продаж</button>
        <button type="button" class="btn-secondary ${typeView === 'waitlist' ? 'active' : ''}" id="task-type-waitlist-btn">Лист ожидания</button>
        <button type="button" class="btn-secondary ${typeView === 'visit' ? 'active' : ''}" id="task-type-visit-btn">Визиты с супервайзером</button>
      </div>
      ${typeView === 'visit' ? `
      <div class="filter-bar">
        <span class="muted" style="font-size:13px">Фильтр по тегам:</span>
        ${state.taskTags.map((tag) => `<button type="button" class="tag-filter-btn ${state.taskTagFilter.has(tag) ? 'active' : ''}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`).join('')}
        ${state.taskTagFilter.size ? '<button type="button" class="link-btn" id="tag-filter-reset">Сбросить</button>' : ''}
      </div>` : typeView === 'sale' ? `
      <div class="sub muted" style="margin-bottom:6px">Звонок (узнать когда на месте) → Встреча (дата/время, показать ассортимент) → Сделка / Провал (нельзя закрыть без пояснения).</div>
      ` : `
      <div class="sub muted" style="margin-bottom:6px">Клиент ждёт товар → Накладная оформлена → Товар получен клиентом (закрытая — подтверждает администратор/супервайзер).</div>
      <div class="filter-bar">
        <span class="muted" style="font-size:13px">Фильтр по тегам:</span>
        ${(state.waitlistTags || []).map((tag) => `<button type="button" class="tag-filter-btn waitlist-tag-filter-btn ${state.waitlistTagFilter.has(tag) ? 'active' : ''}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`).join('')}
        ${state.waitlistTagFilter.size ? '<button type="button" class="link-btn" id="waitlist-tag-filter-reset">Сбросить</button>' : ''}
      </div>
      `}
      ${bulk && typeView === 'visit' ? `<div class="filter-bar">
        <span class="muted" style="font-size:13px">Выбрано: <span id="task-bulk-count">0</span></span>
        <button type="button" class="btn-secondary" id="task-bulk-delete-btn">Удалить выбранные</button>
      </div>` : ''}
      <div class="kanban ${typeView === 'sale' ? 'sale-board' : ''}" id="kanban"></div>
    </div>
  `));
  document.getElementById('add-task-btn').addEventListener('click', () => openTaskModal(null, typeView));
  // Экспорт/импорт задач файлом (п.11, 31.08.2026) — на случай пересборки проекта,
  // после которой data/db.json не переносится и все задачи теряются. "Выгрузить" —
  // просто ссылка на скачивание (сессия и так авторизована через cookie). "Загрузить"
  // читает выбранный файл на клиенте и шлёт его содержимое на /api/tasks/import —
  // сервер сам сопоставит клиентов/агентов по имени и пропустит дубли/нераспознанное.
  const taskImportBtn = document.getElementById('task-import-btn');
  const taskImportInput = document.getElementById('task-import-input');
  if (taskImportBtn && taskImportInput) {
    taskImportBtn.addEventListener('click', () => taskImportInput.click());
    taskImportInput.addEventListener('change', async () => {
      const file = taskImportInput.files[0];
      if (!file) return;
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch (e) {
        alert('Не удалось прочитать файл — это не корректный JSON');
        taskImportInput.value = '';
        return;
      }
      try {
        const result = await api('POST', '/api/tasks/import', { tasks: parsed.tasks || [] });
        let msg = `Загружено новых задач: ${result.imported}.\nПропущено (уже есть): ${result.skippedDuplicate}.`;
        if (result.unresolvedCount) {
          msg += `\nНе удалось распознать: ${result.unresolvedCount} (клиент не найден в текущей базе) — список в консоли браузера.`;
          console.log('Не распознано при импорте задач:', result.unresolved);
        }
        alert(msg);
        await loadAll();
        render();
      } catch (e) {
        alert('Ошибка загрузки: ' + e.message);
      }
      taskImportInput.value = '';
    });
  }
  document.getElementById('task-type-visit-btn').addEventListener('click', () => { state.taskTypeView = 'visit'; render(); });
  document.getElementById('task-type-sale-btn').addEventListener('click', () => { state.taskTypeView = 'sale'; render(); });
  document.getElementById('task-type-waitlist-btn').addEventListener('click', () => { state.taskTypeView = 'waitlist'; render(); });
  const taskBulkModeBtn = document.getElementById('task-bulk-mode-btn');
  if (taskBulkModeBtn) taskBulkModeBtn.addEventListener('click', () => { state.taskBulkMode = !state.taskBulkMode; state.taskBulkSelected = new Set(); render(); });
  const taskBulkDeleteBtn = document.getElementById('task-bulk-delete-btn');
  if (taskBulkDeleteBtn) taskBulkDeleteBtn.addEventListener('click', async () => {
    if (!state.taskBulkSelected.size) return alert('Не выбрано ни одной задачи');
    if (!confirm(`Удалить ${state.taskBulkSelected.size} задач(и)?`)) return;
    await api('POST', '/api/tasks/bulk-delete', { ids: Array.from(state.taskBulkSelected) });
    state.taskBulkMode = false;
    state.taskBulkSelected = new Set();
    await loadAll();
    render();
  });

  content.querySelectorAll('.tag-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (state.taskTagFilter.has(tag)) state.taskTagFilter.delete(tag);
      else state.taskTagFilter.add(tag);
      render();
    });
  });
  const tagResetBtn = document.getElementById('tag-filter-reset');
  if (tagResetBtn) tagResetBtn.addEventListener('click', () => { state.taskTagFilter = new Set(); render(); });

  content.querySelectorAll('.waitlist-tag-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (state.waitlistTagFilter.has(tag)) state.waitlistTagFilter.delete(tag);
      else state.waitlistTagFilter.add(tag);
      render();
    });
  });
  const waitlistTagResetBtn = document.getElementById('waitlist-tag-filter-reset');
  if (waitlistTagResetBtn) waitlistTagResetBtn.addEventListener('click', () => { state.waitlistTagFilter = new Set(); render(); });

  if (typeView === 'sale') { renderSaleKanban(); return; }
  if (typeView === 'waitlist') { renderWaitlistKanban(); return; }

  const today = new Date().toISOString().slice(0, 10);
  const kanban = document.getElementById('kanban');
  state.stages.forEach((stage) => {
    let inStage = state.tasks.filter((t) => (t.taskType || 'visit') === 'visit' && t.stage === stage.key);
    if (state.taskTagFilter.size) {
      inStage = inStage.filter((t) => (t.tags || []).some((tag) => state.taskTagFilter.has(tag)));
    }
    const col = el(`
      <div class="kanban-col" data-stage="${stage.key}">
        <h3>${stage.label} <span class="col-sum">· ${inStage.length}</span></h3>
        <div class="col-body"></div>
      </div>
    `);
    const colBody = col.querySelector('.col-body');
    inStage.forEach((t) => {
      const client = clientById(t.clientId);
      const overdue = t.dueDate && t.dueDate < today && ACTIVE_STAGES.includes(t.stage);
      const card = el(`
        <div class="deal-card" draggable="true" data-id="${t.id}">
          ${bulk ? `<input type="checkbox" class="bulk-check task-bulk-check" data-id="${t.id}" ${state.taskBulkSelected.has(t.id) ? 'checked' : ''} onclick="event.stopPropagation()">` : ''}
          <div class="deal-title">${escapeHtml(t.title)}</div>
          <div class="deal-client">${client ? escapeHtml(client.name) : '—'}</div>
          <div class="deal-client">${agentTag(t.assigneeId)} ${t.dueDate ? '· ' + fmtDate(t.dueDate) : ''}${t.visitTime ? ' · ' + escapeHtml(t.visitTime) : ''} ${overdue ? '<span class="badge badge-overdue">просрочено</span>' : ''} ${t.report ? '<span class="report-check" title="Отчёт заполнен">✓ отчёт</span>' : ''}</div>
          ${taskTagBadges(t) ? `<div class="card-tags">${taskTagBadges(t)}</div>` : ''}
          ${(t.attachments || []).length ? `<div class="muted">📎 ${t.attachments.length}</div>` : ''}
        </div>
      `);
      card.addEventListener('click', () => { if (!bulk) openTaskModal(t); });
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', t.id));
      const cb = card.querySelector('.task-bulk-check');
      if (cb) cb.addEventListener('change', () => {
        if (cb.checked) state.taskBulkSelected.add(t.id); else state.taskBulkSelected.delete(t.id);
        const countEl = document.getElementById('task-bulk-count');
        if (countEl) countEl.textContent = state.taskBulkSelected.size;
      });
      colBody.appendChild(card);
    });
    col.addEventListener('dragover', (e) => e.preventDefault());
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      await api('PUT', `/api/tasks/${id}`, { stage: stage.key });
      await loadAll();
      render();
    });
    kanban.appendChild(col);
  });
}

// ---------- Воронка продаж: звонок → встреча → сделка/провал ----------

function renderSaleKanban() {
  const kanban = document.getElementById('kanban');
  const stages = state.saleStages || [];
  const today = new Date().toISOString().slice(0, 10);
  stages.forEach((stage) => {
    const inStage = state.tasks.filter((t) => t.taskType === 'sale' && t.stage === stage.key);
    const col = el(`
      <div class="sale-col" data-stage="${stage.key}">
        <h3>${escapeHtml(stage.label)} · ${inStage.length}</h3>
        <div class="col-body"></div>
      </div>
    `);
    const colBody = col.querySelector('.col-body');
    inStage.forEach((t) => {
      const client = clientById(t.clientId);
      const overdue = t.dueDate && t.dueDate < today;
      const card = el(`
        <div class="deal-card" draggable="true" data-id="${t.id}">
          <div class="deal-title">${escapeHtml(t.title)}</div>
          <div class="deal-client">${client ? escapeHtml(client.name) : '—'}</div>
          <div class="deal-client">${agentTag(t.assigneeId)} ${t.dueDate ? '· ' + fmtDate(t.dueDate) : ''} ${overdue ? '<span class="badge badge-overdue">просрочено</span>' : ''}</div>
          ${t.dateChangeRequest ? '<div class="badge badge-amber" style="margin-top:4px">заявка на перенос даты</div>' : ''}
          ${t.explanation ? `<div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(t.explanation)}</div>` : ''}
        </div>
      `);
      card.addEventListener('click', () => openTaskModal(t));
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', t.id));
      colBody.appendChild(card);
    });
    col.addEventListener('dragover', (e) => e.preventDefault());
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      const draggedTask = state.tasks.find((x) => String(x.id) === String(id));
      // В "Сделку"/"Провал" нельзя перетащить напрямую — нужно короткое пояснение,
      // поэтому просто открываем карточку задачи, где есть это поле.
      if (draggedTask && SALE_FINAL_STAGES_CLIENT.includes(stage.key) && draggedTask.stage !== stage.key) {
        openTaskModal(draggedTask);
        return;
      }
      try {
        await api('PUT', `/api/tasks/${id}`, { stage: stage.key });
        await loadAll();
        render();
      } catch (err) { alert(err.message); }
    });
    kanban.appendChild(col);
  });
}

// ---------- Воронка "Лист ожидания": клиент ждёт товар → накладная → получен ----------

function renderWaitlistKanban() {
  const kanban = document.getElementById('kanban');
  const stages = state.waitlistStages || [];
  const today = new Date().toISOString().slice(0, 10);
  stages.forEach((stage) => {
    let inStage = state.tasks.filter((t) => t.taskType === 'waitlist' && t.stage === stage.key);
    if (state.waitlistTagFilter.size) {
      inStage = inStage.filter((t) => (t.tags || []).some((tag) => state.waitlistTagFilter.has(tag)));
    }
    const col = el(`
      <div class="kanban-col" data-stage="${stage.key}">
        <h3>${escapeHtml(stage.label)} <span class="col-sum">· ${inStage.length}</span></h3>
        <div class="col-body"></div>
      </div>
    `);
    const colBody = col.querySelector('.col-body');
    inStage.forEach((t) => {
      const client = clientById(t.clientId);
      const overdue = t.dueDate && t.dueDate < today && stage.key !== 'received';
      const card = el(`
        <div class="deal-card" draggable="true" data-id="${t.id}">
          <div class="deal-title">${escapeHtml(t.title)}</div>
          <div class="deal-client">${client ? escapeHtml(client.name) : '—'}</div>
          <div class="deal-client">${agentTag(t.assigneeId)} ${t.dueDate ? '· ' + fmtDate(t.dueDate) : ''} ${overdue ? '<span class="badge badge-overdue">просрочено</span>' : ''}</div>
          ${taskTagBadges(t) ? `<div class="card-tags">${taskTagBadges(t)}</div>` : ''}
        </div>
      `);
      card.addEventListener('click', () => openTaskModal(t));
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', t.id));
      colBody.appendChild(card);
    });
    col.addEventListener('dragover', (e) => e.preventDefault());
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      try {
        await api('PUT', `/api/tasks/${id}`, { stage: stage.key });
        await loadAll();
        render();
      } catch (err) { alert(err.message); }
    });
    kanban.appendChild(col);
  });
}

function openTaskModal(task, forceType, presetClientId) {
  const isEdit = !!task;
  if (!state.clients.length) {
    alert('Сначала добавьте хотя бы одного клиента во вкладке «Клиенты».');
    return;
  }
  const agentOptions = state.users.filter((u) => u.role === 'agent');
  const assigneeBlock = isStaff()
    ? `<label>Ответственный агент</label><select name="assigneeId">${agentOptions.map((u) => `<option value="${u.id}" ${task && task.assigneeId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}</select>`
    : '';

  const myClients = state.user.role === 'agent' ? state.clients.filter((c) => c.ownerId === state.user.id) : state.clients;

  // Дату можно менять свободно, пока она не проставлена; после установки —
  // только администратор/супервайзер (у агента поле блокируется).
  const dateLocked = isEdit && !isStaff() && !!task.dueDate;
  const taskClient = isEdit ? clientById(task.clientId) : null;
  const hasAssortment = taskClient && ((taskClient.regularAssortment || []).length || (taskClient.testAssortment || []).length);
  const isSale = isEdit ? task.taskType === 'sale' : forceType === 'sale';
  const isWaitlist = isEdit ? task.taskType === 'waitlist' : forceType === 'waitlist';
  const stageOptions = isSale ? (state.saleStages || []) : isWaitlist ? (state.waitlistStages || []) : state.stages;

  const typeSelectBlock = !isEdit ? `
      <label>Тип задачи</label>
      <select name="taskType" id="task-type-select">
        <option value="visit" ${forceType !== 'sale' && forceType !== 'waitlist' ? 'selected' : ''}>Визит</option>
        <option value="sale" ${forceType === 'sale' ? 'selected' : ''}>Продажа (звонок → встреча → сделка)</option>
        <option value="waitlist" ${forceType === 'waitlist' ? 'selected' : ''}>Лист ожидания (товар под заказ)</option>
      </select>
  ` : '';

  const body = `
    <h2>${isEdit ? (isSale ? 'Задача воронки продаж' : isWaitlist ? 'Задача листа ожидания' : 'Задача') : 'Новая задача'}</h2>
    ${isEdit && isStaff() ? `<div class="muted" style="font-size:12px;margin-bottom:8px">Создано: ${fmtDateTime(task.createdAt)} · ${escapeHtml(userName(task.createdBy))}</div>` : ''}
    <form id="task-form">
      <label>Клиент *</label>
      ${!isEdit ? '<input type="text" id="task-client-search" placeholder="Поиск клиента по названию..." autocomplete="off" style="margin-bottom:6px">' : ''}
      <select name="clientId" id="task-client-select" required ${isEdit ? 'disabled' : ''}>
        ${myClients.map((c) => `<option value="${c.id}" ${(task && task.clientId === c.id) || (!isEdit && presetClientId && Number(presetClientId) === c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>
      ${isEdit && taskClient && taskClient.phone ? `<div class="muted" style="font-size:13px;margin:-6px 0 10px">📞 ${telLink(taskClient.phone)}</div>` : ''}
      ${typeSelectBlock}
      <label>Название</label>
      <input name="title" value="${task ? escapeAttr(task.title) : ''}" placeholder="${isSale ? 'Звонок клиенту' : isWaitlist ? 'Ожидание товара' : 'Посетить клиента'}">
      <label>Описание</label>
      <textarea name="description">${task ? escapeHtml(task.description || '') : ''}</textarea>
      <div class="field-row">
        <div><label>Срок *${dateLocked ? ' <span class="lock" title="Обратитесь к супервайзеру">🔒</span>' : ''}</label>
          ${dateFieldHTML({ name: 'dueDate', value: task ? task.dueDate : '', required: true, disabled: dateLocked })}
        </div>
        ${!isSale && !isWaitlist ? `<div><label>Время визита</label><input type="time" name="visitTime" value="${task ? escapeAttr(task.visitTime || '') : ''}"></div>` : ''}
        ${isEdit ? `<div><label>Этап</label><select name="stage">${stageOptions.map((s) => `<option value="${s.key}" ${task.stage === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>` : ''}
      </div>
      ${assigneeBlock}
      ${!isSale && !isWaitlist ? `
      <label>Теги</label>
      <div class="tag-checks">
        ${state.taskTags.map((tag) => `<label class="tag-check"><input type="checkbox" name="tags" value="${escapeAttr(tag)}" ${task && (task.tags || []).includes(tag) ? 'checked' : ''}> ${escapeHtml(tag)}</label>`).join('')}
      </div>` : ''}
      ${isWaitlist ? `
      <label>Бренд товара</label>
      <div class="tag-checks">
        ${(state.waitlistTags || []).map((tag) => `<label class="tag-check"><input type="checkbox" name="tags" value="${escapeAttr(tag)}" ${task && (task.tags || []).includes(tag) ? 'checked' : ''}> ${escapeHtml(tag)}</label>`).join('')}
      </div>` : ''}
      ${isEdit && !isSale && !isWaitlist ? `<label>Комментарий по визиту</label><textarea name="comment">${escapeHtml(task.comment || '')}</textarea>` : ''}
      ${isEdit && !isSale && !isWaitlist ? `<label>Отчёт по задаче ${task.stage === 'done' ? '*' : ''}</label><textarea name="report" placeholder="Без отчёта нельзя перевести в «Выполнена»">${escapeHtml(task.report || '')}</textarea>` : ''}
      ${isEdit && isSale ? `<label>Пояснение${SALE_FINAL_STAGES_CLIENT.includes(task.stage) ? '' : ' (обязательно перед «Сделка»/«Провал»)'}</label><textarea name="explanation" placeholder="Короткое пояснение по итогам звонка/встречи">${escapeHtml(task.explanation || '')}</textarea>` : ''}
      <div class="modal-actions">
        ${isEdit && isStaff() ? '<button type="button" class="btn-secondary" id="delete-task">Удалить</button>' : ''}
        <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить</button>
      </div>
    </form>
    ${isEdit ? renderDateChangeSection(task) : ''}
    ${isEdit && isSale ? renderMeetingRecordSection(task, taskClient) : ''}
    ${isEdit && hasAssortment ? `<div class="assort-panel"><h3>Ассортимент клиента: ${escapeHtml(taskClient.name)}</h3>${renderAssortmentSection(taskClient)}${renderTestAssortmentSection(taskClient)}</div>` : ''}
    ${isEdit ? renderAttachmentsSection(task) : ''}
  `;
  openModal(body, async (form) => {
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());
    data.tags = fd.getAll('tags');
    if (task) await api('PUT', `/api/tasks/${task.id}`, data);
    else await api('POST', '/api/tasks', data);
    await loadAll();
    closeModal();
    render();
  });
  const delBtn = document.getElementById('delete-task');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Удалить задачу?')) return;
    await api('DELETE', `/api/tasks/${task.id}`);
    await loadAll();
    closeModal();
    render();
  });
  if (isEdit && hasAssortment) wireAssortmentToggle(taskClient.id);
  if (isEdit) wireAttachments(task);
  if (isEdit) wireDateChangeSection(task);
  if (isEdit && isSale) wireMeetingRecordSection(task);
  if (!isEdit) wireTaskClientSearch(myClients, presetClientId);
}

// Поиск клиента в модалке создания задачи (в очереди с 02.09.2026, реализовано
// в Фазе 18) — при сотнях клиентов у агента обычный <select> одним длинным
// списком неудобен. Решение: текстовое поле над <select> живьём перестраивает
// список опций по подстроке в названии клиента (без учёта регистра) — сам
// <select> остаётся источником истины для отправки формы (clientId всегда
// валиден), просто его опции сужаются на лету. Поле поиска есть только при
// создании новой задачи — при редактировании клиент задачи заблокирован
// (disabled select), искать нечего.
function wireTaskClientSearch(myClients, presetClientId) {
  const searchInput = document.getElementById('task-client-search');
  const select = document.getElementById('task-client-select');
  if (!searchInput || !select) return;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const currentValue = select.value;
    const filtered = q ? myClients.filter((c) => (c.name || '').toLowerCase().includes(q)) : myClients;
    select.innerHTML = filtered.map((c) => `<option value="${c.id}" ${String(c.id) === currentValue ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    // Если текущий выбор отфильтрован — выбираем первый в списке (select
    // required не пропустит пустое значение при отправке формы).
    if (!filtered.some((c) => String(c.id) === currentValue) && filtered.length) {
      select.value = String(filtered[0].id);
    }
  });
}

// ---------- Заявка на перенос даты задачи ----------

function renderDateChangeSection(task) {
  const req = task.dateChangeRequest;
  if (req) {
    return `
      <div class="date-change-note">
        <strong>Заявка на перенос даты:</strong> на ${fmtDate(req.requestedDate)}${req.reason ? ' — ' + escapeHtml(req.reason) : ''}
        <div class="muted" style="margin-top:4px">От: ${escapeHtml(userName(req.requestedBy))} · ${fmtDateTime(req.createdAt)}</div>
        ${isStaff() ? `
          <div style="margin-top:8px;display:flex;gap:8px">
            <button type="button" class="btn-primary" id="approve-date-change">Одобрить</button>
            <button type="button" class="btn-secondary" id="reject-date-change">Отклонить</button>
          </div>` : '<div class="muted" style="margin-top:4px">Ожидает решения супервайзера/администратора.</div>'}
      </div>
    `;
  }
  if (isStaff()) return '';
  return `
    <div class="assort-panel">
      <h3>Перенос даты</h3>
      <button type="button" class="btn-secondary" id="open-date-change-form">Запросить перенос даты</button>
      <div id="date-change-form" style="display:none;margin-top:8px">
        <label>Новая дата</label>
        ${dateFieldHTML({ name: 'dateChangeDate', id: 'date-change-date', value: task.dueDate || '' })}
        <label>Причина</label>
        <textarea id="date-change-reason" placeholder="Почему нужно перенести"></textarea>
        <button type="button" class="btn-primary" id="submit-date-change" style="margin-top:6px">Отправить заявку</button>
      </div>
    </div>
  `;
}

function wireDateChangeSection(task) {
  const openBtn = document.getElementById('open-date-change-form');
  if (openBtn) openBtn.addEventListener('click', () => {
    document.getElementById('date-change-form').style.display = '';
    openBtn.style.display = 'none';
  });
  const submitBtn = document.getElementById('submit-date-change');
  if (submitBtn) submitBtn.addEventListener('click', async () => {
    const requestedDate = document.getElementById('date-change-date').value;
    const reason = document.getElementById('date-change-reason').value;
    if (!requestedDate) return alert('Укажите дату');
    try {
      await api('POST', `/api/tasks/${task.id}/request-date-change`, { requestedDate, reason });
      await loadAll();
      closeModal();
      const fresh = state.tasks.find((t) => t.id === task.id);
      render();
      if (fresh) openTaskModal(fresh);
    } catch (e) { alert(e.message); }
  });
  const approveBtn = document.getElementById('approve-date-change');
  if (approveBtn) approveBtn.addEventListener('click', async () => {
    await api('POST', `/api/tasks/${task.id}/approve-date-change`);
    await loadAll();
    closeModal();
    render();
  });
  const rejectBtn = document.getElementById('reject-date-change');
  if (rejectBtn) rejectBtn.addEventListener('click', async () => {
    if (!confirm('Отклонить заявку на перенос?')) return;
    await api('POST', `/api/tasks/${task.id}/reject-date-change`);
    await loadAll();
    closeModal();
    render();
  });
}

// ---------- Записи встреч (воронка продаж): аудио + пояснение ----------

function renderMeetingRecordSection(task) {
  const client = clientById(task.clientId);
  const records = ((client && client.meetingRecords) || []).filter((r) => r.taskId === task.id);
  return `
    <div class="assort-panel">
      <h3>Записи встреч</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:8px">Аудиозапись + короткое пояснение обязательны перед переводом задачи в «Сделка» или «Провал».</div>
      <div id="meeting-records-list">
        ${records.length ? records.map((r) => `
          <div class="attach-row">
            <audio controls src="${r.audioUrl}"></audio>
            <span class="muted">${escapeHtml(r.explanation || '')}</span>
          </div>
        `).join('') : '<div class="muted">Пока нет записей</div>'}
      </div>
      <label style="margin-top:8px">Аудиофайл встречи</label>
      <input type="file" id="meeting-audio-input" accept="audio/*">
      <label>Пояснение к встрече</label>
      <textarea id="meeting-explanation-input" placeholder="Короткое пояснение по итогам встречи"></textarea>
      <button type="button" class="btn-secondary" id="upload-meeting-record" style="margin-top:6px">Загрузить запись</button>
    </div>
  `;
}

function wireMeetingRecordSection(task) {
  const btn = document.getElementById('upload-meeting-record');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const fileInput = document.getElementById('meeting-audio-input');
    const explanation = document.getElementById('meeting-explanation-input').value;
    if (!fileInput.files.length) return alert('Выберите аудиофайл записи встречи');
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    fd.append('explanation', explanation);
    try {
      await apiUpload(`/api/tasks/${task.id}/meeting-record`, fd);
      await loadAll();
      closeModal();
      const fresh = state.tasks.find((t) => t.id === task.id);
      render();
      if (fresh) openTaskModal(fresh);
    } catch (e) { alert(e.message); }
  });
}

function renderAttachListHtml(items) {
  return (items || []).map((a) => `
    <div class="attach-row" data-att="${a.id}">
      ${a.mimeType.startsWith('image/') ? `<img src="${a.url}" class="attach-thumb">` : `<audio controls src="${a.url}"></audio>`}
      <span class="muted">${escapeHtml(a.filename)}</span>
      <button type="button" class="icon-btn del-attach" data-id="${a.id}">✕</button>
    </div>
  `).join('') || '<div class="muted">Пока нет файлов</div>';
}

function renderAttachmentsSection(task) {
  return `
    <div class="assort-panel">
      <h3>Вложения (фото / аудио)</h3>
      <div id="attach-list">${renderAttachListHtml(task.attachments)}</div>
      <input type="file" id="attach-input" accept="image/*,audio/*" multiple style="margin-top:8px">
    </div>
  `;
}

function wireAttachments(task) {
  const input = document.getElementById('attach-input');
  if (input) input.addEventListener('change', async () => {
    if (!input.files.length) return;
    const fd = new FormData();
    Array.from(input.files).forEach((file) => fd.append('file', file));
    try {
      const res = await apiUpload(`/api/tasks/${task.id}/attachments`, fd);
      task.attachments = res.task.attachments;
      document.getElementById('attach-list').innerHTML = renderAttachListHtml(task.attachments);
      input.value = '';
      wireAttachDeletes(task);
    } catch (e) { alert(e.message); }
  });
  wireAttachDeletes(task);
}

function wireAttachDeletes(task) {
  document.querySelectorAll('.del-attach').forEach((btn) => {
    btn.onclick = async () => {
      const res = await api('DELETE', `/api/tasks/${task.id}/attachments/${btn.dataset.id}`);
      task.attachments = res.task.attachments;
      document.getElementById('attach-list').innerHTML = renderAttachListHtml(task.attachments);
      wireAttachDeletes(task);
    };
  });
}

// ---------- Отчёты (админ/супервайзер) ----------

async function renderReports(content) {
  if (!isStaff()) return;
  content.appendChild(el(`
    <div>
      <h2 style="margin-top:0">Ассортимент по агентам</h2>
      <div class="sub muted" style="margin-bottom:10px">Товар / бренд / штук / выручка / число клиентов — фильтры по бренду, агенту и месяцу (по умолчанию — 7-месячная агрегация; при выборе конкретного месяца показаны данные только за него).</div>
      <div class="filter-bar" style="margin-bottom:10px">
        <select id="reports-agent-filter">
          <option value="">Все агенты</option>
        </select>
      </div>
      <div id="reports-month-bar" class="assort-brand-filter" style="margin-bottom:10px"></div>
      <div id="reports-brand-bar" class="assort-brand-filter" style="margin-bottom:6px"></div>
      <div id="reports-colorant-bar" class="assort-brand-filter"></div>
      <div id="reports-table" class="report-table-wrap"><div class="muted">Загрузка…</div></div>

      <h2 style="margin-top:26px">🎁 Акции</h2>
      <div class="sub muted" style="margin-bottom:10px">Кто из клиентов и что именно брал по текущим акциям склада/магазина (срез на дату последнего импорта, с суммой в сомах) — с фильтром по агенту и по конкретной акции.</div>
      <div class="filter-bar" style="margin-bottom:10px">
        <select id="promo-report-agent-filter">
          <option value="">Все агенты</option>
        </select>
        <select id="promo-report-promo-filter">
          <option value="">Все акции</option>
        </select>
      </div>
      <div id="promo-report-table" class="report-table-wrap"><div class="muted">Загрузка…</div></div>
    </div>
  `));

  // Правка 02.09.2026: фильтр по бренду стал мультивыбором (можно отметить сразу
  // Kapous+EPICA+Studio и т.п.), а "Красители/оксиды" вынесен в отдельный
  // трёхпозиционный переключатель, который сочетается с выбором бренда —
  // "Kapous" + "Только краски/оксиды" покажет краски/оксиды именно Kapous.
  // "Без красок/оксидов" — обратный фильтр, чтобы убрать их из общего реестра.
  const selectedBrands = new Set();
  let colorantMode = 'all'; // 'all' | 'only' | 'exclude'
  // Правка 31.08.2026: раньше был select одного месяца, теперь можно выбрать
  // несколько сразу (чипы, как у фильтра по бренду) — пустой набор = все 7 мес.
  const selectedMonths = new Set();

  function monthsParam() {
    return selectedMonths.size ? Array.from(selectedMonths).join(',') : '';
  }

  async function load() {
    const agentId = document.getElementById('reports-agent-filter').value;
    const qs = new URLSearchParams();
    if (agentId) qs.set('agentId', agentId);
    const mp = monthsParam();
    if (mp) qs.set('month', mp);
    const res = await api('GET', `/api/reports/assortment-by-agent?${qs.toString()}`);

    const agentSel = document.getElementById('reports-agent-filter');
    if (!agentSel.dataset.filled) {
      agentSel.innerHTML = '<option value="">Все агенты</option>' +
        res.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
      agentSel.value = agentId;
      agentSel.dataset.filled = '1';
    }
    const monthBar = document.getElementById('reports-month-bar');
    if (!monthBar.dataset.filled) {
      monthBar.innerHTML = `
        <button type="button" class="brand-chip ${!selectedMonths.size ? 'active' : ''}" data-month="all">Все месяцы (7 мес)</button>
        ${res.months.map((m) => `<button type="button" class="brand-chip" data-month="${escapeAttr(m)}">${escapeHtml(m.charAt(0).toUpperCase() + m.slice(1))}</button>`).join('')}
      `;
      monthBar.dataset.filled = '1';
      monthBar.querySelectorAll('.brand-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const m = chip.dataset.month;
          if (m === 'all') {
            selectedMonths.clear();
          } else {
            if (selectedMonths.has(m)) selectedMonths.delete(m); else selectedMonths.add(m);
          }
          monthBar.querySelectorAll('.brand-chip').forEach((c) => {
            c.classList.toggle('active', c.dataset.month === 'all' ? !selectedMonths.size : selectedMonths.has(c.dataset.month));
          });
          load();
        });
      });
    }
    const month = mp; // используется ниже только для подписи колонки "Шт"

    const bar = document.getElementById('reports-brand-bar');
    bar.innerHTML = `
      <button type="button" class="brand-chip ${!selectedBrands.size ? 'active' : ''}" data-brand="all">Все бренды</button>
      ${res.brands.map((b) => `<button type="button" class="brand-chip ${selectedBrands.has(b) ? 'active' : ''}" data-brand="${escapeAttr(b)}">${escapeHtml(b)}</button>`).join('')}
    `;
    const colorantBar = document.getElementById('reports-colorant-bar');
    colorantBar.innerHTML = `
      <button type="button" class="brand-chip ${colorantMode === 'all' ? 'active' : ''}" data-colorant-mode="all">Все категории</button>
      <button type="button" class="brand-chip ${colorantMode === 'only' ? 'active' : ''}" data-colorant-mode="only">Только краски/оксиды</button>
      <button type="button" class="brand-chip ${colorantMode === 'exclude' ? 'active' : ''}" data-colorant-mode="exclude">Убрать краски/оксиды</button>
    `;

    function renderTable() {
      let rows = res.rows;
      if (selectedBrands.size) rows = rows.filter((r) => selectedBrands.has(r.brand));
      if (colorantMode === 'only') rows = rows.filter((r) => r.category === 'Краситель' || r.category === 'Оксид');
      else if (colorantMode === 'exclude') rows = rows.filter((r) => r.category !== 'Краситель' && r.category !== 'Оксид');
      const qtyHeader = month ? 'Шт (за выбр. месяцы)' : 'Шт (7 мес)';
      document.getElementById('reports-table').innerHTML = rows.length ? `
        <table>
          <thead><tr><th>Агент</th><th>Товар</th><th>Бренд</th><th>${qtyHeader}</th><th>Выручка</th><th>Клиентов</th></tr></thead>
          <tbody>
            ${rows.slice(0, 300).map((r) => `
              <tr>
                <td>${escapeHtml(r.agentName)}</td>
                <td>${escapeHtml(r.product)}</td>
                <td><span class="brand-badge">${escapeHtml(r.brand)}</span></td>
                <td>${r.qty}</td>
                <td>${fmtMoney(r.revenue)}</td>
                <td>${r.clientsCount}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${rows.length > 300 ? `<div class="muted" style="margin-top:6px;font-size:12px">Показаны первые 300 из ${rows.length} — сузьте фильтр по бренду.</div>` : ''}
      ` : '<div class="empty-state">Нет данных по этому фильтру.</div>';
    }
    renderTable();
    // Фильтр по бренду — мультивыбор: можно отметить сразу несколько чипов
    // (Kapous+EPICA+Studio и т.п.), "Все бренды" сбрасывает выбор.
    bar.querySelectorAll('.brand-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const b = chip.dataset.brand;
        if (b === 'all') {
          selectedBrands.clear();
        } else {
          if (selectedBrands.has(b)) selectedBrands.delete(b); else selectedBrands.add(b);
        }
        bar.querySelectorAll('.brand-chip').forEach((c) => {
          c.classList.toggle('active', c.dataset.brand === 'all' ? !selectedBrands.size : selectedBrands.has(c.dataset.brand));
        });
        renderTable();
      });
    });
    colorantBar.querySelectorAll('.brand-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        colorantMode = chip.dataset.colorantMode;
        colorantBar.querySelectorAll('.brand-chip').forEach((c) => c.classList.toggle('active', c.dataset.colorantMode === colorantMode));
        renderTable();
      });
    });
  }

  document.getElementById('reports-agent-filter').addEventListener('change', load);
  await load();

  async function loadPromoReport() {
    const agentId = document.getElementById('promo-report-agent-filter').value;
    const promo = document.getElementById('promo-report-promo-filter').value;
    const qs = new URLSearchParams();
    if (agentId) qs.set('agentId', agentId);
    if (promo) qs.set('promo', promo);
    const res = await api('GET', `/api/reports/promotions?${qs.toString()}`);
    const agentSel = document.getElementById('promo-report-agent-filter');
    if (!agentSel.dataset.filled) {
      agentSel.innerHTML = '<option value="">Все агенты</option>' +
        res.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
      agentSel.value = agentId;
      agentSel.dataset.filled = '1';
    }
    const promoSel = document.getElementById('promo-report-promo-filter');
    if (!promoSel.dataset.filled) {
      promoSel.innerHTML = '<option value="">Все акции</option>' +
        res.promos.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join('');
      promoSel.value = promo;
      promoSel.dataset.filled = '1';
    }
    document.getElementById('promo-report-table').innerHTML = res.rows.length ? `
      <table>
        <thead><tr><th>Агент</th><th>Клиент</th><th>Акция</th><th>Кол-во</th><th>Сумма</th></tr></thead>
        <tbody>
          ${res.rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.agentName)}</td>
              <td>${escapeHtml(r.clientName)}</td>
              <td>${escapeHtml(r.promo)}</td>
              <td>${formatQty(r.qty)}</td>
              <td>${fmtMoney(r.sum)}</td>
            </tr>
          `).join('')}
          <tr><td colspan="4"><strong>Итого</strong></td><td><strong>${fmtMoney(res.totalSum)}</strong></td></tr>
        </tbody>
      </table>
    ` : '<div class="empty-state">По этому фильтру акций нет.</div>';
  }
  document.getElementById('promo-report-agent-filter').addEventListener('change', loadPromoReport);
  document.getElementById('promo-report-promo-filter').addEventListener('change', loadPromoReport);
  await loadPromoReport();
}

// ---------- Команда (только админ) ----------

function renderTeam(content) {
  if (!isAdmin()) return;
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Команда</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn-secondary" href="/api/clients/export" download style="text-decoration:none;display:inline-block" title="Ручные поля клиентов (адрес/телефон/контакт/маршрут/договор/заметки и т.п.) — чтобы перенести правки в новую базу при следующей пересборке">⬇ Выгрузить клиентов</a>
          <button type="button" class="btn-secondary" id="client-import-btn" title="Обновить ручные поля уже существующих клиентов из ранее выгруженного файла — по имени и агенту, без дублей">⬆ Загрузить клиентов</button>
          <input type="file" id="client-import-input" accept=".json" style="display:none">
          <button type="button" class="btn-secondary" id="debts-import-btn" title="Обновить задолженность по всем клиентам из файла .xlsx/.csv — без пересборки архива. Полностью заменяет прежний снимок долгов (клиент, которого нет в новом файле, — долг 0).">⬆ Загрузить долги</button>
          <input type="file" id="debts-import-input" accept=".xlsx,.csv" style="display:none">
          <button type="button" class="btn-secondary" id="stock-import-btn" title="Обновить остаток на складе по позициям ассортимента из файла .xlsx/.csv — без пересборки архива. Полностью заменяет прежний снимок остатков.">⬆ Загрузить остатки</button>
          <input type="file" id="stock-import-input" accept=".xlsx,.csv" style="display:none">
          <a class="btn-secondary" href="/api/backup" style="text-decoration:none;display:inline-block" title="Полный архив: клиенты, задачи, сотрудники, вложения">Скачать резервную копию (всё)</a>
          <button class="btn-primary" id="add-user-btn">+ Сотрудник</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Аватар</th><th>Имя</th><th>Email</th><th>Роль</th><th></th></tr></thead>
          <tbody id="users-tbody"></tbody>
        </table>
      </div>
    </div>
  `));
  document.getElementById('add-user-btn').addEventListener('click', () => openUserModal());
  // Загрузка ранее выгруженного файла клиентов (пара к "Выгрузить клиентов", 02.09.2026) —
  // обновляет ручные поля уже существующих клиентов по имени+агенту, без дублей;
  // тот же паттерн, что и у загрузки задач на вкладке "Задачи".
  const clientImportBtn = document.getElementById('client-import-btn');
  const clientImportInput = document.getElementById('client-import-input');
  if (clientImportBtn && clientImportInput) {
    clientImportBtn.addEventListener('click', () => clientImportInput.click());
    clientImportInput.addEventListener('change', async () => {
      const file = clientImportInput.files[0];
      if (!file) return;
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch (e) {
        alert('Не удалось прочитать файл — это не корректный JSON');
        clientImportInput.value = '';
        return;
      }
      try {
        const result = await api('POST', '/api/clients/import', { clients: parsed.clients || [] });
        let msg = `Обновлено клиентов: ${result.updated}.`;
        if (result.unresolvedCount) {
          msg += `\nНе удалось сопоставить: ${result.unresolvedCount} (агент или клиент не найдены в текущей базе) — список в консоли браузера.`;
          console.log('Не распознано при загрузке клиентов:', result.unresolved);
        }
        alert(msg);
        await loadAll();
        render();
      } catch (e) {
        alert('Ошибка загрузки: ' + e.message);
      } finally {
        clientImportInput.value = '';
      }
    });
  }
  // Загрузка долгов/остатков напрямую через панель (Фаза 19, 04.09.2026) —
  // без пересборки архива, файл .xlsx или .csv. Оба эндпойнта полностью
  // заменяют прежний снимок (см. пояснение в src/api.js) — предупреждаем об
  // этом в подтверждении перед отправкой.
  function wireTableUploadButton(btnId, inputId, endpoint, confirmText, successMsg) {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (!confirm(confirmText)) { input.value = ''; return; }
      const fd = new FormData();
      fd.append('file', file);
      try {
        const result = await apiUpload(endpoint, fd);
        alert(successMsg(result));
        await loadAll();
        render();
      } catch (e) {
        alert('Ошибка загрузки: ' + e.message);
      } finally {
        input.value = '';
      }
    });
  }
  wireTableUploadButton(
    'debts-import-btn', 'debts-import-input', '/api/debts/import',
    'Это полностью заменит текущие данные о долгах у всех клиентов (клиент, которого нет в новом файле, останется с долгом 0). Продолжить?',
    (r) => `Готово. Строк в файле: ${r.parsedRows}, сопоставлено с клиентами: ${r.matchedClients}.`
  );
  wireTableUploadButton(
    'stock-import-btn', 'stock-import-input', '/api/stock/import',
    'Это полностью заменит текущие остатки склада на позициях ассортимента у всех клиентов. Продолжить?',
    (r) => `Готово. Товарных строк в файле: ${r.parsedRows}. Дата "снято на" обновлена: ${r.stockAsOf}.`
  );
  const tbody = document.getElementById('users-tbody');
  state.users.forEach((u) => {
    const row = el(`
      <tr>
        <td>
          <label class="avatar-upload" title="Загрузить аватар">
            ${avatarHtml(u.id, 36)}
            <input type="file" accept="image/*" class="avatar-input" data-id="${u.id}" style="display:none">
          </label>
        </td>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email || '')}</td>
        <td>${roleLabel(u.role)}</td>
        <td>${u.id !== state.user.id ? '<button class="link-btn delete-user">Удалить</button>' : ''}</td>
      </tr>
    `);
    const delBtn = row.querySelector('.delete-user');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('Удалить сотрудника?')) return;
      await api('DELETE', `/api/users/${u.id}`);
      await loadAll();
      render();
    });
    const avatarInput = row.querySelector('.avatar-input');
    avatarInput.addEventListener('change', async () => {
      if (!avatarInput.files.length) return;
      const fd = new FormData();
      fd.append('file', avatarInput.files[0]);
      try {
        await apiUpload(`/api/users/${u.id}/avatar`, fd);
        await loadAll();
        render();
      } catch (e) { alert(e.message); }
    });
    tbody.appendChild(row);
  });
}

function openUserModal() {
  const body = `
    <h2>Новый сотрудник</h2>
    <form id="user-form">
      <label>Имя *</label><input name="name" required>
      <label>Email *</label><input name="email" type="email" required>
      <label>Пароль *</label><input name="password" type="password" required minlength="4">
      <label>Роль</label>
      <select name="role">
        <option value="agent">Торговый агент</option>
        <option value="supervisor">Супервайзер</option>
        <option value="admin">Администратор</option>
      </select>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
        <button type="submit" class="btn-primary">Создать</button>
      </div>
    </form>
  `;
  openModal(body, async (form) => {
    const data = Object.fromEntries(new FormData(form).entries());
    await api('POST', '/api/users', data);
    await loadAll();
    closeModal();
    render();
  });
}

// ---------- Календарь ----------

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTH_LABELS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function startOfWeek(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const res = new Date(d);
  res.setDate(d.getDate() + diff);
  res.setHours(0, 0, 0, 0);
  return res;
}
function fmtDateShort(d) { return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`; }
function fmtDateLong(d) { return `${d.getDate()} ${(MONTH_LABELS[d.getMonth()] || '').toLowerCase()} ${d.getFullYear()}`; }
function tasksOnDate(dateKey) { return state.tasks.filter((t) => t.dueDate === dateKey); }
function supMeetingsOnDate(dateKey) { return (state.supervisorMeetings || []).filter((m) => m.date === dateKey); }

function shiftCalendar(dir) {
  const cal = state.calendar;
  const d = new Date(cal.date);
  if (cal.mode === 'month') d.setMonth(d.getMonth() + dir);
  else if (cal.mode === 'week') d.setDate(d.getDate() + dir * 7);
  else d.setDate(d.getDate() + dir);
  state.calendar.date = d;
}

function renderCalendar(content) {
  const cal = state.calendar;
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Календарь</h2>
        <div class="cal-controls">
          <button type="button" class="btn-secondary cal-mode-btn" id="cal-mode-month">Месяц</button>
          <button type="button" class="btn-secondary cal-mode-btn" id="cal-mode-week">Неделя</button>
          <button type="button" class="btn-secondary cal-mode-btn" id="cal-mode-day">День</button>
          <button type="button" class="btn-secondary" id="cal-prev">←</button>
          <button type="button" class="btn-secondary" id="cal-today">Сегодня</button>
          <button type="button" class="btn-secondary" id="cal-next">→</button>
          ${state.user.role === 'supervisor' ? '<button type="button" class="btn-secondary" id="cal-print">Печать маршрута (неделя)</button>' : ''}
          ${state.user.role === 'supervisor' ? '<button type="button" class="btn-primary" id="cal-add-sup-meeting">+ Встреча с клиентом</button>' : ''}
        </div>
      </div>
      ${state.user.role !== 'supervisor' ? '<div class="sub muted" style="margin-bottom:6px">🟣 — в этот день у супервайзера запланирована встреча с клиентом (день занят).</div>' : ''}
      <div id="cal-title" class="cal-title"></div>
      <div id="cal-body"></div>
      <div id="print-route" class="print-only"></div>
    </div>
  `));

  const printBtn = document.getElementById('cal-print');
  if (printBtn) printBtn.addEventListener('click', () => { renderPrintRoute(); window.print(); });
  const addSupBtn = document.getElementById('cal-add-sup-meeting');
  if (addSupBtn) addSupBtn.addEventListener('click', () => openSupervisorMeetingModal(toDateKey(cal.date)));

  ['month', 'week', 'day'].forEach((m) => {
    const btn = document.getElementById(`cal-mode-${m}`);
    btn.classList.toggle('active', cal.mode === m);
    btn.addEventListener('click', () => { state.calendar.mode = m; render(); });
  });
  document.getElementById('cal-today').addEventListener('click', () => { state.calendar.date = new Date(); render(); });
  document.getElementById('cal-prev').addEventListener('click', () => { shiftCalendar(-1); render(); });
  document.getElementById('cal-next').addEventListener('click', () => { shiftCalendar(1); render(); });

  if (cal.mode === 'month') renderCalMonth();
  else if (cal.mode === 'week') renderCalWeek();
  else renderCalDay();
}

function renderCalMonth() {
  const cal = state.calendar;
  const y = cal.date.getFullYear(), m = cal.date.getMonth();
  document.getElementById('cal-title').textContent = `${MONTH_LABELS[m]} ${y}`;
  const startDate = startOfWeek(new Date(y, m, 1));
  const todayKey = toDateKey(new Date());
  const grid = el('<div class="cal-month-grid"></div>');
  WEEKDAY_LABELS.forEach((wd) => grid.appendChild(el(`<div class="cal-weekday">${wd}</div>`)));
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const key = toDateKey(d);
    const dayTasks = tasksOnDate(key);
    const inMonth = d.getMonth() === m;
    // Мобильная версия: вместо списка карточек (не помещается) — точка-индикатор.
    // Все задачи в ячейке имеют один и тот же срок (= дата ячейки), поэтому
    // цвет общий на ячейку: зелёная — срок ещё не прошёл, красная — просрочено.
    // Показывается только если есть незавершённые задачи (этап "В работе").
    const incomplete = dayTasks.filter((t) => ACTIVE_STAGES.includes(t.stage));
    const dotClass = incomplete.length ? (key < todayKey ? 'cal-dot-red' : 'cal-dot-green') : '';
    const supMeetings = supMeetingsOnDate(key);
    const cell = el(`
      <div class="cal-day-cell ${inMonth ? '' : 'cal-day-outside'} ${key === todayKey ? 'cal-day-today' : ''}">
        <div class="cal-day-num">${d.getDate()} ${supMeetings.length ? '<span class="cal-dot cal-dot-sup" title="Встреча супервайзера в этот день">●</span>' : ''}</div>
        <div class="cal-day-tasks">
          ${dayTasks.slice(0, 3).map((t) => { const c = clientById(t.clientId); return `<div class="cal-chip">${escapeHtml(c ? c.name : t.title)}</div>`; }).join('')}
          ${dayTasks.length > 3 ? `<div class="cal-more">+${dayTasks.length - 3}</div>` : ''}
        </div>
        ${incomplete.length ? `<div class="cal-day-dot-wrap"><span class="cal-dot ${dotClass}"></span><span class="cal-dot-count">${incomplete.length}</span></div>` : ''}
      </div>
    `);
    cell.addEventListener('click', () => { state.calendar.date = d; state.calendar.mode = 'day'; render(); });
    grid.appendChild(cell);
  }
  document.getElementById('cal-body').appendChild(grid);
}

function renderCalWeek() {
  const cal = state.calendar;
  const start = startOfWeek(cal.date);
  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  document.getElementById('cal-title').textContent = `${fmtDateShort(days[0])} – ${fmtDateShort(days[6])}`;
  const todayKey = toDateKey(new Date());
  const grid = el('<div class="cal-week-grid"></div>');
  days.forEach((d) => {
    const key = toDateKey(d);
    const dayTasks = tasksOnDate(key);
    const dayMeetings = supMeetingsOnDate(key);
    const col = el(`
      <div class="cal-week-col ${key === todayKey ? 'cal-day-today' : ''}">
        <div class="cal-week-head">${WEEKDAY_LABELS[(d.getDay() + 6) % 7]} ${d.getDate()}</div>
        <div class="cal-week-body"></div>
        <div class="cal-week-sup-col"></div>
      </div>
    `);
    const colBody = col.querySelector('.cal-week-body');
    if (!dayTasks.length) colBody.appendChild(el('<div class="muted" style="font-size:12px;padding:4px">—</div>'));
    dayTasks.forEach((t) => {
      const c = clientById(t.clientId);
      const card = el(`<div class="cal-chip cal-chip-block">${escapeHtml(c ? c.name : t.title)}<div class="muted" style="font-size:11px">${escapeHtml(stageLabel(t.stage))}</div></div>`);
      card.addEventListener('click', () => openTaskModal(t));
      colBody.appendChild(card);
    });
    // Отдельный столбец/раздел встреч супервайзера — виден всем (агенты видят,
    // какие дни у клиента уже заняты), но добавлять/удалять может только супервайзер.
    const supCol = col.querySelector('.cal-week-sup-col');
    supCol.appendChild(el('<div class="cal-week-sup-head">👔 Супервайзер</div>'));
    if (!dayMeetings.length) {
      supCol.appendChild(el('<div class="muted" style="font-size:11px;padding:2px 4px">—</div>'));
    }
    dayMeetings.forEach((m) => {
      const c = clientById(m.clientId);
      const chip = el(`
        <div class="cal-chip cal-chip-block cal-chip-sup">
          ${escapeHtml(c ? c.name : '—')} ${m.time ? `<span class="muted">· ${escapeHtml(m.time)}</span>` : ''}
          ${state.user.role === 'supervisor' ? '<button type="button" class="icon-btn del-sup-meeting" title="Удалить">✕</button>' : ''}
        </div>
      `);
      const delBtn = chip.querySelector('.del-sup-meeting');
      if (delBtn) delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Удалить встречу?')) return;
        await api('DELETE', `/api/supervisor-meetings/${m.id}`);
        await loadAll();
        render();
      });
      supCol.appendChild(chip);
    });
    grid.appendChild(col);
  });
  document.getElementById('cal-body').appendChild(grid);
}

function renderCalDay() {
  const cal = state.calendar;
  const key = toDateKey(cal.date);
  document.getElementById('cal-title').textContent = fmtDateLong(cal.date);
  const dayTasks = tasksOnDate(key);
  const dayMeetings = supMeetingsOnDate(key);
  const body = document.getElementById('cal-body');

  if (!dayTasks.length) {
    body.appendChild(el('<div class="empty-state">На этот день задач нет.</div>'));
  } else {
    const list = el('<div class="cal-day-list"></div>');
    dayTasks.forEach((t) => {
      const c = clientById(t.clientId);
      const row = el(`
        <div class="history-row cal-day-row">
          <div><strong>${escapeHtml(c ? c.name : t.title)}</strong> <span class="badge">${escapeHtml(stageLabel(t.stage))}</span></div>
          <div class="muted">${agentTag(t.assigneeId)}</div>
          ${taskTagBadges(t) ? `<div class="card-tags">${taskTagBadges(t)}</div>` : ''}
        </div>
      `);
      row.addEventListener('click', () => openTaskModal(t));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  // Отдельный раздел — встречи супервайзера на этот день (свой "столбец" данных,
  // не смешан с задачами агентов). У супервайзера — с кнопкой удаления.
  const panel = el(`
    <div class="panel">
      <h2 style="margin:0 0 8px">👔 Встречи супервайзера</h2>
      <div id="cal-day-sup-list"></div>
    </div>
  `);
  const supList = panel.querySelector('#cal-day-sup-list');
  if (!dayMeetings.length) {
    supList.appendChild(el('<div class="muted">Встреч не запланировано.</div>'));
  }
  dayMeetings.forEach((m) => {
    const c = clientById(m.clientId);
    const row = el(`
      <div class="history-row cal-day-row">
        <div><strong>${escapeHtml(c ? c.name : '—')}</strong> ${m.time ? `<span class="badge">${escapeHtml(m.time)}</span>` : ''}</div>
        <div class="muted">${c ? agentTag(c.ownerId) : ''}</div>
        ${m.note ? `<div class="muted">${escapeHtml(m.note)}</div>` : ''}
        ${state.user.role === 'supervisor' ? '<button type="button" class="btn-secondary del-sup-meeting" style="margin-top:6px">Удалить</button>' : ''}
      </div>
    `);
    const delBtn = row.querySelector('.del-sup-meeting');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('Удалить встречу?')) return;
      await api('DELETE', `/api/supervisor-meetings/${m.id}`);
      await loadAll();
      render();
    });
    supList.appendChild(row);
  });
  body.appendChild(panel);
}

function openSupervisorMeetingModal(dateKey) {
  const body = `
    <h2>Встреча с клиентом</h2>
    <form id="sup-meeting-form">
      <label>Клиент *</label>
      <select name="clientId" required>
        ${state.clients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <label>Дата *</label>
      ${dateFieldHTML({ name: 'date', value: dateKey || '', required: true })}
      <label>Время</label>
      <input name="time" type="time">
      <label>Заметка</label>
      <textarea name="note" placeholder="Тема встречи, детали"></textarea>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
        <button type="submit" class="btn-primary">Добавить</button>
      </div>
    </form>
  `;
  openModal(body, async (form) => {
    const data = Object.fromEntries(new FormData(form).entries());
    await api('POST', '/api/supervisor-meetings', data);
    await loadAll();
    closeModal();
    render();
  });
}

// ---------- "Мой день" — упрощённый вид для агента в дороге ----------

function renderMyDay(content) {
  const stats = state.stats;
  const tasks = stats ? stats.todayTasks : [];
  content.appendChild(el(`
    <div>
      <h2 style="margin:0 0 14px">Мой день — ${fmtDateLong(new Date())}</h2>
      <div id="myday-list"></div>
    </div>
  `));
  const list = document.getElementById('myday-list');
  if (!tasks.length) {
    list.appendChild(el('<div class="empty-state">На сегодня задач нет.</div>'));
    return;
  }
  tasks.forEach((t) => {
    const client = clientById(t.clientId);
    const card = el(`
      <div class="myday-card">
        <div class="myday-name">${escapeHtml(client ? client.name : t.title)}</div>
        ${client ? `<div class="myday-row">${escapeHtml(client.address || 'адрес не указан')} ${mapsLink(client.address)}</div>` : ''}
        ${client && client.phone ? `<div class="myday-row">${telLink(client.phone, '📞 ' + client.phone)}</div>` : ''}
        <div class="myday-row muted">${escapeHtml(stageLabel(t.stage))}${t.report ? ' · ✓ отчёт' : ''}</div>
        <button type="button" class="btn-secondary myday-open">Открыть задачу</button>
      </div>
    `);
    card.querySelector('.myday-open').addEventListener('click', () => openTaskModal(t));
    list.appendChild(card);
  });
}

// ---------- Уведомления (Notification API + Service Worker) ----------

let notifiedTaskIds = null;
function loadNotifiedIds() {
  if (notifiedTaskIds) return notifiedTaskIds;
  try {
    const raw = localStorage.getItem('notifiedTasks_' + new Date().toISOString().slice(0, 10));
    notifiedTaskIds = new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { notifiedTaskIds = new Set(); }
  return notifiedTaskIds;
}
function saveNotifiedIds() {
  try { localStorage.setItem('notifiedTasks_' + new Date().toISOString().slice(0, 10), JSON.stringify(Array.from(notifiedTaskIds || []))); } catch (e) {}
}

async function checkAndNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!state.stats) return;
  const seen = loadNotifiedIds();
  const toNotify = [...(state.stats.todayTasks || []), ...(state.stats.overdueTasks || [])].filter((t) => !seen.has(t.id));
  if (!toNotify.length) return;
  let reg = null;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch (e) {}
  toNotify.forEach((t) => {
    const client = clientById(t.clientId);
    const overdue = (state.stats.overdueTasks || []).some((o) => o.id === t.id);
    const title = overdue ? 'Просроченная задача' : 'Задача на сегодня';
    const bodyText = client ? client.name : t.title;
    try {
      if (reg && reg.showNotification) reg.showNotification(title, { body: bodyText, tag: 'task-' + t.id });
      else new Notification(title, { body: bodyText });
    } catch (e) {}
    seen.add(t.id);
  });
  saveNotifiedIds();
}

function setupNotifications() {
  if (!('Notification' in window)) return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(() => checkAndNotify());
  } else if (Notification.permission === 'granted') {
    checkAndNotify();
  }
  // Работает и когда вкладка свёрнута в фон (таймер будет реже срабатывать,
  // но не остановится, пока страница открыта в браузере).
  setInterval(async () => {
    try { await loadAll(); checkAndNotify(); } catch (e) {}
  }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkAndNotify();
  });
}

// Печать маршрута на неделю (только супервайзер) — простой список по агентам/дням.
// Правка 01.09.2026 (Фаза 16, п.6/следствие): внутри каждого дня точки теперь
// сортируются по полю "Номер маршрута" клиента (по возрастанию) — как только у
// клиента проставлено значение, он встаёт на своё место; у кого номер не
// проставлен — остаются в конце, в исходном порядке между собой (стабильная
// сортировка, ничего не перетасовывает лишний раз).
function renderPrintRoute() {
  const box = document.getElementById('print-route');
  if (!box) return;
  const start = startOfWeek(state.calendar.date);
  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  const agents = state.users.filter((u) => u.role === 'agent');
  let html = `<h1>Маршрут на неделю: ${fmtDateShort(days[0])} – ${fmtDateShort(days[6])}</h1>`;
  agents.forEach((agent) => {
    html += `<h2>${escapeHtml(agent.name)}</h2>`;
    days.forEach((d) => {
      const key = toDateKey(d);
      const dayTasks = tasksOnDate(key).filter((t) => t.assigneeId === agent.id);
      if (!dayTasks.length) return;
      const sortedTasks = dayTasks.slice().sort((a, b) => {
        const ca = clientById(a.clientId), cb = clientById(b.clientId);
        const ra = ca && ca.routeNumber != null ? ca.routeNumber : Infinity;
        const rb = cb && cb.routeNumber != null ? cb.routeNumber : Infinity;
        return ra - rb;
      });
      html += `<h3>${WEEKDAY_LABELS[(d.getDay() + 6) % 7]} ${fmtDateShort(d)}</h3><ul>`;
      sortedTasks.forEach((t) => {
        const c = clientById(t.clientId);
        const routeLabel = c && c.routeNumber != null ? `№${escapeHtml(String(c.routeNumber))} — ` : '';
        html += `<li>${routeLabel}${escapeHtml(c ? c.name : t.title)}${c && c.address ? ' — ' + escapeHtml(c.address) : ''}${c && c.phone ? ' — ' + escapeHtml(c.phone) : ''}</li>`;
      });
      html += '</ul>';
    });
  });
  box.innerHTML = html;
}

// ---------- Модальные окна ----------

function openModal(innerHtml, onSubmit) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-overlay"><div class="modal">${innerHtml}</div></div>`;
  const overlay = root.querySelector('.modal-overlay');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  const cancelBtn = root.querySelector('#cancel-modal');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  const form = root.querySelector('form');
  if (!form) return;
  const errBox = el('<p class="error"></p>');
  form.appendChild(errBox);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    // Скрытые поля даты (виджет ДД.ММ.ГГ) не участвуют в нативной HTML5-валидации
    // required, поэтому обязательность проверяем вручную.
    const missingDate = Array.from(form.querySelectorAll('.date-field input[type="hidden"][data-required="1"]')).find((h) => !h.value);
    if (missingDate) {
      const textInput = missingDate.closest('.date-field').querySelector('.date-display-input');
      errBox.textContent = 'Укажите корректную дату (ДД.ММ.ГГ)';
      if (textInput) textInput.classList.add('invalid');
      return;
    }
    try {
      await onSubmit(form);
    } catch (err) {
      errBox.textContent = err.message;
    }
  });
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

// Свайп вправо для закрытия модалки (тач-жест, мобильные устройства).
// Подключается точечно там, где это нужно (сейчас — карточка клиента),
// а не глобально в openModal(), чтобы не мешать горизонтальному скроллу
// внутри других модалок (широкие чипы фильтров, недельный календарь и т.п.).
function wireSwipeToClose(modalEl, onClose) {
  if (!modalEl) return;
  const THRESHOLD_PX = 90;
  const MAX_DURATION_MS = 700;
  let startX = null;
  let startY = null;
  let startTime = 0;
  let tracking = false;
  modalEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    // Не перехватываем жест, начавшийся на элементах со своим горизонтальным
    // скроллом (чипы-фильтры, недельный/месячный календарь) — иначе свайп
    // для прокрутки чипов случайно закрывал бы карточку.
    if (e.target.closest('.assort-brand-filter, .cal-week-grid, .cal-month-grid, input[type="range"]')) {
      tracking = false;
      return;
    }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
    tracking = true;
  }, { passive: true });
  modalEl.addEventListener('touchend', (e) => {
    if (!tracking || startX === null) return;
    tracking = false;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const duration = Date.now() - startTime;
    if (duration <= MAX_DURATION_MS && dx > THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      onClose();
    }
  }, { passive: true });
}

// ---------- Экранирование ----------

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// ---------- Старт ----------

boot();
