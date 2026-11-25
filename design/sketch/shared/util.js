/* Small helpers shared by the three directions, plus the sketch chrome (not part of any design). */
(function () {
  const F = window.FACTORY;
  const NOW = Date.parse(F.now);

  const ago = (iso, now = NOW) => {
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? "yesterday" : `${d} days ago`;
  };
  const dur = (sec) => {
    if (sec < 60) return `${sec} s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r === 0 ? `${h} h` : `${h} h ${r} min`;
  };
  const since = (iso, now = NOW) => dur(Math.round((now - Date.parse(iso)) / 1000));
  const usd = (v) => `$${v.toFixed(2)}`;
  const clock = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const pct = (r, d = 0) => `${(r * 100).toFixed(d)}%`;
  const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const num = (n) => (n < words.length ? words[n] : String(n));
  const plural = (n, one, many) => (n === 1 ? one : many || one + "s");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const PIPE = { product_work: "Product work", gardening: "Gardening", hardening: "Hardening" };
  const STEP = { triage: "Reading the request", spec: "Writing the spec", builder: "Building", verifier: "Verifying in the sandbox", gardener: "Tidying", hardener: "Hardening", scorer: "Scoring", gate: "At the gate", merge: "Merging" };

  /**
   * Sketch chrome: a small, deliberately plain bar for moving between the screens
   * of one direction and flipping light/dark. It is not part of the design.
   */
  function chrome(screens, opts = {}) {
    const bar = document.createElement("nav");
    bar.className = "sketch-chrome";
    bar.setAttribute("aria-label", "Sketch screens");
    const params = new URLSearchParams(location.search);
    const initial = params.get("screen") || location.hash.slice(1) || screens[0][0];
    const theme = params.get("theme");
    if (theme) document.documentElement.dataset.theme = theme;
    if (params.has("bare")) bar.hidden = true;
    bar.innerHTML = `<a class="sc-home" href="../index.html">All directions</a><span class="sc-name">${opts.name || ""}</span>
      <select aria-label="Screen">${screens.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select>
      <button type="button" class="sc-theme" aria-label="Toggle light and dark">Light / dark</button>`;
    document.body.appendChild(bar);
    const sel = bar.querySelector("select");
    const show = (id, fromHistory) => {
      sel.value = id;
      document.querySelectorAll("[data-screen]").forEach((el) => (el.hidden = el.dataset.screen !== id));
      document.documentElement.dataset.view = id;
      try {
        if (location.hash.slice(1) !== id && !fromHistory) history[opts.push ? "pushState" : "replaceState"](null, "", "#" + id);
      } catch { /* not available in an embedded frame */ }
      window.dispatchEvent(new CustomEvent("screen", { detail: id }));
    };
    sel.addEventListener("change", () => show(sel.value));
    bar.querySelector(".sc-theme").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
    });
    window.showScreen = show;
    if (opts.push) window.addEventListener("popstate", () => { const h = location.hash.slice(1); if (h) show(h, true); });
    show(opts.anyRoute || screens.some((s) => s[0] === initial) ? initial : screens[0][0], true);
  }

  const style = document.createElement("style");
  style.textContent = `.sketch-chrome{position:fixed;z-index:1000;left:50%;bottom:14px;translate:-50% 0;display:flex;gap:8px;align-items:center;padding:6px 8px;background:#eee;color:#222;border:1px solid #ccc;border-radius:8px;font:12px/1.2 system-ui,sans-serif;box-shadow:0 2px 10px rgb(0 0 0/.15)}
  .sketch-chrome select,.sketch-chrome button{font:inherit;white-space:nowrap;padding:4px 6px;border:1px solid #bbb;border-radius:5px;background:#fff;color:#222}
  .sketch-chrome a{color:#222}.sketch-chrome .sc-name{font-weight:600}
  .sketch-chrome :focus-visible{outline:2px solid #2563eb;outline-offset:2px}
  @media (max-width:560px){.sketch-chrome .sc-name,.sketch-chrome .sc-home{display:none}}`;
  document.head.appendChild(style);

  window.U = { F, NOW, ago, dur, since, usd, clock, pct, num, plural, esc, PIPE, STEP, chrome };
})();
