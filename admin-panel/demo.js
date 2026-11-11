(function() {
  'use strict';

  var reports = [];
  var groups = [];
  var regenciesByProvince = {};
  var refreshTimer = null;
  var refreshInFlight = false;
  var refreshQueued = false;
  var adminMode = false;
  var adminDataLoaded = false;
  var moderatorEmail = '';
  var endpoint = window.ENV_SUPABASE_URL && window.ENV_SUPABASE_ANON_KEY
    ? window.ENV_SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/community-reports'
    : '';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(value) {
    if (!value) return '-';
    var date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '-'
      : date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB';
  }

  function showMessage(message, isError) {
    var box = document.getElementById('admin-login-error');
    if (!box) return;
    box.textContent = message;
    box.hidden = !message;
    box.classList.toggle('is-error', Boolean(isError));
  }

  function setAdminMode(enabled, email) {
    adminMode = enabled;
    adminDataLoaded = false;
    moderatorEmail = enabled ? (email || '') : '';
    if (!enabled) {
      reports = [];
      groups = [];
    }
    document.getElementById('admin-moderator-label').textContent = enabled
      ? 'Admin: ' + moderatorEmail
      : 'Mode baca saja';
    document.getElementById('btn-admin-login-open').hidden = enabled;
    document.getElementById('btn-admin-logout').hidden = !enabled;
    document.querySelectorAll('[data-admin-only]').forEach(function(element) {
      element.hidden = !enabled || !adminDataLoaded;
    });
    document.getElementById('admin-filter-status').querySelector('option[value="rejected"]').hidden = !enabled || !adminDataLoaded;
    if (!enabled && document.getElementById('admin-filter-status').value === 'rejected') {
      document.getElementById('admin-filter-status').value = 'all';
    }
    renderReports();
  }

  function populateProvinces(data) {
    var select = document.getElementById('admin-filter-province');
    if (!select) return;
    (data.provinces || []).forEach(function(province) {
      var option = document.createElement('option');
      option.value = province.province_pum_code;
      option.textContent = province.province_name;
      select.appendChild(option);
    });

    (data.regencies || []).forEach(function(regency) {
      var code = regency.province_pum_code;
      if (!regenciesByProvince[code]) regenciesByProvince[code] = [];
      regenciesByProvince[code].push(regency);
    });
  }

  function updateRegencies() {
    var province = document.getElementById('admin-filter-province').value;
    var select = document.getElementById('admin-filter-regency');
    select.replaceChildren(new Option('Semua Kabupaten/Kota', 'all'));
    var options = regenciesByProvince[province] || [];
    options.forEach(function(regency) {
      select.add(new Option(regency.display_name || regency.regency_name, regency.regency_pum_code));
    });
    select.disabled = !options.length;
  }

  function getGroup(report) {
    return groups.find(function(group) { return group.group_key === report.group_key; }) || null;
  }

  function renderReports() {
    var tbody = document.getElementById('admin-reports-tbody');
    var category = document.getElementById('admin-filter-category').value;
    var province = document.getElementById('admin-filter-province').value;
    var regency = document.getElementById('admin-filter-regency').value;
    var status = document.getElementById('admin-filter-status').value;
    var actionHeader = document.querySelector('[data-admin-only]');
    if (actionHeader) actionHeader.hidden = !adminMode || !adminDataLoaded;
    var filtered = reports.filter(function(report) {
      return (category === 'all' || report.category === category) &&
        (province === 'all' || report.province_pum_code === province) &&
        (regency === 'all' || report.regency_pum_code === regency) &&
        (status === 'all' || report.moderation_status === status);
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="' + (adminMode && adminDataLoaded ? 7 : 6) + '">' +
        (adminMode ? 'Tidak ada laporan yang sesuai filter.' : 'Tidak ada laporan publik yang sesuai filter.') +
        '</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(function(report) {
      var group = getGroup(report);
      var count = Number(report.group_valid_count || (group && group.valid_report_count) || 0);
      var approvedCount = Number(group && group.approved_report_count || 0);
      var eligibleCount = report.category === 'karhutla'
        ? (approvedCount >= 5 ? approvedCount : 0)
        : Number(report.group_eligible_report_count != null
          ? report.group_eligible_report_count
          : group && group.eligible_report_count || 0);
      var isHotspotGroup = report.category === 'karhutla' && eligibleCount >= 5;
      var queueLabel = report.category === 'karhutla'
        ? (isHotspotGroup ? 'Titik panas komunitas · ' + eligibleCount : approvedCount + '/5 disetujui')
        : (count >= 5 ? 'Data tambahan · ' + count : 'Antrean · ' + count);
      var categoryLabel = report.category === 'karhutla' ? 'Karhutla' : 'Kualitas Udara';
      var statusLabel = report.moderation_status === 'approved'
        ? 'Disetujui'
        : report.moderation_status === 'rejected' ? 'Ditolak' : 'Belum disetujui';
      var statusClass = report.moderation_status === 'approved'
        ? 'is-approved'
        : report.moderation_status === 'rejected' ? 'is-rejected' : 'is-valid';
      var reportId = report.report_id || report.id || '';
      var actions = '';
      var summary = report.public_summary || (report.category === 'karhutla'
        ? report.description
        : (report.air_decline_pct != null
          ? 'Penurunan kualitas udara dirasakan sebesar ' + report.air_decline_pct + '% selama ' + report.air_duration_days + ' hari.'
          : '-'));
      if (adminMode && adminDataLoaded) {
        actions = '<td><div class="admin-actions-cell">' +
          (report.moderation_status === 'approved'
            ? '<span class="mod-pill is-approved">Terverifikasi</span>'
            : '<button type="button" class="btn-mod-approve" data-mod-action="approved" data-report-id="' + escapeHtml(reportId) + '">Verifikasi</button>') +
          (report.moderation_status === 'rejected'
            ? ''
            : '<button type="button" class="btn-mod-reject" data-mod-action="rejected" data-report-id="' + escapeHtml(reportId) + '">Tolak</button>') +
          '</div></td>';
      }
      return '<tr>' +
        '<td><div class="row-code">' + escapeHtml(report.report_code) + '</div>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + escapeHtml(formatDate(report.created_at_utc)) + '</div></td>' +
        '<td><strong>' + escapeHtml(report.regency_name) + '</strong>' +
          '<div style="font-size:12px;color:var(--text-soft);">' + escapeHtml(report.province_name) + '</div>' +
          (adminMode ? '<div style="font-size:12px;color:var(--muted);margin-top:4px;">Pelapor: ' + escapeHtml(report.reporter_name || 'Anonim') + '</div>' : '') + '</td>' +
        '<td>' + escapeHtml(categoryLabel) + '</td>' +
        '<td>' + escapeHtml(summary || '-') + '</td>' +
        '<td>' + escapeHtml(queueLabel) + '</td>' +
        '<td><span class="mod-pill ' + statusClass + '">' + statusLabel + '</span></td>' +
        actions +
      '</tr>';
    }).join('');
  }

  function loadAdminReports() {
    return fetch('/api/admin/reports', { cache: 'no-store' }).then(function(response) {
      return response.json().then(function(body) {
        if (!response.ok || !body.ok) throw new Error(body.message || 'Gagal memuat laporan admin.');
        reports = Array.isArray(body.reports) ? body.reports : [];
        groups = Array.isArray(body.groups) ? body.groups : [];
        adminDataLoaded = true;
        document.querySelectorAll('[data-admin-only]').forEach(function(element) { element.hidden = false; });
        document.getElementById('admin-filter-status').querySelector('option[value="rejected"]').hidden = false;
        renderReports();
      });
    });
  }

  function loadReports(force) {
    if (refreshInFlight) {
      if (force) refreshQueued = true;
      return;
    }
    if (document.hidden && !force) return;
    if (!adminMode && !endpoint) {
      showMessage('Konfigurasi Supabase belum tersedia untuk memuat laporan.', true);
      return;
    }
    refreshInFlight = true;
    var refreshButton = document.getElementById('btn-admin-refresh');
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Memuat...';
    }
    (adminMode
      ? loadAdminReports().then(function() { return null; })
      : fetch(endpoint + '?mode=public&limit=100&t=' + Date.now(), {
          headers: { apikey: window.ENV_SUPABASE_ANON_KEY },
          cache: 'no-store'
        }))
      .then(function(response) {
        if (!response) return null;
        return response.json().then(function(body) {
          if (!response.ok || body.status !== 'ok') {
            throw new Error(body.message || 'Gagal memuat laporan publik.');
          }
          return body;
        });
      })
      .then(function(payload) {
        if (payload) {
          reports = Array.isArray(payload.reports) ? payload.reports : [];
          groups = Array.isArray(payload.groups) ? payload.groups : [];
        }
        showMessage(adminMode
          ? ''
          : (reports.length ? '' : 'Belum ada laporan valid atau disetujui untuk ditampilkan. Laporan yang ditolak tidak ditampilkan di demo publik.'), false);
        document.getElementById('admin-last-updated').textContent =
          'Terakhir diperbarui: ' + new Date().toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: 'Asia/Jakarta'
          }) +
          ' WIB · Pembaruan otomatis setiap 30 detik';
        renderReports();
      })
      .catch(function(error) {
        showMessage('Gagal memperbarui data: ' + (error.message || 'Tidak dapat terhubung ke layanan laporan.'), true);
        if (adminMode && error.message && /sesi admin|belum login|sesi tidak valid/i.test(error.message)) {
          setAdminMode(false);
          refreshQueued = true;
        }
      })
      .finally(function() {
        refreshInFlight = false;
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = 'Muat Ulang';
        }
        if (refreshQueued) {
          refreshQueued = false;
          loadReports(true);
        }
      });
  }

  function showLoginError(message) {
    var box = document.getElementById('admin-login-dialog-error');
    box.textContent = message;
    box.hidden = !message;
  }

  function handleLogin(event) {
    event.preventDefault();
    var emailInput = document.getElementById('admin-email');
    var email = emailInput.value.trim();
    var passwordInput = document.getElementById('admin-password');
    var button = document.getElementById('btn-admin-login');
    showLoginError('');
    if (!email || !emailInput.checkValidity()) {
      showLoginError(email ? 'Format email admin tidak valid.' : 'Email admin wajib diisi.');
      emailInput.focus();
      return;
    }
    if (!passwordInput.value) {
      showLoginError('Kata sandi admin wajib diisi.');
      passwordInput.focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Memverifikasi...';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: passwordInput.value })
    })
      .then(function(response) {
        return response.json().then(function(body) {
          if (!response.ok || !body.ok) throw new Error(body.message || 'Login admin gagal.');
          return body;
        });
      })
      .then(function(session) {
        passwordInput.value = '';
        document.getElementById('admin-login-dialog').close();
        setAdminMode(true, session.email || email);
        showMessage('Login berhasil. Memuat antrean moderasi...', false);
        loadReports(true);
      })
      .catch(function(error) {
        showLoginError(error.message || 'Login admin gagal.');
      })
      .finally(function() {
        button.disabled = false;
        button.textContent = 'Masuk';
      });
  }

  function handleLogout() {
    fetch('/api/admin/logout', { method: 'POST' })
      .then(function(response) {
        return response.json().then(function(body) {
          if (!response.ok || !body.ok) throw new Error(body.message || 'Logout gagal.');
        });
      })
      .then(function() {
        setAdminMode(false);
        showMessage('Anda sudah keluar dari mode moderator.', false);
        loadReports(true);
      })
      .catch(function(error) {
        showMessage('Gagal keluar: ' + (error.message || 'Silakan coba lagi.'), true);
      });
  }

  function handleModeration(event) {
    var button = event.target.closest('button[data-mod-action]');
    if (!button || button.disabled) return;
    var action = button.getAttribute('data-mod-action');
    if (action === 'rejected' && !window.confirm('Tolak laporan ini? Laporan tidak akan dihitung sebagai titik panas komunitas.')) return;
    button.disabled = true;
    fetch('/api/admin/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_id: button.getAttribute('data-report-id'),
        moderation_status: action
      })
    })
      .then(function(response) {
        return response.json().then(function(body) {
          if (!response.ok || (!body.ok && body.status !== 'ok')) throw new Error(body.message || 'Status laporan gagal diperbarui.');
          return body;
        });
      })
      .then(function(result) {
        try { localStorage.setItem('wia-mia-last-update-ts', String(Date.now())); } catch (_) {}
        if (typeof BroadcastChannel !== 'undefined') {
          var channel = new BroadcastChannel('wia-mia-realtime-updates');
          channel.postMessage({ type: 'moderation_updated', regency_pum_code: result.regency_pum_code, ts: Date.now() });
          channel.close();
        }
        loadReports(true);
      })
      .catch(function(error) {
        button.disabled = false;
        showMessage('Gagal mengubah status laporan: ' + (error.message || 'Silakan coba lagi.'), true);
      });
  }

  function init() {
    setAdminMode(false);
    fetch('../laporan/data/wilayah-indonesia.json')
      .then(function(response) { return response.ok ? response.json() : {}; })
      .then(populateProvinces)
      .catch(function() {});

    ['admin-filter-category', 'admin-filter-province', 'admin-filter-regency', 'admin-filter-status']
      .forEach(function(id) {
        document.getElementById(id).addEventListener('change', function() {
          if (id === 'admin-filter-province') updateRegencies();
          renderReports();
        });
      });
    document.getElementById('btn-admin-refresh').addEventListener('click', loadReports);
    document.getElementById('btn-admin-login-open').addEventListener('click', function() {
      showLoginError('');
      document.getElementById('admin-login-dialog').showModal();
      document.getElementById('admin-email').focus();
    });
    document.getElementById('btn-admin-login-cancel').addEventListener('click', function() {
      document.getElementById('admin-login-dialog').close();
    });
    document.getElementById('admin-login-form').addEventListener('submit', handleLogin);
    document.getElementById('btn-admin-logout').addEventListener('click', handleLogout);
    document.getElementById('admin-reports-tbody').addEventListener('click', handleModeration);
    document.getElementById('admin-login-dialog').addEventListener('click', function(event) {
      if (event.target === this) this.close();
    });
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) loadReports();
    });
    fetch('/api/admin/session', { cache: 'no-store' })
      .then(function(response) { return response.ok ? response.json() : null; })
      .then(function(session) {
        if (session && session.ok) setAdminMode(true, session.email);
      })
      .catch(function() { showMessage('Tidak dapat memeriksa sesi admin. Panel tetap menampilkan data publik.', true); })
      .finally(function() { loadReports(true); });
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(loadReports, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
