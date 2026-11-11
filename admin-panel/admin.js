(function() {
  'use strict';

  var WILAYAH_JSON_URL = '../laporan/data/wilayah-indonesia.json';

  var state = {
    provinces: [],
    regenciesByProv: {},
    moderatorEmail: '',
    reports: [],
    groups: [],
    filters: {
      category: 'all',
      province_pum_code: 'all',
      regency_pum_code: 'all',
      moderation_status: 'all'
    }
  };

  function getApiEndpoint() {
    return '/api/admin/reports';
  }

  function buildAuthHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTimeId(isoStr) {
    if (!isoStr) return '-';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return String(isoStr);
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' WIB';
  }

  function populateProvinceDropdown() {
    var selectEl = document.getElementById('admin-filter-province');
    if (!selectEl) return;
    var html = '<option value="all">Semua Provinsi</option>';
    for (var i = 0; i < state.provinces.length; i++) {
      var p = state.provinces[i];
      html += '<option value="' + escapeHtml(p.province_pum_code) + '">' + escapeHtml(p.province_name) + '</option>';
    }
    selectEl.innerHTML = html;
  }

  function populateRegencyDropdown(provinceCode) {
    var selectEl = document.getElementById('admin-filter-regency');
    if (!selectEl) return;
    var regencies = state.regenciesByProv[provinceCode] || [];
    if (!provinceCode || provinceCode === 'all' || !regencies.length) {
      selectEl.innerHTML = '<option value="all">Semua Kabupaten/Kota</option>';
      selectEl.value = 'all';
      selectEl.disabled = true;
      return;
    }
    var html = '<option value="all">Semua Kabupaten/Kota</option>';
    for (var i = 0; i < regencies.length; i++) {
      var r = regencies[i];
      html += '<option value="' + escapeHtml(r.regency_pum_code) + '">' + escapeHtml(r.display_name) + ' (' + escapeHtml(r.regency_pum_code) + ')</option>';
    }
    selectEl.innerHTML = html;
    selectEl.value = 'all';
    selectEl.disabled = false;
  }

  function loadWilayah() {
    return fetch(WILAYAH_JSON_URL, { cache: 'no-cache' })
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        if (!data || !Array.isArray(data.provinces)) return;
        state.provinces = data.provinces;
        state.regenciesByProv = {};
        var regList = Array.isArray(data.regencies) ? data.regencies : [];
        for (var i = 0; i < regList.length; i++) {
          var r = regList[i];
          var pCode = r.province_pum_code;
          if (!state.regenciesByProv[pCode]) state.regenciesByProv[pCode] = [];
          state.regenciesByProv[pCode].push(r);
        }
        populateProvinceDropdown();
      })
      .catch(function() {});
  }

  function showDashboardView() {
    var loginSec = document.getElementById('admin-login-section');
    var dashSec = document.getElementById('admin-dashboard-section');
    var modLabel = document.getElementById('admin-moderator-label');
    if (loginSec) loginSec.hidden = true;
    if (dashSec) dashSec.hidden = false;
    if (modLabel) modLabel.textContent = 'Moderator: ' + (state.moderatorEmail || 'Terautentikasi');
  }

  function showLoginView() {
    var loginSec = document.getElementById('admin-login-section');
    var dashSec = document.getElementById('admin-dashboard-section');
    if (loginSec) loginSec.hidden = false;
    if (dashSec) dashSec.hidden = true;
  }

  function loadAdminReports() {
    return fetch(getApiEndpoint(), {
      method: 'GET',
      headers: buildAuthHeaders(),
      cache: 'no-store'
    })
      .then(function(res) {
        return res.json().then(function(body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function(result) {
        if (!result.ok) {
          if (result.status === 401) showLoginView();
          var loginError = document.getElementById('admin-login-error');
          if (loginError) {
            loginError.textContent = result.body && result.body.message
              ? result.body.message
              : 'Gagal memuat panel moderasi. Periksa akun moderator dan koneksi Supabase.';
            loginError.hidden = false;
          }
          return;
        }
        state.reports = Array.isArray(result.body.reports) ? result.body.reports : [];
        if (Array.isArray(result.body.groups)) {
          state.groups = result.body.groups;
        } else {
          var groupsByKey = new Map();
          state.reports.forEach(function(report) {
            var group = report.community_report_groups;
            if (Array.isArray(group)) group = group[0];
            if (group && group.group_key) groupsByKey.set(group.group_key, group);
          });
          state.groups = Array.from(groupsByKey.values());
        }
        showDashboardView();
        renderAdminStats();
        renderAdminTable();
      })
      .catch(function(err) {
        showLoginView();
        var loginError = document.getElementById('admin-login-error');
        if (loginError) {
          loginError.textContent = err && err.message
            ? 'Tidak dapat memuat panel moderasi: ' + err.message
            : 'Tidak dapat terhubung ke Supabase. Periksa koneksi lalu coba lagi.';
          loginError.hidden = false;
        }
      });
  }

  function renderAdminStats() {
    var validCount = 0;
    var rejectedCount = 0;
    for (var i = 0; i < state.reports.length; i++) {
      if (state.reports[i].moderation_status === 'rejected') {
        rejectedCount++;
      } else {
        validCount++;
      }
    }
    var queueGroups = 0;
    var promotedGroups = 0;
    for (var j = 0; j < state.groups.length; j++) {
      var g = state.groups[j];
      var c = Number(g.valid_report_count || 0);
      if (c >= 5 || g.queue_status === 'promoted_supplementary') {
        promotedGroups++;
      } else if (c >= 1) {
        queueGroups++;
      }
    }
    var elValid = document.getElementById('admin-stat-valid');
    var elRej = document.getElementById('admin-stat-rejected');
    var elQueue = document.getElementById('admin-stat-queue-groups');
    var elProm = document.getElementById('admin-stat-promoted-groups');
    if (elValid) elValid.textContent = String(validCount);
    if (elRej) elRej.textContent = String(rejectedCount);
    if (elQueue) elQueue.textContent = String(queueGroups);
    if (elProm) elProm.textContent = String(promotedGroups);
  }

  function getGroupForReport(report) {
    for (var i = 0; i < state.groups.length; i++) {
      var g = state.groups[i];
      if (g.id === report.group_id || g.group_key === report.group_key) {
        return g;
      }
    }
    return null;
  }

  function formatGroupStatusBadge(group) {
    if (!group) {
      return '<span class="badge-pill">0 Laporan Valid</span>';
    }
    var count = Number(group.valid_report_count || 0);
    var approvedCount = Number(group.approved_report_count || 0);
    var eligibleCount = group.eligible_report_count != null
      ? Number(group.eligible_report_count)
      : (count >= 5 ? count : approvedCount);
    if (count >= 5 || group.queue_status === 'promoted_supplementary') {
      return '<span class="badge-pill is-promoted">Data Tambahan (' + count + ' Laporan · Dihitung di Peta)</span>';
    }
    if (eligibleCount > 0) {
      return '<span class="badge-pill is-promoted">Terverifikasi Moderator (' + eligibleCount + ' Dihitung di Peta · ' + count + ' Valid)</span>';
    }
    if (count >= 3) {
      return '<span class="badge-pill is-priority-high">Prioritas Tinggi (' + count + ' Laporan Valid)</span>';
    }
    if (count === 2) {
      return '<span class="badge-pill is-priority-elevated">Prioritas Meningkat (2 Laporan Valid)</span>';
    }
    if (count === 1) {
      return '<span class="badge-pill">Antrean (1 Laporan Valid)</span>';
    }
    return '<span class="badge-pill">Tidak Aktif (0 Laporan Valid)</span>';
  }

  function formatModerationStatusBadge(status) {
    if (status === 'approved') {
      return '<span class="mod-pill is-approved">Disetujui</span>';
    }
    if (status === 'rejected') {
      return '<span class="mod-pill is-rejected">Ditolak</span>';
    }
    return '<span class="mod-pill is-valid">Valid (Aktif)</span>';
  }

  function matchesAdminFilter(report) {
    var f = state.filters;
    if (f.category !== 'all' && report.category !== f.category) return false;
    if (f.province_pum_code !== 'all' && report.province_pum_code !== f.province_pum_code) return false;
    if (f.regency_pum_code !== 'all' && report.regency_pum_code !== f.regency_pum_code) return false;
    if (f.moderation_status !== 'all' && report.moderation_status !== f.moderation_status) return false;
    return true;
  }

  function renderAdminTable() {
    var tbody = document.getElementById('admin-reports-tbody');
    if (!tbody) return;

    var filtered = [];
    for (var i = 0; i < state.reports.length; i++) {
      if (matchesAdminFilter(state.reports[i])) {
        filtered.push(state.reports[i]);
      }
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7">Tidak ada laporan yang sesuai dengan filter moderasi saat ini.</td></tr>';
      return;
    }

    var html = '';
    for (var j = 0; j < filtered.length; j++) {
      var r = filtered[j];
      var reportId = r.id || r.report_id;
      var grp = getGroupForReport(r);
      var catBadge = r.category === 'karhutla'
        ? '<span class="badge-pill is-karhutla">Karhutla</span>'
        : '<span class="badge-pill is-air">Kualitas Udara</span>';

      var detailHtml = '';
      if (r.category === 'karhutla') {
        detailHtml =
          '<div><strong>Waktu Pengamatan:</strong> ' + escapeHtml(formatDateTimeId(r.observed_at_utc)) + '</div>' +
          '<div style="margin-top:4px;">' + escapeHtml(r.description || '-') + '</div>';
      } else {
        detailHtml =
          '<div><strong>Penurunan Kualitas Udara:</strong> ' + escapeHtml(r.air_decline_pct) + '%</div>' +
          '<div style="margin-top:4px;"><strong>Durasi Dirasakan:</strong> ' + escapeHtml(r.air_duration_days) + ' hari</div>';
      }

      var approveDisabled = r.moderation_status === 'approved' ? ' disabled' : '';
      var rejectDisabled = r.moderation_status === 'rejected' ? ' disabled' : '';

      html +=
        '<tr data-report-id="' + escapeHtml(reportId) + '">' +
          '<td>' +
            '<div class="row-code">' + escapeHtml(r.report_code) + '</div>' +
            '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + escapeHtml(formatDateTimeId(r.created_at_utc)) + '</div>' +
          '</td>' +
          '<td>' +
            '<strong>' + escapeHtml(r.regency_name) + '</strong>' +
            '<div style="font-size:12px;color:var(--text-soft);">' + escapeHtml(r.province_name) + ' (' + escapeHtml(r.regency_pum_code) + ')</div>' +
            '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Pelapor (Internal): ' + escapeHtml(r.reporter_name || 'Anonim') + '</div>' +
          '</td>' +
          '<td>' + catBadge + '</td>' +
          '<td>' + detailHtml + '</td>' +
          '<td>' + formatGroupStatusBadge(grp) + '</td>' +
          '<td>' + formatModerationStatusBadge(r.moderation_status) + '</td>' +
          '<td>' +
            '<div class="admin-actions-cell">' +
              '<button type="button" class="btn-mod-approve" data-mod-action="approved" data-report-id="' + escapeHtml(reportId) + '"' + approveDisabled + '>Setujui</button>' +
              '<button type="button" class="btn-mod-reject" data-mod-action="rejected" data-report-id="' + escapeHtml(reportId) + '"' + rejectDisabled + '>Tolak</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  function handleModerateClick(reportId, newStatus, btnEl) {
    if (!reportId || !newStatus) return;
    if (btnEl) btnEl.disabled = true;

    fetch('/api/admin/moderate', {
      method: 'POST',
      headers: buildAuthHeaders(),
      body: JSON.stringify({
        report_id: reportId,
        moderation_status: newStatus
      })
    })
      .then(function(res) {
        return res.json().then(function(body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function(result) {
        if (!result.ok || !result.body || (!result.body.ok && result.body.status !== 'ok')) {
          if (btnEl) btnEl.disabled = false;
          return;
        }
        var feedbackBanner = document.getElementById('admin-action-feedback');
        var feedbackText = document.getElementById('admin-action-feedback-text');
        if (feedbackBanner && feedbackText) {
          var g = result.body.group || {};
          var vCount = g.valid_report_count != null ? Number(g.valid_report_count) : 0;
          var appCount = g.approved_report_count != null ? Number(g.approved_report_count) : 0;
          var eligCount = g.eligible_report_count != null ? Number(g.eligible_report_count) : (vCount >= 5 ? vCount : appCount);
          var statusWord = newStatus === 'rejected'
            ? 'ditolak dan dikeluarkan dari perhitungan indikator peta wilayah'
            : 'disetujui moderator dan langsung dihitung pada indikator peta wilayah';
          feedbackText.textContent =
            'Laporan ' + (result.body.report_code || '') + ' telah ' + statusWord +
            '. Laporan masyarakat yang memenuhi syarat pada kelompok wilayah ini sekarang: ' +
            String(eligCount) + ' laporan (Total valid: ' + String(vCount) + ').';
          feedbackBanner.hidden = false;
        }
        try {
          localStorage.setItem('wia-mia-last-update-ts', String(Date.now()));
        } catch (_e) {}
        if (typeof BroadcastChannel !== 'undefined') {
          try {
            var bc = new BroadcastChannel('wia-mia-realtime-updates');
            bc.postMessage({
              type: 'moderation_updated',
              report_id: reportId,
              moderation_status: newStatus,
              regency_pum_code: result.body.regency_pum_code || null,
              ts: Date.now()
            });
            bc.close();
          } catch (_e2) {}
        }
        loadAdminReports();
      })
      .catch(function() {
        if (btnEl) btnEl.disabled = false;
      });
  }

  function handleLoginSubmit(e) {
    e.preventDefault();
    var emailInput = document.getElementById('admin-email');
    var passwordInput = document.getElementById('admin-password');
    var errEl = document.getElementById('admin-login-error');
    var btnLogin = document.getElementById('btn-admin-login');

    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }

    var email = emailInput ? emailInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';
    if (!email || !password) {
      if (errEl) {
        errEl.textContent = 'Email moderator dan kata sandi wajib diisi.';
        errEl.hidden = false;
      }
      return;
    }
    if (btnLogin) {
      btnLogin.disabled = true;
      btnLogin.textContent = 'Memverifikasi...';
    }

    var loginPromise = fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function(res) {
      return res.json().then(function(data) {
        if (!res.ok || !data.ok) {
          throw new Error(data.message || 'Email atau kata sandi admin tidak valid.');
        }
        return { email: data.email || email };
      });
    });

    loginPromise
      .then(function(session) {
        state.moderatorEmail = session.email;
        if (passwordInput) passwordInput.value = '';
        return loadAdminReports();
      })
      .catch(function(err) {
        if (errEl) {
          errEl.textContent = err && err.message ? err.message : 'Gagal masuk ke panel moderasi.';
          errEl.hidden = false;
        }
      })
      .finally(function() {
        if (btnLogin) {
          btnLogin.disabled = false;
          btnLogin.textContent = 'Masuk ke Panel Moderasi';
        }
      });
  }

  function handleLogout() {
    state.moderatorEmail = '';
    fetch('/api/admin/logout', { method: 'POST', headers: buildAuthHeaders() })
      .catch(function() {})
      .finally(showLoginView);
  }

  function bindEvents() {
    var loginForm = document.getElementById('admin-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', handleLoginSubmit);
    }

    var btnLogout = document.getElementById('btn-admin-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', handleLogout);
    }

    var btnRefresh = document.getElementById('btn-admin-refresh');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', function() {
        loadAdminReports();
      });
    }

    var fCat = document.getElementById('admin-filter-category');
    var fProv = document.getElementById('admin-filter-province');
    var fReg = document.getElementById('admin-filter-regency');
    var fStat = document.getElementById('admin-filter-status');

    if (fCat) {
      fCat.addEventListener('change', function() {
        state.filters.category = fCat.value;
        renderAdminTable();
      });
    }
    if (fProv) {
      fProv.addEventListener('change', function() {
        state.filters.province_pum_code = fProv.value;
        state.filters.regency_pum_code = 'all';
        populateRegencyDropdown(fProv.value);
        renderAdminTable();
      });
    }
    if (fReg) {
      fReg.addEventListener('change', function() {
        state.filters.regency_pum_code = fReg.value;
        renderAdminTable();
      });
    }
    if (fStat) {
      fStat.addEventListener('change', function() {
        state.filters.moderation_status = fStat.value;
        renderAdminTable();
      });
    }

    var tbody = document.getElementById('admin-reports-tbody');
    if (tbody) {
      tbody.addEventListener('click', function(e) {
        var btn = e.target.closest('button[data-mod-action]');
        if (!btn || btn.disabled) return;
        var reportId = btn.getAttribute('data-report-id');
        var modAction = btn.getAttribute('data-mod-action');
        handleModerateClick(reportId, modAction, btn);
      });
    }
  }

  function init() {
    bindEvents();
    loadWilayah().then(function() {
      fetch('/api/admin/session', { cache: 'no-store' })
        .then(function(res) { return res.json().then(function(body) { return { ok: res.ok, body: body }; }); })
        .then(function(result) {
          if (result.ok && result.body.ok) {
            state.moderatorEmail = result.body.email;
            loadAdminReports();
          } else showLoginView();
        })
        .catch(function() { showLoginView(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
