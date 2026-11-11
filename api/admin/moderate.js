const {
  assertSameOrigin,
  readJsonBody,
  requireEnv,
  requireSession,
  sendJson,
  supabaseHeaders,
  supabaseUrl
} = require('../../lib/admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  const session = requireSession(req, res);
  if (!session) return;
  try {
    assertSameOrigin(req);
    requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    const body = await readJsonBody(req);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.report_id || ''))) {
      return sendJson(res, 400, { ok: false, message: 'ID laporan tidak valid.' });
    }
    if (!['approved', 'rejected', 'valid'].includes(body.moderation_status)) {
      return sendJson(res, 400, { ok: false, message: 'Status moderasi tidak valid.' });
    }
    const response = await fetch(supabaseUrl('rpc/moderate_community_report_admin'), {
      method: 'POST',
      headers: supabaseHeaders('return=representation'),
      body: JSON.stringify({
        p_report_id: body.report_id,
        p_new_status: body.moderation_status,
        p_note: body.moderation_note || null,
        p_admin_email: session.email
      })
    });
    const result = await response.json();
    if (!response.ok) {
      return sendJson(res, response.status === 404 ? 404 : 400, {
        ok: false,
        message: result.message || result.details || result.hint || 'Status laporan gagal diperbarui.'
      });
    }
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, error.message === 'Permintaan lintas situs ditolak.' ? 403 : 500, {
      ok: false,
      message: error.message || 'Status laporan gagal diperbarui.'
    });
  }
};
