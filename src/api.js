const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const { parseMultipart } = require('./multipart');
const { buildZip } = require('./miniZip');
const googleSheets = require('./googleSheets');

// Этапы доски задач. "Новая задача" убрана — задача сразу создаётся в "В работе".
// "Лист ожидания" и "Прогрев" больше не этапы доски, а теги задачи (см. TASK_TAGS) —
// так их проще сочетать с обычным статусом выполнения.
// "Архив" — задачу переводит туда только администратор/супервайзер, после того как
// подтвердит выполненный визит; у агента на доске этого этапа нет (см. GET /api/tasks).
const TASK_STAGES = [
  { key: 'in_progress', label: 'В работе' },
  { key: 'done', label: 'Выполнена' },
  { key: 'not_done', label: 'Не выполнена' },
  { key: 'archive', label: 'Архив' }
];

const STAFF_ONLY_STAGES = ['archive'];

// Воронка активной продажи (звонок → встреча → сделка/провал) — отдельный тип
// задачи (taskType: 'sale'), со своим набором этапов, независимым от обычных
// визитных задач (taskType: 'visit', тип по умолчанию для всех старых задач).
const SALE_STAGES = [
  { key: 'call', label: 'Звонок' },
  { key: 'meeting', label: 'Встреча' },
  { key: 'deal', label: 'Сделка' },
  { key: 'fail', label: 'Провал' }
];
const SALE_FINAL_STAGES = ['deal', 'fail']; // требуют аудио+пояснение встречи перед переходом
const VISIT_DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
// JS: getDay() воскресенье=0, понедельник=1 ... суббота=6
const VISIT_DAY_INDEX = { 'Понедельник': 1, 'Вторник': 2, 'Среда': 3, 'Четверг': 4, 'Пятница': 5, 'Суббота': 6 };

// Ближайшая дата (после сегодня) с нужным днём недели, в формате YYYY-MM-DD.
function nextDateForWeekday(weekdayName) {
  const targetIdx = VISIT_DAY_INDEX[weekdayName];
  if (targetIdx === undefined) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== targetIdx);
  return d.toISOString().slice(0, 10);
}

const TASK_TAGS = ['Kapous', 'EPICA', 'Чистовье', 'Палитра', 'новый клиент', 'Лист ожидания', 'Прогрев'];
const ACTIVE_STAGES = ['in_progress'];
const SALE_ACTIVE_STAGES = ['call', 'meeting'];
// Общий помощник: активна ли задача (не закрыта), независимо от её типа (визит/продажа).
function isActiveStage(task) {
  return task.taskType === 'sale' ? SALE_ACTIVE_STAGES.includes(task.stage) : ACTIVE_STAGES.includes(task.stage);
}

// Разовая идемпотентная миграция старых данных при обновлении сервера:
//  - этап "new" ("Новая задача") убран — такие задачи удаляются (по факту это
//    ещё не начатые визиты без другой ценной информации);
//  - этапы "waiting"/"failed" стали тегами — переносим такие задачи в "В работе"
//    и проставляем соответствующий тег, чтобы ничего не потерять.
// Безопасно вызывать при каждом запуске: после первого прогона таких задач больше нет.
function migrateLegacyTaskStages() {
  const tasks = db.all('tasks').slice();
  tasks.forEach((t) => {
    if (t.stage === 'new') {
      db.remove('tasks', t.id);
      return;
    }
    const patch = {};
    if (t.stage === 'waiting' || t.stage === 'failed') {
      const tagToAdd = t.stage === 'waiting' ? 'Лист ожидания' : 'Прогрев';
      const tags = Array.isArray(t.tags) ? t.tags.slice() : [];
      if (!tags.includes(tagToAdd)) tags.push(tagToAdd);
      patch.stage = 'in_progress';
      patch.tags = tags;
    }
    if (t.report === undefined) patch.report = '';
    if (t.taskType === undefined) patch.taskType = 'visit';
    if (t.dateChangeRequest === undefined) patch.dateChangeRequest = null;
    if (t.explanation === undefined) patch.explanation = '';
    if (Object.keys(patch).length) db.update('tasks', t.id, patch);
  });
}

