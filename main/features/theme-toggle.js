(() => {
  "use strict";
  const KEY = "site-theme", SKEY = "site-theme-session", root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem(KEY) || sessionStorage.getItem(SKEY); } catch (_) {}
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";
  const apply = theme => {
    const dark = theme === "dark";
    root.dataset.theme = theme;
    btn.textContent = dark ? "☀" : "☾";
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
  apply(saved === "light" || saved === "dark" ? saved : (root.dataset.theme || "dark"));
})();
