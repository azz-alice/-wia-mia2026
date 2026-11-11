(() => {
  "use strict";
  const GEOJSON_URL = "./data/indonesia-kabupaten-kota.geojson";
  const PROVINCE_BORDER_URL = "./data/indonesia-provinsi.geojson";
  const HOTSPOT_URL = "./data/hotspots.json";
  const AIR_QUALITY_URL = "./data/air-quality.json";
  const SUMMARY_URL = "./data/city-environment-summary.json";
  const COMMUNITY_SUPPLEMENTARY_URL = "./data/community-supplementary.json";

  const shell = window.SiteShell?.init();
  if (!shell) return;
  const { mapEl, layout, loading, el, cssVar, fmt, title, normalize, getName, getDisplayName, load, showFailure, createMap, bindFitAndControls } = shell;

  const ENV_CONFIG = {
    firmsProduct: "VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT,MODIS_NRT,VIIRS_SNPP_NRT",
    bbox: [94, -12, 142, 7],
    scheduleMinutes: 60,
    livePollSeconds: 60,
    staleAfterHours: 3,
    communityPerception: { minPct: 0, maxPct: 100, stepPct: 10, minDays: 1, maxDays: 35 }
  };

  const REGENCY_HOTSPOT_LEVELS = [
    { min: 51, label: "Sangat tinggi", range: "51+ indikator", v: "--lv-0" },
    { min: 21, label: "Tinggi", range: "21–50 indikator", v: "--lv-1" },
    { min: 6, label: "Sedang", range: "6–20 indikator", v: "--lv-2" },
    { min: 1, label: "Rendah", range: "1–5 indikator", v: "--lv-3" },
    { min: 0, label: "Tidak ada deteksi", range: "0 indikator", v: "--lv-4" }
  ].map(l => ({ ...l, get color() { return cssVar(l.v); } }));

  const LEVELS = [
    { min: 15000, label: "Sangat tinggi", range: "15.000+" },
    { min: 5000, label: "Tinggi", range: "5.000–14.999" },
    { min: 1000, label: "Sedang", range: "1.000–4.999" },
    { min: 100, label: "Rendah", range: "100–999" },
    { min: 0, label: "Sangat rendah", range: "Di bawah 100" }
  ].map((l, i) => ({ ...l, get color() { return cssVar(`--lv-${i}`); } }));

  const ISPU_PM25_LEVELS = [
    { max: 15.5, label: "Baik", range: "0–15,5 µg/m³ (ISPU)", v: "--ispu-baik", smoke: "--smoke-ispu-good" },
    { max: 55.4, label: "Sedang", range: "15,6–55,4 µg/m³ (ISPU)", v: "--ispu-sedang", smoke: "--smoke-ispu-moderate" },
    { max: 150.4, label: "Tidak sehat", range: "55,5–150,4 µg/m³ (ISPU)", v: "--ispu-tidak-sehat", smoke: "--smoke-ispu-unhealthy" },
    { max: 250.4, label: "Sangat tidak sehat", range: "150,5–250,4 µg/m³ (ISPU)", v: "--ispu-sangat-tidak-sehat", smoke: "--smoke-ispu-very-unhealthy" },
    { max: Infinity, label: "Berbahaya", range: ">250,4 µg/m³ (ISPU)", v: "--ispu-berbahaya", smoke: "--smoke-ispu-hazardous" }
  ].map(l => ({ ...l, get color() { return cssVar(l.v); } }));

  const getLevel = c => c == null ? null : (LEVELS.find(l => c >= l.min) || LEVELS[LEVELS.length - 1]);
  const getRegencyHotspotLevel = c => c == null || !Number.isFinite(Number(c)) ? null : (REGENCY_HOTSPOT_LEVELS.find(l => Number(c) >= l.min) || REGENCY_HOTSPOT_LEVELS[REGENCY_HOTSPOT_LEVELS.length - 1]);
  const getIspuLevel = v => v == null || !Number.isFinite(Number(v)) ? null : (ISPU_PM25_LEVELS.find(l => Number(v) <= l.max) || ISPU_PM25_LEVELS[ISPU_PM25_LEVELS.length - 1]);

  const map = createMap();
  if (!map) return;

  const regencyRenderer = L.canvas({ padding: 0.5 });
  const provBorderPane = map.createPane("provinceBorder");
  provBorderPane.style.zIndex = 425;
  provBorderPane.style.pointerEvents = "none";
  const provBorderRenderer = L.canvas({ pane: "provinceBorder", padding: 0.5 });

  Promise.all([
    load(GEOJSON_URL),
    load(PROVINCE_BORDER_URL),
    load(HOTSPOT_URL),
    load(AIR_QUALITY_URL),
    load(SUMMARY_URL).catch(() => null),
    load(COMMUNITY_SUPPLEMENTARY_URL).catch(() => null)
  ])
    .then(([g, pb, d, a, s, cs]) => render(g, pb, d, a, s, cs))
    .catch(err => showFailure(err?.message || "Data tidak dapat dimuat. Periksa koneksi internet atau pastikan folder data tersedia, lalu muat ulang halaman."));

  function render(geojson, provinceBorders, data, airQuality, initialSummary, initialCommunitySupp) {
    if (!geojson?.features?.length) return showFailure("Data batas wilayah tidak valid atau kosong.");
    if (!data || typeof data.provinces !== "object") return showFailure("Data titik panas tidak valid: properti \"provinces\" tidak ditemukan.");
    const entries = Object.entries(data.provinces).map(([n, c]) => [n, Number(c)]).filter(([, c]) => Number.isFinite(c));
    if (!entries.length) return showFailure("Data titik panas kosong.");

    const summaryByPum = new Map();
    const summaryByBps = new Map();
    const communityByPum = new Map();
    const layerByPum = new Map();
    const layerByBps = new Map();
    let lastGeneratedAt = initialSummary?.generated_at_utc || null;
    let lastCommunityUpdatedAt = initialCommunitySupp?.updated_at_utc || null;
    let pollInFlight = false;

    const indexCommunitySupplementary = payload => {
      communityByPum.clear();
      if (!payload || typeof payload.regencies !== "object") return;
      Object.entries(payload.regencies).forEach(([pum, entry]) => {
        if (pum && entry) communityByPum.set(String(pum).trim(), entry);
      });
    };

    const communitySupplementaryFromGroups = groups => {
      const regencies = {};
      groups.forEach(group => {
        const pum = String(group?.regency_pum_code || "").trim();
        if (!pum || group?.category !== "karhutla") return;
        const valid = Number(group.valid_report_count) || 0;
        const approved = Number(group.approved_report_count) || 0;
        const eligible = group.eligible_report_count == null
          ? (valid >= 5 ? valid : approved)
          : Number(group.eligible_report_count) || 0;
        if (!valid && !eligible) return;

        let entry = regencies[pum];
        if (!entry) {
          entry = {
            regency_pum_code: pum,
            karhutla: { valid_report_count: 0, eligible_report_count: 0 }
          };
          regencies[pum] = entry;
        }
        entry.karhutla.valid_report_count += valid;
        entry.karhutla.eligible_report_count += eligible;
      });
      return { regencies };
    };

    if (initialCommunitySupp) {
      indexCommunitySupplementary(initialCommunitySupp);
    }

    const getCommunityEntry = f => {
      const pum = String(f?.properties?.regency_pum_code || "").trim();
      return pum ? (communityByPum.get(pum) || null) : null;
    };

    const indexSummaryRow = row => {
      if (!row || typeof row !== "object") return;
      const pum = String(row.regency_pum_code || "").trim();
      const bps = String(row.regency_bps_code || "").trim();
      if (pum) summaryByPum.set(pum, row);
      if (bps) summaryByBps.set(bps, row);
    };

    if (Array.isArray(initialSummary?.regencies)) {
      initialSummary.regencies.forEach(indexSummaryRow);
    }

    const getRegencySummary = f => {
      const p = f?.properties;
      if (!p) return null;
      const pum = String(p.regency_pum_code || "").trim();
      const bps = String(p.regency_bps_code || "").trim();
      return (pum && summaryByPum.get(pum)) || (bps && summaryByBps.get(bps)) || null;
    };

    const getRegencyIndicators = f => {
      const rs = getRegencySummary(f);
      const comm = getCommunityEntry(f);
      const officialCount = rs && rs.hotspot_count_24h != null && Number.isFinite(Number(rs.hotspot_count_24h))
        ? Number(rs.hotspot_count_24h)
        : null;
      let communityCount = 0;
      if (comm?.karhutla && Number.isFinite(Number(comm.karhutla.eligible_report_count))) {
        communityCount = Number(comm.karhutla.eligible_report_count);
      } else if (comm?.karhutla && Number.isFinite(Number(comm.karhutla.valid_report_count))) {
        communityCount = Number(comm.karhutla.valid_report_count);
      } else if (rs && Number.isFinite(Number(rs.community_karhutla_count))) {
        communityCount = Number(rs.community_karhutla_count);
      }
      const combinedCount = (officialCount != null || communityCount > 0)
        ? ((officialCount ?? 0) + communityCount)
        : null;
      const status = rs?.hotspot_status || (officialCount != null ? "ok" : "no_data");
      return {
        officialCount,
        communityCount,
        combinedCount,
        status,
        level: getRegencyHotspotLevel(combinedCount)
      };
    };

    const airGrid = airQuality?.grid;
    const airLats = Array.isArray(airGrid?.latitudes) ? airGrid.latitudes : [];
    const airLons = Array.isArray(airGrid?.longitudes) ? airGrid.longitudes : [];
    const airValues = Array.isArray(airGrid?.pm25_ugm3) ? airGrid.pm25_ugm3 : [];

    const pointInRing = (lon, lat, ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
      }
      return inside;
    };
    const geomBbox = geom => {
      if (geom._bbox) return geom._bbox;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      for (let p = 0; p < polys.length; p++) {
        const ring = polys[p][0];
        for (let i = 0; i < ring.length; i++) {
          const [x, y] = ring[i];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return (geom._bbox = [minX, minY, maxX, maxY]);
    };
    const pointInFeature = (lon, lat, geom) => {
      if (!geom || !Array.isArray(geom.coordinates)) return false;
      const [minX, minY, maxX, maxY] = geomBbox(geom);
      if (lon < minX || lon > maxX || lat < minY || lat > maxY) return false;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      return polys.some(p => pointInRing(lon, lat, p[0]) && !p.slice(1).some(r => pointInRing(lon, lat, r)));
    };

    const provFeatureByKey = new Map();
    if (Array.isArray(provinceBorders?.features)) {
      provinceBorders.features.forEach(pf => provFeatureByKey.set(normalize(getName(pf)), pf));
    }
    const pm25Cache = new Map();
    const provincePm25 = f => {
      const key = normalize(getName(f));
      if (pm25Cache.has(key)) return pm25Cache.get(key);
      const target = provFeatureByKey.get(key) || f;
      const vals = [];
      for (let yi = 0; yi < airLats.length; yi++) {
        const row = airValues[yi];
        if (!Array.isArray(row)) continue;
        const lat = airLats[yi];
        for (let xi = 0; xi < airLons.length; xi++) {
          const v = row[xi];
          if (typeof v === "number" && Number.isFinite(v) && pointInFeature(airLons[xi], lat, target.geometry)) vals.push(v);
        }
      }
      const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      pm25Cache.set(key, avg);
      return avg;
    };

    const counts = new Map(entries.map(([n, c]) => [normalize(n), c]));
    const infoOf = f => {
      const k = normalize(getName(f)), count = counts.has(k) ? counts.get(k) : null;
      const regSummary = getRegencySummary(f);
      const indicators = getRegencyIndicators(f);
      const regPm25 = regSummary?.pm25_24h_ugm3;
      return {
        name: getDisplayName(f),
        provinceName: title(getName(f)),
        provinceKey: k,
        regencyCode: f?.properties?.regency_pum_code || f?.properties?.regency_bps_code || "",
        count,
        level: getLevel(count),
        regSummary,
        indicators,
        regHotspotLevel: indicators.level,
        regIspuLevel: getIspuLevel(regPm25)
      };
    };

    const ABBR = {
      "ACEH": "Aceh", "BALI": "Bali", "BANTEN": "Banten", "BENGKULU": "Bengkulu",
      "DAERAH ISTIMEWA YOGYAKARTA": "DIY", "DKI JAKARTA": "DKI", "GORONTALO": "Gorontalo",
      "JAMBI": "Jambi", "JAWA BARAT": "Jabar", "JAWA TENGAH": "Jateng", "JAWA TIMUR": "Jatim",
      "KALIMANTAN BARAT": "Kalbar", "KALIMANTAN SELATAN": "Kalsel", "KALIMANTAN TENGAH": "Kalteng",
      "KALIMANTAN TIMUR": "Kaltim", "KALIMANTAN UTARA": "Kaltara", "KEPULAUAN BANGKA BELITUNG": "Babel",
      "KEPULAUAN RIAU": "Kepri", "LAMPUNG": "Lampung", "MALUKU": "Maluku", "MALUKU UTARA": "Malut",
      "NUSA TENGGARA BARAT": "NTB", "NUSA TENGGARA TIMUR": "NTT", "PAPUA": "Papua",
      "PAPUA BARAT": "Pabar", "PAPUA BARAT DAYA": "PBD", "PAPUA PEGUNUNGAN": "Papeg",
      "PAPUA SELATAN": "Pasel", "PAPUA TENGAH": "Pateng", "RIAU": "Riau", "SULAWESI BARAT": "Sulbar",
      "SULAWESI SELATAN": "Sulsel", "SULAWESI TENGAH": "Sulteng", "SULAWESI TENGGARA": "Sultra",
      "SULAWESI UTARA": "Sulut", "SUMATERA BARAT": "Sumbar", "SUMATERA SELATAN": "Sumsel",
      "SUMATERA UTARA": "Sumut"
    };

    const statsView = el("div", "map-stats-view");
    statsView.hidden = true;
    layout.append(statsView);
    let statsBuilt = false;

    const buildStatsView = () => {
      if (statsBuilt) return;
      statsBuilt = true;
      const provList = Array.isArray(provinceBorders?.features) && provinceBorders.features.length ? provinceBorders.features : geojson.features;
      const pm25ByProv = new Map();
      provList.forEach(f => {
        const k = normalize(getName(f));
        if (!pm25ByProv.has(k)) pm25ByProv.set(k, provincePm25(f) ?? 0);
      });

      const chartProvinces = entries
        .map(([n, c]) => {
          const key = normalize(n);
          return { key, name: title(n), shortName: ABBR[key] || title(n), hotspots: c, pm25: pm25ByProv.get(key) ?? 0 };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "id"));

      const statsHeader = el("div", "stats-header");
      const statsTitleGroup = el("div", "stats-title-group");
      statsTitleGroup.append(
        el("h3", "stats-title", "Statistik Karhutla & Kesehatan Udara"),
        el("p", "stats-desc", "Jumlah titik panas (kiri) dan rata-rata PM2.5 (kanan) berdasarkan provinsi")
      );

      const statsLegend = el("div", "stats-legend");
      const legHot = el("span", "stats-legend-item is-hot");
      legHot.append(el("i"), "Titik panas");
      const legAir = el("span", "stats-legend-item is-air");
      legAir.append(el("i"), "Kesehatan udara (PM2.5)");
      statsLegend.append(legHot, legAir);
      statsHeader.append(statsTitleGroup, statsLegend);

      const maxHotspots = Math.max(...chartProvinces.map(d => d.hotspots), 1);
      const yMaxHot = Math.ceil(maxHotspots / 20000) * 20000;
      const yTicksHot = [0, yMaxHot * 0.25, yMaxHot * 0.5, yMaxHot * 0.75, yMaxHot];

      const maxAir = Math.max(...chartProvinces.map(d => d.pm25), 1);
      const stepAir = maxAir > 100 ? 50 : 25;
      const yMaxAir = Math.max(stepAir * 4, Math.ceil(maxAir / stepAir) * stepAir);
      const yTicksAir = [0, yMaxAir * 0.25, yMaxAir * 0.5, yMaxAir * 0.75, yMaxAir];

      const svgWidth = 1000, svgHeight = 420, padLeft = 65, padRight = 55, padTop = 25, padBottom = 65;
      const chartW = svgWidth - padLeft - padRight, chartH = svgHeight - padTop - padBottom;
      const svgEl = (tag, attrs) => {
        const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
        Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
        return n;
      };

      const chartWrap = el("div", "stats-chart-wrap");
      const svg = svgEl("svg", { viewBox: `0 0 ${svgWidth} ${svgHeight}`, class: "stats-svg", "aria-hidden": "true" });
      const tooltip = el("div", "stats-tooltip");
      tooltip.hidden = true;

      yTicksHot.forEach((tHot, i) => {
        const y = Math.round(padTop + chartH - (tHot / yMaxHot) * chartH);
        svg.append(
          svgEl("line", { x1: padLeft, y1: y, x2: padLeft + chartW, y2: y, class: "stats-grid-line" }),
          Object.assign(svgEl("text", { x: padLeft - 10, y: y + 4, class: "stats-y-label-left" }), { textContent: fmt(tHot) }),
          Object.assign(svgEl("text", { x: padLeft + chartW + 10, y: y + 4, class: "stats-y-label-right" }), { textContent: fmt(yTicksAir[i]) })
        );
      });

      svg.append(
        svgEl("line", { x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + chartH, class: "stats-axis-line" }),
        svgEl("line", { x1: padLeft + chartW, y1: padTop, x2: padLeft + chartW, y2: padTop + chartH, class: "stats-axis-line" }),
        svgEl("line", { x1: padLeft, y1: padTop + chartH, x2: padLeft + chartW, y2: padTop + chartH, class: "stats-axis-line" })
      );

      const stepX = chartW / (chartProvinces.length - 1);
      const ptsHot = [], ptsAir = [], dotsHot = [], dotsAir = [], xLabels = [];
      const guideLine = svgEl("line", { x1: 0, y1: padTop, x2: 0, y2: padTop + chartH, class: "stats-guide-line" });
      guideLine.style.display = "none";
      svg.append(guideLine);

      chartProvinces.forEach((item, idx) => {
        const x = Math.round(padLeft + idx * stepX);
        const yHot = Math.round(padTop + chartH - (item.hotspots / yMaxHot) * chartH);
        const yAir = Math.round(padTop + chartH - (item.pm25 / yMaxAir) * chartH);
        ptsHot.push([x, yHot]);
        ptsAir.push([x, yAir]);
        svg.append(svgEl("line", { x1: x, y1: padTop + chartH, x2: x, y2: padTop + chartH + 5, class: "stats-tick" }));
        const lbl = svgEl("text", { x, y: padTop + chartH + 16, transform: `rotate(-45, ${x}, ${padTop + chartH + 16})`, class: "stats-x-label" });
        lbl.textContent = item.shortName;
        xLabels.push(lbl);
        svg.append(lbl);
      });

      svg.append(
        svgEl("polyline", { points: ptsAir.map(p => p.join(",")).join(" "), class: "stats-line-air-halo" }),
        svgEl("polyline", { points: ptsAir.map(p => p.join(",")).join(" "), class: "stats-line-air" }),
        svgEl("polyline", { points: ptsHot.map(p => p.join(",")).join(" "), class: "stats-line-hot" })
      );

      ptsAir.forEach(([x, y]) => {
        const dot = svgEl("circle", { cx: x, cy: y, r: 3.5, class: "stats-dot-air" });
        dotsAir.push(dot);
        svg.append(dot);
      });
      ptsHot.forEach(([x, y]) => {
        const dot = svgEl("circle", { cx: x, cy: y, r: 3.5, class: "stats-dot-hot" });
        dotsHot.push(dot);
        svg.append(dot);
      });

      const selectPoint = idx => {
        dotsHot.forEach((d, i) => d.classList.toggle("is-active", i === idx));
        dotsAir.forEach((d, i) => d.classList.toggle("is-active", i === idx));
        xLabels.forEach((l, i) => l.classList.toggle("is-active", i === idx));
        const item = chartProvinces[idx];
        const [x] = ptsHot[idx];
        guideLine.setAttribute("x1", x);
        guideLine.setAttribute("x2", x);
        guideLine.style.display = "block";
        tooltip.innerHTML = `<span class="stats-tooltip-name">${item.name}</span><span class="stats-tooltip-hot">${fmt(item.hotspots)} titik panas</span><span class="stats-tooltip-air">${item.pm25.toFixed(1).replace(".", ",")} µg/m³ PM2.5</span>`;
        tooltip.hidden = false;
        const r = chartWrap.getBoundingClientRect();
        const tw = tooltip.offsetWidth || 150, th = tooltip.offsetHeight || 56;
        let left = (x / svgWidth) * r.width - tw / 2;
        let top = Math.min((ptsHot[idx][1] / svgHeight) * r.height, (ptsAir[idx][1] / svgHeight) * r.height) - th - 12;
        if (left < 6) left = 6;
        if (left + tw > r.width - 6) left = r.width - tw - 6;
        if (top < 6) top = Math.max((ptsHot[idx][1] / svgHeight) * r.height, (ptsAir[idx][1] / svgHeight) * r.height) + 12;
        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
      };

      chartProvinces.forEach((_, idx) => {
        const [x] = ptsHot[idx];
        const hitW = Math.round(stepX);
        const hit = svgEl("rect", { x: Math.round(x - hitW / 2), y: padTop, width: hitW, height: chartH, fill: "transparent", class: "stats-hit-area" });
        const activate = () => selectPoint(idx);
        hit.addEventListener("mouseenter", activate);
        hit.addEventListener("click", activate);
        hit.addEventListener("touchstart", e => { activate(); e.stopPropagation(); }, { passive: true });
        dotsHot[idx].addEventListener("mouseenter", activate);
        dotsHot[idx].addEventListener("click", activate);
        dotsAir[idx].addEventListener("mouseenter", activate);
        dotsAir[idx].addEventListener("click", activate);
        xLabels[idx].addEventListener("mouseenter", activate);
        xLabels[idx].addEventListener("click", activate);
        svg.append(hit);
      });

      chartWrap.append(svg, tooltip);
      chartWrap.addEventListener("pointerleave", () => {
        dotsHot.forEach(dot => dot.classList.remove("is-active"));
        dotsAir.forEach(dot => dot.classList.remove("is-active"));
        xLabels.forEach(label => label.classList.remove("is-active"));
        guideLine.style.display = "none";
        tooltip.hidden = true;
      });
      statsView.append(statsHeader, chartWrap);
    };

    let activeMode = "hotspots", selected = null;

    const resolveHotspotFill = f => {
      const ind = getRegencyIndicators(f);
      if ((ind.status === "error" || ind.status === "no_data") && ind.combinedCount == null) {
        return cssVar("--st-unknown");
      }
      if (ind.combinedCount != null && ind.level) {
        return ind.level.color;
      }
      return cssVar("--st-unknown");
    };

    const resolveAirFill = f => {
      const summaryValue = getRegencySummary(f)?.pm25_24h_ugm3;
      const pm25 = summaryValue != null && Number.isFinite(Number(summaryValue))
        ? Number(summaryValue)
        : provincePm25(f);
      return getIspuLevel(pm25)?.color || cssVar("--ispu-nodata");
    };

    const baseStyle = f => ({
      renderer: regencyRenderer,
      stroke: true,
      color: cssVar("--regency-edge"),
      weight: 0.65,
      opacity: 0.88,
      fillColor: activeMode === "air" ? resolveAirFill(f) : resolveHotspotFill(f),
      fillOpacity: 0.96
    });

    const provinceBorderStyle = () => ({
      renderer: provBorderRenderer,
      pane: "provinceBorder",
      stroke: true,
      color: cssVar("--province-edge"),
      weight: 1.5,
      opacity: 1,
      fill: false,
      interactive: false
    });

    const popupContent = (info, feature) => {
      const currentInfo = feature ? infoOf(feature) : info;
      const rs = currentInfo.regSummary;
      const comm = feature ? getCommunityEntry(feature) : null;
      const commKu = comm?.kualitas_udara;
      const ind = currentInfo.indicators || (feature ? getRegencyIndicators(feature) : { officialCount: null, communityCount: 0, combinedCount: null, status: "no_data", level: null });
      const box = el("div", "province-popup");
      box.append(el("h3", "popup-title", currentInfo.name));

      if (activeMode === "air") {
        const cityPm25 = rs?.pm25_24h_ugm3 != null ? Number(rs.pm25_24h_ugm3) : (feature ? provincePm25(feature) : null);
        if (cityPm25 == null || !Number.isFinite(cityPm25)) {
          box.append(el("p", "popup-meta", `OpenAQ (${currentInfo.regencyCode || "-"}): No Data (belum ada pengukuran PM2.5 di wilayah ini).`));
        } else {
          const cnt = el("p", "popup-count"), lvl = getIspuLevel(cityPm25), badge = el("p", "popup-level"), dot = el("i");
          cnt.append(el("strong", null, `${cityPm25.toFixed(1).replace(".", ",")} µg/m³`), "PM2.5 (24 jam)");
          dot.setAttribute("aria-hidden", "true");
          dot.style.background = lvl ? lvl.color : cssVar("--ispu-nodata");
          badge.append(dot, `ISPU ${lvl ? lvl.label.toLowerCase() : "tidak diketahui"}`);
          box.append(cnt, badge);

          if (rs) {
            const stText = rs.pm25_valid_station_count > 0
              ? `Kode ${rs.regency_pum_code} · ${rs.pm25_valid_station_count} stasiun OpenAQ aktif`
              : `Kode ${rs.regency_pum_code} · Observasi wilayah (belum ada sensor darat lokal)`;
            box.append(el("p", "popup-meta", stText));
          }
        }

        const provAvg = feature ? provincePm25(feature) : null;
        if (provAvg != null) {
          box.append(el("p", "popup-meta", `Rata-rata Provinsi ${currentInfo.provinceName}: ${provAvg.toFixed(1).replace(".", ",")} µg/m³`));
        }

        const airCommCount = Number(commKu?.eligible_report_count ?? commKu?.valid_report_count ?? rs?.community_report_count ?? 0);
        const airCommPct = commKu?.avg_air_decline_pct ?? rs?.community_perception_avg_pct;
        const airCommDays = commKu?.avg_air_duration_days ?? rs?.community_duration_avg_days;
        if (airCommCount > 0 && airCommPct != null) {
          box.append(
            el(
              "p",
              "popup-meta",
              `Laporan Masyarakat Memenuhi Syarat (Terpisah dari PM2.5 Resmi): Penurunan dirasakan rata-rata ${Number(airCommPct).toFixed(1).replace(".0", "")}% selama rata-rata ${Number(airCommDays || 1).toFixed(1).replace(".0", "")} hari (${airCommCount} laporan).`
            )
          );
        }
        return box;
      }

      const cnt = el("p", "popup-count");
      cnt.append(el("strong", null, fmt(ind.combinedCount ?? 0)), "titik panas");
      box.append(cnt);
      return box;
    };

    const hover = l => {
      if (l === selected) return;
      l.setStyle({ stroke: true, color: cssVar("--province-edge"), weight: 1.25, opacity: 1, fillOpacity: 1 });
    };
    const unhover = l => { if (l !== selected) provinces.resetStyle(l); };
    const select = l => {
      if (selected && selected !== l) provinces.resetStyle(selected);
      selected = l;
      l.setStyle({ stroke: true, color: cssVar("--province-edge"), weight: 1.25, opacity: 1, fillOpacity: 1 });
    };
    const clearSelection = l => { if (selected === l) { provinces.resetStyle(l); selected = null; } };
    const clearMapEffects = () => {
      map.closePopup();
      if (map._tooltip?.isOpen()) map.closeTooltip();
      if (selected) {
        provinces.resetStyle(selected);
        selected = null;
      }
    };

    const provinces = L.geoJSON(geojson, {
      style: baseStyle,
      onEachFeature: (f, layer) => {
        const info = infoOf(f);
        const pum = String(f?.properties?.regency_pum_code || "").trim();
        const bps = String(f?.properties?.regency_bps_code || "").trim();
        if (pum) layerByPum.set(pum, layer);
        if (bps) layerByBps.set(bps, layer);

        layer.bindTooltip(info.name, { sticky: true, direction: "top", opacity: 1, className: "province-tooltip" });
        layer.bindPopup(() => popupContent(info, layer.feature), { className: "province-popup-wrap", maxWidth: 280, minWidth: 180, autoPan: false });
        layer.on({
          mouseover: () => hover(layer),
          mouseout: () => unhover(layer),
          click: () => select(layer),
          popupopen: () => layer.closeTooltip(),
          popupclose: () => clearSelection(layer)
        });
      }
    }).addTo(map);
    map.getContainer().addEventListener("pointerleave", clearMapEffects);

    const provBordersLayer = provinceBorders?.features?.length
      ? L.geoJSON(provinceBorders, {
          pane: "provinceBorder",
          interactive: false,
          style: provinceBorderStyle
        }).addTo(map)
      : null;

    const refreshLayerVisual = targetLayer => {
      if (!targetLayer) return;
      if (selected === targetLayer) {
        targetLayer.setStyle({
          ...baseStyle(targetLayer.feature),
          stroke: true,
          color: cssVar("--province-edge"),
          weight: 1.25,
          opacity: 1,
          fillOpacity: 1
        });
        if (map._popup && targetLayer.isPopupOpen()) {
          targetLayer.setPopupContent(popupContent(infoOf(targetLayer.feature), targetLayer.feature));
        }
      } else {
        targetLayer.setStyle(baseStyle(targetLayer.feature));
      }
    };

    const applyRegencyUpdate = row => {
      if (!row || typeof row !== "object") return false;
      indexSummaryRow(row);
      const pum = String(row.regency_pum_code || "").trim();
      const bps = String(row.regency_bps_code || "").trim();
      const targetLayer = (pum && layerByPum.get(pum)) || (bps && layerByBps.get(bps)) || null;
      if (!targetLayer) return false;
      refreshLayerVisual(targetLayer);
      return true;
    };

    const refreshAllLayers = () => {
      provinces.eachLayer(l => {
        if (l !== selected) provinces.resetStyle(l);
      });
      if (selected) refreshLayerVisual(selected);
    };

    window.WiaEnvironmentMap = {
      config: ENV_CONFIG,
      regencyHotspotLevels: REGENCY_HOTSPOT_LEVELS,
      ispuPm25Levels: ISPU_PM25_LEVELS,
      applyRegencyUpdate,
      refreshAllLayers,
      getRegencySummaryByCode: code => summaryByPum.get(String(code)) || summaryByBps.get(String(code)) || null,
      getCommunityEntryByCode: code => communityByPum.get(String(code)) || null,
      getRegencyIndicatorsByCode: code => {
        const layer = layerByPum.get(String(code)) || layerByBps.get(String(code));
        return layer ? getRegencyIndicators(layer.feature) : null;
      }
    };

    const pollLocalSummary = (force = false) => {
      if ((!force && document.hidden) || pollInFlight) return;
      pollInFlight = true;
      const sbUrl = window.ENV_SUPABASE_URL;
      const sbAnonKey = window.ENV_SUPABASE_ANON_KEY;
      const localSummaryRequest = fetch(SUMMARY_URL, { cache: "no-cache" })
        .then(r => (r.ok ? r.json() : null))
        .then(payload => {
          if (!payload || !Array.isArray(payload.regencies)) return;
          if (!force && payload.generated_at_utc && payload.generated_at_utc === lastGeneratedAt) return;
          lastGeneratedAt = payload.generated_at_utc || String(Date.now());
          payload.regencies.forEach(applyRegencyUpdate);
        })
        .catch(() => {});

      const communityRequest = sbUrl && sbAnonKey
        ? fetch(`${sbUrl.replace(/\/$/, "")}/functions/v1/community-reports?mode=public&limit=5`, {
            headers: { apikey: sbAnonKey, Authorization: `Bearer ${sbAnonKey}` },
            cache: "no-store"
          })
            .then(r => (r.ok ? r.json() : null))
            .then(payload => {
              if (!Array.isArray(payload?.groups)) return;
              const signature = JSON.stringify(payload.groups
                .map(group => [
                  group.group_key,
                  group.updated_at_utc,
                  group.valid_report_count,
                  group.approved_report_count,
                  group.eligible_report_count
                ])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
              if (!force && signature === lastCommunityUpdatedAt) return;
              lastCommunityUpdatedAt = signature;
              indexCommunitySupplementary(communitySupplementaryFromGroups(payload.groups));
              refreshAllLayers();
            })
            .catch(() => {})
        : fetch(COMMUNITY_SUPPLEMENTARY_URL, { cache: "no-cache" })
            .then(r => (r.ok ? r.json() : null))
            .then(payload => {
              if (!payload || typeof payload.regencies !== "object") return;
              if (!force && payload.updated_at_utc && payload.updated_at_utc === lastCommunityUpdatedAt) return;
              lastCommunityUpdatedAt = payload.updated_at_utc || String(Date.now());
              indexCommunitySupplementary(payload);
              refreshAllLayers();
            })
            .catch(() => {});

      const remoteSummaryRequest = sbUrl && sbAnonKey
        ? fetch(`${sbUrl.replace(/\/$/, "")}/rest/v1/city_environment_summary?select=*`, {
            headers: { apikey: sbAnonKey, Authorization: `Bearer ${sbAnonKey}` },
            cache: "no-store"
          })
            .then(r => (r.ok ? r.json() : null))
            .then(rows => {
              if (Array.isArray(rows)) rows.forEach(applyRegencyUpdate);
            })
            .catch(() => {})
        : Promise.resolve();

      Promise.all([localSummaryRequest, communityRequest, remoteSummaryRequest]).finally(() => { pollInFlight = false; });
    };

    setInterval(() => pollLocalSummary(false), ENV_CONFIG.livePollSeconds * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollLocalSummary(true);
    });
    window.addEventListener("storage", e => {
      if (e.key === "wia-mia-last-update-ts") {
        pollLocalSummary(true);
      }
    });
    if ("BroadcastChannel" in window) {
      const bc = new BroadcastChannel("wia-mia-realtime-updates");
      bc.addEventListener("message", () => {
        pollLocalSummary(true);
      });
    }

    pollLocalSummary(true);

    const renderLegend = (node, mode = activeMode) => {
      if (!node) return;
      const items = mode === "air"
        ? [...ISPU_PM25_LEVELS, { label: "Tidak ada data", range: "Belum tersedia", color: cssVar("--ispu-nodata") }]
        : REGENCY_HOTSPOT_LEVELS;
      node.replaceChildren(...items.map(item => {
        const row = el("div", "legend-item"), sw = el("span", "legend-swatch"), txt = el("span", "legend-text");
        sw.style.background = item.color || cssVar(item.v);
        sw.setAttribute("aria-hidden", "true");
        txt.append(el("b", null, item.label), el("small", null, item.range));
        row.append(sw, txt);
        return row;
      }));
    };

    const { fit, getLegendContent } = bindFitAndControls(map, provinces, node => renderLegend(node, "hotspots"));

    new MutationObserver(() => {
      renderLegend(getLegendContent(), activeMode);
      provinces.eachLayer(l => provinces.resetStyle(l));
      if (provBordersLayer) provBordersLayer.eachLayer(l => provBordersLayer.resetStyle(l));
      if (selected) select(selected);
      if (map._popup && selected) selected.openPopup(selected.getBounds().getCenter());
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const modeBar = el("div", "map-mode-bar");
    const hotBtn = el("button", "map-mode-btn is-active", "Karhutla");
    const airBtn = el("button", "map-mode-btn", "Kualitas udara");
    const statBtn = el("button", "map-mode-btn", "Statistik");
    hotBtn.type = airBtn.type = statBtn.type = "button";
    hotBtn.setAttribute("aria-pressed", "true");
    airBtn.setAttribute("aria-pressed", "false");
    statBtn.setAttribute("aria-pressed", "false");
    modeBar.append(hotBtn, airBtn, statBtn);
    layout.append(modeBar);

    const setMode = mode => {
      const isStats = mode === "stats";
      if (!isStats) activeMode = mode;
      hotBtn.classList.toggle("is-active", mode === "hotspots");
      airBtn.classList.toggle("is-active", mode === "air");
      statBtn.classList.toggle("is-active", isStats);
      hotBtn.setAttribute("aria-pressed", String(mode === "hotspots"));
      airBtn.setAttribute("aria-pressed", String(mode === "air"));
      statBtn.setAttribute("aria-pressed", String(isStats));

      if (isStats) {
        map.closePopup();
        buildStatsView();
        statsView.hidden = false;
        mapEl.style.visibility = "hidden";
        mapEl.setAttribute("aria-hidden", "true");
      } else {
        statsView.hidden = true;
        mapEl.style.visibility = "";
        mapEl.removeAttribute("aria-hidden");
        provinces.eachLayer(l => provinces.resetStyle(l));
        if (selected) select(selected);
        renderLegend(getLegendContent(), mode);
        map.invalidateSize({ animate: false });
        fit();
        if (map._popup && selected) selected.openPopup(selected.getBounds().getCenter());
      }
    };
    hotBtn.addEventListener("click", () => setMode("hotspots"));
    airBtn.addEventListener("click", () => setMode("air"));
    statBtn.addEventListener("click", () => setMode("stats"));

    loading.remove();
  }
})();