// Проставляет значения по умолчанию для новых полей клиента у уже существующих
// записей (созданных до появления "точка закрыта" / заметок по контакту).
// Безопасно вызывать при каждом запуске — на уже проинициализированных клиентов не влияет.
function migrateClientDefaults() {
  db.all('clients').forEach((c) => {
    const patch = {};
    if (c.closed === undefined) patch.closed = false;
    if (c.closureRequested === undefined) patch.closureRequested = false;
    if (c.closureRequestedBy === undefined) patch.closureRequestedBy = null;
    if (c.contactNotes === undefined) patch.contactNotes = [];
    if (c.masters === undefined) patch.masters = [];
    if (c.inn === undefined) patch.inn = '';
    if (c.socialContact === undefined) patch.socialContact = '';
    if (c.bestCallTime === undefined) patch.bestCallTime = '';
    if (c.decisionMakerName === undefined) patch.decisionMakerName = '';
    if (c.specialRequests === undefined) patch.specialRequests = '';
    if (c.orderWindow === undefined) patch.orderWindow = '';
    if (c.meetingRecords === undefined) patch.meetingRecords = [];
    if (c.promotions === undefined) patch.promotions = [];
    if (Object.keys(patch).length) db.update('clients', c.id, patch);
  });
}

const PAYMENT_METHODS = ['Наличные', 'Безналичные', 'QR'];
const CONTRACT_STATUSES = ['да', 'нет', 'неизвестно'];

