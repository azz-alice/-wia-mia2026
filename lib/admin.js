const crypto = require('node:crypto');

const COOKIE_NAME = 'wia_admin_session';
const SESSION_SECONDS = 8 * 60 * 60;

function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
  res.end(JSON.stringify(body));
}

function requireEnv(names) {
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Konfigurasi server belum lengkap: ${missing.join(', ')}`);
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || new URL(origin).host !== String(host).split(',')[0].trim()) {
    throw new Error('Permintaan lintas situs ditolak.');
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(value).digest('base64url');
}

function makeSession(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([key]) => key));
}

function getSession(req) {
  const token = readCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Math.floor(Date.now() / 1000) && typeof session.email === 'string'
      ? session
      : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { ok: false, message: 'Sesi admin tidak valid atau sudah berakhir. Silakan login lagi.' });
    return null;
  }
  return session;
}

function supabaseHeaders(prefer) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
}

function supabaseUrl(path) {
  return `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  assertSameOrigin,
  getSession,
  makeSession,
  readJsonBody,
  requireEnv,
  requireSession,
  safeEqual,
  sendJson,
  setSessionCookie,
  supabaseHeaders,
  supabaseUrl
};
