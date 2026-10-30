(() => {
  "use strict";
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  window.SiteShell = {
    init() {
      const mapSection = document.querySelector("#map-section");
      const mapEl = document.querySelector("#map-container");
      if (!mapSection || !mapEl) return null;
      const skip = el("a", "skip-link", "Lewati peta, langsung ke informasi");
      skip.href = "#highlight-section";
      document.body.prepend(skip);
      const hero = el("header", "hero");
      hero.innerHTML = `<div class="hero-head"><div class="hero-intro"><h1>Jejak Titik Panas &amp; Kualitas Udara</h1></div><div class="stats" id="stats" aria-live="polite"></div></div>`;
      mapSection.before(hero);
      const statsEl = hero.querySelector("#stats");
      statsEl.append(el("div", "stat-card stat-status", "Memuat statistik titik panas…"));
      const layout = el("div", "map-layout");
      layout.setAttribute("role", "region");
      layout.setAttribute("aria-label", "Peta interaktif titik panas karhutla per provinsi");
      mapSection.insertBefore(layout, mapEl);
      const loading = el("div", "map-status is-loading", "Memuat peta dan data titik panas…");
      loading.setAttribute("role", "status");
      layout.append(mapEl, loading);
      return { mapSection, mapEl, statsEl, layout, loading, el };
    }
  };
})();
