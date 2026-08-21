// Задачник для торговых агентов — фронтенд на чистом JS, без сборки и фреймворков.

const state = {
  user: null,
  stages: [],
  taskTags: [],
  paymentMethods: [],
  contractStatuses: [],
  clients: [],
  tasks: [],
  users: [],
  view: 'dashboard',
  clientFilters: { visitDay: '', pointType: '', onlyRegular: false, onlyDebt: false },
  taskTagFilter: new Set(),
  calendar: { mode: 'month', date: new Date() }
};

const ACTIVE_STAGES = ['new', 'in_progress', 'waiting'];

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
  const [clientsRes, tasksRes, usersRes] = await Promise.all([
    api('GET', '/api/clients'),
    api('GET', '/api/tasks'),
    api('GET', '/api/users')
  ]);
  state.clients = clientsRes.clients;
  state.tasks = tasksRes.tasks;
  state.stages = tasksRes.stages;
  state.users = usersRes.users;
}

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.stages = me.stages;
    state.paymentMethods = me.paymentMethods;
    state.contractStatuses = me.contractStatuses;
    state.taskTags = me.taskTags || [];
  } catch (e) {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-screen').style.display = 'none';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('user-name').textContent = `${state.user.name} (${roleLabel(state.user.role)})`;
  document.getElementById('team-tab').style.display = isAdmin() ? '' : 'none';
  await loadAll();
  render();
}

// ---------- Рендер по вкладкам ----------

function render() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (state.view === 'dashboard') return renderDashboard(content);
  if (state.view === 'clients') return renderClients(content);
  if (state.view === 'tasks') return renderTasks(content);
  if (state.view === 'calendar') return renderCalendar(content);
  if (state.view === 'team') return renderTeam(content);
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

