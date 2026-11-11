const {
  requireEnv,
  requireSession,
  sendJson,
  supabaseHeaders,
  supabaseUrl
} = require('../../lib/admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, message: 'Metode tidak diizinkan.' });
  if (!requireSession(req, res)) return;
  try {
    requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    const url = new URL(req.url, `https://${req.headers.host}`);
    const reportQuery = new URLSearchParams({
      select: '*,community_report_groups(*)',
      order: 'created_at_utc.desc',
      limit: '100'
    });
    const groupQuery = new URLSearchParams({
      select: '*',
      valid_report_count: 'gt.0',
      order: 'priority_tier.desc,valid_report_count.desc,first_report_at_utc.asc'
    });
    ['category', 'province_pum_code', 'regency_pum_code'].forEach(key => {
      const value = url.searchParams.get(key);
      if (value && value !== 'all') reportQuery.set(key, `eq.${value}`);
    });
    const status = url.searchParams.get('moderation_status');
    if (status && status !== 'all') reportQuery.set('moderation_status', `eq.${status}`);

    const [reportsRes, groupsRes] = await Promise.all([
      fetch(supabaseUrl(`community_reports?${reportQuery}`), { headers: supabaseHeaders() }),
      fetch(supabaseUrl(`community_report_groups?${groupQuery}`), { headers: supabaseHeaders() })
    ]);
    const [reports, groups] = await Promise.all([reportsRes.json(), groupsRes.json()]);
    if (!reportsRes.ok || !groupsRes.ok) {
      const details = !reportsRes.ok ? reports : groups;
      return sendJson(res, 502, { ok: false, message: details.message || details.error || 'Gagal memuat data moderasi.' });
    }
    return sendJson(res, 200, { ok: true, reports, groups });
  } catch (error) {
    return sendJson(res, 500, { ok: false, message: error.message || 'Gagal memuat data moderasi.' });
  }
};
