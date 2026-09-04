// Минимальный ридер табличных файлов (.xlsx / .csv) без внешних библиотек —
// нужен для загрузки долгов/остатков прямо через панель (Фаза 19, см.
// crm-mvp-status.md), чтобы не требовать пересборки zip-архива на каждое
// обновление этих двух источников. В духе остального проекта (свой ZIP-writer
// в miniZip.js, свой multipart-парсер) — здесь свой ZIP-reader (через
// встроенный zlib.inflateRawSync, без сторонних пакетов) и упрощённый
// SpreadsheetML-парсер (регулярные выражения по XML, без полноценного
// XML-парсера — формат листа Excel достаточно просто устроен для этого).
//
// Поддерживается только ПЕРВЫЙ лист книги — для наших файлов (долги/остатки,
// один плоский список) этого достаточно; лист выбирается по первому
// найденному в архиве "xl/worksheets/sheetN.xml" с наименьшим N.

const zlib = require('zlib');

function parseTableFile(filename, buffer) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(buffer);
  if (lower.endsWith('.xlsx')) return parseXlsx(buffer);
  // Определяем по содержимому, если расширение не помогло/отсутствует:
  // .xlsx — это ZIP-архив, начинается с сигнатуры "PK".
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return parseXlsx(buffer);
  return parseCsv(buffer);
}

// ---------------------------------------------------------------- CSV ----

function parseCsv(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM

  // Определяем разделитель по первой непустой строке — в российских выгрузках
  // Excel часто используется ";" вместо ",".
  const firstLine = (text.split(/\r\n|\r|\n/).find((l) => l.trim()) || '');
  const delimiter = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c || '').toString().trim() !== ''));
}

// ---------------------------------------------------------------- XLSX ----

function parseXlsx(buffer) {
  const entries = readZipCentralDirectory(buffer);

  const sheetEntry = pickFirstSheetEntry(entries);
  if (!sheetEntry) throw new Error('В файле не найден лист (xl/worksheets/sheetN.xml) — это точно .xlsx?');
  const sheetXml = readZipEntry(buffer, entries, sheetEntry.name).toString('utf8');

  const sharedStringsEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const sharedStrings = sharedStringsEntry
    ? parseSharedStrings(readZipEntry(buffer, entries, sharedStringsEntry.name).toString('utf8'))
    : [];

  return parseSheetXml(sheetXml, sharedStrings);
}

function pickFirstSheetEntry(entries) {
  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .map((e) => ({ e, n: parseInt(/sheet(\d+)\.xml$/i.exec(e.name)[1], 10) }))
    .sort((a, b) => a.n - b.n);
  return sheetEntries.length ? sheetEntries[0].e : null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const block = m[1];
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(block))) text += tm[1];
    out.push(decodeXmlEntities(text));
  }
  return out;
}

// "A1" -> 0, "B1" -> 1, "AA1" -> 26 ...
function colRefToIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref || '');
  if (!letters) return 0;
  const s = letters[1].toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowXml = rm[1];
    const cells = [];
    const cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refMatch = /r="([A-Z]+\d+)"/i.exec(attrs);
      const idx = refMatch ? colRefToIndex(refMatch[1]) : cells.length;
      const typeMatch = /t="([^"]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : null;

      let value = '';
      if (type === 'inlineStr') {
        const isMatch = /<is>([\s\S]*?)<\/is>/.exec(inner);
        if (isMatch) {
          let text = '';
          const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
          let tm;
          while ((tm = tRe.exec(isMatch[1]))) text += tm[1];
          value = decodeXmlEntities(text);
        }
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vMatch ? decodeXmlEntities(vMatch[1]) : '';
        if (type === 's') {
          const si = sharedStrings[parseInt(raw, 10)];
          value = si !== undefined ? si : '';
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else {
          value = raw; // число или строка формулы (str) — как есть
        }
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((c) => (c || '').toString().trim() !== ''));
}

// ---------------------------------------------------------- ZIP reader ----

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readZipCentralDirectory(buffer) {
  // Ищем End Of Central Directory с конца файла (комментарий архива может
  // сдвигать его от самого конца, но у сгенерированных Excel-ом файлов
  // комментария обычно нет — на всякий случай сканируем последние 64KB+22).
  const searchStart = Math.max(0, buffer.length - 66000);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Не найден конец ZIP-архива (EOCD) — файл повреждён или это не .xlsx');

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIG) break;
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buffer, entries, name) {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`В архиве нет файла ${name}`);
  const off = entry.localHeaderOffset;
  if (buffer.readUInt32LE(off) !== LOCAL_SIG) throw new Error('Повреждённый локальный заголовок ZIP');
  const nameLen = buffer.readUInt16LE(off + 26);
  const extraLen = buffer.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const raw = buffer.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return raw; // stored, без сжатия
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`Неподдерживаемый метод сжатия в ZIP: ${entry.compressionMethod}`);
}

module.exports = { parseTableFile, parseCsv, parseXlsx };
