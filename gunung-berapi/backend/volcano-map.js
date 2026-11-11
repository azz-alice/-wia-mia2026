(() => {
  "use strict";
  const VOLCANO_URL = "./data/gunung-api-map.json";
  const GEOJSON_URL = "./data/indonesia-kabupaten-kota.geojson";
  const PROVINCE_BORDER_URL = "./data/indonesia-provinsi.geojson";

  const shell = window.SiteShell?.init();
  if (!shell) return;
  const { loading, el, cssVar, fmt, getDisplayName, load, showFailure, createMap, bindFitAndControls } = shell;

  const LEVELS = [
    { level: 1, label: "Normal", range: "Level I", full: "Level I — Normal", v: "--st-1" },
    { level: 2, label: "Waspada", range: "Level II", full: "Level II — Waspada", v: "--st-2" },
    { level: 3, label: "Siaga", range: "Level III", full: "Level III — Siaga", v: "--st-3" },
    { level: 4, label: "Awas", range: "Level IV", full: "Level IV — Awas", v: "--st-4" }
  ];

  const validNum = v => v !== null && v !== "" && Number.isFinite(Number(v));
  const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const statusFor = v => LEVELS.find(l => l.level === Number(v.status_level)) || LEVELS[0];

  const map = createMap();
  if (!map) return;

  const regencyRenderer = L.canvas({ padding: 0.5 });
  const provBorderPane = map.createPane("provinceBorder");
  provBorderPane.style.zIndex = 415;
  provBorderPane.style.pointerEvents = "none";
  const provBorderRenderer = L.canvas({ pane: "provinceBorder", padding: 0.5 });
  const markerPane = map.createPane("volcanoMarker");
  markerPane.style.zIndex = 430;
  const markerRenderer = L.canvas({ pane: "volcanoMarker", padding: 0.5 });

  Promise.all([load(GEOJSON_URL), load(PROVINCE_BORDER_URL), load(VOLCANO_URL)])
    .then(([g, pb, d]) => render(g, pb, d))
    .catch(e => showFailure(e?.message || "Data tidak dapat dimuat."));

  function render(geojson, provinceBorders, dataset) {
    if (!geojson?.features?.length) return showFailure("Batas wilayah tidak valid atau kosong.");
    const volcanoes = Array.isArray(dataset?.volcanoes) ? dataset.volcanoes : [];
    if (!volcanoes.length) return showFailure("Dataset gunung api kosong.");

    const pointInRing = (lon, lat, ring) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
      }
      return inside;
    };
    const featureBounds = new WeakMap();
    const pointInFeature = (lon, lat, feature) => {
      const geom = feature?.geometry;
      if (!geom || !Array.isArray(geom.coordinates)) return false;
      let bounds = featureBounds.get(feature);
      if (!bounds) {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
        polygons.forEach(polygon => polygon[0].forEach(([x, y]) => {
          minLon = Math.min(minLon, x);
          minLat = Math.min(minLat, y);
          maxLon = Math.max(maxLon, x);
          maxLat = Math.max(maxLat, y);
        }));
        bounds = [minLon, minLat, maxLon, maxLat];
        featureBounds.set(feature, bounds);
      }
      const [minLon, minLat, maxLon, maxLat] = bounds;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
      const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
      return polygons.some(polygon => pointInRing(lon, lat, polygon[0]) && !polygon.slice(1).some(ring => pointInRing(lon, lat, ring)));
    };
    const findAreaForVolcano = volcano => {
      if (!validNum(volcano.latitude) || !validNum(volcano.longitude)) return null;
      return geojson.features.find(feature => pointInFeature(Number(volcano.longitude), Number(volcano.latitude), feature)) || null;
    };
    const volcanoesByArea = new Map(geojson.features.map(feature => [feature, []]));
    const areaByVolcano = new Map();
    volcanoes.forEach(volcano => {
      const area = findAreaForVolcano(volcano);
      areaByVolcano.set(volcano, area);
      if (area) volcanoesByArea.get(area).push(volcano);
    });

    const infoOf = feature => {
      const areaVolcanoes = volcanoesByArea.get(feature) || [];
      return { name: getDisplayName(feature), volcanoes: areaVolcanoes, count: areaVolcanoes.length };
    };

    const baseStyle = () => ({ renderer: regencyRenderer, stroke: true, color: cssVar("--regency-edge"), weight: 0.65, opacity: 0.88, fillColor: cssVar("--land-grass"), fillOpacity: 0.96 });
    const activeStyle = () => ({ stroke: true, color: cssVar("--province-edge"), weight: 1.25, opacity: 1, fillColor: cssVar("--land-grass-hover"), fillOpacity: 1 });
    const provinceBorderStyle = () => ({ renderer: provBorderRenderer, pane: "provinceBorder", stroke: true, color: cssVar("--province-edge"), weight: 1.5, opacity: 1, fill: false, interactive: false });

    let selected = null;
    const hover = l => { if (l !== selected) l.setStyle(activeStyle()); };
    const unhover = l => { if (l !== selected) provinces.resetStyle(l); };
    const select = l => { if (selected && selected !== l) provinces.resetStyle(selected); selected = l; l.setStyle(activeStyle()); };
    const clearSelection = l => { if (selected === l) { provinces.resetStyle(l); selected = null; } };

    const provinces = L.geoJSON(geojson, {
      style: baseStyle,
      onEachFeature: (f, layer) => {
        const info = infoOf(f);
        layer.bindTooltip(info.name, { sticky: true, direction: "top", opacity: 1, className: "province-tooltip" });
        layer.bindPopup(() => {
          const box = el("div", "province-popup");
          const cnt = el("p", "popup-count");
          cnt.append(el("strong", null, fmt(info.count)), "gunung berapi");
          box.append(el("h3", "popup-title", info.name), cnt);
          if (info.volcanoes.length) box.append(el("p", "popup-meta", info.volcanoes.map(volcano => volcano.name).join(", ")));
          return box;
        }, { className: "province-popup-wrap", maxWidth: 264, minWidth: 168, autoPan: false });
        layer.on({
          mouseover: () => hover(layer),
          mouseout: () => unhover(layer),
          click: () => select(layer),
          popupopen: () => layer.closeTooltip(),
          popupclose: () => clearSelection(layer)
        });
      }
    }).addTo(map);

    const provBordersLayer = provinceBorders?.features?.length
      ? L.geoJSON(provinceBorders, {
          pane: "provinceBorder",
          interactive: false,
          style: provinceBorderStyle
        }).addTo(map)
      : null;

    const markers = volcanoes.filter(v => validNum(v.latitude) && validNum(v.longitude)).map(v => {
      const st = statusFor(v);
      const m = L.circleMarker([Number(v.latitude), Number(v.longitude)], {
        renderer: markerRenderer,
        pane: "volcanoMarker",
        radius: 7,
        weight: 2,
        color: cssVar("--edge"),
        fillColor: cssVar(st.v),
        fillOpacity: 0.96,
        className: "volcano-marker"
      }).addTo(map);
      m.status = st;
      const elev = validNum(v.elevation_m) ? `${Number(v.elevation_m).toLocaleString("id-ID")} m` : "Tidak tersedia";
      const coords = `${Number(v.latitude).toFixed(4)}, ${Number(v.longitude).toFixed(4)}`;
      const area = areaByVolcano.get(v);
      const areaName = area ? getDisplayName(area) : (v.province || "Tidak tersedia");
      const note = v.coordinate_note ? `<p class="volcano-popup-note">${esc(v.coordinate_note)}</p>` : "";
      m.bindPopup(`<div class="volcano-popup"><div class="volcano-popup-status"><span style="background:${cssVar(st.v)}"></span>${esc(st.full)}</div><h3>${esc(v.name)}</h3><dl><div><dt>Kabupaten/Kota</dt><dd>${esc(areaName)}</dd></div><div><dt>Provinsi</dt><dd>${esc(v.province || "Tidak tersedia")}</dd></div><div><dt>Elevasi</dt><dd>${esc(elev)}</dd></div><div><dt>Koordinat</dt><dd>${esc(coords)}</dd></div></dl>${note}</div>`, {
        className: "volcano-popup-wrap", maxWidth: 264, closeButton: true, autoPan: false
      });
      m.on({
        mouseover: () => m.setStyle({ radius: 8.5, weight: 2.5, fillOpacity: 1 }),
        mouseout: () => { if (!m.isPopupOpen()) m.setStyle({ radius: 7, weight: 2, fillOpacity: 0.96 }); },
        popupopen: () => m.setStyle({ radius: 9, weight: 2.6, fillOpacity: 1 }),
        popupclose: () => m.setStyle({ radius: 7, weight: 2, fillOpacity: 0.96 })
      });
      return m;
    });
    map.getContainer().addEventListener("pointerleave", () => {
      map.closePopup();
      if (map._tooltip?.isOpen()) map.closeTooltip();
      if (selected) {
        provinces.resetStyle(selected);
        selected = null;
      }
      markers.forEach(marker => marker.setStyle({ radius: 7, weight: 2, fillOpacity: 0.96 }));
    });

    const renderLegend = node => {
      if (!node) return;
      node.replaceChildren(...LEVELS.map(item => {
        const row = el("div", "legend-item"), sw = el("span", "legend-swatch"), txt = el("span", "legend-text");
        sw.style.background = cssVar(item.v);
        sw.setAttribute("aria-hidden", "true");
        txt.append(el("b", null, item.label), el("small", null, item.range));
        row.append(sw, txt);
        return row;
      }));
    };

    const { getLegendContent } = bindFitAndControls(map, provinces, renderLegend);

    new MutationObserver(() => {
      renderLegend(getLegendContent());
      provinces.eachLayer(l => provinces.resetStyle(l));
      if (provBordersLayer) provBordersLayer.eachLayer(l => provBordersLayer.resetStyle(l));
      if (selected) select(selected);
      markers.forEach(m => m.setStyle({ color: cssVar("--edge"), fillColor: cssVar(m.status.v) }));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    loading.remove();
  }
})();
