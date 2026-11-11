(() => {
  "use strict";
  const WILAYAH_URL = "./data/wilayah-indonesia.json";
  const PUBLIC_SNAPSHOT_URL = "./data/community-reports-public.json";
  const PAGE_SIZE = 10;
  const $ = s => document.querySelector(s);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const formatDateTimeId = iso => {
    if (!iso) return "-";
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "-";
    const d = new Date(ms);
    return `${d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })} · ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })} WIB`;
  };

  const openModalBtn = $("#open-report-modal-btn");
  const formModal = $("#report-form-modal");
  const reportForm = $("#community-report-form");
  const inputName = $("#input-reporter-name");
  const inputProvince = $("#input-province");
  const inputRegency = $("#input-regency");
  const fieldsKarhutla = $("#fields-karhutla");
  const fieldsAir = $("#fields-kualitas-udara");
  const inputObservedAt = $("#input-observed-at");
  const inputDescription = $("#input-description");
  const inputAirDecline = $("#input-air-decline");
  const inputAirDuration = $("#input-air-duration");
  const formErrorBox = $("#form-error-box");
  const submitReportBtn = $("#submit-report-btn");

  const successModal = $("#report-success-modal");
  const confirmCodeEl = $("#confirm-report-code");
  const copyCodeBtn = $("#copy-code-btn");
  const copyFeedback = $("#copy-feedback");

  const searchForm = $("#report-search-form");
  const searchInput = $("#search-code-input");
  const searchFeedback = $("#search-feedback");

  const tabs = Array.from(document.querySelectorAll(".category-tab"));
  const tabIndicator = $(".category-tabs-indicator");
  const connectionBadge = $("#backend-connection-badge");

  const listContainer = $("#active-reports-container");
  const paginationBar = $("#pagination-bar");
  const prevPageBtn = $("#prev-page-btn");
  const nextPageBtn = $("#next-page-btn");
  const pageIndicator = $("#page-indicator");

  const alertBanner = $("#community-alert-banner");
  const alertMsg = $("#community-alert-msg");

  let allPublicReports = [];
  let allGroups = [];
  let provincesList = [];
  let regenciesByProv = new Map();
  let regencyByPum = new Map();
  let provinceByPum = new Map();
  let activeCategory = "karhutla";
  let currentPage = 1;
  let highlightTimer = null;
  let lastCreatedCode = "";

  const option = (value, text) => {
    const o = el("option", null, text);
    o.value = value;
    return o;
  };

  const initDurationDropdown = () => {
    const frag = document.createDocumentFragment();
    frag.append(option("", "Pilih Durasi (1–35 Hari)"));
    for (let d = 1; d <= 35; d++) frag.append(option(String(d), `${d} hari`));
    inputAirDuration.replaceChildren(frag);
  };

  const loadWilayah = async () => {
    try {
      const res = await fetch(WILAYAH_URL);
      if (!res.ok) return;
      const data = await res.json();
      const rawProvs = Array.isArray(data?.provinces) ? data.provinces : [];
      const rawRegs = Array.isArray(data?.regencies) ? data.regencies : [];

      provincesList = [...rawProvs].sort((a, b) => a.province_name.localeCompare(b.province_name, "id"));
      provinceByPum = new Map(provincesList.map(p => [p.province_pum_code, p]));
      regenciesByProv = new Map();
      regencyByPum = new Map();

      rawRegs.forEach(r => {
        regencyByPum.set(r.regency_pum_code, r);
        const pCode = r.province_pum_code;
        if (!regenciesByProv.has(pCode)) regenciesByProv.set(pCode, []);
        regenciesByProv.get(pCode).push(r);
      });

      for (const [pCode, regs] of regenciesByProv.entries()) {
        regs.sort((a, b) => (a.display_name || a.regency_name).localeCompare(b.display_name || b.regency_name, "id"));
      }

      if (inputProvince) {
        const frag = document.createDocumentFragment();
        frag.append(option("", "Pilih Provinsi"));
        provincesList.forEach(p => frag.append(option(p.province_pum_code, p.province_name)));
        inputProvince.replaceChildren(frag);
      }
    } catch (_) {}
  };

  const syncRegencyDropdown = () => {
    if (!inputProvince || !inputRegency) return;
    const selectedProv = String(inputProvince.value || "").trim();
    const regs = regenciesByProv.get(selectedProv) || [];
    const frag = document.createDocumentFragment();
    frag.append(option("", regs.length ? "Pilih Kabupaten/Kota" : "Pilih Provinsi Terlebih Dahulu"));
    regs.forEach(r => frag.append(option(r.regency_pum_code, r.display_name || r.regency_name)));
    inputRegency.replaceChildren(frag);
    inputRegency.value = "";
    inputRegency.disabled = !regs.length;
  };

  const getSelectedCategory = () => reportForm?.querySelector('input[name="report_category"]:checked')?.value || "";

  const syncCategoryFields = () => {
    const cat = getSelectedCategory();
    if (fieldsKarhutla) fieldsKarhutla.hidden = cat !== "karhutla";
    if (fieldsAir) fieldsAir.hidden = cat !== "kualitas_udara";
    if (formErrorBox) formErrorBox.hidden = true;
  };

  const getApiEndpoint = () => {
    const sbUrl = window.ENV_SUPABASE_URL;
    const sbAnon = window.ENV_SUPABASE_ANON_KEY;
    if (sbUrl && sbAnon) {
      return {
        type: "supabase",
        url: `${sbUrl.replace(/\/$/, "")}/functions/v1/community-reports`,
        headers: { "Content-Type": "application/json", apikey: sbAnon, Authorization: `Bearer ${sbAnon}` }
      };
    }
    return null;
  };

  const SEEN_KEY = "wia-seen-promoted-groups-v1";
  const readSeen = () => {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); } catch (_) { return []; }
  };

  const checkNotifiedGroups = groups => {
    const seen = readSeen();
    const latest = (groups || []).find(g => g.queue_status === "promoted_supplementary" && g.valid_report_count >= 5 && g.threshold_notified_at_utc && !seen.includes(g.group_key));
    alertBanner.hidden = !latest;
    if (!latest) return;
    const catLabel = latest.category === "karhutla" ? "Karhutla" : "Kualitas Udara";
    alertMsg.textContent = `Kelompok laporan ${catLabel} di ${latest.regency_name}, ${latest.province_name} telah mencapai ${latest.valid_report_count} laporan valid dan dipublikasikan sebagai Data Tambahan Masyarakat.`;
    alertBanner.dataset.currentGroupKey = latest.group_key;
  };

  $("#community-alert-close")?.addEventListener("click", () => {
    const gKey = alertBanner.dataset.currentGroupKey;
    if (gKey) {
      const seen = readSeen();
      if (!seen.includes(gKey)) seen.push(gKey);
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (_) {}
    }
    alertBanner.hidden = true;
  });

  const initialOf = name => (String(name || "").trim().charAt(0) || "?").toUpperCase();

  const buildReportRow = r => {
    const code = String(r.report_code || "").toUpperCase();
    const row = el("article", "report-row");
    row.id = `report-row-${code}`;

    const head = el("div", "row-head");
    const who = el("div", "row-who");
    who.append(el("span", "row-avatar", initialOf(r.reporter_name)));
    const meta = el("div", "row-meta");
    meta.append(el("strong", "row-name", r.reporter_name || "Anonim"), el("span", "row-time", formatDateTimeId(r.created_at_utc)));
    who.append(meta);
    const statusLabel = r.moderation_status === "approved" ? "Terverifikasi" : "Laporan Valid";
    head.append(who, el("span", `status-tag is-${r.moderation_status || "valid"}`, statusLabel));

    const body = el("p", "row-summary");
    if (r.category === "karhutla") {
      const obsText = r.observed_at_utc ? `Diamati ${formatDateTimeId(r.observed_at_utc)}: ` : "";
      body.textContent = `${obsText}${r.public_summary || r.description || "Pengamatan indikasi karhutla wilayah."}`;
    } else {
      body.textContent = `Persepsi penurunan kualitas udara sebesar ${r.air_decline_pct}% selama ${r.air_duration_days} hari.`;
    }

    const foot = el("div", "row-foot");
    foot.append(el("span", "row-region", `${r.regency_name || "Kabupaten Sidoarjo"}, ${r.province_name || "Jawa Timur"}`));
    foot.append(el("span", "row-code", code));

    row.append(head, body, foot);
    return row;
  };

  const visibleReports = () => allPublicReports.filter(r => r.moderation_status !== "rejected");

  const reportsFor = category => {
    return visibleReports()
      .filter(r => r.category === category)
      .sort((a, b) => String(b.created_at_utc).localeCompare(String(a.created_at_utc)));
  };

  const moveIndicator = () => {
    const active = tabs.find(t => t.dataset.category === activeCategory);
    if (!active || !tabIndicator) return;
    tabIndicator.style.width = `${active.offsetWidth}px`;
    tabIndicator.style.transform = `translateX(${active.offsetLeft - 4}px)`;
  };

  const renderLists = () => {
    const visible = visibleReports();
    document.querySelectorAll("[data-count-for]").forEach(n => {
      n.textContent = String(visible.filter(r => r.category === n.dataset.countFor).length);
    });
    tabs.forEach(t => {
      const on = t.dataset.category === activeCategory;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    moveIndicator();

    const items = reportsFor(activeCategory);
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);
    const pageItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

    if (!pageItems.length) {
      const label = activeCategory === "karhutla" ? "Karhutla" : "Kualitas Udara";
      listContainer.replaceChildren(el("div", "empty-state", `Belum ada laporan ${label} yang masuk.`));
      paginationBar.hidden = true;
    } else {
      const frag = document.createDocumentFragment();
      pageItems.forEach(r => frag.append(buildReportRow(r)));
      listContainer.replaceChildren(frag);
      paginationBar.hidden = totalPages <= 1;
      pageIndicator.textContent = `Halaman ${currentPage} dari ${totalPages}`;
      prevPageBtn.disabled = currentPage <= 1;
      nextPageBtn.disabled = currentPage >= totalPages;
    }
  };

  const applyPayload = (payload, badgeText) => {
    allPublicReports = Array.isArray(payload?.reports) ? payload.reports : [];
    allGroups = Array.isArray(payload?.groups) ? payload.groups : [];
    connectionBadge.textContent = badgeText || "";
    connectionBadge.hidden = !badgeText;
    checkNotifiedGroups(allGroups);
    renderLists();
  };

  const fetchReportsData = async () => {
    const ep = getApiEndpoint();
    if (!ep) {
      try {
        const snapRes = await fetch(`${PUBLIC_SNAPSHOT_URL}?t=${Date.now()}`, { cache: "no-store" });
        if (snapRes.ok) return applyPayload(await snapRes.json(), "");
      } catch (_) {}
      return applyPayload(null, "");
    }
    try {
      const res = await fetch(`${ep.url}?limit=100`, { method: "GET", headers: ep.headers, cache: "no-store" });
      if (res.ok) {
        return applyPayload(await res.json(), ep.type === "supabase" ? "Database: Supabase Terhubung" : "Database: Penyimpanan Server Aktif");
      }
    } catch (_) {}
    try {
      const snapRes = await fetch(`${PUBLIC_SNAPSHOT_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (snapRes.ok) return applyPayload(await snapRes.json(), "");
    } catch (_) {}
    applyPayload(null, "");
  };

  const highlightAndScrollToCode = codeStr => {
    const cleanCode = String(codeStr || "").trim().toUpperCase();
    const target = cleanCode && visibleReports().find(r => String(r.report_code || "").toUpperCase() === cleanCode);
    if (!target) return false;
    activeCategory = target.category;
    const items = reportsFor(activeCategory);
    const idx = items.findIndex(r => String(r.report_code || "").toUpperCase() === cleanCode);
    currentPage = idx >= 0 ? Math.floor(idx / PAGE_SIZE) + 1 : 1;
    renderLists();
    const rowEl = document.getElementById(`report-row-${cleanCode}`);
    if (!rowEl) return false;
    document.querySelectorAll(".report-row.is-highlighted").forEach(n => n.classList.remove("is-highlighted"));
    rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
    rowEl.classList.add("is-highlighted");
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => rowEl.classList.remove("is-highlighted"), 4500);
    return true;
  };

  const showSearchFeedback = (ok, text) => {
    searchFeedback.hidden = false;
    searchFeedback.className = `search-feedback ${ok ? "is-found" : "is-error"}`;
    searchFeedback.textContent = text;
  };

  searchForm?.addEventListener("submit", async e => {
    e.preventDefault();
    const rawCode = String(searchInput.value || "").trim().toUpperCase();
    if (!rawCode) return showSearchFeedback(false, "Masukkan kode unik laporan terlebih dahulu.");
    const foundText = `Laporan ${rawCode} ditemukan. Halaman telah diarahkan ke baris laporan.`;
    if (highlightAndScrollToCode(rawCode)) return showSearchFeedback(true, foundText);
    await fetchReportsData();
    if (highlightAndScrollToCode(rawCode)) return showSearchFeedback(true, foundText);
    showSearchFeedback(false, `Kode laporan "${rawCode}" tidak ditemukan dalam database publik.`);
  });

  tabs.forEach(t => t.addEventListener("click", () => {
    if (t.dataset.category === activeCategory) return;
    activeCategory = t.dataset.category;
    currentPage = 1;
    renderLists();
  }));
  window.addEventListener("resize", moveIndicator);

  const openFormModal = () => {
    if (!formModal.hidden || !successModal.hidden) return;
    formErrorBox.hidden = true;
    const catChecked = reportForm.querySelector('input[name="report_category"]:checked');
    if (!catChecked) {
      const targetRadio = reportForm.querySelector(`input[name="report_category"][value="${activeCategory || "karhutla"}"]`) || reportForm.querySelector('input[name="report_category"]');
      if (targetRadio) targetRadio.checked = true;
    }
    syncCategoryFields();
    if (!inputObservedAt.value) {
      const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      inputObservedAt.value = local;
      inputObservedAt.max = local;
    }
    formModal.hidden = false;
    inputName.focus();
  };

  const closeFormModal = () => {
    formModal.hidden = true;
    openModalBtn?.focus();
  };

  const closeSuccessModal = () => {
    successModal.hidden = true;
    copyFeedback.hidden = true;
    openModalBtn?.focus();
  };

  openModalBtn?.addEventListener("click", openFormModal);
  $("#close-form-modal-btn")?.addEventListener("click", closeFormModal);
  $("#cancel-form-btn")?.addEventListener("click", closeFormModal);
  $("#close-success-modal-btn")?.addEventListener("click", closeSuccessModal);
  formModal?.addEventListener("click", e => { if (e.target === formModal) closeFormModal(); });
  successModal?.addEventListener("click", e => { if (e.target === successModal) closeSuccessModal(); });
  document.addEventListener("keydown", e => {
    const activeModal = !successModal.hidden ? successModal : !formModal.hidden ? formModal : null;
    if (!activeModal) return;
    if (e.key === "Escape") {
      if (activeModal === successModal) closeSuccessModal();
      else closeFormModal();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = Array.from(activeModal.querySelectorAll(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )).filter(node => node.getClientRects().length > 0);
    if (!focusable.length) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  });

  inputProvince?.addEventListener("change", syncRegencyDropdown);
  reportForm?.querySelectorAll('input[name="report_category"]').forEach(r => r.addEventListener("change", syncCategoryFields));
  prevPageBtn?.addEventListener("click", () => { currentPage--; renderLists(); });
  nextPageBtn?.addEventListener("click", () => { currentPage++; renderLists(); });

  const showFormError = msg => {
    formErrorBox.textContent = msg;
    formErrorBox.hidden = false;
    formErrorBox.classList.remove("is-shake");
    void formErrorBox.offsetWidth;
    formErrorBox.classList.add("is-shake");
  };

  const setSubmitting = on => {
    submitReportBtn.disabled = on;
    submitReportBtn.textContent = on ? "Menyimpan..." : "Kirim Laporan";
  };

  const buildPayload = () => {
    const reporterName = String(inputName.value || "").trim();
    if (reporterName.length < 2 || reporterName.length > 80) throw new Error("Nama pelapor wajib diisi (minimal 2 karakter).");
    const category = getSelectedCategory();
    if (category !== "karhutla" && category !== "kualitas_udara") throw new Error("Pilih jenis laporan (Karhutla atau Kualitas Udara).");

    const provCode = String(inputProvince?.value || "").trim();
    if (!provCode) throw new Error("Pilih provinsi pengamatan.");
    const regCode = String(inputRegency?.value || "").trim();
    if (!regCode) throw new Error("Pilih kabupaten/kota pengamatan.");

    const provObj = provinceByPum.get(provCode);
    const regObj = regencyByPum.get(regCode);
    const provName = provObj?.province_name || "Indonesia";
    const regName = regObj?.display_name || regObj?.regency_name || "Wilayah Pengamatan";
    const regBps = regObj?.regency_bps_code || regCode.replace(".", "");

    const payload = {
      action: "submit",
      reporter_name: reporterName,
      category,
      province_pum_code: provCode,
      province_name: provName,
      regency_pum_code: regCode,
      regency_bps_code: regBps,
      regency_name: regName
    };

    if (category === "karhutla") {
      const rawObs = String(inputObservedAt.value || "").trim();
      if (!rawObs) throw new Error("Waktu pengamatan Karhutla wajib diisi.");
      const obsMs = Date.parse(rawObs);
      if (!Number.isFinite(obsMs) || obsMs > Date.now() + 300000) throw new Error("Waktu pengamatan tidak valid atau berada di masa depan.");
      const desc = String(inputDescription.value || "").trim();
      if (desc.length < 5 || desc.length > 1000) throw new Error("Deskripsi laporan wajib diisi (minimal 5 karakter).");
      payload.observed_at_utc = new Date(obsMs).toISOString();
      payload.description = desc;
    } else {
      const rawPct = String(inputAirDecline.value || "").trim();
      const rawDur = String(inputAirDuration.value || "").trim();
      if (rawPct === "") throw new Error("Pilih persentase penurunan kualitas udara (0% hingga 100%).");
      if (rawDur === "") throw new Error("Pilih durasi penurunan kualitas udara (1 hingga 35 hari).");
      const pct = Number(rawPct);
      const dur = Number(rawDur);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100 || pct % 10 !== 0) throw new Error("Persentase penurunan kualitas udara harus kelipatan 10% antara 0% sampai 100%.");
      if (!Number.isInteger(dur) || dur < 1 || dur > 35) throw new Error("Durasi penurunan kualitas udara harus antara 1 sampai 35 hari.");
      payload.air_decline_pct = pct;
      payload.air_duration_days = dur;
    }
    return payload;
  };

  const broadcastUpdate = result => {
    try { localStorage.setItem("wia-mia-last-update-ts", String(Date.now())); } catch (_) {}
    if (typeof BroadcastChannel === "undefined") return;
    try {
      const bc = new BroadcastChannel("wia-mia-realtime-updates");
      bc.postMessage({ type: "report_submitted", report_code: result.report_code, regency_pum_code: result.regency_pum_code || null, ts: Date.now() });
      bc.close();
    } catch (_) {}
  };

  reportForm?.addEventListener("submit", async e => {
    e.preventDefault();
    formErrorBox.hidden = true;
    let payload;
    try { payload = buildPayload(); } catch (err) { return showFormError(err.message); }

    setSubmitting(true);
    const ep = getApiEndpoint();
    if (!ep) {
      setSubmitting(false);
      return showFormError("Supabase belum dikonfigurasi. Isi Project URL dan anon/public key di site-config.js sebelum mengirim laporan.");
    }
    try {
      const res = await fetch(ep.url, { method: "POST", headers: ep.headers, body: JSON.stringify(payload) });
      const result = await res.json().catch(() => null);
      if (!res.ok || !result || result.status !== "ok" || !result.report_code) {
        setSubmitting(false);
        return showFormError(result?.message || "Gagal menyimpan laporan ke database. Pastikan server database aktif dan coba lagi.");
      }
      lastCreatedCode = result.report_code;
      confirmCodeEl.textContent = result.report_code;
      reportForm.reset();
      syncCategoryFields();
      setSubmitting(false);
      closeFormModal();
      successModal.hidden = false;
      copyCodeBtn?.focus();

      const newReportObj = {
        id: result.report_id || String(Date.now()),
        report_code: result.report_code,
        reporter_name: payload.reporter_name,
        category: payload.category,
        province_pum_code: payload.province_pum_code,
        province_name: payload.province_name,
        regency_pum_code: payload.regency_pum_code,
        regency_bps_code: payload.regency_bps_code,
        regency_name: payload.regency_name,
        period_bucket: new Date().toISOString().slice(0, 10),
        observed_at_utc: payload.observed_at_utc || null,
        description: payload.description || null,
        air_decline_pct: payload.air_decline_pct != null ? payload.air_decline_pct : null,
        air_duration_days: payload.air_duration_days != null ? payload.air_duration_days : null,
        moderation_status: "valid",
        created_at_utc: new Date().toISOString(),
        public_summary: payload.category === "karhutla" ? (payload.description || "Pengamatan indikasi karhutla wilayah.") : `Persepsi penurunan kualitas udara sebesar ${payload.air_decline_pct}% selama ${payload.air_duration_days} hari.`
      };
      const existingIdx = allPublicReports.findIndex(r => r.report_code === result.report_code);
      if (existingIdx >= 0) {
        allPublicReports[existingIdx] = newReportObj;
      } else {
        allPublicReports.unshift(newReportObj);
      }
      activeCategory = payload.category;
      currentPage = 1;
      renderLists();

      broadcastUpdate(result);
      await fetchReportsData();
    } catch (_) {
      setSubmitting(false);
      showFormError("Tidak dapat terhubung ke server database. Data formulir Anda tetap tersimpan di layar, silakan coba kirim ulang setelah server aktif.");
    }
  });

  copyCodeBtn?.addEventListener("click", async () => {
    if (!lastCreatedCode) return;
    try {
      await navigator.clipboard.writeText(lastCreatedCode);
      copyFeedback.textContent = `Kode ${lastCreatedCode} berhasil disalin.`;
    } catch (_) {
      copyFeedback.textContent = `Salin manual kode: ${lastCreatedCode}`;
    }
    copyFeedback.hidden = false;
  });

  $("#find-my-report-btn")?.addEventListener("click", () => {
    const code = lastCreatedCode;
    closeSuccessModal();
    if (!code) return;
    searchInput.value = code;
    highlightAndScrollToCode(code);
  });

  initDurationDropdown();
  syncCategoryFields();
  loadWilayah()
    .then(fetchReportsData)
    .catch(() => listContainer.replaceChildren(el("div", "empty-state", "Gagal memuat daftar laporan.")));
})();
