/*
 * Proof media for the sketch: the verifier's recording of Ledgerline, the
 * exported CSV, the API response and the diagram. Shared by all three
 * directions so they can be compared on the same evidence.
 */
(function () {
  const reduce = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function autoscale(viewport, stage, base) {
    const fit = () => stage.style.setProperty("--ll-scale", String(viewport.clientWidth / base));
    fit();
    new ResizeObserver(fit).observe(viewport);
  }

  const ROWS = [
    ["INV-0412", "Halden & Co", "GBP", "£4,200.00", "paid", "s-paid", "Paid"],
    ["INV-0415", "Brightwater GmbH", "EUR", "€2,850.00", "sent", "s-sent", "Sent"],
    ["INV-0417", "Northpass Ltd", "USD", "$1,960.00", "sent", "s-sent", "Sent"],
    ["INV-0418", "Halden & Co", "GBP", "£780.00", "over", "s-over", "Overdue"],
    ["INV-0420", "Ostrava Design s.r.o.", "EUR", "€3,120.00", "sent", "s-sent", "Sent"],
    ["INV-0421", "Pinecrest Dental", "USD", "$640.00", "sent", "s-sent", "Sent"],
  ];

  const ARROW = '<svg viewBox="0 0 18 22" width="18" height="22" aria-hidden="true"><path d="M1 1l15 11.5-6.6 1.1 3.9 7.2-2.6 1.3-3.9-7.3L1 19z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  function appFrame() {
    const rows = ROWS.map((r, i) => `<div class="ll-row" data-t="row${i}"><span class="ll-box"></span><span>${r[0]}</span><span>${r[1]}</span><span>${r[2]}</span><span class="amt">${r[3]}</span><span class="ll-status ${r[5]}">${r[6]}</span></div>`).join("");
    return `<div class="ll-stage" data-s="">
      <aside class="ll-side"><div class="ll-logo"><i></i>Ledgerline</div>
        <div class="ll-nav">Overview</div><div class="ll-nav on">Invoices</div><div class="ll-nav">Clients</div><div class="ll-nav">Reports</div><div class="ll-nav">Settings</div></aside>
      <section class="ll-main">
        <div class="ll-head"><h4>Invoices</h4><span class="ll-chip">November 2026</span>
          <span class="ll-btn" data-t="filter">Filter</span>
          <span class="ll-btn" data-t="export">Export<span class="ll-menu"><div data-t="csv" class="hot">CSV, client currency</div><div>PDF bundle</div></span></span>
          <span class="ll-btn primary">New invoice</span></div>
        <div class="ll-table"><div class="ll-row"><span></span><span>Number</span><span>Client</span><span>Currency</span><span class="amt">Amount</span><span>Status</span></div>${rows}</div>
      </section>
      <div class="ll-toast">invoices-2026-11.csv <b>downloaded</b></div>
      <div class="ll-cursor">${ARROW}<span class="ll-click"></span></div>
    </div>`;
  }

  /** The recording. Returns play/pause and reports progress in recorded seconds. */
  function video(viewport, opts = {}) {
    const total = opts.seconds || 42;
    viewport.classList.add("ll-viewport");
    viewport.innerHTML = appFrame();
    const stage = viewport.querySelector(".ll-stage");
    const cursor = stage.querySelector(".ll-cursor");
    autoscale(viewport, stage, 960);

    const at = (t) => {
      const el = stage.querySelector(`[data-t="${t}"]`);
      const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
      const k = s.width / 960;
      return [(r.left - s.left) / k + Math.min(26, r.width / k / 2), (r.top - s.top) / k + r.height / k / 2];
    };
    const state = new Set();
    const set = () => (stage.dataset.s = [...state].join(" "));
    const move = (t) => { const [x, y] = at(t); cursor.style.transform = `translate(${x}px, ${y}px)`; };
    const tap = () => { cursor.classList.remove("tap"); void cursor.offsetWidth; cursor.classList.add("tap"); };
    const sel = (i) => stage.querySelector(`[data-t="row${i}"]`).classList.add("sel");

    const SCRIPT = [
      [400, () => move("filter")], [1300, () => { tap(); state.add("filter"); set(); }],
      [1900, () => move("row0")], [2500, () => { tap(); sel(0); }],
      [2800, () => move("row1")], [3200, () => { tap(); sel(1); }],
      [3500, () => move("row2")], [3900, () => { tap(); sel(2); }],
      [4200, () => move("row4")], [4700, () => { tap(); sel(4); }],
      [5100, () => move("export")], [5900, () => { tap(); state.add("menu"); set(); }],
      [6200, () => move("csv")], [6900, () => { tap(); state.delete("menu"); state.add("toast"); set(); }],
    ];
    const LEN = 8200;
    let timers = [], startedAt = 0, raf = 0, playing = false;

    function finalFrame() {
      state.clear(); state.add("filter"); state.add("toast"); set();
      [0, 1, 2, 4].forEach(sel);
      cursor.style.transition = "none"; move("csv"); requestAnimationFrame(() => (cursor.style.transition = ""));
    }
    function reset() {
      state.clear(); set();
      stage.querySelectorAll(".sel").forEach((r) => r.classList.remove("sel"));
      cursor.style.transition = "none"; cursor.style.transform = "translate(700px, 520px)";
      requestAnimationFrame(() => (cursor.style.transition = ""));
    }
    function tick() {
      const p = Math.min(1, (performance.now() - startedAt) / LEN);
      opts.onTime?.(p * total, p);
      if (p < 1 && playing) raf = requestAnimationFrame(tick);
      else if (p >= 1) { playing = false; opts.onEnd?.(); }
    }
    function play() {
      if (reduce()) { finalFrame(); opts.onTime?.(total, 1); opts.onEnd?.(); return; }
      stop(); reset(); playing = true; startedAt = performance.now();
      timers = SCRIPT.map(([ms, fn]) => setTimeout(fn, ms));
      raf = requestAnimationFrame(tick);
    }
    function stop() { playing = false; timers.forEach(clearTimeout); cancelAnimationFrame(raf); }
    if (opts.final) finalFrame();
    return { play, stop, finalFrame, reset, get playing() { return playing; } };
  }

  function csv(viewport) {
    viewport.classList.add("csv-shot");
    const cols = ["A", "B", "C", "D", "E", "F", "G"];
    const data = [
      ["number", "client", "currency", "amount", "rate_to_usd", "issued_on", ""],
      ["INV-0412", "Halden & Co", "GBP", "4200.00", "1.268400", "2026-11-03", ""],
      ["INV-0415", "Brightwater GmbH", "EUR", "2850.00", "1.081200", "2026-11-07", ""],
      ["INV-0417", "Northpass Ltd", "USD", "1960.00", "", "2026-11-12", ""],
      ["INV-0420", "Ostrava Design s.r.o.", "EUR", "3120.00", "1.079900", "2026-11-18", ""],
    ];
    let cells = '<div class="h"></div>' + cols.map((c) => `<div class="h">${c}</div>`).join("");
    for (let i = 0; i < 15; i++) {
      const row = data[i] || ["", "", "", "", "", "", ""];
      cells += `<div class="n">${i + 1}</div>` + row.map((v, j) => `<div class="${i === 0 ? "b" : ""} ${j === 3 || j === 4 ? "r" : ""} ${i === 3 && j === 4 ? "hl" : ""}">${v}</div>`).join("");
    }
    viewport.innerHTML = `<div class="csv-stage"><div class="csv-bar">invoices-2026-11.csv <span>fx</span></div><div class="csv-grid">${cells}</div></div>`;
    autoscale(viewport, viewport.firstElementChild, 960);
  }

  const API = `GET /api/invoices/export?month=2026-11&ids=0412,0415,0417,0420
200 OK  184 ms
content-type: text/csv; charset=utf-8
content-disposition: attachment; filename="invoices-2026-11.csv"

number,client,currency,amount,rate_to_usd,issued_on
INV-0412,Halden & Co,GBP,4200.00,1.268400,2026-11-03
INV-0415,Brightwater GmbH,EUR,2850.00,1.081200,2026-11-07
INV-0417,Northpass Ltd,USD,1960.00,,2026-11-12
INV-0420,Ostrava Design s.r.o.,EUR,3120.00,1.079900,2026-11-18`;

  /** The diagram block, drawn in currentColor so each direction can colour it. */
  function diagram() {
    const box = (x, y, w, t, sub, strong) => `<g><rect x="${x}" y="${y}" width="${w}" height="54" rx="6" fill="${strong ? "currentColor" : "none"}" fill-opacity="${strong ? 0.08 : 0}" stroke="currentColor" stroke-opacity=".55"/><text x="${x + 14}" y="${y + 23}" font-size="14" font-weight="600" fill="currentColor">${t}</text><text x="${x + 14}" y="${y + 41}" font-size="12" fill="currentColor" fill-opacity=".7">${sub}</text></g>`;
    const line = (x1, y1, x2, y2) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5" marker-end="url(#ah)"/>`;
    return `<svg viewBox="0 0 720 200" role="img" aria-label="Export reads each invoice, looks up the rate for its date once, and writes one row" style="width:100%;height:auto;font-family:inherit">
      <defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="currentColor" fill-opacity=".6"/></marker></defs>
      ${box(10, 20, 170, "Export button", "filter or selection")}
      ${box(270, 20, 180, "csv.ts", "one row per invoice", true)}
      ${box(540, 20, 170, "invoices.csv", "client currency kept")}
      ${box(270, 126, 180, "rates.ts", "cached per issue date")}
      ${line(180, 47, 266, 47)}${line(450, 47, 536, 47)}${line(360, 74, 360, 122)}
      <text x="372" y="104" font-size="12" fill="currentColor" fill-opacity=".7">rate for 2026-11-07</text>
    </svg>`;
  }

  function mini(viewport, kind) {
    viewport.classList.add("mini");
    let html = "";
    if (kind === "reminder") {
      html = `<div class="mini-stage" style="background:#f4f5f7;padding:22px 30px;color:#1d2433">
        <div style="background:#fff;border-radius:8px;padding:18px 20px;box-shadow:0 1px 2px rgb(0 0 0/.08)">
        <div style="color:#6b7280;font-size:11px">To: accounts@brightwater.de</div>
        <div style="font-weight:650;font-size:15px;margin:6px 0 10px">Reminder: INV-0415 is due Friday</div>
        <div style="color:#374151">Hallo, a reminder that €2,850.00 is due on <b>Fri 27 Nov, 09:00 Berlin time</b>.</div>
        <div style="margin-top:14px;display:inline-block;background:#1f7a5c;color:#fff;border-radius:6px;padding:6px 12px;font-weight:600">Pay invoice</div></div>
        <div style="margin-top:12px;color:#6b7280;font-size:11px">Sent 08:00 CET, not 02:00 as before</div></div>`;
    } else if (kind === "diff") {
      html = `<div class="mini-stage" style="background:#fff;padding:20px 24px;font-family:ui-monospace,monospace;font-size:12px;color:#24292f;line-height:1.75">
        <div style="color:#57606a">8 files changed</div>
        ${["src/pdf/v1/render.ts", "src/pdf/v1/layout.ts", "src/pdf/v1/fonts.ts", "src/pdf/v1/table.ts", "src/pdf/v1/index.ts"].map((f) => `<div><span style="color:#cf222e">deleted</span>  ${f}</div>`).join("")}
        <div style="margin-top:8px"><span style="color:#1a7f37;font-weight:700">+0</span> <span style="color:#cf222e;font-weight:700">−1,284</span>  bundle 61 KB smaller</div></div>`;
    } else {
      html = `<div class="mini-stage" style="background:#16181d;color:#d7dae0;padding:20px 24px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.7">
        <div style="color:#8b93a1">$ npx eslint src/app/api</div>
        <div><span style="color:#f2777a">error</span>  Promises must be awaited  <span style="color:#8b93a1">no-floating-promises</span></div>
        <div style="color:#8b93a1">  src/app/api/webhooks/stripe/route.ts:41:5</div>
        <div style="margin-top:10px;color:#8b93a1">fixed in this PR, rule now required</div>
        <div style="color:#99d18f">0 problems in 112 files</div></div>`;
    }
    viewport.innerHTML = html;
    autoscale(viewport, viewport.firstElementChild, 480);
  }

  window.PROOF = { video, csv, diagram, mini, API, autoscale };
})();
