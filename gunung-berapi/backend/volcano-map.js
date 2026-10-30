(() => {
  "use strict";
  const VOLCANO_URL = "./data/gunung-api-map.json";
  const GEOJSON_URL = "./data/indonesia-38-provinces.json";
  const LEVELS = [
    { level: 1, label: "Normal", range: "Level I", full: "Level I — Normal", v: "--st-1" },
    { level: 2, label: "Waspada", range: "Level II", full: "Level II — Waspada", v: "--st-2" },
    { level: 3, label: "Siaga", range: "Level III", full: "Level III — Siaga", v: "--st-3" },
    { level: 4, label: "Awas", range: "Level IV", full: "Level IV — Awas", v: "--st-4" }
  ];
  const ACRONYMS = new Set(["DKI", "DI"]);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = matchMedia("(pointer: coarse)").matches;
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = n => n.toLocaleString("id-ID");
  const validNum = v => v !== null && v !== "" && Number.isFinite(Number(v));
  const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const title = s => String(s).toLowerCase().replace(/\S+/g, w => ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  const normalize = name => String(name || "").toUpperCase().replace(/^PROVINSI\s+/, "").replace(/^DAERAH ISTIMEWA ACEH$/, "ACEH").replace(/[.]/g, "").replace(/[^A-Z0-9]+/g, " ").trim();
  const getName = f => f?.properties?.PROVINSI || "";
  const statusFor = v => LEVELS.find(l => l.level === Number(v.status_level)) || LEVELS[0];
  const load = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url} tidak dapat dimuat (${r.status})`); return r.json(); });

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
  map.createPane("provinceOverlay").style.zIndex = 400;
  map.createPane("volcanoMarker").style.zIndex = 430;
  L.control.zoom({ position: "bottomright" }).addTo(map);

  let panPt = null;
  mapEl.addEventListener("contextmenu", e => e.preventDefault());
  mapEl.addEventListener("mousedown", e => { if (e.button === 2) { panPt = [e.clientX, e.clientY]; e.preventDefault(); } });
  addEventListener("mouseup", e => { if (e.button === 2) panPt = null; });
  mapEl.addEventListener("mousemove", e => {
    if (!panPt) return;
    map.panBy([panPt[0] - e.clientX, panPt[1] - e.clientY], { animate: false });
    panPt = [e.clientX, e.clientY];
  });

  Promise.all([load(GEOJSON_URL), load(VOLCANO_URL)]).then(([g, d]) => render(g, d)).catch(e => showFailure(e.message));

  function render(geojson, dataset) {
    if (!geojson?.features?.length) throw new Error("Batas provinsi tidak valid atau kosong.");
    const volcanoes = Array.isArray(dataset?.volcanoes) ? dataset.volcanoes : [];
    if (!volcanoes.length) throw new Error("Dataset gunung api kosong.");

    const byProvince = new Map(geojson.features.map(f => [normalize(getName(f)), []]));
    volcanoes.forEach(v => String(v.province || "").split(/,|\bdan\b/i).forEach(p => {
      const k = normalize(p);
      if (byProvince.has(k)) byProvince.get(k).push(v);
    }));

    const infoOf = f => {
      const list = byProvince.get(normalize(getName(f))) || [];
      return { name: title(getName(f)), count: list.length };
    };

    const baseStyle = () => ({ pane: "provinceOverlay", stroke: false, weight: 0, opacity: 0, fillColor: cssVar("--land-grass"), fillOpacity: 0.96 });
    const activeStyle = () => ({ stroke: false, weight: 0, opacity: 0, fillColor: cssVar("--land-grass-hover"), fillOpacity: 1 });

    let selected = null;
    const hover = l => { if (l !== selected) l.setStyle(activeStyle()); };
    const unhover = l => { if (l !== selected) provinces.resetStyle(l); };
    const select = l => { if (selected && selected !== l) provinces.resetStyle(selected); selected = l; l.setStyle(activeStyle()); };
    const clearSelection = l => { if (selected === l) { provinces.resetStyle(l); selected = null; } };

    const provinces = L.geoJSON(geojson, {
      pane: "provinceOverlay",
      style: baseStyle,
      onEachFeature: (f, layer) => {
        const info = infoOf(f);
        layer.bindTooltip(info.name, { sticky: true, direction: "top", opacity: 1, className: "province-tooltip" });
        layer.bindPopup(() => {
          const box = el("div", "province-popup");
          const cnt = el("p", "popup-count");
          cnt.append(el("strong", null, fmt(info.count)), "gunung berapi");
          box.append(el("h3", "popup-title", info.name), cnt);
          return box;
        }, { className: "province-popup-wrap", maxWidth: 224, minWidth: 168, autoPan: false });
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
      path.setAttribute("aria-label", `${info.name}: ${fmt(info.count)} gunung berapi. Tekan Enter untuk detail.`);
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

    const markers = volcanoes.filter(v => validNum(v.latitude) && validNum(v.longitude)).map(v => {
      const st = statusFor(v);
      const m = L.circleMarker([Number(v.latitude), Number(v.longitude)], {
        pane: "volcanoMarker", radius: 7, weight: 2, color: cssVar("--edge"), fillColor: cssVar(st.v), fillOpacity: 0.96, className: "volcano-marker"
      }).addTo(map);
      m.status = st;
      const elev = validNum(v.elevation_m) ? `${Number(v.elevation_m).toLocaleString("id-ID")} m` : "Tidak tersedia";
      const coords = `${Number(v.latitude).toFixed(4)}, ${Number(v.longitude).toFixed(4)}`;
      const note = v.coordinate_note ? `<p class="volcano-popup-note">${esc(v.coordinate_note)}</p>` : "";
      m.bindPopup(`<div class="volcano-popup"><div class="volcano-popup-status"><span style="background:${cssVar(st.v)}"></span>${esc(st.full)}</div><h3>${esc(v.name)}</h3><dl><div><dt>Provinsi</dt><dd>${esc(v.province || "Tidak tersedia")}</dd></div><div><dt>Elevasi</dt><dd>${esc(elev)}</dd></div><div><dt>Koordinat</dt><dd>${esc(coords)}</dd></div><div><dt>Sumber titik</dt><dd>${esc(v.coordinate_source || "Tidak tersedia")}</dd></div></dl>${note}</div>`, {
        className: "volcano-popup-wrap", maxWidth: 264, closeButton: true, autoPan: false
      });
      return m;
    });

    let baseZoom = 0, resizeTimer;
    const syncDrag = () => { if (coarsePointer) map.dragging[map.getZoom() > baseZoom + 0.05 ? "enable" : "disable"](); };
    const fit = () => {
      map.invalidateSize({ animate: false });
      map.fitBounds(provinces.getBounds(), { padding: [8, 8], animate: false });
      baseZoom = map.getZoom();
      syncDrag();
    };
    fit();
    map.on("zoomend", syncDrag);

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => Math.abs(map.getZoom() - baseZoom) < 0.05 ? fit() : map.invalidateSize({ animate: false }), 150);
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

    let legendContent = null;
    const renderLegend = () => {
      if (!legendContent) return;
      legendContent.replaceChildren(...LEVELS.map(item => {
        const row = el("div", "legend-item"), sw = el("span", "legend-swatch"), txt = el("span", "legend-text");
        sw.style.background = cssVar(item.v);
        sw.setAttribute("aria-hidden", "true");
        txt.append(el("b", null, item.label), el("small", null, item.range));
        row.append(sw, txt);
        return row;
      }));
    };

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
      renderLegend();
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

    new MutationObserver(() => {
      renderLegend();
      provinces.eachLayer(l => provinces.resetStyle(l));
      if (selected) select(selected);
      markers.forEach(m => m.setStyle({ color: cssVar("--edge"), fillColor: cssVar(m.status.v) }));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    loading.remove();
  }
})();