// Поля карточки клиента, которые редактирует ТОЛЬКО администратор
const CLIENT_ADMIN_ONLY_FIELDS = [
  'name', 'pointType', 'address', 'phone', 'contactName',
  'visitDay', 'contractStatus', 'paymentMethod', 'ownerId',
  'inn', 'socialContact', 'bestCallTime', 'decisionMakerName', 'specialRequests', 'orderWindow'
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
  return { id: u.id, name: u.name, email: u.email, role: u.role, avatarUrl: u.avatarUrl || null };
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

// Удаление (клиентов, задач) разрешено только администратору и супервайзеру — не агентам
function requireStaff(handler) {
  return requireAuth(async (req, res, params) => {
    if (!isStaff(req.user)) return sendJson(res, 403, { error: 'Удаление доступно только администратору и супервайзеру' });
    return handler(req, res, params);
  });
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
      stages: isStaff(req.user) ? TASK_STAGES : TASK_STAGES.filter((s) => !STAFF_ONLY_STAGES.includes(s.key)),
      saleStages: SALE_STAGES,
      paymentMethods: PAYMENT_METHODS,
      contractStatuses: CONTRACT_STATUSES,
      taskTags: TASK_TAGS
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

  // Аватар сотрудника — для быстрого визуального распознавания в списках/канбане
  router.post('/api/users/:id/avatar', requireAdmin(async (req, res, params) => {
    const user = db.find('users', params.id);
    if (!user) return sendJson(res, 404, { error: 'Не найдено' });
    let parsed;
    try {
      parsed = await parseMultipart(req, 5 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const file = parsed.files[0];
    if (!file || !/^image\//.test(file.mimeType)) {
      return sendJson(res, 400, { error: 'Нужен файл изображения' });
    }
    const avatarsDir = path.join(UPLOADS_DIR, 'avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });
    const ext = (file.mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const storedName = `user${user.id}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(avatarsDir, storedName), file.data);
    const updated = db.update('users', user.id, { avatarUrl: `/uploads/avatars/${storedName}` });
    sendJson(res, 200, { user: publicUser(updated) });
  }));

  // Резервная копия одной кнопкой: db.json + все вложения одним zip-файлом.
  router.get('/api/backup', requireAdmin(async (req, res) => {
    const entries = [];
    const dbPath = path.join(__dirname, '..', 'data', 'db.json');
    if (fs.existsSync(dbPath)) entries.push({ name: 'db.json', data: fs.readFileSync(dbPath) });

    function walk(dir, prefix) {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        const rel = prefix + '/' + entry.name;
        if (entry.isDirectory()) walk(full, rel);
        else entries.push({ name: 'uploads' + rel, data: fs.readFileSync(full) });
      });
    }
    walk(UPLOADS_DIR, '');

    const zipBuf = buildZip(entries);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="backup-${dateStr}.zip"`,
      'Content-Length': zipBuf.length
    });
    res.end(zipBuf);
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
      testAssortment: [],
      debtAmount: 0,
      debtOverdue: false,
      debtAsOf: null,
      closed: false,
      closureRequested: false,
      closureRequestedBy: null,
      contactNotes: [],
      masters: [],
      inn: body.inn || '',
      socialContact: body.socialContact || '',
      bestCallTime: body.bestCallTime || '',
      decisionMakerName: body.decisionMakerName || '',
      specialRequests: body.specialRequests || '',
      orderWindow: body.orderWindow || '',
      meetingRecords: [],
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
    // Защищённые поля карточки клиента редактирует администратор ИЛИ супервайзер
    // (по решению пользователя их права в целом равны для работы с клиентами/задачами;
    // отдельно от прав на управление самими сотрудниками — это осталось только у админа).
    if (isStaff(req.user)) {
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

  router.post('/api/clients/:id/approve', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { client: db.update('clients', params.id, { pendingApproval: false }) });
  }));

  router.delete('/api/clients/:id', requireStaff(async (req, res, params) => {
    const ok = db.remove('clients', params.id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Не найдено' });
  }));

  // Массовая смена ответственного агента (админ/супервайзер)
  router.post('/api/clients/bulk-reassign', requireStaff(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    const ownerId = Number(body.ownerId);
    const agent = db.find('users', ownerId);
    if (!ids.length) return sendJson(res, 400, { error: 'Не выбрано ни одного клиента' });
    if (!agent || agent.role !== 'agent') return sendJson(res, 400, { error: 'Укажите корректного агента' });
    let updated = 0;
    ids.forEach((id) => { if (db.update('clients', id, { ownerId })) updated++; });
    sendJson(res, 200, { updated });
  }));

  // ---- "Точка закрыта": агент предлагает закрыть, админ/супервайзер подтверждает ----

  router.post('/api/clients/:id/request-closure', requireAuth(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && client.ownerId !== req.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
    sendJson(res, 200, { client: db.update('clients', params.id, { closureRequested: true, closureRequestedBy: req.user.id }) });
  }));

  router.post('/api/clients/:id/confirm-closure', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { client: db.update('clients', params.id, { closed: true, closureRequested: false }) });
  }));

  router.post('/api/clients/:id/reject-closure', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { client: db.update('clients', params.id, { closureRequested: false }) });
  }));

  router.post('/api/clients/:id/reopen', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { client: db.update('clients', params.id, { closed: false, closureRequested: false }) });
  }));

  // ---- Заметки/звонки по клиенту (лёгкий журнал контактов, отдельно от задач) ----

  router.post('/api/clients/:id/notes', requireAuth(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && client.ownerId !== req.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.text || !body.text.trim()) return sendJson(res, 400, { error: 'Пустая заметка' });
    const note = { id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), text: body.text.trim(), authorId: req.user.id, createdAt: new Date().toISOString() };
    const contactNotes = [note, ...(client.contactNotes || [])];
    sendJson(res, 201, { client: db.update('clients', params.id, { contactNotes }) });
  }));

  router.delete('/api/clients/:id/notes/:noteId', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    const contactNotes = (client.contactNotes || []).filter((n) => n.id !== params.noteId);
    sendJson(res, 200, { client: db.update('clients', params.id, { contactNotes }) });
  }));

  // ---- Мастера точки (сотрудники салона/кабинета/массажной и т.п.) ----
  // Добавляются сразу (без обязательного подтверждения) — супервайзер видит
  // непросмотренные через isNew/newMastersCount на дашборде.

  router.post('/api/clients/:id/masters', requireAuth(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && client.ownerId !== req.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.name || !body.name.trim()) return sendJson(res, 400, { error: 'Укажите ФИО мастера' });
    const master = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: body.name.trim(),
      phone: body.phone || '',
      specialization: body.specialization || '',
      isNew: !isStaff(req.user),
      createdBy: req.user.id,
      createdAt: new Date().toISOString()
    };
    const masters = [...(client.masters || []), master];
    sendJson(res, 201, { client: db.update('clients', params.id, { masters }) });
  }));

  router.put('/api/clients/:id/masters/:masterId', requireAuth(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && client.ownerId !== req.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const masters = (client.masters || []).map((m) => {
      if (m.id !== params.masterId) return m;
      return {
        ...m,
        name: body.name !== undefined ? body.name : m.name,
        phone: body.phone !== undefined ? body.phone : m.phone,
        specialization: body.specialization !== undefined ? body.specialization : m.specialization
      };
    });
    sendJson(res, 200, { client: db.update('clients', params.id, { masters }) });
  }));

  router.post('/api/clients/:id/masters/:masterId/mark-reviewed', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    const masters = (client.masters || []).map((m) => (m.id === params.masterId ? { ...m, isNew: false } : m));
    sendJson(res, 200, { client: db.update('clients', params.id, { masters }) });
  }));

  router.delete('/api/clients/:id/masters/:masterId', requireStaff(async (req, res, params) => {
    const client = db.find('clients', params.id);
    if (!client) return sendJson(res, 404, { error: 'Не найдено' });
    const masters = (client.masters || []).filter((m) => m.id !== params.masterId);
    sendJson(res, 200, { client: db.update('clients', params.id, { masters }) });
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
    sendJson(res, 200, {
      tasks: scoped(db.all('tasks'), req.user, 'assigneeId'),
      stages: isStaff(req.user) ? TASK_STAGES : TASK_STAGES.filter((s) => !STAFF_ONLY_STAGES.includes(s.key)),
      saleStages: SALE_STAGES
    });
  }));

  // Массовое удаление задач (админ/супервайзер)
  router.post('/api/tasks/bulk-delete', requireStaff(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    let removed = 0;
    ids.forEach((id) => {
      const task = db.find('tasks', id);
      if (!task) return;
      (task.attachments || []).forEach((a) => {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, String(task.id), a.storedName)); } catch (e) {}
      });
      if (db.remove('tasks', id)) removed++;
    });
    sendJson(res, 200, { removed });
  }));

  router.post('/api/tasks', requireAuth(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.clientId) return sendJson(res, 400, { error: 'Укажите клиента' });
    if (!body.dueDate) return sendJson(res, 400, { error: 'Укажите срок (дату) задачи' });
    const client = db.find('clients', body.clientId);
    if (!client) return sendJson(res, 400, { error: 'Клиент не найден' });
    if (req.user.role === 'agent' && client.ownerId !== req.user.id) {
      return sendJson(res, 403, { error: 'Это не ваш клиент' });
    }
    const assigneeId = isStaff(req.user) && body.assigneeId ? Number(body.assigneeId) : (req.user.role === 'agent' ? req.user.id : client.ownerId);
    const tags = Array.isArray(body.tags) ? body.tags.filter((t) => TASK_TAGS.includes(t)) : [];
    const taskType = body.taskType === 'sale' ? 'sale' : 'visit';
    const task = db.insert('tasks', {
      clientId: Number(body.clientId),
      taskType,
      title: body.title || (taskType === 'sale' ? `Звонок: ${client.name}` : `Посетить: ${client.name}`),
      description: body.description || '',
      dueDate: body.dueDate,
      stage: taskType === 'sale' ? 'call' : 'in_progress',
      tags,
      comment: '',
      report: '',
      explanation: '',
      dateChangeRequest: null,
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

    // Дату задачи после того, как она уже установлена, может менять только
    // администратор/супервайзер — агент задаёт её только один раз (при создании
    // или пока поле ещё пустое).
    if (body.dueDate !== undefined && body.dueDate !== task.dueDate && task.dueDate && !isStaff(req.user)) {
      return sendJson(res, 403, { error: 'Дату может изменить только администратор или супервайзер. Обратитесь к супервайзеру.' });
    }

    const patch = { updatedAt: new Date().toISOString() };
    ['title', 'description', 'dueDate', 'comment', 'report', 'explanation'].forEach((f) => {
      if (body[f] !== undefined) patch[f] = body[f];
    });
    if (body.tags !== undefined) {
      patch.tags = Array.isArray(body.tags) ? body.tags.filter((t) => TASK_TAGS.includes(t)) : [];
    }
    const isSale = task.taskType === 'sale';
    if (body.stage !== undefined) {
      if (isSale) {
        if (SALE_STAGES.some((s) => s.key === body.stage)) patch.stage = body.stage;
      } else if (TASK_STAGES.some((s) => s.key === body.stage)) {
        // "Архив" — только админ/супервайзер подтверждают выполненный визит и переносят туда сами.
        if (STAFF_ONLY_STAGES.includes(body.stage) && !isStaff(req.user)) {
          return sendJson(res, 403, { error: 'Перевести задачу в архив может только администратор или супервайзер' });
        }
        patch.stage = body.stage;
      }
    }

    const finalStage = patch.stage !== undefined ? patch.stage : task.stage;
    const finalReport = patch.report !== undefined ? patch.report : task.report;
    const finalExplanation = patch.explanation !== undefined ? patch.explanation : task.explanation;

    // Нельзя перевести визитную задачу в "Выполнена" без заполненного отчёта.
    if (!isSale && finalStage === 'done' && !String(finalReport || '').trim()) {
      return sendJson(res, 400, { error: 'Заполните отчёт по задаче — без него нельзя перевести в «Выполнена»' });
    }

    // Задачу воронки продажи нельзя закрыть в "Сделка"/"Провал" без аудиозаписи
    // встречи и короткого пояснения — записи хранятся в карточке клиента
    // (раздел "Записи встреч"), привязка к конкретной задаче — по taskId.
    if (isSale && SALE_FINAL_STAGES.includes(finalStage) && task.stage !== finalStage) {
      if (!String(finalExplanation || '').trim()) {
        return sendJson(res, 400, { error: 'Добавьте короткое пояснение — без него нельзя закрыть в «Сделка»/«Провал»' });
      }
      const client = db.find('clients', task.clientId);
      const hasAudio = client && (client.meetingRecords || []).some((r) => r.taskId === task.id && r.audioUrl);
      if (!hasAudio) {
        return sendJson(res, 400, { error: 'Прикрепите аудиозапись встречи (раздел «Записи встреч» у клиента) — без неё нельзя закрыть в «Сделка»/«Провал»' });
      }
    }

    if (isStaff(req.user)) {
      if (body.assigneeId !== undefined) patch.assigneeId = Number(body.assigneeId);
      if (body.clientId !== undefined) patch.clientId = Number(body.clientId);
    }

    const wasDone = task.stage === 'done';
    const updated = db.update('tasks', params.id, patch);

    // При первом переводе в "Выполнена" — если у клиента есть день визита, сразу
    // планируем следующий визит на ближайшую подходящую дату (чтобы агент не забыл).
    // Защита от дублей: только если у клиента ещё нет другой активной задачи в будущем.
    if (finalStage === 'done' && !wasDone) {
      const client = db.find('clients', updated.clientId);
      if (client && client.visitDay) {
        const today = new Date().toISOString().slice(0, 10);
        const hasFutureActive = db.all('tasks').some((t) =>
          t.clientId === client.id && t.id !== updated.id && ACTIVE_STAGES.includes(t.stage) && t.dueDate > today
        );
        if (!hasFutureActive) {
          const nextDate = nextDateForWeekday(client.visitDay);
          if (nextDate) {
            db.insert('tasks', {
              clientId: client.id,
              taskType: 'visit',
              title: `Посетить: ${client.name}`,
              description: '',
              dueDate: nextDate,
              stage: 'in_progress',
              tags: [],
              comment: '',
              report: '',
              explanation: '',
              dateChangeRequest: null,
              attachments: [],
              assigneeId: updated.assigneeId,
              createdBy: req.user.id,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }
        }
      }
    }

    // Провал в воронке продажи — автоматически выгружаем строку в Google Таблицу
    // (для анализа ситуации), без блокировки ответа пользователю.
    if (isSale && finalStage === 'fail' && task.stage !== 'fail') {
      const client = db.find('clients', updated.clientId);
      const agent = db.find('users', updated.assigneeId);
      googleSheets.appendRow([
        new Date().toISOString(),
        client ? client.name : '',
        agent ? agent.name : '',
        updated.title,
        updated.explanation || '',
        updated.dueDate || ''
      ]).catch(() => {});
    }

    sendJson(res, 200, { task: updated });
  }));

  // ---- Заявка на перенос даты задачи (агент просит — админ/супервайзер решает) ----

  router.post('/api/tasks/:id/request-date-change', requireAuth(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && task.assigneeId !== req.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.requestedDate) return sendJson(res, 400, { error: 'Укажите желаемую дату' });
    const dateChangeRequest = {
      requestedDate: body.requestedDate,
      reason: body.reason || '',
      requestedBy: req.user.id,
      createdAt: new Date().toISOString()
    };
    sendJson(res, 200, { task: db.update('tasks', params.id, { dateChangeRequest, updatedAt: new Date().toISOString() }) });
  }));

  router.post('/api/tasks/:id/approve-date-change', requireStaff(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!task.dateChangeRequest) return sendJson(res, 400, { error: 'Нет заявки на перенос' });
    sendJson(res, 200, {
      task: db.update('tasks', params.id, {
        dueDate: task.dateChangeRequest.requestedDate,
        dateChangeRequest: null,
        updatedAt: new Date().toISOString()
      })
    });
  }));

  router.post('/api/tasks/:id/reject-date-change', requireStaff(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    sendJson(res, 200, { task: db.update('tasks', params.id, { dateChangeRequest: null, updatedAt: new Date().toISOString() }) });
  }));

  // ---- Записи встреч (аудио + пояснение), привязаны к клиенту и к конкретной задаче ----

  router.post('/api/tasks/:id/meeting-record', requireAuth(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
    if (!isStaff(req.user) && task.assigneeId !== req.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const client = db.find('clients', task.clientId);
    if (!client) return sendJson(res, 400, { error: 'Клиент не найден' });
    let parsed;
    try {
      parsed = await parseMultipart(req, 20 * 1024 * 1024);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const audioFile = parsed.files.find((f) => /^audio\//.test(f.mimeType));
    if (!audioFile) return sendJson(res, 400, { error: 'Нужен аудиофайл записи встречи' });
    const explanation = (parsed.fields && parsed.fields.explanation) || '';

    const meetingsDir = path.join(UPLOADS_DIR, 'meetings', String(client.id));
    fs.mkdirSync(meetingsDir, { recursive: true });
    const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${audioFile.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.writeFileSync(path.join(meetingsDir, storedName), audioFile.data);

    const record = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      taskId: task.id,
      explanation,
      audioUrl: `/uploads/meetings/${client.id}/${storedName}`,
      authorId: req.user.id,
      createdAt: new Date().toISOString()
    };
    const meetingRecords = [record, ...(client.meetingRecords || [])];
    db.update('clients', client.id, { meetingRecords });
    // Пояснение можно сохранить сразу и в самой задаче — удобно видеть в карточке без перехода к клиенту.
    if (explanation && !task.explanation) db.update('tasks', task.id, { explanation });
    sendJson(res, 201, { client: db.find('clients', client.id) });
  }));

  router.delete('/api/tasks/:id', requireStaff(async (req, res, params) => {
    const task = db.find('tasks', params.id);
    if (!task) return sendJson(res, 404, { error: 'Не найдено' });
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

  // ---- Встречи супервайзера с клиентом (отдельно от задач агентов) ----
  // Видны в календаре: агентам — чтобы видеть, какие дни у клиента уже заняты
  // визитом супервайзера; у самого супервайзера — отдельным разделом с
  // возможностью добавить/удалить. Не привязаны к воронке задач намеренно —
  // это просто бронь дня/времени, без этапов и отчётов.
  router.get('/api/supervisor-meetings', requireAuth(async (req, res) => {
    let meetings = db.all('supervisorMeetings');
    if (req.user.role === 'agent') {
      const myClientIds = new Set(db.all('clients').filter((c) => c.ownerId === req.user.id).map((c) => c.id));
      meetings = meetings.filter((m) => myClientIds.has(m.clientId));
    }
    sendJson(res, 200, { meetings });
  }));

  router.post('/api/supervisor-meetings', requireStaff(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body.clientId) return sendJson(res, 400, { error: 'Укажите клиента' });
    if (!body.date) return sendJson(res, 400, { error: 'Укажите дату встречи' });
    const client = db.find('clients', body.clientId);
    if (!client) return sendJson(res, 400, { error: 'Клиент не найден' });
    const meeting = db.insert('supervisorMeetings', {
      clientId: Number(body.clientId),
      date: body.date,
      time: body.time || '',
      note: body.note || '',
      createdBy: req.user.id,
      createdAt: new Date().toISOString()
    });
    sendJson(res, 201, { meeting });
  }));

  router.delete('/api/supervisor-meetings/:id', requireStaff(async (req, res, params) => {
    const meeting = db.find('supervisorMeetings', params.id);
    if (!meeting) return sendJson(res, 404, { error: 'Не найдено' });
    db.remove('supervisorMeetings', params.id);
    sendJson(res, 200, { ok: true });
  }));

  // Экспорт проваленных задач воронки продажи в CSV (работает уже сейчас, без
  // настройки Google Таблицы — можно скачать и залить на Диск вручную).
  router.get('/api/tasks/failed-export', requireStaff(async (req, res) => {
    const failed = db.all('tasks').filter((t) => t.taskType === 'sale' && t.stage === 'fail');
    const rows = [['Дата', 'Клиент', 'Агент', 'Задача', 'Пояснение', 'Срок']];
    failed.forEach((t) => {
      const client = db.find('clients', t.clientId);
      const agent = db.find('users', t.assigneeId);
      rows.push([t.updatedAt || t.createdAt, client ? client.name : '', agent ? agent.name : '', t.title, t.explanation || '', t.dueDate || '']);
    });
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const buf = Buffer.from('﻿' + csv, 'utf8'); // BOM — чтобы Excel корректно показал кириллицу
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="provaly-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Content-Length': buf.length
    });
    res.end(buf);
  }));

  // ---- Отчёты (супервайзер/администратор) ----

  // Ассортимент по агентам: товар/бренд/шт/выручка/кол-во клиентов, с фильтром по бренду.
  router.get('/api/reports/assortment-by-agent', requireStaff(async (req, res) => {
    const agents = db.all('users').filter((u) => u.role === 'agent');
    const clients = db.all('clients');
    const brandFilter = new URL(req.url, 'http://internal').searchParams.get('brand');

    const rows = [];
    agents.forEach((agent) => {
      const aClients = clients.filter((c) => c.ownerId === agent.id);
      const byProduct = {};
      aClients.forEach((c) => {
        [...(c.regularAssortment || []), ...(c.testAssortment || [])].forEach((it) => {
          if (brandFilter && brandFilter !== 'all' && it.brand !== brandFilter) return;
          if (brandFilter === 'colorants' && it.category !== 'Краситель' && it.category !== 'Оксид') return;
          const key = it.product;
          if (!byProduct[key]) byProduct[key] = { product: it.product, brand: it.brand, category: it.category, qty: 0, revenue: 0, clientIds: new Set() };
          byProduct[key].qty += it.avgQty || 0;
          byProduct[key].revenue += it.revenue || 0;
          byProduct[key].clientIds.add(c.id);
        });
      });
      Object.values(byProduct).forEach((row) => {
        rows.push({
          agentId: agent.id, agentName: agent.name,
          product: row.product, brand: row.brand, category: row.category,
          qty: Math.round(row.qty * 100) / 100, revenue: Math.round(row.revenue),
          clientsCount: row.clientIds.size
        });
      });
    });

    const brands = ['Kapous', 'EPICA', 'Чистовье', 'Палитра', 'Прочее'];
    sendJson(res, 200, { rows: rows.sort((a, b) => b.revenue - a.revenue), brands });
  }));

  // ---- Дашборд ----

  router.get('/api/stats', requireAuth(async (req, res) => {
    const clients = scoped(db.all('clients'), req.user, 'ownerId');
    const tasks = scoped(db.all('tasks'), req.user, 'assigneeId');
    const today = new Date().toISOString().slice(0, 10);
    const overdueTasks = tasks.filter((t) => isActiveStage(t) && t.dueDate && t.dueDate < today);
    const todayTasks = tasks.filter((t) => isActiveStage(t) && t.dueDate === today);
    const atRiskClients = clients.filter((c) => (c.regularAssortment || []).some((p) => p.atRisk));
    const pendingApproval = clients.filter((c) => c.pendingApproval).length;
    const totalDebt = clients.reduce((s, c) => s + (c.debtAmount || 0), 0);

    const byStage = TASK_STAGES.map((s) => ({
      key: s.key, label: s.label, count: tasks.filter((t) => t.taskType !== 'sale' && t.stage === s.key).length
    }));
    const byStageSale = SALE_STAGES.map((s) => ({
      key: s.key, label: s.label, count: tasks.filter((t) => t.taskType === 'sale' && t.stage === s.key).length
    }));

    const todayClientIds = new Set(todayTasks.map((t) => t.clientId));
    const todayClientsWithDebt = clients.filter((c) => todayClientIds.has(c.id) && c.debtAmount > 0);

    const payload = {
      clientsCount: clients.length,
      todayTasksCount: todayTasks.length,
      overdueTasksCount: overdueTasks.length,
      atRiskClientsCount: atRiskClients.length,
      pendingApprovalCount: pendingApproval,
      totalDebt,
      byStage,
      todayTasks,
      overdueTasks,
      todayClientsWithDebt
    };

    if (isStaff(req.user)) {
      const agents = db.all('users').filter((u) => u.role === 'agent');
      const allTasks = db.all('tasks');
      const allClients = db.all('clients');

      payload.byAgent = agents.map((agent) => {
        const aTasks = allTasks.filter((t) => t.assigneeId === agent.id);
        const done = aTasks.filter((t) => t.stage === 'done').length;
        const notDone = aTasks.filter((t) => t.stage === 'not_done').length;
        const closed = done + notDone;
        const agentDebt = allClients.filter((c) => c.ownerId === agent.id).reduce((s, c) => s + (c.debtAmount || 0), 0);
        return {
          agentId: agent.id,
          agentName: agent.name,
          totalTasks: aTasks.length,
          done,
          notDone,
          open: aTasks.filter(isActiveStage).length,
          completionRate: closed ? Math.round((done / closed) * 100) : null,
          totalDebt: agentDebt
        };
      });

      // Явный общий итог по всей команде — чтобы у супервайзера точно было видно
      // суммарное количество задач по сотрудникам, а не только разбивку по одному.
      payload.teamTotals = {
        totalTasks: allTasks.length,
        open: allTasks.filter(isActiveStage).length,
        done: allTasks.filter((t) => t.stage === 'done').length,
        notDone: allTasks.filter((t) => t.stage === 'not_done').length,
        archived: allTasks.filter((t) => t.stage === 'archive').length
      };
      payload.byStageSale = byStageSale;

      // Задачи на день по команде: сколько всего/выполнено/не выполнено сегодня у каждого агента.
      payload.teamTasksToday = agents.map((agent) => {
        const aToday = allTasks.filter((t) => t.assigneeId === agent.id && t.dueDate === today);
        return {
          agentId: agent.id,
          agentName: agent.name,
          total: aToday.length,
          done: aToday.filter((t) => t.stage === 'done' || t.stage === 'deal').length,
          notDone: aToday.filter((t) => t.stage === 'not_done' || t.stage === 'fail').length
        };
      });

      payload.pendingClosureCount = allClients.filter((c) => c.closureRequested).length;
      payload.newMastersCount = allClients.reduce((s, c) => s + (c.masters || []).filter((m) => m.isNew).length, 0);

      // Рейтинг клиентов: выручка/маржа/активные месяцы — считается из тех же файлов
      // продаж (поля revenue/margin у позиций ассортимента, см. build_test_assortment.py
      // и обновлённый aggregate.py). Если данные ещё не пересчитаны — просто будут нули.
      payload.clientRating = allClients
        .map((c) => {
          const items = [...(c.regularAssortment || []), ...(c.testAssortment || [])];
          const revenue = items.reduce((s, it) => s + (it.revenue || 0), 0);
          const margin = items.reduce((s, it) => s + (it.margin || 0), 0);
          const activeMonths = items.reduce((mx, it) => Math.max(mx, it.monthsCount || 0), 0);
          const owner = agents.find((a) => a.id === c.ownerId);
          return {
            clientId: c.id, clientName: c.name, agentName: owner ? owner.name : '',
            revenue, margin, marginPct: revenue ? Math.round((margin / revenue) * 100) : 0, activeMonths
          };
        })
        .filter((r) => r.revenue > 0)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 50);

      // Клиенты, у которых день визита выпадает на текущую неделю, но задачи на неё пока нет.
      const now = new Date();
      const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0);
      const dow = (weekStart.getDay() + 6) % 7; // 0=понедельник
      weekStart.setDate(weekStart.getDate() - dow);
      const weekDates = [];
      for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); weekDates.push(d.toISOString().slice(0, 10)); }
      const weekIdxByDay = {};
      VISIT_DAYS.forEach((name) => {
        const idx = VISIT_DAY_INDEX[name] - 1; // 0=понедельник ... 5=суббота
        weekIdxByDay[name] = weekDates[idx];
      });
      payload.noTaskThisWeek = allClients.filter((c) => {
        if (c.closed || !c.visitDay || !weekIdxByDay[c.visitDay]) return false;
        const dateForThisWeek = weekIdxByDay[c.visitDay];
        return !allTasks.some((t) => t.clientId === c.id && t.dueDate === dateForThisWeek);
      });
    }

    // Метрики для отдельного дашборда агента (продажи, клиенты, топ-товары, встречи/звонки).
    if (req.user.role === 'agent') {
      const items = clients.flatMap((c) => [...(c.regularAssortment || []), ...(c.testAssortment || [])]);
      const salesTotal = items.reduce((s, it) => s + (it.revenue || 0), 0);
      const clientsWithSales = clients.filter((c) => [...(c.regularAssortment || []), ...(c.testAssortment || [])].some((it) => (it.revenue || 0) > 0)).length;

      const byProduct = {};
      items.forEach((it) => {
        if (!it.product) return;
        if (!byProduct[it.product]) byProduct[it.product] = { product: it.product, qty: 0, revenue: 0 };
        byProduct[it.product].qty += it.avgQty || 0;
        byProduct[it.product].revenue += it.revenue || 0;
      });
      const topProducts = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

      const myTasksAll = db.all('tasks').filter((t) => t.assigneeId === req.user.id);
      const saleTasksToday = myTasksAll.filter((t) => t.taskType === 'sale' && t.dueDate === today);

      payload.agentDashboard = {
        salesTotal,
        clientsWithSales,
        topProducts,
        callsToday: saleTasksToday.filter((t) => t.stage === 'call').length,
        meetingsToday: saleTasksToday.filter((t) => t.stage === 'meeting').length,
        doneTasksToday: tasks.filter((t) => t.dueDate === today && (t.stage === 'done' || t.stage === 'deal')).length,
        overdueTasksCount: overdueTasks.length
      };
    }

    sendJson(res, 200, payload);
  }));
}

module.exports = { register, migrateLegacyTaskStages, migrateClientDefaults, TASK_STAGES, TASK_TAGS, PAYMENT_METHODS, CONTRACT_STATUSES, sendJson, UPLOADS_DIR };
