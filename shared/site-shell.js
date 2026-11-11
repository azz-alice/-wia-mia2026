(() => {
  "use strict";
  const ACRONYMS = new Set(["DKI", "DI"]);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = matchMedia("(pointer: coarse)").matches;
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = n => n.toLocaleString("id-ID");
  const title = s => String(s).toLowerCase().replace(/\S+/g, w => ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  const normalize = name => String(name || "").toUpperCase().replace(/^PROVINSI\s+/, "").replace(/^DAERAH ISTIMEWA ACEH$/, "ACEH").replace(/[.]/g, "").replace(/[^A-Z0-9]+/g, " ").trim();
  const getName = f => f?.properties?.PROVINSI || f?.properties?.province_name || "";
  const getRegencyName = f => f?.properties?.regency_name || "";
  const getDisplayName = f => {
    const reg = getRegencyName(f);
    if (!reg) return title(getName(f));
    const type = f?.properties?.admin_type || "";
    const label = type === "Kabupaten" && !/^kabupaten\b/i.test(reg) ? `Kab. ${title(reg)}` : title(reg);
    return `${label} (${title(getName(f))})`;
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const load = url => fetch(url).then(r => {
    if (!r.ok) throw new Error(`Berkas ${url} tidak dapat dimuat (status ${r.status}).`);
    return r.json();
  });

  window.SiteShell = {
    reduceMotion,
    coarsePointer,
    cssVar,
    fmt,
    title,
    normalize,
    getName,
    getDisplayName,
    el,
    load,
    init() {
      const mapSection = document.querySelector("#map-section");
      const mapEl = document.querySelector("#map-container");
      if (!mapSection || !mapEl) return null;
      const isVolcano = location.pathname.includes("gunung-berapi");
      const heroTitle = isVolcano ? "Sebaran & Tingkat Aktivitas Gunung Api" : "Jejak Titik Panas & Kualitas Udara";
      const regionLabel = isVolcano ? "Peta interaktif status gunung api di Indonesia" : "Peta interaktif titik panas karhutla per provinsi";
      const loadingText = isVolcano ? "Memuat peta dan status gunung api…" : "Memuat peta dan data titik panas…";

      const skip = el("a", "skip-link", "Lewati peta, langsung ke informasi");
      skip.href = "#highlight-section";
      document.body.prepend(skip);

      const hero = el("header", "hero");
      const head = el("div", "hero-head");
      const intro = el("div", "hero-intro");
      intro.append(el("h1", null, heroTitle));
      head.append(intro);
      hero.append(head);
      mapSection.before(hero);

      const layout = el("div", "map-layout");
      layout.setAttribute("role", "region");
      layout.setAttribute("aria-label", regionLabel);
      mapSection.insertBefore(layout, mapEl);

      const loading = el("div", "map-status is-loading", loadingText);
      loading.setAttribute("role", "status");
      layout.append(mapEl, loading);

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

      const createMap = () => {
        if (typeof L === "undefined") {
          showFailure("Pustaka peta gagal dimuat. Periksa koneksi internet Anda, lalu muat ulang halaman.");
          return null;
        }
        const map = L.map(mapEl, {
          preferCanvas: true,
          scrollWheelZoom: false,
          zoomControl: false,
          attributionControl: false,
          zoomSnap: 0,
          zoomAnimation: !reduceMotion,
          fadeAnimation: !reduceMotion,
          markerZoomAnimation: !reduceMotion
        });
        L.control.zoom({ position: "bottomright" }).addTo(map);
        const zoomInBtn = mapEl.querySelector(".leaflet-control-zoom-in");
        const zoomOutBtn = mapEl.querySelector(".leaflet-control-zoom-out");
        if (zoomInBtn) zoomInBtn.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 2v10M2 7h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
        if (zoomOutBtn) zoomOutBtn.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M2 7h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

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

        return map;
      };

      const bindFitAndControls = (map, boundsLayer, renderLegendFn) => {
        let baseZoom = 0, resizeTimer;
        const syncDrag = () => { if (coarsePointer) map.dragging[map.getZoom() > baseZoom + 0.05 ? "enable" : "disable"](); };
        const fit = () => {
          if (!mapEl || mapEl.clientWidth === 0 || mapEl.clientHeight === 0) return;
          map.invalidateSize({ animate: false });
          map.fitBounds(boundsLayer.getBounds(), { padding: [8, 8], animate: false });
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

        let legendContent = null;
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
          renderLegendFn(legendContent);
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

        return { fit, getLegendContent: () => legendContent };
      };

      return {
        mapSection,
        mapEl,
        layout,
        loading,
        el,
        cssVar,
        fmt,
        title,
        normalize,
        getName,
        getDisplayName,
        load,
        showFailure,
        createMap,
        bindFitAndControls
      };
    }
  };
})();
