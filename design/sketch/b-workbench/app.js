(function () {
  const { F, dur, since, usd, clock, esc, STEP } = window.U;

  const rowsYours = [
    { id: "pr", t: F.waiting[1].title, k: "#219", s: "Ready to merge, with a recording", cls: "yours", go: "home" },
    { id: "talk", t: F.waiting[0].title, k: "#214", s: "Asked you a question 9 min ago", cls: "yours", go: "talk" },
    { id: "x", t: F.waiting[2].title, k: "#207", s: "Stuck after three tries", cls: "yours" },
    { id: "x", t: F.waiting[3].title, k: "#222", s: "From jonas-albuquerque, needs your OK", cls: "yours" },
    { id: "x", t: F.waiting[4].problem_class, k: "rule", s: "Seen 4 times. Add it as a lint rule?", cls: "yours" },
  ];
  const rowsMachine = F.live.map((r) => ({ id: "run", t: r.title, k: r.issue ? "#" + r.issue : "tidy", s: `${STEP[r.step]}, try ${r.attempt} of ${r.of}`, cls: "machine", prog: r.step === "builder" ? 45 : 70, go: r.step === "builder" ? "run" : undefined }))
    .concat(F.queued.map((q) => ({ t: q.title, k: q.issue ? "#" + q.issue : "harden", s: "Queued", cls: "machine" })))
    .concat(F.mergeQueue.map((m) => ({ t: m.title, k: "#" + m.pr, s: `Merges itself at ${clock(m.eligible_at)}`, cls: "machine" })));
  const rowsDone = F.landed.map((l) => ({ t: l.title, k: "#" + l.pr, s: `Merged itself at ${clock(l.merged_at)}, no edits`, cls: "done" }));

  const row = (r, cur) => `<div class="row ${r.cls}" role="link" tabindex="0" ${r.go ? `data-go="${r.go}"` : ""} aria-current="${r.id === cur}">
    <span class="ball" aria-hidden="true"></span><span class="t">${esc(r.t)}</span><span class="k tn">${r.k}</span>
    <span class="s ${r.cls === "yours" ? "ball-c" : ""}">${esc(r.s)}</span>${r.prog ? `<span class="prog"><i style="width:${r.prog}%"></i></span>` : ""}</div>`;

  const list = (cur) => `<nav class="list" aria-label="Requests">
    <section class="group"><h2>Your move <span>${rowsYours.length}</span></h2>${rowsYours.map((r) => row(r, cur)).join("")}</section>
    <section class="group"><h2>The factory's move <span>${rowsMachine.length}</span></h2>${rowsMachine.map((r) => row(r, cur)).join("")}</section>
    <section class="group"><h2>Landed since last night <span>${rowsDone.length}</span></h2>${rowsDone.map((r) => row(r, cur)).join("")}</section></nav>`;

  const bar = `<header class="bar"><span class="repo">ledgerline <span>maraokafor</span></span>
    <span class="find">Search requests, or type a new one <kbd>/</kbd></span><span class="grow"></span>
    <span class="spend tn">${usd(F.metrics.spend_usd)} of ${usd(F.metrics.budget_usd)}<span class="meter"><i style="width:${(F.metrics.spend_usd / F.metrics.budget_usd) * 100}%"></i></span></span>
    <button class="b-btn" type="button">New request <kbd>N</kbd></button></header>`;

  const node = (cls, title, when, body) => `<div class="node ${cls}"><span class="dot" aria-hidden="true"></span><div class="n-body"><div class="n-title"><b>${title}</b><span>${when}</span></div>${body}</div></div>`;

  function prDetail() {
    const p = F.pr;
    return `<section class="detail" aria-label="Request #203">
      <header class="d-head"><div class="meta"><span>#203</span><span>PR #219</span><span class="route">Product work <select aria-label="Move to another lane"><option>Move to…</option><option>Gardening</option><option>Hardening</option></select></span><span>${dur(p.duration)}, ${usd(p.cost)}</span></div>
        <h1>${esc(p.title)}</h1></header>
      <div class="spine">
        ${node("ok", "You asked", "Mon 23 Nov", `<div class="quote">Our accountant needs the November invoices as CSV, in the client's currency, not converted to dollars.</div>`)}
        ${node("ok", "Talked it through", "4 messages, Mon", `<details><summary>It played back: export the list to CSV, keep each client's currency, add the rate used on the invoice date. You agreed.</summary></details>`)}
        ${node("ok", "Built and checked", "26 min, $3.84", `<div class="n-sub">Spec, build, verify. Both gates passed first try; coverage on changed lines 94%.</div>`)}
        ${node("now", "Proof", "4 pieces", `<ul class="summary3">${p.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
          <div class="proofgrid">
            <div class="pf main"><div class="vid" data-film><div class="vp"></div><div class="ov"><button type="button" aria-label="Play the recording"><svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1v16l14-8z" fill="currentColor"/></svg></button><span class="tl">0:00 / 0:42</span></div><div class="line"><i></i></div></div>
              <div class="cap"><b>export-flow.webm</b>${esc(p.blocks[0].caption)}</div></div>
            <div class="pf"><div data-csv></div><div class="cap"><b>csv-opened.png</b>${esc(p.blocks[1].caption)}</div></div>
            <div class="pf"><div class="diag">${window.PROOF.diagram()}</div><div class="cap"><b>Where the rate comes from</b>Fetched once per invoice date.</div></div>
          </div>
          <div class="files">${p.files.map((f) => `<div class="f"><span>${f.name}</span><span class="tn"><span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></span></div>`).join("")}</div>`)}
        ${node("", "Merge", "your move", `<div class="n-sub">Closes #203 and deletes the branch.</div>`)}
      </div>
      <div class="dock"><span class="say"><b>Your move.</b> Look at the recording, then merge.</span>
        <button class="b-btn ghost" type="button">Comment <kbd>C</kbd></button><button class="b-btn" type="button">Request changes <kbd>R</kbd></button><button class="b-btn go" type="button">Squash and merge <kbd>M</kbd></button></div>
    </section>`;
  }

  function talkDetail() {
    const B = F.brainstorm;
    const msgs = B.turns.map((t) => `<div class="msg ${t.who === "factory" ? "f" : "p"}">${esc(t.text)}</div>`).join("");
    return `<section class="detail" aria-label="Request #214">
      <header class="d-head"><div class="meta"><span>#214</span><span>Product work</span><span>opened 17 min ago</span></div><h1>${esc(B.title)}</h1></header>
      <div class="spine">
        ${node("ok", "You asked", "17 min ago", `<div class="quote">${esc(B.request)}</div>`)}
        ${node("now", "Talking it through", "listening", `<div class="chat" aria-live="polite"><span class="stamp">Today ${clock(B.turns[0].at)}</span>${msgs}<div data-slot></div></div>`)}
        ${node("", "Build, check, prove", "after you agree", `<div class="n-sub">Next you'll see a pull request with a recording.</div>`)}
      </div>
      <div class="dock col"><span class="live"><i aria-hidden="true"></i>Listening. Replies come back in seconds.</span>
        <form class="composer" data-compose><textarea rows="1" aria-label="Reply" placeholder="Reply on #214"></textarea><button class="b-btn go" type="submit">Send</button></form></div>
    </section>`;
  }

  function runDetail() {
    const r = F.live[0];
    const steps = [["triage", "Read", "41 s"], ["spec", "Spec", "5 min"], ["builder", "Build", "try 2 of 3"], ["verifier", "Verify", ""], ["gate", "Gate", ""]];
    const at = steps.findIndex((s) => s[0] === r.step);
    return `<section class="detail" aria-label="Request #221">
      <header class="d-head"><div class="meta"><span>#221</span><span>Product work</span><span class="tn">${since(r.started_at)} so far, ${usd(r.cost_usd_so_far)}</span></div><h1>${esc(r.title)}</h1></header>
      <div class="spine">
        ${node("ok", "You asked", "yesterday", `<div class="quote">Select a batch of paid invoices and archive them in one go. Archived ones should leave the default list but stay in reports.</div>`)}
        ${node("ok", "Talked it through", "3 messages", `<div class="n-sub">Agreed: archive is reversible, and archived invoices still count in reports.</div>`)}
        ${node("run", "Building", "try 2 of 3", `<div class="steps">${steps.map((s, i) => `<div class="${i < at ? "ok" : i === at ? "at" : ""}"><b>${s[1]}</b>${s[2]}</div>`).join("")}</div>
          <div class="log">${esc(r.note)}\nThe builder is fixing src/app/invoices/archive.ts:58 and re-running the static gate.</div>`)}
        ${node("", "Proof", "", `<div class="n-sub">The verifier will archive three invoices in the sandbox and record it.</div>`)}
      </div>
      <div class="dock"><span class="say">The factory's move. Nothing for you to do.</span><button class="b-btn ghost" type="button">Cancel the run</button></div>
    </section>`;
  }

  const SCREENS = [["home", "Pull request selected", () => list("pr") + prDetail()], ["talk", "Conversation, live", () => list("talk") + talkDetail()], ["run", "A run in flight", () => list("run") + runDetail()]];
  document.getElementById("app").innerHTML = SCREENS.map(([id, , fn]) => `<div class="shell" data-screen="${id}" hidden>${bar}${fn()}</div>`).join("");

  function wire(scope) {
    scope.querySelectorAll("[data-film]").forEach((el) => {
      if (el.dataset.w) return; el.dataset.w = 1;
      const tl = el.querySelector(".tl"), ln = el.querySelector(".line i");
      const c = window.PROOF.video(el.querySelector(".vp"), { onTime: (s, p) => { tl.textContent = `0:${String(Math.floor(s)).padStart(2, "0")} / 0:42`; ln.style.width = p * 100 + "%"; } });
      el.querySelector("button").addEventListener("click", () => c.play());
    });
    scope.querySelectorAll("[data-csv]").forEach((el) => { if (!el.dataset.w) { el.dataset.w = 1; window.PROOF.csv(el); } });
  }
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) window.showScreen(g.dataset.go); });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const scope = e.target.closest("[data-screen]"), chat = scope.querySelector(".chat"), ta = e.target.querySelector("textarea");
    chat.insertAdjacentHTML("beforeend", `<div class="msg p">${esc(ta.value.trim() || F.brainstorm.reply.text)}</div>`); ta.value = "";
    setTimeout(() => chat.insertAdjacentHTML("beforeend", `<div class="msg f" data-typing><span class="typing"><i></i><i></i><i></i></span></div>`), 1200);
    setTimeout(() => { const t = chat.querySelector("[data-typing]"); if (t) t.outerHTML = `<div class="msg f">${esc(F.brainstorm.next.text)}</div>`; }, 4200);
  });
  window.addEventListener("screen", (e) => {
    const s = document.querySelector(`[data-screen="${e.detail}"]`); wire(s);
    if (e.detail === "talk" && !s.dataset.ran) { s.dataset.ran = 1; setTimeout(() => s.querySelector("form").requestSubmit(), 600); }
  });
  window.U.chrome(SCREENS.map(([a, b]) => [a, b]), { name: "B. Workbench" });
})();
