const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'crm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = val;
  });
  return out;
}

function createSessionForUser(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.createSession(token, userId, Date.now() + SESSION_TTL_MS);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toUTCString();
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Expires=${expires}; SameSite=Lax`
  );
  return token;
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

function currentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  const user = db.find('users', session.userId);
  if (!user) return null;
  return user;
}

function logout(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) db.deleteSession(token);
  clearSessionCookie(res);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSessionForUser,
  clearSessionCookie,
  currentUser,
  logout
};
