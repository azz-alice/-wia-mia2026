const { assertSameOrigin, sendJson, setSessionCookie } = require('../../lib/admin');

module.exports = function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  try {
    assertSameOrigin(req);
    setSessionCookie(res, '', 0);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 403, { ok: false, message: error.message });
  }
};
