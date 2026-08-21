// Задачник для торговых агентов — фронтенд на чистом JS, без сборки и фреймворков.

const state = {
  user: null,
  stages: [],
  paymentMethods: [],
  contractStatuses: [],
  clients: [],
  tasks: [],
  users: [],
  view: 'dashboard'
};

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
  if (state.view === 'team') return renderTeam(content);
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
        <h2>Задачи по этапам</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Этап</th><th>Кол-во</th></tr></thead>
            <tbody>
              ${stats.byStage.map((s) => `<tr><td>${s.label}</td><td>${s.count}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${stats.byAgent ? `
      <div class="panel">
        <h2>Выполнение по агентам</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Агент</th><th>Всего задач</th><th>В работе</th><th>Выполнено</th><th>Не выполнено</th><th>Провал</th><th>% выполнения</th></tr></thead>
            <tbody>
              ${stats.byAgent.map((a) => `
                <tr>
                  <td>${escapeHtml(a.agentName)}</td>
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
}

// ---------- Клиенты ----------

function renderClients(content) {
  content.appendChild(el(`
    <div>
      <div class="toolbar">
        <h2 style="margin:0">Клиенты</h2>
        <button class="btn-primary" id="add-client-btn">+ Новый клиент</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Название</th><th>Тип точки</th><th>День визита</th><th>Ответственный</th><th>Долг</th><th>Ассортимент</th><th></th></tr></thead>
          <tbody id="clients-tbody"></tbody>
        </table>
      </div>
    </div>
  `));
  document.getElementById('add-client-btn').addEventListener('click', () => openClientModal());

  const tbody = document.getElementById('clients-tbody');
  if (!state.clients.length) {
    tbody.appendChild(el(`<tr><td colspan="7"><div class="empty-state">Пока нет клиентов. Добавьте первого.</div></td></tr>`));
    return;
  }
  state.clients.forEach((c) => {
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
        <td>${escapeHtml(userName(c.ownerId))}</td>
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
              ${['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'].map((d) => `<option value="${d}" ${client && client.visitDay === d ? 'selected' : ''}>${d}</option>`).join('')}
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
          ${isEdit && isAdmin() ? '<button type="button" class="btn-secondary" id="delete-client">Удалить</button>' : ''}
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

  if (isEdit) loadClientHistory(client.id);
}

function renderAssortmentSection(client) {
  const items = client.regularAssortment || [];
  if (!items.length) return '';
  return `
    <button type="button" class="assort-btn" id="assort-toggle-${client.id}">🛒 Регулярный ассортимент (${items.length})</button>
    <div class="assort-panel" id="assort-panel-${client.id}" style="display:none">
      ${items.map((p) => `
        <div class="assort-row">
          <span>${escapeHtml(p.product)} ${p.atRisk ? '<span class="badge badge-overdue">не заказывал в последнем месяце</span>' : ''}</span>
          <span class="freq">${p.monthsCount} из 7 мес · ~${p.avgQty} шт/мес · посл.: ${p.lastMonth}</span>
        </div>
      `).join('')}
    </div>
    <script>document.getElementById('assort-toggle-${client.id}').addEventListener('click',()=>{const p=document.getElementById('assort-panel-${client.id}');p.style.display=p.style.display==='none'?'block':'none';});</script>
  `;
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

function renderTasks(content) {
  content.appendChild(el(`<div><div class="toolbar"><h2 style="margin:0">Задачи по клиентам</h2><button class="btn-primary" id="add-task-btn">+ Новая задача</button></div><div class="kanban" id="kanban"></div></div>`));
  document.getElementById('add-task-btn').addEventListener('click', () => openTaskModal());

  const kanban = document.getElementById('kanban');
  state.stages.forEach((stage) => {
    const inStage = state.tasks.filter((t) => t.stage === stage.key);
    const col = el(`
      <div class="kanban-col" data-stage="${stage.key}">
        <h3>${stage.label} <span class="col-sum">· ${inStage.length}</span></h3>
        <div class="col-body"></div>
      </div>
    `);
    const colBody = col.querySelector('.col-body');
    inStage.forEach((t) => {
      const client = clientById(t.clientId);
      const overdue = t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) && ['new', 'in_progress'].includes(t.stage);
      const card = el(`
        <div class="deal-card" draggable="true" data-id="${t.id}">
          <div class="deal-title">${escapeHtml(t.title)}</div>
          <div class="deal-client">${client ? escapeHtml(client.name) : '—'}</div>
          <div class="deal-client">${escapeHtml(userName(t.assigneeId))} ${t.dueDate ? '· ' + fmtDate(t.dueDate) : ''} ${overdue ? '<span class="badge badge-overdue">просрочено</span>' : ''}</div>
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
      ${isEdit ? `<label>Комментарий по визиту</label><textarea name="comment">${escapeHtml(task.comment || '')}</textarea>` : ''}
      <div class="modal-actions">
        ${isEdit ? '<button type="button" class="btn-secondary" id="delete-task">Удалить</button>' : ''}
        <button type="button" class="btn-secondary" id="cancel-modal">Отмена</button>
        <button type="submit" class="btn-primary">Сохранить</button>
      </div>
    </form>
    ${isEdit ? renderAttachmentsSection(task) : ''}
  `;
  openModal(body, async (form) => {
    const data = Object.fromEntries(new FormData(form).entries());
    if (task) await api('PUT', `/api/tasks/${task.id}`, data);
    else await api('POST', '/api/tasks', data);
    await loadAll();
    closeModal();
    render();
  });
  if (isEdit) {
    document.getElementById('delete-task').addEventListener('click', async () => {
      if (!confirm('Удалить задачу?')) return;
      await api('DELETE', `/api/tasks/${task.id}`);
      await loadAll();
      closeModal();
      render();
    });
    wireAttachments(task);
  }
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
          <thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th></th></tr></thead>
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