async function renderDashboard(content) {
  const stats = await api('GET', '/api/stats');
  content.appendChild(el(`
    <div>
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${stats.clientsCount}</div><div class="label">Клиентов</div></div>
        <div class="stat-card"><div class="num">${stats.todayTasksCount}</div><div class="label">Задач на сегодня</div></div>
        <div class="stat-card"><div class="num">${stats.overdueTasksCount}</div><div class="label">Просроченных задач</div></div>
        <div class="stat-card"><div class="num">${stats.atRiskClientsCount}</div><div class="label">Клиентов с риском «отвала» товара</div></div>
        <div class="stat-card"><div class="num">${fmtMoney(stats.totalDebt)}</div><div class="label">Общий долг</div></div>
        ${isAdmin() ? `<div class="stat-card"><div class="num">${stats.pendingApprovalCount}</div><div class="label">Новых точек на согласовании</div></div>` : ''}
      </div>

      <div class="panel">
        <h2>Клиенты на сегодня</h2>
        <div class="kanban kanban-mini" id="today-kanban"></div>
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
            <thead><tr><th>Агент</th><th>Всего задач</th><th>В работе</th><th>Выполнено</th><th>Не выполнено</th><th>Прогрев</th><th>% выполнения</th></tr></thead>
            <tbody>
              ${stats.byAgent.map((a) => `
                <tr>
                  <td>${agentTag(a.agentId)}</td>
                  <td>${a.totalTasks}</td>
                  <td>${a.open}</td>
                  <td>${a.done}</td>
                  <td>${a.notDone}</td>
                  <td>${a.failed}</td>
                  <td>${a.completionRate === null ? '—' : a.completionRate + '%'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    </div>
  `));

  const todayKanban = document.getElementById('today-kanban');
  state.stages.forEach((stage) => {
    const inStage = stats.todayTasks.filter((t) => t.stage === stage.key);
    const col = el(`
      <div class="kanban-col" data-stage="${stage.key}">
        <h3>${stage.label} <span class="col-sum">· ${inStage.length}</span></h3>
        <div class="col-body"></div>
      </div>
    `);
    const colBody = col.querySelector('.col-body');
    if (!inStage.length) colBody.appendChild(el('<div class="muted" style="padding:6px 4px;font-size:12px">Пусто</div>'));
    inStage.forEach((t) => {
      const client = clientById(t.clientId);
      const card = el(`
        <div class="deal-card deal-card-mini">
          <div class="deal-title">${escapeHtml(client ? client.name : t.title)}</div>
          <div class="deal-client">${agentTag(t.assigneeId)}</div>
        </div>
      `);
      card.addEventListener('click', () => openTaskModal(t));
      colBody.appendChild(card);
    });
    todayKanban.appendChild(col);
  });
}

// ---------- Клиенты ----------

const VISIT_DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function filteredClients() {
  const f = state.clientFilters;
  return state.clients.filter((c) => {
    if (f.visitDay && c.visitDay !== f.visitDay) return false;
    if (f.pointType && (c.pointType || '') !== f.pointType) return false;
    if (f.onlyRegular && !(c.regularAssortment || []).length) return false;
    if (f.onlyDebt && !(c.debtAmount > 0)) return false;
    return true;
  });
}

function renderClients(content) {
  const pointTypes = Array.from(new Set(state.clients.map((c) => c.pointType).filter(Boolean))).sort();
  const f = state.clientFilters;
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Клиенты</h2>
        <button class="btn-primary" id="add-client-btn">+ Новый клиент</button>
      </div>
      <div class="filter-bar">
        <select id="filter-visitDay">
          <option value="">День недели: все</option>
          ${VISIT_DAYS.map((d) => `<option value="${d}" ${f.visitDay === d ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <select id="filter-pointType">
          <option value="">Тип точки: все</option>
          ${pointTypes.map((p) => `<option value="${escapeAttr(p)}" ${f.pointType === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        </select>
        <label class="filter-check"><input type="checkbox" id="filter-onlyRegular" ${f.onlyRegular ? 'checked' : ''}> Постоянный клиент</label>
        <label class="filter-check"><input type="checkbox" id="filter-onlyDebt" ${f.onlyDebt ? 'checked' : ''}> Есть задолженность</label>
        ${(f.visitDay || f.pointType || f.onlyRegular || f.onlyDebt) ? '<button type="button" class="link-btn" id="filter-reset">Сбросить</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Название</th><th>Тип точки</th><th>День визита</th><th>Контактное лицо</th><th>Ответственный</th><th>Долг</th><th>Ассортимент</th><th></th></tr></thead>
          <tbody id="clients-tbody"></tbody>
        </table>
      </div>
    </div>
  `));
  document.getElementById('add-client-btn').addEventListener('click', () => openClientModal());

  document.getElementById('filter-visitDay').addEventListener('change', (e) => { state.clientFilters.visitDay = e.target.value; render(); });
  document.getElementById('filter-pointType').addEventListener('change', (e) => { state.clientFilters.pointType = e.target.value; render(); });
  document.getElementById('filter-onlyRegular').addEventListener('change', (e) => { state.clientFilters.onlyRegular = e.target.checked; render(); });
  document.getElementById('filter-onlyDebt').addEventListener('change', (e) => { state.clientFilters.onlyDebt = e.target.checked; render(); });
  const resetBtn = document.getElementById('filter-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => { state.clientFilters = { visitDay: '', pointType: '', onlyRegular: false, onlyDebt: false }; render(); });

  const tbody = document.getElementById('clients-tbody');
  const list = filteredClients();
  if (!list.length) {
    tbody.appendChild(el(`<tr><td colspan="8"><div class="empty-state">${state.clients.length ? 'Ничего не найдено по выбранным фильтрам.' : 'Пока нет клиентов. Добавьте первого.'}</div></td></tr>`));
    return;
  }
  list.forEach((c) => {
    const atRisk = (c.regularAssortment || []).some((p) => p.atRisk);
    const row = el(`
      <tr>
        <td>
          <strong>${escapeHtml(c.name)}</strong>
          ${c.pendingApproval ? '<span class="badge badge-pending">на согласовании</span>' : ''}
          ${c.isOffRoute ? '<span class="badge badge-offroute">вне маршрута</span>' : ''}
        </td>
        <td>${escapeHtml(c.pointType || '—')}</td>
        <td>${escapeHtml(c.visitDay || '—')}</td>
        <td>${escapeHtml(c.contactName || '—')}</td>
        <td>${agentTag(c.ownerId)}</td>
        <td>${c.debtAmount ? `<span class="badge ${c.debtOverdue ? 'badge-overdue' : 'badge-pay'}">${fmtMoney(c.debtAmount)}</span>` : '—'}</td>
        <td>${(c.regularAssortment || []).length} ${atRisk ? '<span class="badge badge-overdue">риск</span>' : ''}</td>
        <td><button class="link-btn open-client">Открыть</button></td>
      </tr>
    `);
    row.querySelector('.open-client').addEventListener('click', () => openClientModal(c));
    tbody.appendChild(row);
  });
}

function fieldRow(label, value, locked) {
  return `<div class="field"><span class="k">${label}${locked ? ' <span class="lock" title="Редактирует только администратор">🔒</span>' : ''}</span><span class="v">${value}</span></div>`;
}

async function openClientModal(client) {
  const isEdit = !!client;
  const isOwner = isEdit && client.ownerId === state.user.id;
  const canEditCore = isAdmin();

  const ownerOptions = state.users.filter((u) => u.role === 'agent' || u.role === undefined);

  let bodyHtml;
  if (isEdit && !canEditCore) {
    // Просмотр для агента/супервайзера: карточка + доступное редактирование заметок
    bodyHtml = `
      <h2>${escapeHtml(client.name)}</h2>
      ${client.pendingApproval ? '<p class="note-pending">Точка на согласовании у администратора</p>' : ''}
      <div class="panel-inline">
        ${fieldRow('Тип точки', escapeHtml(client.pointType || '—'), true)}
        ${fieldRow('Адрес', escapeHtml(client.address || '—'), true)}
        ${fieldRow('Телефон', escapeHtml(client.phone || '—'), true)}
        ${fieldRow('Контактное лицо', escapeHtml(client.contactName || '—'), true)}
        ${fieldRow('День визита', escapeHtml(client.visitDay || '—'), true)}
        ${fieldRow('Работает по договору', escapeHtml(client.contractStatus), true)}
        ${fieldRow('Способ оплаты', escapeHtml(client.paymentMethod || 'не указан'), true)}
        ${fieldRow('Ответственный', escapeHtml(userName(client.ownerId)), true)}
        ${fieldRow('Задолженность', client.debtAmount ? fmtMoney(client.debtAmount) + (client.debtOverdue ? ' (просрочка)' : '') : 'нет', true)}
      </div>
      <form id="client-form">
        <label>Заметки</label>
        <textarea name="notes">${escapeHtml(client.notes || '')}</textarea>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancel-modal">Закрыть</button>
          <button type="submit" class="btn-primary">Сохранить заметки</button>
        </div>
      </form>
      ${renderAssortmentSection(client)}
      <div id="history-section" class="assort-panel"><h3>История визитов</h3><div class="muted">Загрузка…</div></div>
    `;
  } else {
    bodyHtml = `
      <h2>${isEdit ? 'Контрагент' : 'Новый контрагент'}</h2>
      <form id="client-form">
        <label>Название *</label>
        <input name="name" required value="${client ? escapeAttr(client.name) : ''}">
        <div class="field-row">
          <div><label>Тип точки</label><input name="pointType" value="${client ? escapeAttr(client.pointType) : ''}" placeholder="Салон красоты, мед.клиника..."></div>
          <div><label>День визита</label>
            <select name="visitDay">
              <option value="">—</option>
              ${VISIT_DAYS.map((d) => `<option value="${d}" ${client && client.visitDay === d ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
        </div>
        <label>Адрес</label>
        <input name="address" value="${client ? escapeAttr(client.address) : ''}">
        <div class="field-row">
          <div><label>Телефон</label><input name="phone" value="${client ? escapeAttr(client.phone) : ''}"></div>
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
        ${isAdmin() ? `<label>Ответственный агент</label>
          <select name="ownerId">
            ${ownerOptions.map((u) => `<option value="${u.id}" ${client && client.ownerId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
          </select>` : ''}
        <label>Заметки</label>
        <textarea name="notes">${client ? escapeHtml(client.notes || '') : ''}</textarea>
        <div class="modal-actions">
          ${isEdit && isStaff() ? '<button type="button" class="btn-secondary" id="delete-client">Удалить</button>' : ''}
          ${isEdit && client.pendingApproval && isAdmin() ? '<button type="button" class="btn-secondary" id="approve-client">Одобрить точку</button>' : ''}
          <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
          <button type="submit" class="btn-primary">Сохранить</button>
        </div>
      </form>
      ${isEdit ? renderAssortmentSection(client) : ''}
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

  if (isEdit) {
    wireAssortmentToggle(client.id);
    loadClientHistory(client.id);
  }
}

function assortRow(p) {
  return `
    <div class="assort-row">
      <span>${escapeHtml(p.product)}</span>
      <span class="freq">${p.monthsCount} из 7 мес · ~${p.avgQty} шт/мес · посл.: ${p.lastMonth}</span>
    </div>
  `;
}

function renderAssortmentSection(client) {
  const items = client.regularAssortment || [];
  if (!items.length) return '';
  const normal = items.filter((p) => !p.atRisk);
  const risky = items.filter((p) => p.atRisk);
  return `
    <button type="button" class="assort-btn" id="assort-toggle-${client.id}">🛒 Регулярный ассортимент (${items.length})</button>
    <div class="assort-panel" id="assort-panel-${client.id}" style="display:none">
      ${normal.length ? normal.map(assortRow).join('') : '<div class="muted" style="font-size:13px;padding:4px 0">Все позиции в риске — см. ниже.</div>'}
      ${risky.length ? `
        <div class="assort-risk-heading">⚠️ Риск «отвала» — не заказывали в последнем доступном месяце</div>
        ${risky.map(assortRow).join('')}
      ` : ''}
    </div>
  `;
}

// Скрипты, вставленные через innerHTML/template, браузер не выполняет —
// поэтому переключатель ассортимента навешивается явным addEventListener
// после того, как модалка реально попала в DOM (см. вызовы в openClientModal).
function wireAssortmentToggle(clientId) {
  const btn = document.getElementById(`assort-toggle-${clientId}`);
  const panel = document.getElementById(`assort-panel-${clientId}`);
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
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
  content.appendChild(el(`
    <div>
      <div class="toolbar"><h2 style="margin:0">Задачи по клиентам</h2><button class="btn-primary" id="add-task-btn">+ Новая задача</button></div>
      <div class="filter-bar">
        <span class="muted" style="font-size:13px">Фильтр по тегам:</span>
        ${state.taskTags.map((tag) => `<button type="button" class="tag-filter-btn ${state.taskTagFilter.has(tag) ? 'active' : ''}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`).join('')}
        ${state.taskTagFilter.size ? '<button type="button" class="link-btn" id="tag-filter-reset">Сбросить</button>' : ''}
      </div>
      <div class="kanban" id="kanban"></div>
    </div>
  `));
  document.getElementById('add-task-btn').addEventListener('click', () => openTaskModal());

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

  const today = new Date().toISOString().slice(0, 10);
  const kanban = document.getElementById('kanban');
  state.stages.forEach((stage) => {
    let inStage = state.tasks.filter((t) => t.stage === stage.key);
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
          <div class="deal-title">${escapeHtml(t.title)}</div>
          <div class="deal-client">${client ? escapeHtml(client.name) : '—'}</div>
          <div class="deal-client">${agentTag(t.assigneeId)} ${t.dueDate ? '· ' + fmtDate(t.dueDate) : ''} ${overdue ? '<span class="badge badge-overdue">просрочено</span>' : ''}</div>
          ${taskTagBadges(t) ? `<div class="card-tags">${taskTagBadges(t)}</div>` : ''}
          ${(t.attachments || []).length ? `<div class="muted">📎 ${t.attachments.length}</div>` : ''}
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
      await api('PUT', `/api/tasks/${id}`, { stage: stage.key });
      await loadAll();
      render();
    });
    kanban.appendChild(col);
  });
}

function openTaskModal(task) {
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

  const body = `
    <h2>${isEdit ? 'Задача' : 'Новая задача'}</h2>
    <form id="task-form">
      <label>Клиент *</label>
      <select name="clientId" required ${isEdit ? 'disabled' : ''}>
        ${myClients.map((c) => `<option value="${c.id}" ${task && task.clientId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <label>Название</label>
      <input name="title" value="${task ? escapeAttr(task.title) : ''}" placeholder="Посетить клиента">
      <label>Описание</label>
      <textarea name="description">${task ? escapeHtml(task.description || '') : ''}</textarea>
      <div class="field-row">
        <div><label>Срок</label><input name="dueDate" type="date" value="${task ? task.dueDate : ''}"></div>
        ${isEdit ? `<div><label>Этап</label><select name="stage">${state.stages.map((s) => `<option value="${s.key}" ${task.stage === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>` : ''}
      </div>
      ${assigneeBlock}
      <label>Теги</label>
      <div class="tag-checks">
        ${state.taskTags.map((tag) => `<label class="tag-check"><input type="checkbox" name="tags" value="${escapeAttr(tag)}" ${task && (task.tags || []).includes(tag) ? 'checked' : ''}> ${escapeHtml(tag)}</label>`).join('')}
      </div>
      ${isEdit ? `<label>Комментарий по визиту</label><textarea name="comment">${escapeHtml(task.comment || '')}</textarea>` : ''}
      <div class="modal-actions">
        ${isEdit && isStaff() ? '<button type="button" class="btn-secondary" id="delete-task">Удалить</button>' : ''}
        <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить</button>
      </div>
    </form>
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
  if (isEdit) wireAttachments(task);
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
      <input type="file" id="attach-input" accept="image/*,audio/*" style="margin-top:8px">
    </div>
  `;
}

function wireAttachments(task) {
  const input = document.getElementById('attach-input');
  if (input) input.addEventListener('change', async () => {
    if (!input.files.length) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
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

// ---------- Команда (только админ) ----------

function renderTeam(content) {
  if (!isAdmin()) return;
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Команда</h2>
        <button class="btn-primary" id="add-user-btn">+ Сотрудник</button>
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
        </div>
      </div>
      <div id="cal-title" class="cal-title"></div>
      <div id="cal-body"></div>
    </div>
  `));

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
    const cell = el(`
      <div class="cal-day-cell ${inMonth ? '' : 'cal-day-outside'} ${key === todayKey ? 'cal-day-today' : ''}">
        <div class="cal-day-num">${d.getDate()}</div>
        <div class="cal-day-tasks">
          ${dayTasks.slice(0, 3).map((t) => { const c = clientById(t.clientId); return `<div class="cal-chip">${escapeHtml(c ? c.name : t.title)}</div>`; }).join('')}
          ${dayTasks.length > 3 ? `<div class="cal-more">+${dayTasks.length - 3}</div>` : ''}
        </div>
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
    const col = el(`
      <div class="cal-week-col ${key === todayKey ? 'cal-day-today' : ''}">
        <div class="cal-week-head">${WEEKDAY_LABELS[(d.getDay() + 6) % 7]} ${d.getDate()}</div>
        <div class="cal-week-body"></div>
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
    grid.appendChild(col);
  });
  document.getElementById('cal-body').appendChild(grid);
}

function renderCalDay() {
  const cal = state.calendar;
  const key = toDateKey(cal.date);
  document.getElementById('cal-title').textContent = fmtDateLong(cal.date);
  const dayTasks = tasksOnDate(key);
  const body = document.getElementById('cal-body');
  if (!dayTasks.length) { body.appendChild(el('<div class="empty-state">На этот день задач нет.</div>')); return; }
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

// ---------- Экранирование ----------

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

// ---------- Старт ----------

boot();
