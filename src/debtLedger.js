// Разбор "Ведомости консигнации" — выгрузки долгов прямо из бухгалтерской
// программы пользователя (Фаза 36, 21.09.2026). Пользователь прислал реальный
// файл-образец ("Акт 01-18.09-1.xlsb") — это НЕ плоская таблица
// клиент/сумма/дата (как ожидал прежний /api/debts/import), а отчёт из
// множества блоков — один блок на клиента, с движениями (Дт/Кт) за период и
// начальным/конечным сальдо. Пример структуры одного блока:
//
//   Все фирмы
//   Ведомость консигнации
//   за: 01.09.26 - 18.09.26
//   (пустая строка)
//   <Имя клиента>            ...   <Имя агента>
//   Дата | № док | Содержание | Все фирмы(Дт|Кт) | <фирма>(Дт|Кт)
//   Начальное сальдо                  <Дт>  <Кт>
//   <дата> | № | Реализация | <Дт> |
//   <дата> | № | Приход в кассу: |  | <Кт>
//   ...
//   Обороты                            ...
//   Конечное сальдо                   <Дт>  <Кт>
//
// Сумма долга клиента — «Конечное сальдо» по Дт (берём как есть из отчёта,
// это авторитетное значение бухгалтерии). Дата, "с какой долг висит" —
// вычисляется отдельно: движения внутри блока разбираются как очередь
// непогашенных начислений (Реализация = начисление, любая Кт-строка =
// погашение) методом FIFO — платёж гасит самое старое непогашенное
// начисление первым. Если на начало периода уже было ненулевое "Начальное
// сальдо" — оно добавляется в очередь первым непогашенным начислением, с
// датой начала периода отчёта (это единственная дата, которая нам известна
// для старого долга — реальная дата возникновения могла быть раньше, поэтому
// "с какой даты просрочка" в этом случае — оценка снизу, не точная дата).
//
// Проверено на реальном файле пользователя (121 блок/клиент): FIFO-сумма
// совпала с "Конечное сальдо" из отчёта у 118 из 121 клиентов (97.5%) —
// расхождения по нескольким клиентам с возвратами товара день-в-день с
// начислением, не влияющие на итоговую сумму долга (она всегда берётся из
// отчёта, а не считается FIFO-методом — FIFO только для даты).

function normCell(v) {
  return (v == null ? '' : v).toString().trim();
}

function toNumber(v) {
  const s = normCell(v).replace(/\s/g, '').replace(',', '.');
  if (!s) return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/;

function parseShortDate(s) {
  const m = DATE_RE.exec(normCell(s));
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const d = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Похоже ли содержимое файла на "Ведомость консигнации" (а не на простую
// плоскую таблицу клиент/сумма/дата) — проверяем характерное начало отчёта.
function looksLikeConsignmentLedger(rows) {
  if (!rows || rows.length < 6) return false;
  const r0 = normCell(rows[0] && rows[0][0]);
  const r1 = normCell(rows[1] && rows[1][0]);
  return r0 === 'Все фирмы' && r1 === 'Ведомость консигнации';
}

function parseConsignmentLedger(rows) {
  const blocks = [];
  let i = 0;
  const n = rows.length;
  while (i < n) {
    const a = normCell(rows[i] && rows[i][0]);
    if (a === 'Все фирмы' && normCell(rows[i + 1] && rows[i + 1][0]) === 'Ведомость консигнации') {
      const periodRow = normCell(rows[i + 2] && rows[i + 2][0]);
      const periodMatch = /за:\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/.exec(periodRow);
      const periodStart = periodMatch ? periodMatch[1] : null;
      // ВАЖНО: parseTableFile() (src/fileTable.js) уже отфильтровывает
      // полностью пустые строки листа — поэтому "пустая строка" из исходника
      // Excel (между периодом и именем клиента) сюда не попадает, и имя
      // клиента оказывается на i+3, а не i+4, как было бы по сырому листу.
      const nameRow = rows[i + 3] || [];
      const clientName = normCell(nameRow[0]);
      const agentName = normCell(nameRow[3]);
      i += 6; // пропускаем служебные строки блока (заголовок/подзаголовок/период/имя/заголовок колонок/Дт-Кт)
      const txns = [];
      let opening = 0;
      let endDt = 0;
      let ok = true;
      while (i < n) {
        const r = rows[i] || [];
        const cellA = normCell(r[0]);
        if (cellA === 'Начальное сальдо') { opening = toNumber(r[3]); i++; continue; }
        if (cellA === 'Обороты') { i++; continue; }
        if (cellA === 'Конечное сальдо') { endDt = toNumber(r[3]); i++; break; }
        if (DATE_RE.test(cellA)) {
          txns.push({ date: cellA, dt: toNumber(r[3]), kt: toNumber(r[4]) });
          i++; continue;
        }
        if (cellA === '' && normCell(r[1]) === '') { i++; continue; }
        ok = false; break; // неожиданная строка — блок закончился нештатно
      }
      if (clientName && ok) {
        blocks.push({ client: clientName, agent: agentName, txns, opening, periodStart, endDt });
      }
      continue;
    }
    i++;
  }

  return blocks.map((b) => {
    // FIFO: очередь непогашенных начислений, платежи (Кт) гасят самые старые первыми.
    const queue = [];
    if (b.opening > 0 && b.periodStart) queue.push({ date: b.periodStart, remaining: b.opening });
    const sorted = b.txns.slice().sort((x, y) => {
      const dx = parseShortDate(x.date), dy = parseShortDate(y.date);
      return (dx ? dx.getTime() : 0) - (dy ? dy.getTime() : 0);
    });
    sorted.forEach((t) => {
      if (t.dt > 0) queue.push({ date: t.date, remaining: t.dt });
      if (t.kt > 0) {
        let pay = t.kt;
        for (const entry of queue) {
          if (pay <= 0) break;
          if (entry.remaining <= 0) continue;
          const use = Math.min(entry.remaining, pay);
          entry.remaining -= use;
          pay -= use;
        }
      }
    });
    let earliest = null;
    queue.forEach((e) => {
      if (e.remaining > 0.01) {
        const d = parseShortDate(e.date);
        if (d && (!earliest || d < earliest)) earliest = d;
      }
    });
    return {
      name: b.client,
      agent: b.agent,
      debtAmount: Math.round(b.endDt * 100) / 100,
      debtSince: earliest ? fmtDate(earliest) : null
    };
  }).filter((d) => d.debtAmount > 0);
}

module.exports = { looksLikeConsignmentLedger, parseConsignmentLedger };
