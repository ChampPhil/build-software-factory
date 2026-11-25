(function () {
  const { F, ago, dur, since, usd, clock, esc, STEP } = window.U;
  const p = F.pr, B = F.brainstorm;

  const ticker = `<div class="ticker" role="status"><span class="name">Ledgerline</span>
    ${F.live.map((r) => `<span class="tk"><span class="spin" aria-hidden="true"></span><b>${esc(r.title)}</b>${STEP[r.step].toLowerCase()}, try ${r.attempt} of ${r.of}, <span class="tn">${since(r.started_at)}, ${usd(r.cost_usd_so_far)}</span></span>`).join("")}
    <span class="grow"></span><span class="tn">${usd(F.metrics.spend_usd)} of ${usd(F.metrics.budget_usd)} this month</span><button class="c-btn" type="button">New request</button></div>`;

  const calls = F.waiting.filter((w) => w.kind !== "review").map((w) => {
    if (w.kind === "question") return `<article class="call q"><span class="ty">A question for you, ${ago(w.since)}</span><h3>${esc(w.title)}</h3><p>${esc(w.line)}</p><div class="row"><button class="c-btn" type="button" data-go="talk" style="background:var(--cue);color:var(--cue-ink);border-color:var(--cue)">Answer</button></div></article>`;
    if (w.kind === "escalated") return `<article class="call x"><span class="ty">Stuck after three tries</span><h3>${esc(w.title)}</h3><p>Works in Chrome and Firefox; Safari still drops the session after 40 minutes asleep.</p><div class="row"><button class="c-btn" type="button">See the attempts</button><button class="c-btn plain" type="button">Close</button></div></article>`;
    if (w.kind === "trust") return `<article class="call"><span class="ty">From someone without write access</span><h3>${esc(w.title)}</h3><p>Filed by jonas-albuquerque. Nothing is spent until you say so.</p><div class="row"><button class="c-btn" type="button">Let it start</button><button class="c-btn plain" type="button">Close</button></div></article>`;
    return `<article class="call"><span class="ty">A rule it could add, seen ${w.occurrences} times</span><h3>${esc(w.problem_class)}</h3><p>You corrected this on #211 and three times before.</p><div class="row"><button class="c-btn" type="button">Add the rule</button><button class="c-btn plain" type="button">Not a rule</button></div></article>`;
  }).join("");

  const home = () => `${ticker}
    <section class="screening" aria-label="Up for review">
      <div><div class="screen-frame" data-film><div class="vp"></div><button class="bigplay" type="button" aria-label="Play the recording, 42 seconds"><span><svg width="30" height="34" viewBox="0 0 30 34"><path d="M3 2v30l25-15z" fill="var(--cue-ink)"/></svg></span></button></div>
        <div class="scrub"><span class="t tn">0:00</span><span class="tr"><i></i></span><span class="tn">0:42</span></div>
        <div class="strip" role="group" aria-label="Proof">
          <button type="button" aria-pressed="true"><div class="th"><div data-mini-video></div></div><div class="lb">Recording, 42 s</div></button>
          <button type="button" aria-pressed="false"><div class="th"><div data-csv></div></div><div class="lb">The exported file</div></button>
          <button type="button" aria-pressed="false"><div class="th" style="color:var(--ink-2);padding:8px">${window.PROOF.diagram()}</div><div class="lb">Where the rate comes from</div></button>
          <button type="button" aria-pressed="false"><div class="th" style="font:9px/1.4 ui-monospace,monospace;white-space:pre;place-items:start;padding:8px;text-align:left">${esc(window.PROOF.API.split("\n").slice(0, 7).join("\n"))}</div><div class="lb">API response</div></button>
        </div></div>
      <div class="billing"><span class="kick">Ready to merge, PR #${p.number}</span>
        <h1>${esc(p.title)}</h1>
        <ol>${p.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <div class="cta"><button class="c-btn cue" type="button">Merge #${p.number}</button><button class="c-btn" type="button">Request changes</button><button class="c-btn plain" type="button">Diff, ${p.files.length} files</button></div>
        <div class="facts"><span>Checks</span><b>Both gates passed first try</b><span>Cost</span><b class="tn">${usd(p.cost)}, ${dur(p.duration)}</b><span>Look at</span><b>${esc(p.focus[0].title)}</b></div>
      </div>
    </section>
    <section class="rack"><h2>Waiting on your word<span>${F.waiting.length - 1}</span></h2><div class="calls">${calls}</div>
      <h2>Landed overnight<span>${F.landed.length}, none needed you</span></h2>
      <div class="reel">${F.landed.map((l) => `<article><div class="mini" data-mini="${l.poster}"></div><h3>${esc(l.title)}</h3><p>Merged itself at ${clock(l.merged_at)}. ${usd(l.cost)}.</p></article>`).join("")}</div></section>`;

  const msg = (t) => `<div class="m ${t.who === "factory" ? "f" : "p"}"><div class="w">${t.who === "factory" ? "Factory" : "You"}, ${clock(t.at)}</div><div class="x">${esc(t.text)}</div></div>`;
  const talk = () => home() + `<div class="scrim"></div><aside class="sheet" aria-label="Conversation on #214">
    <header><span class="ty">#214, talking it through</span><h2>${esc(B.title)}</h2></header>
    <div class="msgs" aria-live="polite">${B.turns.map(msg).join("")}</div>
    <div class="foot"><div class="state"><i aria-hidden="true"></i>Listening. Replies in a few seconds.</div>
      <form class="composer" data-compose><textarea rows="1" aria-label="Reply" placeholder="Reply"></textarea><button class="c-btn cue" style="padding:8px 16px;font-size:15px" type="submit">Send</button></form></div></aside>`;

  const SCREENS = [["home", "Screening: up for review", home], ["talk", "Conversation sheet, live", talk]];
  document.getElementById("app").innerHTML = SCREENS.map(([id, , fn]) => `<div data-screen="${id}" hidden>${fn()}</div>`).join("");

  function wire(s) {
    s.querySelectorAll("[data-film]").forEach((el) => {
      if (el.dataset.w) return; el.dataset.w = 1;
      const wrap = el.parentElement, t = wrap.querySelector(".scrub .t"), bar = wrap.querySelector(".scrub i");
      const c = window.PROOF.video(el.querySelector(".vp"), { onTime: (x, q) => { t.textContent = `0:${String(Math.floor(x)).padStart(2, "0")}`; bar.style.width = q * 100 + "%"; }, onEnd: () => el.classList.remove("playing") });
      el.querySelector(".bigplay").addEventListener("click", () => { el.classList.add("playing"); c.play(); });
    });
    s.querySelectorAll("[data-mini-video]").forEach((el) => { if (!el.dataset.w) { el.dataset.w = 1; window.PROOF.video(el, { final: true }); } });
    s.querySelectorAll("[data-csv]").forEach((el) => { if (!el.dataset.w) { el.dataset.w = 1; window.PROOF.csv(el); } });
    s.querySelectorAll("[data-mini]").forEach((el) => { if (!el.dataset.w) { el.dataset.w = 1; window.PROOF.mini(el, el.dataset.mini); } });
  }
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) window.showScreen(g.dataset.go); if (e.target.closest(".scrim")) window.showScreen("home"); });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const box = e.target.closest(".sheet").querySelector(".msgs"), ta = e.target.querySelector("textarea");
    box.insertAdjacentHTML("beforeend", msg({ ...B.reply, text: ta.value.trim() || B.reply.text })); ta.value = "";
    setTimeout(() => box.insertAdjacentHTML("beforeend", `<div class="m f" data-typing><div class="w">Factory</div><span class="typing"><i></i><i></i><i></i></span></div>`), 1200);
    setTimeout(() => { const t = box.querySelector("[data-typing]"); if (t) t.outerHTML = msg(B.next); }, 4200);
  });
  window.addEventListener("screen", (e) => { const s = document.querySelector(`[data-screen="${e.detail}"]`); wire(s); if (e.detail === "talk" && !s.dataset.ran) { s.dataset.ran = 1; setTimeout(() => s.querySelector("form").requestSubmit(), 600); } });
  window.U.chrome(SCREENS.map(([a, b]) => [a, b]), { name: "C. Reel" });
})();
