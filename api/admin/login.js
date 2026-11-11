const {
  assertSameOrigin,
  makeSession,
  readJsonBody,
  safeEqual,
  sendJson,
  setSessionCookie,
  SESSION_SECONDS
} = require('../../lib/admin');

const DEMO_ADMIN_EMAIL = 'admin@gmail.com';
const DEMO_ADMIN_PASSWORD = 'SemangatKompak2026!';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  try {
    assertSameOrigin(req);
    const body = await readJsonBody(req);
    const emailMatches = safeEqual(String(body.email || '').trim().toLowerCase(), DEMO_ADMIN_EMAIL);
    const passwordMatches = safeEqual(body.password || '', DEMO_ADMIN_PASSWORD);
    if (!emailMatches || !passwordMatches) {
      return sendJson(res, 401, { ok: false, message: 'Email atau kata sandi admin salah.' });
    }
    setSessionCookie(res, makeSession(DEMO_ADMIN_EMAIL), SESSION_SECONDS);
    return sendJson(res, 200, { ok: true, email: DEMO_ADMIN_EMAIL });
  } catch (error) {
    return sendJson(res, error.message === 'Permintaan lintas situs ditolak.' ? 403 : 500, {
      ok: false,
      message: error.message || 'Login gagal karena kesalahan server.'
    });
  }
};
