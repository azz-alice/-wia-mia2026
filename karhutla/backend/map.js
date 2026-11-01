(() => {
  "use strict";
  const GEOJSON_URL = "./data/indonesia-38-provinces.json";
  const HOTSPOT_URL = "./data/hotspots.json";
  const AIR_QUALITY_URL = "./data/air-quality.json";
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const LEVELS = [
    { min: 15000, label: "Sangat tinggi", range: "15.000+" },
    { min: 5000, label: "Tinggi", range: "5.000–14.999" },
    { min: 1000, label: "Sedang", range: "1.000–4.999" },
    { min: 100, label: "Rendah", range: "100–999" },
    { min: 0, label: "Sangat rendah", range: "Di bawah 100" }
  ].map((l, i) => ({ ...l, get color() { return cssVar(`--lv-${i}`); } }));
  const PM25_LEVELS = [
    { max: 12, stop: 12, color: [45, 212, 191], alpha: 0.28, label: "Baik", range: "0–12 µg/m³" },
    { max: 35.4, stop: 28, color: [14, 165, 233], alpha: 0.54, label: "Sedang", range: "12,1–35,4 µg/m³" },
    { max: 55.4, stop: 48, color: [37, 99, 235], alpha: 0.74, label: "Tidak sehat", range: "35,5–55,4 µg/m³" },
    { max: Infinity, stop: 72, color: [67, 56, 202], alpha: 0.90, label: "Berbahaya", range: ">55,4 µg/m³" }
  ];
  const pm25DisplayColor = item => {
    const f = document.documentElement.dataset.theme === "light" ? 0.94 : 1.15;
    const rgb = item.color.map(c => Math.min(255, c * f));
    const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return rgb.map(c => Math.round(Math.max(0, Math.min(255, g + (c - g) * 1.45))));
  };
  const edgeStyle = mode => mode === "air"
    ? { stroke: true, color: cssVar("--edge"), weight: 1.25, opacity: 0.9 }
    : { stroke: false, weight: 0, opacity: 0 };
  const ACRONYMS = new Set(["DKI", "DI"]);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = matchMedia("(pointer: coarse)").matches;
  class DataError extends Error {}
  const fmt = n => n.toLocaleString("id-ID");
  const title = s => String(s).toLowerCase().replace(/\S+/g, w => ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  const normalize = name => String(name || "").toUpperCase().replace(/^PROVINSI\s+/, "").replace(/[.]/g, "").replace(/[^A-Z0-9]+/g, " ").trim();
  const getName = f => f?.properties?.PROVINSI || "";
  const getLevel = c => c == null ? null : (LEVELS.find(l => c >= l.min) || LEVELS[LEVELS.length - 1]);
  const getColor = c => (getLevel(c) || { color: cssVar("--muted") }).color;
  const load = url => fetch(url).then(r => { if (!r.ok) throw new DataError(`Berkas ${url} tidak dapat dimuat (status ${r.status}).`); return r.json(); });

  const shell = window.SiteShell?.init();
  if (!shell) return;
  const { mapEl, layout, loading, el } = shell;

  const showFailure = msg => {
    loading.remove();
    layout.querySelectorAll(".map-status.is-error").forEach(n => n.remove());
    const box = el("div", "map-status is-error");
    box.setAttribute("role", "alert");
    const retry = el("button", null, "Muat ulang halaman");
    retry.type = "button";
    retry.addEventListener("click", () => location.reload());
    box.append(el("strong", null, "Peta belum dapat ditampilkan"), el("span", null, msg), retry);
    layout.append(box);
  };

  if (typeof L === "undefined") return showFailure("Pustaka peta gagal dimuat. Periksa koneksi internet Anda, lalu muat ulang halaman.");

  const map = L.map(mapEl, {
    scrollWheelZoom: false, zoomControl: false, attributionControl: false, zoomSnap: 0,
    zoomAnimation: !reduceMotion, fadeAnimation: !reduceMotion, markerZoomAnimation: !reduceMotion
  });
  const airPane = map.createPane("airQuality");
  airPane.style.zIndex = 420;
  airPane.style.pointerEvents = "none";
  map.createPane("provinceOverlay").style.zIndex = 400;
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const zoomInBtn = mapEl.querySelector(".leaflet-control-zoom-in");
  const zoomOutBtn = mapEl.querySelector(".leaflet-control-zoom-out");
  if (zoomInBtn) {
    zoomInBtn.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 2v10M2 7h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (zoomOutBtn) {
    zoomOutBtn.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2 7h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }

  let panPt = null;
  mapEl.addEventListener("contextmenu", e => e.preventDefault());
  mapEl.addEventListener("mousedown", e => { if (e.button === 2) { panPt = [e.clientX, e.clientY]; e.preventDefault(); } });
  addEventListener("mouseup", e => { if (e.button === 2) panPt = null; });
  mapEl.addEventListener("mousemove", e => {
    if (!panPt) return;
    map.panBy([panPt[0] - e.clientX, panPt[1] - e.clientY], { animate: false });
    panPt = [e.clientX, e.clientY];
  });
  mapEl.addEventListener("wheel", e => {
    if (!panPt) return;
    e.preventDefault();
    const r = mapEl.getBoundingClientRect();
    map.setZoomAround(L.point(e.clientX - r.left, e.clientY - r.top), map.getZoom() + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  Promise.all([load(GEOJSON_URL), load(HOTSPOT_URL), load(AIR_QUALITY_URL)])
    .then(([g, d, a]) => render(g, d, a))
    .catch(err => showFailure(err instanceof DataError ? err.message : "Data tidak dapat dimuat. Periksa koneksi internet atau pastikan folder data tersedia, lalu muat ulang halaman."));

  function render(geojson, data, airQuality) {
    if (!geojson?.features?.length) throw new DataError("Data batas wilayah provinsi tidak valid atau kosong.");
    if (!data || typeof data.provinces !== "object") throw new DataError("Data titik panas tidak valid: properti \"provinces\" tidak ditemukan.");
    const entries = Object.entries(data.provinces).map(([n, c]) => [n, Number(c)]).filter(([, c]) => Number.isFinite(c));
    if (!entries.length) throw new DataError("Data titik panas kosong.");

    const airGrid = airQuality?.grid;
    const airLats = Array.isArray(airGrid?.latitudes) ? airGrid.latitudes : [];
    const airLons = Array.isArray(airGrid?.longitudes) ? airGrid.longitudes : [];
    const airValues = Array.isArray(airGrid?.pm25_ugm3) ? airGrid.pm25_ugm3 : [];
    const pm25Color = v => PM25_LEVELS.find(item => v <= item.max) || PM25_LEVELS[PM25_LEVELS.length - 1];

    const pointInRing = (lon, lat, ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
      }
      return inside;
    };
    const pointInFeature = (lon, lat, geom) => {
      if (!geom || !Array.isArray(geom.coordinates)) return false;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      return polys.some(p => pointInRing(lon, lat, p[0]) && !p.slice(1).some(r => pointInRing(lon, lat, r)));
    };
    const pm25Cache = new WeakMap();
    const provincePm25 = f => {
      if (pm25Cache.has(f)) return pm25Cache.get(f);
      const vals = [];
      airValues.forEach((row, yi) => {
        if (!Array.isArray(row) || yi >= airLats.length) return;
        row.forEach((v, xi) => {
          if (typeof v === "number" && Number.isFinite(v) && xi < airLons.length && pointInFeature(airLons[xi], airLats[yi], f.geometry)) vals.push(v);
        });
      });
      const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      pm25Cache.set(f, avg);
      return avg;
    };

    const counts = new Map(entries.map(([n, c]) => [normalize(n), c]));
    const infoOf = f => {
      const k = normalize(getName(f)), count = counts.has(k) ? counts.get(k) : null;
      return { name: title(getName(f)), count, level: getLevel(count) };
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

    const pm25ByProv = new Map();
    geojson.features.forEach(f => {
      pm25ByProv.set(normalize(getName(f)), provincePm25(f) ?? 0);
    });

    const chartProvinces = entries
      .map(([n, c]) => {
        const key = normalize(n);
        return {
          key,
          name: title(n),
          shortName: ABBR[key] || title(n),
          hotspots: c,
          pm25: pm25ByProv.get(key) ?? 0
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "id"));

    const statsView = el("div", "map-stats-view");
    statsView.hidden = true;

    const statsHeader = el("div", "stats-header");
    const statsTitleGroup = el("div", "stats-title-group");
    const statsTitle = el("h3", "stats-title", "Statistik Karhutla & Kesehatan Udara");
    const statsDesc = el("p", "stats-desc", "Jumlah titik panas (kiri) dan rata-rata PM2.5 (kanan) berdasarkan provinsi");
    statsTitleGroup.append(statsTitle, statsDesc);

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

    const svgWidth = 1000;
    const svgHeight = 420;
    const padLeft = 65;
    const padRight = 55;
    const padTop = 25;
    const padBottom = 65;
    const chartW = svgWidth - padLeft - padRight;
    const chartH = svgHeight - padTop - padBottom;

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
      const tAir = yTicksAir[i];
      svg.append(
        svgEl("line", { x1: padLeft, y1: y, x2: padLeft + chartW, y2: y, class: "stats-grid-line" }),
        Object.assign(svgEl("text", { x: padLeft - 10, y: y + 4, class: "stats-y-label-left" }), { textContent: fmt(tHot) }),
        Object.assign(svgEl("text", { x: padLeft + chartW + 10, y: y + 4, class: "stats-y-label-right" }), { textContent: fmt(tAir) })
      );
    });

    svg.append(
      svgEl("line", { x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + chartH, class: "stats-axis-line" }),
      svgEl("line", { x1: padLeft + chartW, y1: padTop, x2: padLeft + chartW, y2: padTop + chartH, class: "stats-axis-line" }),
      svgEl("line", { x1: padLeft, y1: padTop + chartH, x2: padLeft + chartW, y2: padTop + chartH, class: "stats-axis-line" })
    );

    const stepX = chartW / (chartProvinces.length - 1);
    const ptsHot = [];
    const ptsAir = [];

    const guideLine = svgEl("line", { x1: 0, y1: padTop, x2: 0, y2: padTop + chartH, class: "stats-guide-line" });
    guideLine.style.display = "none";
    svg.append(guideLine);

    const dotsHot = [];
    const dotsAir = [];
    const xLabels = [];

    chartProvinces.forEach((item, idx) => {
      const x = Math.round(padLeft + idx * stepX);
      const yHot = Math.round(padTop + chartH - (item.hotspots / yMaxHot) * chartH);
      const yAir = Math.round(padTop + chartH - (item.pm25 / yMaxAir) * chartH);
      ptsHot.push([x, yHot]);
      ptsAir.push([x, yAir]);

      svg.append(svgEl("line", { x1: x, y1: padTop + chartH, x2: x, y2: padTop + chartH + 5, class: "stats-tick" }));

      const lbl = svgEl("text", {
        x: x,
        y: padTop + chartH + 16,
        transform: `rotate(-45, ${x}, ${padTop + chartH + 16})`,
        class: "stats-x-label"
      });
      lbl.textContent = item.shortName;
      xLabels.push(lbl);
      svg.append(lbl);
    });

    const polyHot = ptsHot.map(p => p.join(",")).join(" ");
    const polyAir = ptsAir.map(p => p.join(",")).join(" ");

    svg.append(
      svgEl("polyline", { points: polyAir, class: "stats-line-air-halo" }),
      svgEl("polyline", { points: polyAir, class: "stats-line-air" }),
      svgEl("polyline", { points: polyHot, class: "stats-line-hot" })
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
      const tw = tooltip.offsetWidth || 150;
      const th = tooltip.offsetHeight || 56;
      let left = (x / svgWidth) * r.width - tw / 2;
      let top = Math.min((ptsHot[idx][1] / svgHeight) * r.height, (ptsAir[idx][1] / svgHeight) * r.height) - th - 12;
      if (left < 6) left = 6;
      if (left + tw > r.width - 6) left = r.width - tw - 6;
      if (top < 6) top = Math.max((ptsHot[idx][1] / svgHeight) * r.height, (ptsAir[idx][1] / svgHeight) * r.height) + 12;
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    };

    chartProvinces.forEach((item, idx) => {
      const [x] = ptsHot[idx];
      const hitW = Math.round(stepX);
      const hitX = Math.round(x - hitW / 2);
      const hit = svgEl("rect", {
        x: hitX,
        y: padTop,
        width: hitW,
        height: chartH,
        fill: "transparent",
        class: "stats-hit-area"
      });
      hit.addEventListener("mouseenter", () => selectPoint(idx));
      hit.addEventListener("click", () => selectPoint(idx));
      hit.addEventListener("touchstart", e => { selectPoint(idx); e.stopPropagation(); }, { passive: true });
      dotsHot[idx].addEventListener("mouseenter", () => selectPoint(idx));
      dotsHot[idx].addEventListener("click", () => selectPoint(idx));
      dotsAir[idx].addEventListener("mouseenter", () => selectPoint(idx));
      dotsAir[idx].addEventListener("click", () => selectPoint(idx));
      xLabels[idx].addEventListener("mouseenter", () => selectPoint(idx));
      xLabels[idx].addEventListener("click", () => selectPoint(idx));
      svg.append(hit);
    });

    chartWrap.append(svg, tooltip);
    statsView.append(statsHeader, chartWrap);
    layout.append(statsView);

    let activeMode = "hotspots", selected = null;
    const popupContent = (info, feature) => {
      const box = el("div", "province-popup");
      box.append(el("h3", "popup-title", info.name));
      if (activeMode === "air") {
        const avg = feature ? provincePm25(feature) : null;
        if (avg == null) {
          box.append(el("p", "popup-meta", "Data kualitas udara tidak tersedia untuk provinsi ini."));
        } else {
          const cnt = el("p", "popup-count"), lvl = pm25Color(avg), badge = el("p", "popup-level"), dot = el("i");
          cnt.append(el("strong", null, `${avg.toFixed(1)} µg/m³`));
          dot.style.background = `rgb(${pm25DisplayColor(lvl).join(",")})`;
          badge.append(dot, `Kategori ${lvl.label.toLowerCase()}`);
          box.append(cnt, badge);
        }
        return box;
      }
      if (info.count == null) {
        box.append(el("p", "popup-meta", "Data titik panas untuk provinsi ini tidak tersedia pada dataset."));
        return box;
      }
      const cnt = el("p", "popup-count"), badge = el("p", "popup-level"), dot = el("i");
      cnt.append(el("strong", null, fmt(info.count)), "titik panas");
      dot.setAttribute("aria-hidden", "true");
      dot.style.background = info.level.color;
      badge.append(dot, `Kategori ${info.level.label.toLowerCase()} · ${info.level.range}`);
      box.append(cnt, badge);
      if (info.count === 0) box.append(el("p", "popup-meta", "Nilai nol berarti tidak ada deteksi pada dataset ini, bukan jaminan bebas kebakaran."));
      return box;
    };

    const hover = l => {
      if (l === selected) return;
      l.setStyle(activeMode === "air" ? { stroke: true, color: cssVar("--edge"), weight: 2.2, opacity: 1, fillOpacity: 1 } : { stroke: false, weight: 0, opacity: 0, fillOpacity: 1 });
      l.bringToFront();
    };
    const unhover = l => { if (l !== selected) provinces.resetStyle(l); };
    const select = l => { if (selected && selected !== l) provinces.resetStyle(selected); selected = l; l.setStyle({ fillOpacity: 1 }); };
    const clearSelection = l => { if (selected === l) { provinces.resetStyle(l); selected = null; } };

    const provinces = L.geoJSON(geojson, {
      pane: "provinceOverlay",
      style: f => ({ ...edgeStyle(activeMode), pane: "provinceOverlay", fillColor: activeMode === "air" ? cssVar("--land") : getColor(infoOf(f).count), fillOpacity: activeMode === "air" ? 1 : 0.96 }),
      onEachFeature: (f, layer) => {
        const info = infoOf(f);
        layer.bindTooltip(info.name, { sticky: true, direction: "top", opacity: 1, className: "province-tooltip" });
        layer.bindPopup(() => popupContent(info, layer.feature), { className: "province-popup-wrap", maxWidth: 224, minWidth: 168, autoPan: false });
        layer.on({
          mouseover: () => hover(layer),
          mouseout: () => unhover(layer),
          click: () => select(layer),
          popupopen: () => layer.closeTooltip(),
          popupclose: () => clearSelection(layer)
        });
      }
    }).addTo(map);

    const syncPopupDirection = popup => {
      const node = popup?.getElement?.();
      if (!node) return;
      node.classList.remove("is-below");
      const wrap = node.querySelector(".leaflet-popup-content-wrapper");
      if (wrap) wrap.style.transform = "";
      const pt = map.latLngToContainerPoint(popup.getLatLng());
      const h = node.offsetHeight || 120, w = node.offsetWidth || 180;
      if (pt.y - h - 18 < 10) node.classList.add("is-below");
      if (wrap) {
        const left = 10 - (pt.x - w / 2), right = (pt.x + w / 2) - (mapEl.clientWidth - 10);
        if (left > 0) wrap.style.transform = `translateX(${Math.round(left)}px)`;
        else if (right > 0) wrap.style.transform = `translateX(-${Math.round(right)}px)`;
      }
    };
    map.on("popupopen", e => syncPopupDirection(e.popup));
    map.on("move zoomend", () => { if (map._popup) syncPopupDirection(map._popup); });

    provinces.eachLayer(layer => {
      const path = layer.getElement?.();
      if (!path) return;
      const info = infoOf(layer.feature);
      path.setAttribute("tabindex", "0");
      path.setAttribute("role", "button");
      path.setAttribute("aria-label", info.count == null ? `${info.name}: data tidak tersedia. Tekan Enter untuk detail.` : `${info.name}: ${fmt(info.count)} titik panas, kategori ${info.level.label.toLowerCase()}. Tekan Enter untuk detail.`);
      path.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          layer.openPopup(layer.getBounds().getCenter());
          select(layer);
        }
      });
      path.addEventListener("focus", () => {
        try { if (!path.matches(":focus-visible")) return; } catch (_) {}
        hover(layer);
        layer.openTooltip(layer.getBounds().getCenter());
      });
      path.addEventListener("blur", () => { unhover(layer); layer.closeTooltip(); });
    });

    const makePm25Overlay = () => {
      if (!airLats.length || !airLons.length || !airValues.length) return null;
      const scale = 6, raw = document.createElement("canvas");
      raw.width = airLons.length * scale;
      raw.height = airLats.length * scale;
      const rawCtx = raw.getContext("2d", { alpha: true }), image = rawCtx.createImageData(raw.width, raw.height);
      const stops = PM25_LEVELS.map(l => ({ stop: l.stop, rgb: pm25DisplayColor(l), alpha: l.alpha }));
      const valid = v => typeof v === "number" && Number.isFinite(v);
      const lerp = (a, b, t) => a + (b - a) * t;
      const interp = (a, b, t) => a === null || b === null ? (a ?? b) : lerp(a, b, t);
      const smooth = t => t * t * (3 - 2 * t);
      const sample = (sy, sx) => {
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = Math.min(x0 + 1, airLons.length - 1), y1 = Math.min(y0 + 1, airLats.length - 1);
        const v00 = valid(airValues[y0]?.[x0]) ? airValues[y0][x0] : null;
        const v01 = valid(airValues[y0]?.[x1]) ? airValues[y0][x1] : null;
        const v10 = valid(airValues[y1]?.[x0]) ? airValues[y1][x0] : null;
        const v11 = valid(airValues[y1]?.[x1]) ? airValues[y1][x1] : null;
        if (v00 === null && v01 === null && v10 === null && v11 === null) return null;
        const tx = smooth(sx - x0);
        return interp(interp(v00, v01, tx), interp(v10, v11, tx), smooth(sy - y0));
      };
      const colorFor = val => {
        if (val <= 9) return null;
        if (val <= stops[0].stop) return [...stops[0].rgb, stops[0].alpha * smooth((val - 9) / (stops[0].stop - 9))];
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i], b = stops[i + 1];
          if (val <= b.stop) {
            const t = smooth((val - a.stop) / (b.stop - a.stop));
            return [Math.round(lerp(a.rgb[0], b.rgb[0], t)), Math.round(lerp(a.rgb[1], b.rgb[1], t)), Math.round(lerp(a.rgb[2], b.rgb[2], t)), lerp(a.alpha, b.alpha, t)];
          }
        }
        const last = stops[stops.length - 1];
        return [...last.rgb, last.alpha];
      };

      const marginX = scale * 3.5;
      const marginY = scale * 3.5;

      for (let y = 0; y < raw.height; y++) {
        const distY = Math.min(y, raw.height - 1 - y);
        const factorY = smooth(Math.min(1, distY / marginY));
        if (factorY === 0) continue;

        for (let x = 0; x < raw.width; x++) {
          const distX = Math.min(x, raw.width - 1 - x);
          const factorX = smooth(Math.min(1, distX / marginX));
          const edgeFactor = factorX * factorY;
          if (edgeFactor <= 0.001) continue;

          const val = sample((1 - y / (raw.height - 1)) * (airLats.length - 1), x / (raw.width - 1) * (airLons.length - 1));
          const rgba = val === null ? null : colorFor(val);
          if (!rgba) continue;
          const idx = (y * raw.width + x) * 4;
          image.data[idx] = rgba[0];
          image.data[idx + 1] = rgba[1];
          image.data[idx + 2] = rgba[2];
          image.data[idx + 3] = Math.round(255 * rgba[3] * edgeFactor);
        }
      }
      rawCtx.putImageData(image, 0, 0);
      const canvas = document.createElement("canvas");
      canvas.width = raw.width;
      canvas.height = raw.height;
      const ctx = canvas.getContext("2d", { alpha: true });
      ctx.filter = "blur(8px)";
      ctx.drawImage(raw, 0, 0);
      return L.imageOverlay(canvas.toDataURL("image/png"), [[Math.min(...airLats), Math.min(...airLons)], [Math.max(...airLats), Math.max(...airLons)]], { pane: "airQuality", interactive: false, opacity: 1 });
    };

    let airOverlay = makePm25Overlay(), legendContent = null;
    const renderLegend = mode => {
      if (!legendContent) return;
      legendContent.replaceChildren(...(mode === "air" ? PM25_LEVELS : LEVELS).map(item => {
        const row = el("div", "legend-item"), sw = el("span", "legend-swatch"), txt = el("span", "legend-text");
        sw.style.background = mode === "air" ? `rgb(${pm25DisplayColor(item).join(",")})` : item.color;
        sw.setAttribute("aria-hidden", "true");
        txt.append(el("b", null, item.label), el("small", null, item.range));
        row.append(sw, txt);
        return row;
      }));
    };

    new MutationObserver(() => {
      renderLegend(activeMode);
      provinces.eachLayer(l => provinces.resetStyle(l));
      if (selected) selected.setStyle({ fillOpacity: 1 });
      const vis = airOverlay && map.hasLayer(airOverlay);
      if (airOverlay) map.removeLayer(airOverlay);
      airOverlay = makePm25Overlay();
      if (vis && airOverlay) airOverlay.addTo(map);
      if (map._popup && selected) selected.openPopup(selected.getBounds().getCenter());
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let baseZoom = 0, resizeTimer;
    const syncDrag = () => { if (coarsePointer) map.dragging[map.getZoom() > baseZoom + 0.05 ? "enable" : "disable"](); };
    const fit = () => {
      if (!mapEl || mapEl.clientWidth === 0 || mapEl.clientHeight === 0) return;
      map.invalidateSize({ animate: false });
      map.fitBounds(provinces.getBounds(), { padding: [8, 8], animate: false });
      baseZoom = map.getZoom();
      syncDrag();
    };
    fit();
    map.on("zoomend", syncDrag);

    const onResize = () => {
      if (!mapEl || mapEl.clientWidth === 0 || mapEl.clientHeight === 0) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!mapEl || mapEl.clientWidth === 0 || mapEl.clientHeight === 0) return;
        Math.abs(map.getZoom() - baseZoom) < 0.05 ? fit() : map.invalidateSize({ animate: false });
      }, 150);
    };
    if ("ResizeObserver" in window) new ResizeObserver(onResize).observe(mapEl);
    else addEventListener("resize", onResize);

    const reset = L.control({ position: "bottomright" });
    reset.onAdd = () => {
      const wrap = L.DomUtil.create("div", "leaflet-bar");
      const btn = el("button", "map-reset-btn", "⟲");
      btn.type = "button";
      btn.title = "Atur ulang tampilan peta";
      btn.setAttribute("aria-label", "Atur ulang tampilan peta");
      btn.addEventListener("click", () => { map.closePopup(); fit(); });
      wrap.append(btn);
      L.DomEvent.disableClickPropagation(wrap);
      return wrap;
    };
    reset.addTo(map);

    const legend = L.control({ position: "topleft" });
    legend.onAdd = () => {
      const box = L.DomUtil.create("div", "map-legend");
      const btn = el("button", null, "Legenda +");
      btn.type = "button";
      btn.setAttribute("aria-expanded", "false");
      legendContent = el("div", "map-legend-content");
      legendContent.id = "map-legend-content";
      btn.setAttribute("aria-controls", legendContent.id);
      legendContent.hidden = true;
      renderLegend("hotspots");
      btn.addEventListener("click", () => {
        legendContent.hidden = !legendContent.hidden;
        btn.textContent = legendContent.hidden ? "Legenda +" : "Legenda −";
        btn.setAttribute("aria-expanded", String(!legendContent.hidden));
      });
      box.append(btn, legendContent);
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      return box;
    };
    legend.addTo(map);

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
        statsView.hidden = false;
        mapEl.style.visibility = "hidden";
        mapEl.setAttribute("aria-hidden", "true");
      } else {
        statsView.hidden = true;
        mapEl.style.visibility = "";
        mapEl.removeAttribute("aria-hidden");
        if (airOverlay) mode === "air" ? airOverlay.addTo(map) : map.removeLayer(airOverlay);
        provinces.eachLayer(l => provinces.resetStyle(l));
        renderLegend(mode);
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
