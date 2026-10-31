(() => {
  "use strict";
  const KEY = "site-theme-v2", SKEY = "site-theme-session-v2", root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem(KEY) || sessionStorage.getItem(SKEY); } catch (_) {}
  const SUN_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor" fill-opacity=".18"/><path d="M12 2.5v2.3M12 19.2v2.3M4.2 12H2.5M21.5 12h-2.3M5.8 5.8l1.6 1.6M16.6 16.6l1.6 1.6M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6"/></svg>`;
  const MOON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.2 14.4A8.2 8.2 0 0 1 9.6 3.8a8.2 8.2 0 1 0 10.6 10.6Z" fill="currentColor" fill-opacity=".18"/><path d="M18 4v3M16.5 5.5h3" stroke-width="1.6"/></svg>`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";
  const apply = theme => {
    const dark = theme === "dark";
    root.dataset.theme = theme;
    btn.innerHTML = dark ? SUN_SVG : MOON_SVG;
    btn.title = dark ? "Mode terang" : "Mode gelap";
    btn.setAttribute("aria-label", dark ? "Ganti ke mode terang" : "Ganti ke mode gelap");
    btn.setAttribute("aria-pressed", String(dark));
  };
  btn.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); sessionStorage.setItem(SKEY, next); } catch (_) {}
    apply(next);
  });
  document.body.append(btn);
  apply(saved === "light" || saved === "dark" ? saved : (root.dataset.theme || "light"));
})();