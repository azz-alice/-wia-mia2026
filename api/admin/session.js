const { getSession, sendJson } = require('../../lib/admin');

module.exports = function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { ok: false, message: 'Belum login.' });
  return sendJson(res, 200, { ok: true, email: session.email });
};
