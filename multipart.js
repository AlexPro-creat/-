// Минимальный парсер multipart/form-data без внешних зависимостей.
// Нужен только для загрузки вложений (скриншоты/аудио) к задачам.

function parseMultipart(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!match) return reject(new Error('Ожидался multipart/form-data с boundary'));
    const boundary = '--' + (match[1] || match[2]).trim();

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Файл слишком большой'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        resolve(parseBuffer(buffer, boundary));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseBuffer(buffer, boundary) {
  const boundaryBuf = Buffer.from(boundary);
  const parts = splitBuffer(buffer, boundaryBuf);

  const fields = {};
  const files = [];

  for (const part of parts) {
    if (!part.length) continue;
    // Убираем ведущие \r\n после boundary и завершающие \r\n перед следующим boundary
    let body = part;
    if (body.slice(0, 2).toString() === '\r\n') body = body.slice(2);
    const headerEnd = body.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = body.slice(0, headerEnd).toString('utf8');
    let content = body.slice(headerEnd + 4);
    if (content.slice(-2).toString() === '\r\n') content = content.slice(0, -2);

    const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
    const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
    const fieldName = nameMatch ? nameMatch[1] : '';

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        fieldName,
        filename: filenameMatch[1],
        mimeType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: content
      });
    } else if (fieldName) {
      fields[fieldName] = content.toString('utf8');
    }
  }

  return { fields, files };
}

// Разбивает буфер на части по boundary (бинарно-безопасно, без regex по бинарным данным)
function splitBuffer(buffer, boundaryBuf) {
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return parts;
  start += boundaryBuf.length;
  while (true) {
    const next = buffer.indexOf(boundaryBuf, start);
    if (next === -1) break;
    let piece = buffer.slice(start, next);
    // Отрезаем завершающие "--\r\n" или "\r\n" перед boundary
    if (piece.slice(-2).toString() === '--') piece = piece.slice(0, -2);
    parts.push(piece);
    start = next + boundaryBuf.length;
    // Конец: boundary с последующим "--"
    if (buffer.slice(start, start + 2).toString() === '--') break;
  }
  return parts;
}

module.exports = { parseMultipart };
