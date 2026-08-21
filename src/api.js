const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const { parseMultipart } = require('./multipart');

const TASK_STAGES = [
  { key: 'new', label: 'Новая задача' },
  { key: 'in_progress', label: 'В работе' },
  { key: 'done', label: 'Выполнена' },
  { key: 'not_done', label: 'Не выполнена' },
  { key: 'failed', label: 'Провал' }
];

const PAYMENT_METHODS = ['Наличные', 'Безналичные', 'QR'];
const CONTRACT_STATUSES = ['да', 'нет', 'неизвестно'];

// Поля карточки клиента, которые редактирует ТОЛЬКО администратор
const CLIENT_ADMIN_ONLY_FIELDS = [
  'name', 'pointType', 'address', 'phone', 'contactName',
  'visitDay', 'contractStatus', 'paymentMethod', 'ownerId'
];
// Поля, которые может редактировать и назначенный агент
const CLIENT_AGENT_EDITABLE_FIELDS = ['notes'];

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Некорректный JSON в теле запроса'));
      }
    });
    req.on('error', reject);
  });
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

function norm(s) {
  return (s || '').toString().trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

// Видимость записей по роли: admin/supervisor видят всё, agent — только своё
function scoped(list, user, ownerField) {
  if (user.role === 'admin' || user.role === 'supervisor') return list;
  return list.filter((r) => r[ownerField] === user.id);
}

function requireAuth(handler) {
  return async (req, res, params) => {
    const user = auth.currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Требуется вход в систему' });
    req.user = user;
    return handler(req, res, params);
  };
}

function requireAdmin(handler) {
  return requireAuth(async (req, res, params) => {
    if (req.user.role !== 'admin') return sendJson(res, 403, { error: 'Недостаточно прав' });
    return handler(req, res, params);
  });
}

function isStaff(user) {
  return user.role === 'admin' || user.role === 'supervisor';
}

function findDuplicateClient(name, address, phone) {
  const n = norm(name), a = norm(address), p = norm(phone).replace(/\D/g, '');
  return db.all('clients').find((c) => {
    const cp = norm(c.phone).replace(/\D/g, '');
    return norm(c.name) === n && norm(c.address) === a && (p ? cp === p : true);
  });
}

function register(router) {
  // ---- Аутентификация ----

  router.post('/api/login', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const { email, password } = body;
    const user = db.all('users').find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
    if (!user || !auth.verifyPassword(password, user.passwordHash)) {
      return sendJson(res, 401, { error: 'Неверный email или пароль' });
    }
    auth.createSessionForUser(res, user.id);
    sendJson(res, 200, { user: publicUser(user) });
  });

  router.post('/api/logout', (req, res) => {
    auth.logout(req, res);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/me', requireAuth(async (req, res) => {
    sendJson(res, 200, {
      user: publicUser(req.user),
      stages: TASK_STAGES,
      paymentMethods: PAYMENT_METHODS,
      contractStatuses: CONTRACT_STATUSES
    });
  }));

  // ---- Пользователи (команда) ----

  router.get('/api/users', requireAuth(async (req, res) => {
    const users = db.all('users').map(publicUser);
    if (req.user.role === 'admin') return sendJson(res, 200, { users });
    sendJson(res, 200, { users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })) });
  }));

  router.post('/api/users', requireAdmin(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const { name, email, password, role } = body;
    if (!name || !email || !password) return sendJson(res, 400, { error: 'Заполните имя, email и пароль' });
    if (db.all('users').some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      return sendJson(res, 400, { error: 'Пользователь с таким email уже существует' });
    }
    const validRoles = ['admin', 'supervisor', 'agent'];
    const user = db.insert('users', {
      name,
      email,
      passwordHash: auth.hashPassword(password),
      role: validRoles.includes(role) ? role : 'agent',
      createdAt: new Date().toISOString()
    });
    sendJson(res, 201, { user: publicUser(user) });
  }));

  router.delete('/api/users/:id', requireAdmin(async (req, res, params) => {
    if (Number(params.id) === req.user.id) return sendJson(res, 400, { error: 'Нельзя удалить самого себя' });
    const ok = db.remove('users', params.id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Не найдено' });
  }));

  // ---- Клиенты (контрагенты) ----

  router.get('/api/clients', requireAuth(async (req, res) => {
    sendJson(res, 200, { clients: scoped(db.all('clients'), req.user, 'ownerId') });
  }));

  router.post('/api/clients', requireAuth(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.name) return sendJson(res, 400, { error: 'Укажите название контрагента' });

    if (!body.force) {
      const dup = findDuplicateClient(body.name, body.address, body.phone);
      if (dup) {
        return sendJson(res, 409, {
          error: 'Похоже, такой контрагент уже есть (совпадают название, адрес и телефон)',
          duplicate: dup
        });
      }
    }

    const isAgent = req.user.role === 'agent';
    const ownerId = !isAgent && body.ownerId ? Number(body.ownerId) : req.user.id;

    const client = db.insert('clients', {
      name: body.name,
      pointType: body.pointType || '',
      address: body.address || '',
      phone: body.phone || '',
      contactName: body.contactName || '',
      visitDay: body.visitDay || '',
      contractStatus: CONTRACT_STATUSES.includes(body.contractStatus) ? body.contractStatus : 'неизвестно',
      paymentMethod: PAYMENT_METHODS.includes(body.paymentMethod) ? body.paymentMethod : '',
      notes: body.notes || '',
      ownerId,
      isOffRoute: isAgent ? true : !!body.isOffRoute,
      pendingApproval: isAgent, // новый клиент от агента ждёт подтверждения админом
      regularAssortment: [],
      debtAmount: 0,
      debtOverdue: false,
      debtAsOf: null,
      createdAt: new Date().toISOString()
    });
    sendJson(res, 201, { client });
  }));

  router.put('/api/clients/:id', requireAuth(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    const owns = client.ownerId === req.user.id;
    if (!isStaff(req.user) && !owns) return sendJson(res, 403, { error: 'Недостаточно прав' });

    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    const patch = {};
    if (req.user.role === 'admin') {
      CLIENT_ADMIN_ONLY_FIELDS.forEach((f) => {
        if (body[f] === undefined) return;
        if (f === 'ownerId') { patch.ownerId = Number(body.ownerId); return; }
        if (f === 'contractStatus' && !CONTRACT_STATUSES.includes(body.contractStatus)) return;
        if (f === 'paymentMethod' && body.paymentMethod && !PAYMENT_METHODS.includes(body.paymentMethod)) return;
        patch[f] = body[f];
      });
      if (body.pendingApproval !== undefined) patch.pendingApproval = !!body.pendingApproval;
      if (body.isOffRoute !== undefined) patch.isOffRoute = !!body.isOffRoute;
    }
    CLIENT_AGENT_EDITABLE_FIELDS.forEach((f) => {
      if (body[f] !== undefined) patch[f] = body[f];
    });

    sendJson(res, 200, { client: db.update('clients', params.id, patch) });
  }));

  router.post('/api/clients/:id/approve', requireAdmin(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { client: db.update('clients', params.id, { pendingApproval: false }) });
  }));

  router.delete('/api/clients/:id', requireAdmin(async (req, res, params) => {
    const ok = db.remove('clients', params.id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Не найдено' });
  }));

  // История визитов по клиенту = его задачи, отсортированные по дате
  router.get('/api/clients/:id/history', requireAuth(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && client.ownerId !== req.user.id) {
      return sendJson(res, 403, { error: 'Недостаточно прав' });
    }
    const tasks = db.all('tasks')
      .filter((t) => t.clientId === client.id)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    sendJson(res, 200, { tasks });
  }));

  // ---- Задачи (воронка визитов) ----

  router.get('/api/tasks', requireAuth(async (req, res) => {
    sendJson(res, 200, { tasks: scoped(db.all('tasks'), req.user, 'assigneeId'), stages: TASK_STAGES });
  }));

  router.post('/api/tasks', requireAuth(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.clientId) return sendJson(res, 400, { error: 'Укажите клиента' });
    const client = db.find('clients', body.clientId);
    if (!client) return sendJson(res, 400, { error: 'Клиент не найден' });
    if (req.user.role === 'agent' && client.ownerId !== req.user.id) {
      return sendJson(res, 403, { error: 'Это не ваш клиент' });
    }
    const assigneeId = isStaff(req.user) && body.assigneeId ? Number(body.assigneeId) : (req.user.role === 'agent' ? req.user.id : client.ownerId);
    const task = db.insert('tasks', {
      clientId: Number(body.clientId),
      title: body.title || `Посетить: ${client.name}`,
      description: body.description || '',
      dueDate: body.dueDate || '',
      stage: 'new',
      comment: '',
      attachments: [],
      assigneeId,
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    sendJson(res, 201, { task });
  }));

  router.put('/api/tasks/:id', requireAuth(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && task.assigneeId !== req.user.id) {
      return sendJson(res, 403, { error: 'Недостаточно прав' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const patch = { updatedAt: new Date().toISOString() };
    ['title', 'description', 'dueDate', 'comment'].forEach((f) => {
      if (body[f] !== undefined) patch[f] = body[f];
    });
    if (body.stage !== undefined && TASK_STAGES.some((s) => s.key === body.stage)) patch.stage = body.stage;
    if (isStaff(req.user)) {
      if (body.assigneeId !== undefined) patch.assigneeId = Number(body.assigneeId);
      if (body.clientId !== undefined) patch.clientId = Number(body.clientId);
    }
    sendJson(res, 200, { task: db.update('tasks', params.id, patch) });
  }));

  router.delete('/api/tasks/:id', requireAuth(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && task.assigneeId !== req.user.id) {
      return sendJson(res, 403, { error: 'Недостаточно прав' });
    }
    (task.attachments || []).forEach((a) => {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, String(task.id), a.storedName)); } catch (e) {}
    });
    db.remove('tasks', params.id);
    sendJson(res, 200, { ok: true });
  }));

  // ---- Вложения к задаче (скриншоты, аудио) ----

  router.post('/api/tasks/:id/attachments', requireAuth(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && task.assigneeId !== req.user.id) {
      return sendJson(res, 403, { error: 'Недостаточно прав' });
    }
    let parsed;
    try {
      parsed = await parseMultipart(req, 20 * 1024 * 1024); // до 20 МБ на запрос
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!parsed.files.length) return sendJson(res, 400, { error: 'Файл не найден в запросе' });

    const taskDir = path.join(UPLOADS_DIR, String(task.id));
    fs.mkdirSync(taskDir, { recursive: true });

    const added = [];
    for (const file of parsed.files) {
      const allowed = /^image\//.test(file.mimeType) || /^audio\//.test(file.mimeType);
      if (!allowed) continue; // разрешены только изображения и аудио
      const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(taskDir, storedName), file.data);
      added.push({
        id: storedName,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.data.length,
        storedName,
        url: `/uploads/${task.id}/${storedName}`
      });
    }
    if (!added.length) return sendJson(res, 400, { error: 'Разрешены только изображения и аудиофайлы' });

    const attachments = [...(task.attachments || []), ...added];
    const updated = db.update('tasks', task.id, { attachments, updatedAt: new Date().toISOString() });
    sendJson(res, 201, { task: updated });
  }));

  router.delete('/api/tasks/:id/attachments/:attId', requireAuth(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && task.assigneeId !== req.user.id) {
      return sendJson(res, 403, { error: 'Недостаточно прав' });
    }
    const att = (task.attachments || []).find((a) => a.id === params.attId);
    if (att) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, String(task.id), att.storedName)); } catch (e) {}
    }
    const attachments = (task.attachments || []).filter((a) => a.id !== params.attId);
    const updated = db.update('tasks', task.id, { attachments, updatedAt: new Date().toISOString() });
    sendJson(res, 200, { task: updated });
  }));

  // ---- Дашборд ----

  router.get('/api/stats', requireAuth(async (req, res) => {
    const clients = scoped(db.all('clients'), req.user, 'ownerId');
    const tasks = scoped(db.all('tasks'), req.user, 'assigneeId');
    const today = new Date().toISOString().slice(0, 10);
    const overdueTasks = tasks.filter((t) => ['new', 'in_progress'].includes(t.stage) && t.dueDate && t.dueDate < today);
    const todayTasks = tasks.filter((t) => ['new', 'in_progress'].includes(t.stage) && t.dueDate === today);
    const atRiskClients = clients.filter((c) => (c.regularAssortment || []).some((p) => p.atRisk));
    const pendingApproval = clients.filter((c) => c.pendingApproval).length;
    const totalDebt = clients.reduce((s, c) => s + (c.debtAmount || 0), 0);

    const byStage = TASK_STAGES.map((s) => ({
      key: s.key, label: s.label, count: tasks.filter((t) => t.stage === s.key).length
    }));

    const payload = {
      clientsCount: clients.length,
      todayTasksCount: todayTasks.length,
      overdueTasksCount: overdueTasks.length,
      atRiskClientsCount: atRiskClients.length,
      pendingApprovalCount: pendingApproval,
      totalDebt,
      byStage
    };

    if (isStaff(req.user)) {
      const agents = db.all('users').filter((u) => u.role === 'agent');
      payload.byAgent = agents.map((agent) => {
        const aTasks = db.all('tasks').filter((t) => t.assigneeId === agent.id);
        const done = aTasks.filter((t) => t.stage === 'done').length;
        const closed = aTasks.filter((t) => ['done', 'not_done', 'failed'].includes(t.stage)).length;
        return {
          agentId: agent.id,
          agentName: agent.name,
          totalTasks: aTasks.length,
          done,
          notDone: aTasks.filter((t) => t.stage === 'not_done').length,
          failed: aTasks.filter((t) => t.stage === 'failed').length,
          open: aTasks.filter((t) => ['new', 'in_progress'].includes(t.stage)).length,
          completionRate: closed ? Math.round((done / closed) * 100) : null
        };
      });
    }

    sendJson(res, 200, payload);
  }));
}

module.exports = { register, TASK_STAGES, PAYMENT_METHODS, CONTRACT_STATUSES, sendJson, UPLOADS_DIR };
