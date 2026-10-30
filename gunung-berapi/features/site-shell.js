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
      hero.innerHTML = `<div class="hero-head"><div class="hero-intro"><h1>Sebaran &amp; Tingkat Aktivitas Gunung Api</h1></div></div>`;
      mapSection.before(hero);
      const layout = el("div", "map-layout");
      layout.setAttribute("role", "region");
      layout.setAttribute("aria-label", "Peta interaktif status gunung api di Indonesia");
      mapSection.insertBefore(layout, mapEl);
      const loading = el("div", "map-status is-loading", "Memuat peta dan status gunung api…");
      loading.setAttribute("role", "status");
      layout.append(mapEl, loading);
      return { mapSection, mapEl, layout, loading, el };
    }
  };
})();
