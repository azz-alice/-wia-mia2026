const {
  assertSameOrigin,
  makeSession,
  readJsonBody,
  requireEnv,
  safeEqual,
  sendJson,
  setSessionCookie,
  SESSION_SECONDS
} = require('../../lib/admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  try {
    assertSameOrigin(req);
    requireEnv(['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']);
    if (Buffer.byteLength(process.env.ADMIN_SESSION_SECRET, 'utf8') < 32) {
      throw new Error('ADMIN_SESSION_SECRET harus berisi minimal 32 byte.');
    }
    const body = await readJsonBody(req);
    const emailMatches = safeEqual(body.email || '', process.env.ADMIN_EMAIL);
    const passwordMatches = safeEqual(body.password || '', process.env.ADMIN_PASSWORD);
    if (!emailMatches || !passwordMatches) {
      return sendJson(res, 401, { ok: false, message: 'Email atau kata sandi admin salah.' });
    }
    setSessionCookie(res, makeSession(process.env.ADMIN_EMAIL), SESSION_SECONDS);
    return sendJson(res, 200, { ok: true, email: process.env.ADMIN_EMAIL });
  } catch (error) {
    return sendJson(res, error.message === 'Permintaan lintas situs ditolak.' ? 403 : 500, {
      ok: false,
      message: error.message || 'Login gagal karena kesalahan server.'
    });
  }
};
