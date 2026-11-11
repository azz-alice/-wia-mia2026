(function() {
  'use strict';

  var reports = [];
  var groups = [];
  var regenciesByProvince = {};
  var refreshTimer = null;
  var refreshInFlight = false;
  var refreshQueued = false;
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
    var box = document.getElementById('admin-data-message');
    if (!box) return;
    box.textContent = message;
    box.hidden = !message;
    box.classList.toggle('is-error', Boolean(isError));
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
    var filtered = reports.filter(function(report) {
      return (category === 'all' || report.category === category) &&
        (province === 'all' || report.province_pum_code === province) &&
        (regency === 'all' || report.regency_pum_code === regency) &&
        (status === 'all' || report.moderation_status === status);
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="6">Tidak ada laporan publik yang sesuai filter.</td></tr>';
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
      var queueLabel = report.category === 'karhutla'
        ? (eligibleCount >= 5 ? 'Titik panas komunitas · ' + eligibleCount : approvedCount + '/5 disetujui')
        : (count >= 5 ? 'Data tambahan · ' + count : 'Antrean · ' + count);
      var categoryLabel = report.category === 'karhutla' ? 'Karhutla' : 'Kualitas Udara';
      var statusLabel = report.moderation_status === 'approved' ? 'Disetujui' : 'Belum disetujui';
      var statusClass = report.moderation_status === 'approved' ? 'is-approved' : 'is-valid';
      var summary = report.public_summary || (report.category === 'karhutla'
        ? report.description
        : (report.air_decline_pct != null
          ? 'Penurunan kualitas udara dirasakan sebesar ' + report.air_decline_pct + '% selama ' + report.air_duration_days + ' hari.'
          : '-'));

      return '<tr>' +
        '<td><div class="row-code">' + escapeHtml(report.report_code) + '</div>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:4px;">' + escapeHtml(formatDate(report.created_at_utc)) + '</div></td>' +
        '<td><strong>' + escapeHtml(report.regency_name) + '</strong>' +
          '<div style="font-size:12px;color:var(--text-soft);">' + escapeHtml(report.province_name) + '</div></td>' +
        '<td>' + escapeHtml(categoryLabel) + '</td>' +
        '<td>' + escapeHtml(summary || '-') + '</td>' +
        '<td>' + escapeHtml(queueLabel) + '</td>' +
        '<td><span class="mod-pill ' + statusClass + '">' + statusLabel + '</span></td>' +
      '</tr>';
    }).join('');
  }

  function loadReports(force) {
    if (refreshInFlight) {
      if (force) refreshQueued = true;
      return;
    }
    if (document.hidden && !force) return;
    if (!endpoint) {
      showMessage('Konfigurasi Supabase belum tersedia untuk memuat laporan publik.', true);
      return;
    }
    refreshInFlight = true;
    var refreshButton = document.getElementById('btn-admin-refresh');
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Memuat...';
    }

    fetch(endpoint + '?mode=public&limit=100&t=' + Date.now(), {
      headers: { apikey: window.ENV_SUPABASE_ANON_KEY },
      cache: 'no-store'
    })
      .then(function(response) {
        return response.json().then(function(body) {
          if (!response.ok || body.status !== 'ok') {
            throw new Error(body.message || 'Gagal memuat laporan publik.');
          }
          return body;
        });
      })
      .then(function(payload) {
        reports = Array.isArray(payload.reports) ? payload.reports : [];
        groups = Array.isArray(payload.groups) ? payload.groups : [];
        showMessage(reports.length
          ? ''
          : 'Belum ada laporan valid atau disetujui untuk ditampilkan. Laporan yang ditolak tidak ditampilkan di panel publik.', false);
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

  function init() {
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
    document.getElementById('btn-admin-refresh').addEventListener('click', function() { loadReports(true); });
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) loadReports();
    });
    loadReports(true);
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(loadReports, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
