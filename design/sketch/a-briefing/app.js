/*
 * Direction A, the Briefing, as the whole dashboard.
 *
 * Every page, panel and action the product needs, running on synthetic data.
 * Actions change the sketch's state and say what they did, the way the real
 * dashboard will after the GitHub call returns. Nothing leaves the page.
 */
(function () {
  const { F, ago, dur, since, usd, clock, pct, num, esc, PIPE, STEP } = window.U;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ------------------------------------------------------------------ state */
  const S = {
    items: clone(F.items),
    runs: clone(F.runs),
    candidates: clone(F.candidates),
    goals: clone(F.goals),
    settings: clone(F.settings),
    workflows: clone(F.workflows),
    landed: clone(F.landed),
    prComments: clone(F.prComments),
    activity: { 207: clone(F.issueActivity207) },
    lineComments: [],
    viewed: new Set(),
    reqFilter: "open",
    reqPipe: "all",
    reqQuery: "",
    runFilter: "all",
    talk: "live",          // first | live | cold | understood
    mergeMethod: "squash",
    nextIssue: 224,
    nextPr: 225,
    theme: "system",
    mode: "busy",          // busy | quiet | empty
    prefill: "",
  };
  const key = (it) => (it.issue ? String(it.issue) : it.id.slice(-5).toLowerCase());
  const itemBy = (k) => S.items.find((i) => key(i) === String(k));
  const byIssue = (n) => S.items.find((i) => i.issue === n);
  const runShort = (r) => r.id.replace("run_", "").toLowerCase();
  const runBy = (s) => S.runs.find((r) => runShort(r) === s);
  const OPEN = ["queued", "running", "in_review", "queued_to_merge", "escalated", "waiting_trust", "needs_info"];
  const NEEDS = ["needs_info", "in_review", "escalated", "waiting_trust"];
  const STATUS = {
    queued: "Queued", running: "Running", in_review: "Ready to merge", queued_to_merge: "Merging itself", merged: "Merged",
    escalated: "Stuck, needs you", duplicate: "Duplicate", rejected: "Turned down", waiting_trust: "Waiting for your OK", needs_info: "Question for you", closed: "Closed",
  };
  const TONE = { needs_info: "you", in_review: "you", escalated: "stop", waiting_trust: "you", running: "busy", queued_to_merge: "busy", merged: "done" };
  const OUTCOME = { running: "Running", draft_pr: "Opened a PR", merged: "Merged", escalated: "Handed to you", duplicate: "Duplicate", failed: "Failed", cancelled: "Cancelled", rejected: "Turned down", no_action: "Nothing to do" };
  const KINDS = [["feature", "Feature", "Add or change something"], ["bug", "Bug", "Something is broken"], ["harden", "Harden", "A mistake that keeps happening"], ["tidy", "Tidy", "Clean up without changing behaviour"]];
  const SOURCE = { issue: "an issue", slack: "Slack", schedule: "the nightly schedule", review: "the factory's self-review", correction: "a correction you made", ci_failure: "a CI failure on main" };

  /* ------------------------------------------------------------------ icons */
  const I = {
    mark: '<svg class="mark" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="7" fill="currentColor"/><path d="M10 8.2v9.6l7.6-4.8z" fill="var(--paper)"/></svg>',
    play: '<svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true"><path d="M2 2.5v29L28 17z" fill="#111"/></svg>',
    check: '<svg class="ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="var(--done)"/><path d="M4.5 8.2l2.2 2.2 4.8-4.8" stroke="var(--sheet)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg class="ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="var(--stop)"/><path d="M5.5 5.5l5 5m0-5l-5 5" stroke="var(--sheet)" stroke-width="1.8" stroke-linecap="round"/></svg>',
    spin: '<span class="spinner" aria-hidden="true"></span>',
    search: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    ext: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    gh: '<svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.150-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  };
  const gh = (path, label = "Open on GitHub") => `<a class="out" href="https://github.com/${F.repo}/${path}" target="_blank" rel="noopener">${label} ${I.ext}</a>`;
  const badge = (status) => `<span class="badge ${TONE[status] || ""}">${STATUS[status] || status}</span>`;

  /* ------------------------------------------------------------------ chrome */
  const NAV = [["home", "Briefing"], ["requests", "Requests"], ["runs", "Runs"], ["guardrails", "Guardrails"], ["spend", "Spend"], ["factory", "Factory"]];
  function top(route) {
    const section = route.startsWith("r-") ? "requests" : route.startsWith("run-") ? "runs" : route.startsWith("factory") ? "factory" : route;
    const needs = needsList().length;
    return `<header class="top"><div class="top-in">
      <button class="repo" type="button" data-pop="repos" aria-haspopup="menu">${I.mark}<span>ledgerline <small>maraokafor</small></span>${I.chev}</button>
      <nav class="nav" aria-label="Main">${NAV.map(([id, label]) => `<a href="#${id}" data-go="${id}" ${section === id ? 'aria-current="page"' : ""}>${label}${id === "home" && needs ? ` <span class="count">${needs}</span>` : ""}</a>`).join("")}</nav>
      <span class="gap"></span>
      <button class="btn search" type="button" data-act="palette">${I.search}<span class="lbl">Search or do anything</span><kbd>/</kbd></button>
      <button class="btn go" type="button" data-act="new-request"><span aria-hidden="true">+</span><span class="lbl">New request</span></button>
      <button class="avatar" type="button" data-pop="me" aria-haspopup="menu" aria-label="Your account">MO</button>
    </div></header>`;
  }

  /* ------------------------------------------------------------------ shared pieces */
  const film = (id, opts = {}) => `
    <div class="film" data-film="${id}" data-final="${opts.final ? 1 : ""}">
      <div class="vp"></div>
      <button class="play" type="button" aria-label="Play the recording, 42 seconds"><span class="disc">${I.play}</span></button>
      <div class="bar"><span class="label">0:00</span><span class="track"><i></i></span><span>0:42</span></div>
    </div>`;
  const tries = (a, of) => `<span class="tries" aria-label="attempt ${a} of ${of}">${Array.from({ length: of }, (_, i) => `<i class="${i < a - 1 ? "used" : i === a - 1 ? "now" : ""}"></i>`).join("")}</span>`;
  const SHORT = { triage: "Read", spec: "Spec", brainstorm: "Talk", builder: "Build", verifier: "Verify", gate: "Gate", gardener: "Tidy", hardener: "Harden", scorer: "Score" };

  function needsList() {
    if (S.mode !== "busy") return [];
    const list = [];
    S.items.filter((i) => i.status === "needs_info" && i.issue).forEach((i) => list.push({ kind: "question", it: i }));
    S.items.filter((i) => i.status === "in_review").forEach((i) => list.push({ kind: "review", it: i }));
    S.items.filter((i) => i.status === "escalated").forEach((i) => list.push({ kind: "escalated", it: i }));
    S.items.filter((i) => i.status === "waiting_trust").forEach((i) => list.push({ kind: "trust", it: i }));
    S.items.filter((i) => i.status === "needs_info" && !i.issue).forEach((i) => list.push({ kind: "noissue", it: i }));
    S.candidates.filter((c) => c.status === "pending").forEach((c) => list.push({ kind: "candidate", c }));
    return list;
  }
  const liveRuns = () => (S.mode === "busy" ? S.runs.filter((r) => r.outcome === "running" && r.issue !== 214) : []);

  /* ------------------------------------------------------------------ home */
  function needCard(n) {
    const it = n.it;
    if (n.kind === "question") return `
      <article class="item ask">
        <div class="where"><span class="tag you">Your answer moves this on</span><span>#${it.issue}</span><span>asked ${ago(F.waiting[0].since)}</span></div>
        <h3><a href="#r-${key(it)}" data-go="r-${key(it)}">${esc(it.title)}</a></h3>
        <p class="voice">${esc(F.waiting[0].line)}</p>
        <form class="answer" data-act-submit="answer" data-k="${key(it)}">
          <textarea class="field" rows="1" aria-label="Your answer" placeholder="Answer here, or on the issue"></textarea>
          <button class="btn go" type="submit">Send</button>
          <span class="listening"><span class="pulse" aria-hidden="true"></span>Listening now. A reply takes a few seconds.</span>
        </form>
      </article>`;
    if (n.kind === "review") return `
      <article class="item proof">
        <div class="head">
          <div class="where"><span class="tag">Ready to merge</span><span>PR #${it.pr} for #${it.issue}</span><span>opened ${ago(F.pr.opened_at)}</span></div>
          <h3><a href="#r-${key(it)}" data-go="r-${key(it)}">${esc(it.title)}</a></h3>
        </div>
        ${film("home")}
        <div class="body">
          <ul class="summary">${F.pr.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
          <div class="acts">
            <button class="btn go" type="button" data-act="merge" data-pr="${it.pr}">Merge #${it.pr}</button>
            <button class="btn" type="button" data-go="r-${key(it)}">All proof and the diff</button>
            <button class="btn quiet" type="button" data-act="request-changes" data-pr="${it.pr}">Request changes</button>
          </div>
          <div class="facts"><span>${I.check} Checks passed</span><span><b>${usd(it.cost)}</b> to build</span><span>${dur(F.pr.duration)} start to finish</span></div>
        </div>
      </article>`;
    if (n.kind === "escalated") return `
      <article class="item">
        <div class="where"><span class="tag stop">Stuck after three tries</span><span>#${it.issue}</span><span>${ago(F.waiting[2].since)}</span></div>
        <h3><a href="#r-${key(it)}" data-go="r-${key(it)}">${esc(it.title)}</a></h3>
        <p class="voice small">${esc(F.waiting[2].line)}</p>
        <div class="acts"><button class="btn" type="button" data-go="r-${key(it)}">Read what it tried</button><button class="btn" type="button" data-act="comment" data-n="${it.issue}" data-title="Reply on #${it.issue}" data-placeholder="Tell it what to try, or answer its question">Reply with a note</button><button class="btn quiet" type="button" data-act="close-issue" data-n="${it.issue}">Close the request</button></div>
        <div class="facts"><span><b>${usd(it.cost)}</b> spent across the three tries</span></div>
      </article>`;
    if (n.kind === "trust") return `
      <article class="item">
        <div class="where"><span class="tag you">Someone new asked</span><span>#${it.issue}</span><span>${ago(it.created_at)}</span></div>
        <h3><a href="#r-${key(it)}" data-go="r-${key(it)}">${esc(it.title)}</a></h3>
        <p class="voice small">${esc(F.waiting[3].line)}</p>
        <div class="acts"><button class="btn" type="button" data-act="trust" data-n="${it.issue}">Let the factory start it</button><button class="btn quiet" type="button" data-act="close-issue" data-n="${it.issue}">Close it</button></div>
      </article>`;
    if (n.kind === "noissue") return `
      <article class="item">
        <div class="where"><span class="tag you">A question with nowhere to answer</span><span>from Slack, ${esc(it.source.ref)}</span></div>
        <h3><a href="#r-${key(it)}" data-go="r-${key(it)}">${esc(it.title)}</a></h3>
        <p class="voice small">Should the late fee stop on the day the plan is agreed, or on the first instalment's due date?</p>
        <div class="acts"><button class="btn" type="button" data-act="open-issue-for" data-k="${key(it)}">Open an issue to answer it</button><button class="btn quiet" type="button" data-act="drop" data-k="${key(it)}">Drop the request</button></div>
      </article>`;
    const c = n.c;
    return `
      <article class="item">
        <div class="where"><span class="tag">A rule it could add</span><span>seen ${c.occurrences} times this month</span></div>
        <h3><a href="#guardrails" data-go="guardrails">${esc(c.problem_class)}</a></h3>
        <p class="voice small">${esc(F.waiting[4].line)}</p>
        <div class="acts"><button class="btn" type="button" data-act="candidate" data-id="${c.id}" data-d="accept">Add it as a lint rule</button><button class="btn quiet" type="button" data-act="candidate" data-id="${c.id}" data-d="reject">Not a rule</button></div>
      </article>`;
  }

  function runLine(r) {
    const path = r.pipeline === "gardening" ? ["gardener", "verifier", "gate"] : ["triage", "spec", "builder", "verifier", "gate"];
    const at = r.steps[r.steps.length - 1];
    const i = path.indexOf(at.role);
    return `<a class="run-line" href="#run-${runShort(r)}" data-go="run-${runShort(r)}">
      <span class="t">${esc(r.title)}</span>
      <span class="s">${STEP[at.role] || at.role}${at.attempt > 1 ? `, try ${at.attempt} of 3` : ""} ${tries(at.attempt, 3)}</span>
      <span class="trail" aria-hidden="true">${path.map((p, j) => `<i class="${j < i ? "ok" : j === i ? "at" : ""}">${SHORT[p] || p}</i>`).join("")}</span>
      <span class="m">${since(r.started_at)}, ${usd(r.cost)}</span></a>`;
  }

  function rail() {
    const m = F.metrics, spent = m.spend_usd / S.settings.monthly_budget;
    const live = liveRuns();
    const queued = S.mode === "busy" ? S.items.filter((i) => i.status === "queued") : [];
    const mq = S.mode === "busy" ? S.items.filter((i) => i.status === "queued_to_merge") : [];
    return `<aside class="rail" aria-label="The factory right now">
      <section><h2 class="part">Going now</h2>${live.length ? live.map(runLine).join("") : `<p class="muted">Nothing is running. Gardening starts at ${hourLocal(S.settings.gardening_hour)}.</p>`}</section>
      ${queued.length || mq.length ? `<section><h2 class="part">Up next</h2><ul class="mini-list">
        ${queued.map((q) => `<li><a href="#r-${key(q)}" data-go="r-${key(q)}">${esc(q.title)}</a><span>${PIPE[q.pipeline]}${q.priority === "high" ? ", high priority" : ""}</span></li>`).join("")}
        ${mq.map((q) => `<li><a href="#r-${key(q)}" data-go="r-${key(q)}">${esc(q.title)}</a><span>PR #${q.pr} merges itself at ${clock(F.mergeQueue[0].eligible_at)}</span></li>`).join("")}</ul></section>` : ""}
      <section><h2 class="part">This month</h2>
        <div class="meter"><div class="rail-bar" role="img" aria-label="${pct(spent)} of the budget"><i style="width:${Math.min(100, spent * 100)}%"></i></div>
        <p><b>${usd(m.spend_usd)}</b> of your ${usd(S.settings.monthly_budget)} budget. ${pct(m.automation_rate)} of merges needed no edits. <a href="#spend" data-go="spend">Spend</a></p></div></section>
      ${S.goals.length ? `<section><h2 class="part">Standing goal</h2>${S.goals.map((g) => `<p class="goal">${esc(g.text)}<span>${g.lane ? PIPE[g.lane] : "Any work"}${g.until ? `, until ${new Date(g.until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</span></p>`).join("")}<a href="#factory-goals" data-go="factory-goals">Manage goals</a></section>` : ""}
    </aside>`;
  }

  function landedRow(list) {
    return `<div class="done-list">${list.slice(0, 3).map((l) => {
      const it = S.items.find((i) => i.pr === l.pr);
      const to = it ? "r-" + key(it) : "requests";
      return `<a class="done" href="#${to}" data-go="${to}"><div class="mini" data-mini="${l.poster}"></div>
        <div><h3>${esc(l.title)}</h3><p>Merged ${l.by === "auto-merge" ? "itself" : "by you"} at ${clock(l.merged_at)}${l.by === "auto-merge" ? " with no edits from you" : ""}. ${usd(l.cost)}.</p></div></a>`;
    }).join("")}</div>`;
  }

  function home() {
    if (S.mode === "empty") return emptyHome();
    const needs = needsList();
    const live = liveRuns();
    const quiet = S.mode === "quiet";
    const when = quiet ? "Thursday, 7:55 am. You were last here at 10:30 last night." : "Wednesday, 8:40 am. You were last here at 11:10 last night.";
    const head = needs.length ? `${num(needs.length)} ${needs.length === 1 ? "thing needs" : "things need"} you.` : "Nothing needs you.";
    const rest = quiet ? `Nothing is running. <a href="#landed">Three changes landed</a> overnight, all checked, none needing an edit.`
      : `${live.length ? `${num(live.length)} ${live.length === 1 ? "run is" : "runs are"} going.` : "Nothing is running."} <a href="#landed">${num(F.landed.length)} changes landed</a> while you were away, and none of them needed you.`;
    return `<main class="wrap">
      <section class="lede"><p class="when">${when}</p><h1>${head}</h1><p class="rest">${rest}</p></section>
      <div class="cols">
        <div class="main-col">
          ${needs.length ? `<section aria-label="Needs you" class="needs">${needs.map(needCard).join("")}</section>` : `<p class="all-clear">When something needs you, it shows up here first: a question to answer, a change to merge, or a request that got stuck.</p>`}
          <section class="landed" id="landed" aria-labelledby="landed-h"><h2 class="part" id="landed-h">Landed overnight</h2>${landedRow(S.landed)}</section>
        </div>
        ${rail()}
      </div>
    </main>`;
  }

  function emptyHome() {
    return `<main class="wrap">
      <section class="lede"><p class="when">Set up 4 minutes ago on maraokafor/ledgerline.</p>
        <h1>The factory is ready for its first request.</h1>
        <p class="rest">Describe one change. It will ask you a few questions, build it, check it in a sandbox, and come back with a pull request and a recording of it working.</p></section>
      <div class="cols"><div class="main-col">${requestForm({ first: true })}</div>
      <aside class="rail"><section><h2 class="part">How a request goes</h2><ol class="how">
        <li><b>It asks.</b> One question at a time, until it can say what it's about to build.</li>
        <li><b>It builds.</b> Usually 10 to 40 minutes on GitHub Actions, inside your ${usd(S.settings.monthly_budget)} budget.</li>
        <li><b>It proves.</b> Drives your app in a sandbox and records what it sees.</li>
        <li><b>You merge.</b> From here; you shouldn't need to open GitHub.</li></ol></section>
        <section><h2 class="part">Already set up</h2><p class="muted">Gardening runs nightly at ${hourLocal(S.settings.gardening_hour)}. ${F.rules.length} guardrails from your history are installed. <a href="#factory" data-go="factory">Check the settings</a></p></section></aside></div>
    </main>`;
  }

  function requestForm(opts = {}) {
    const k = opts.kind || "feature";
    return `<form class="request-form ${opts.first ? "first" : ""}" data-act-submit="new-request" aria-label="New request">
      <div class="kinds" role="radiogroup" aria-label="Kind of request">${KINDS.map(([id, label, hint]) => `<label class="kind"><input type="radio" name="kind" value="${id}" ${id === k ? "checked" : ""}><span><b>${label}</b>${hint}</span></label>`).join("")}</div>
      <label class="lab" for="nr-title">What do you want?</label>
      <input id="nr-title" name="title" class="field" required value="${opts.first ? "Show the payment method on the receipt PDF" : ""}" placeholder="One line, the way you'd title an issue">
      <label class="lab" for="nr-body">Anything it should know</label>
      <textarea id="nr-body" name="body" class="field" rows="4" placeholder="Where it goes, who it's for, what it must not break">${opts.first ? "Clients keep asking whether they paid by card or bank transfer. Put it under the total." : ""}</textarea>
      <label class="lab" for="nr-goal">How you'll know it worked <span class="opt">optional</span></label>
      <input id="nr-goal" name="goal" class="field" placeholder="For example: the receipt shows Visa ending 4242">
      ${opts.first ? `<p class="muted small">Setup suggested this one from your open issues. Change it or write your own.</p>` : ""}
      <div class="acts"><button class="btn go" type="submit">Send to the factory</button><span class="muted small">Opens issue #${S.nextIssue} as you. The factory replies there and here.</span></div>
    </form>`;
  }

  /* ------------------------------------------------------------------ requests list */
  const FILTERS = [["open", "Open", (i) => OPEN.includes(i.status)], ["needs", "Needs you", (i) => NEEDS.includes(i.status)], ["running", "In progress", (i) => ["running", "queued", "queued_to_merge"].includes(i.status)], ["merged", "Merged", (i) => i.status === "merged"], ["closed", "Closed", (i) => ["duplicate", "rejected", "closed"].includes(i.status)], ["all", "All", () => true]];
  function requests() {
    const f = FILTERS.find((x) => x[0] === S.reqFilter);
    const q = S.reqQuery.toLowerCase();
    const list = S.items.filter(f[2]).filter((i) => S.reqPipe === "all" || i.pipeline === S.reqPipe).filter((i) => !q || i.title.toLowerCase().includes(q) || String(i.issue).includes(q));
    const order = ["needs_info", "escalated", "in_review", "waiting_trust", "running", "queued_to_merge", "queued", "merged", "duplicate", "rejected", "closed"];
    list.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || Date.parse(b.created_at) - Date.parse(a.created_at));
    return `<main class="wrap">
      <header class="page-head"><h1>Requests</h1><p class="rest">Everything the factory has been asked to do, from issues, Slack, the nightly schedule and its own reviews.</p></header>
      <div class="toolbar">
        <div class="seg" role="tablist" aria-label="Filter by state">${FILTERS.map(([id, label, fn]) => `<button type="button" role="tab" aria-selected="${S.reqFilter === id}" data-act="req-filter" data-v="${id}">${label} <span>${S.items.filter(fn).length}</span></button>`).join("")}</div>
        <label class="sel"><span class="vh">Kind of work</span><select class="field" data-act-change="req-pipe"><option value="all">All kinds</option>${Object.entries(PIPE).map(([k, v]) => `<option value="${k}" ${S.reqPipe === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <input class="field find" type="search" placeholder="Filter by title or number" value="${esc(S.reqQuery)}" data-act-input="req-query" aria-label="Filter requests">
      </div>
      <div class="table req-t" role="table" aria-label="Requests">
        <div class="tr th" role="row"><span role="columnheader">Request</span><span role="columnheader">State</span><span role="columnheader">Kind</span><span role="columnheader">From</span><span role="columnheader">Opened</span><span role="columnheader" class="r">Cost</span></div>
        ${list.map((i) => `<a class="tr" role="row" href="#r-${key(i)}" data-go="r-${key(i)}">
          <span role="cell" class="t"><b>${esc(i.title)}</b><small>${i.issue ? "#" + i.issue : "no issue"}${i.pr ? `, PR #${i.pr}` : ""}${i.priority === "high" ? ", high priority" : ""}</small></span>
          <span role="cell">${badge(i.status)}</span><span role="cell">${PIPE[i.pipeline]}</span>
          <span role="cell">${esc(i.source.actor === "factory" ? SOURCE[i.source.kind] : i.source.actor === "maraokafor" ? "You" : i.source.actor)}</span>
          <span role="cell">${ago(i.created_at)}</span><span role="cell" class="r">${usd(i.cost)}</span></a>`).join("") || `<p class="empty-row">No requests match. <button class="link" type="button" data-act="req-filter" data-v="all">Show all</button></p>`}
      </div>
    </main>`;
  }

  /* ------------------------------------------------------------------ one request */
  const B = F.brainstorm;
  function turn(t, opts = {}) {
    return `<div class="turn ${t.who === "factory" ? "f" : "p"} ${opts.latest ? "latest" : ""} ${opts.sending ? "sending" : ""}">
      <div class="who"><span>${t.who === "factory" ? "The factory" : t.by || "You"}</span><span>${opts.when || clock(t.at)}</span></div>
      <div class="text">${esc(t.text)}</div></div>`;
  }
  const LIVE = `<span class="pulse" aria-hidden="true"></span><span>Listening. Replies come back in a few seconds.</span>`;
  const COLD = `<span class="cold-dot" aria-hidden="true"></span><span>Gone quiet since yesterday. Send anyway: your answer wakes the factory, and the next question takes a few minutes.</span>`;

  function talkPane(it) {
    if (!it.issue) return `<div class="talk-col"><div class="thread">${turn({ who: "factory", at: "2026-11-25T12:02:00Z", text: "Should the late fee stop on the day the plan is agreed, or on the first instalment's due date?" }, { latest: true })}</div>
      <div class="nowhere"><b>This request came from Slack and has no issue, so there's nowhere to answer it yet.</b> Open an issue for it and the conversation carries on there and here.
      <div class="acts"><button class="btn go" type="button" data-act="open-issue-for" data-k="${key(it)}">Open an issue for it</button><button class="btn quiet" type="button" data-act="drop" data-k="${key(it)}">Drop the request</button></div></div></div>`;
    if (it.issue === 203) return `<p class="muted">The conversation ended on 23 Nov when you agreed to this playback. The spec stage took it from there.</p>
      <section class="played calm"><h2>What it understood</h2><p class="voice">Add an export of the invoice list to CSV. Keep each amount in the client's currency rather than converting, and include the exchange rate used on the invoice date so the accountant can reconcile.</p></section>`;
    if (it.issue !== 214) return `<p class="muted">There was no conversation for this request: it was clear enough to start from the issue alone.</p>`;
    const cold = S.talk === "cold";
    let turns = "", placeholder = "Answer the question", hint = "Posts to #214 as you. Answers typed on GitHub show up here too.";
    if (S.talk === "first") turns = turn(B.turns[0], { latest: true, when: "just now" });
    else if (S.talk === "understood") {
      const all = [...B.turns, B.reply, B.next, { at: "2026-11-25T13:33:20Z", who: "person", text: "Each instalment on its own date." }];
      turns = `<button class="btn quiet" type="button" data-act="show-earlier" style="align-self:flex-start">Show the ${all.length - 3} earlier messages</button>${all.slice(-3).map((t) => turn(t)).join("")}
        <section class="played" aria-labelledby="played-h"><h2 id="played-h">Here's what I'll build</h2><p class="voice">${esc(B.understood)}</p>
        <div class="acts"><button class="btn go" type="button" data-act="agree">That's right, build it</button><button class="btn" type="button" data-act="focus-compose">Correct something</button></div></section>`;
      placeholder = "Correct anything that's wrong";
      hint = "If this is right, you don't need to reply. Next you'll see a pull request with a recording of it working.";
    } else turns = B.turns.map((t, i) => turn(t, { latest: i === B.turns.length - 1, when: cold ? "yesterday " + clock(t.at) : undefined })).join("");
    return `<div class="talk-col"><div class="thread" aria-live="polite">${turns}</div>
      <div class="dock"><div class="status" data-status>${cold ? COLD : LIVE}</div>
        <form class="compose" data-act-submit="talk"><textarea rows="1" aria-label="Your answer" placeholder="${placeholder}"></textarea><button class="btn go" type="submit">Send</button></form>
        <div class="hint">${hint}</div></div></div>`;
  }

  function prPane(it) {
    const p = F.pr;
    const merged = it.status === "merged";
    if (it.pr !== 219) return `<div class="pr-lite"><p class="voice small">PR #${it.pr}: ${esc(it.title)}.</p>
      <div class="mini" data-mini="${it.pipeline === "gardening" ? "diff" : it.pipeline === "hardening" ? "lint" : "reminder"}"></div>
      <p class="muted">${merged ? `Merged itself at ${clock(it.merged_at)} after both gates passed. No edits from you.` : `Checks passed. Merges itself at ${clock(F.mergeQueue[0].eligible_at)}, because you let gardening merge by itself.`}</p>
      <div class="acts">${merged ? gh(`pull/${it.pr}`, "See it on GitHub") : `<button class="btn go" type="button" data-act="merge" data-pr="${it.pr}">Merge now</button><button class="btn" type="button" data-act="request-changes" data-pr="${it.pr}">Request changes, which holds it</button>`}</div></div>`;
    const block = (b) => {
      if (b.kind === "video") return `<div class="wide-film">${film("pr")}</div><p class="caption">${esc(b.caption)}</p>`;
      if (b.kind === "image") return `<div class="block-img"><div data-csv></div></div><p class="caption">${esc(b.caption)}</p>`;
      if (b.kind === "diagram") return `<div class="diagram">${window.PROOF.diagram()}</div><p class="caption"><b>${esc(b.title)}.</b> Rates are fetched once for each invoice date and reused.</p>`;
      return `<pre class="log">${esc(window.PROOF.API)}</pre><p class="caption">${esc(b.caption)}</p>`;
    };
    const fileBlock = (f, i) => {
      const lines = i === 0 ? p.patch : [[" ", 1, "// " + f.name], ["+", 2, "// " + f.additions + " lines added, " + f.deletions + " removed in this file"]];
      const lc = S.lineComments.filter((c) => c.file === f.name);
      return `<details class="file" ${i === 0 ? "open" : ""}>
        <summary><span class="fname">${f.name}</span><span class="delta"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span>
          <label class="viewed"><input type="checkbox" data-act-change="viewed" data-f="${f.name}" ${S.viewed.has(f.name) ? "checked" : ""}> Viewed</label></summary>
        <div class="patch" aria-label="Changes in ${f.name}">${lines.map(([k, n, t]) => `<div class="${k === "+" ? "p" : k === "-" ? "m" : ""}"><button class="ln" type="button" data-act="line-comment" data-f="${f.name}" data-l="${n}" aria-label="Comment on line ${n}">${n}</button><span>${k === " " ? "" : k}</span><span>${esc(t)}</span></div>${lc.filter((c) => c.line === n).map((c) => `<div class="line-note"><b>You</b> ${esc(c.text)}</div>`).join("")}`).join("")}</div>
      </details>`;
    };
    return `
      <ul class="pr-summary">${p.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
      ${merged ? `<div class="merged-note">${I.check} Merged into main as ${S.mergeMethod === "squash" ? "one squashed commit" : S.mergeMethod === "rebase" ? "rebased commits" : "a merge commit"}. Request #${it.issue} is closed and the branch is deleted.</div>` : ""}
      ${p.blocks.map(block).join("")}
      <div class="two">
        <section><h2 class="sect">Where to look</h2><div class="focus">${p.focus.map((f) => `<div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p>${f.files.map((x) => `<a class="file-link" href="#diff" data-act="jump-file" data-f="${x}">${x}</a>`).join(" ")}</div>`).join("")}</div></section>
        <section><h2 class="sect">Checks</h2><div class="checks">${F.checkRuns.map((c) => `<div class="check">${I.check}<span><b>${esc(c.name)}</b>. ${esc(c.detail)}.</span></div>`).join("")}
          <div class="check">${I.check}<span><b>Up to date with main.</b> No conflicts.</span></div></div>
          <p class="muted small read-more">Read more: ${gh(`blob/${p.branch}/.factory/specs/wi-01jd3e28.md`, "the full spec")} ${gh(`blob/${p.branch}/.factory/reports/wi-01jd3e28-technical.md`, "technical breakdown")} ${gh(`blob/${p.branch}/.factory/reports/wi-01jd3e28-conceptual.md`, "conceptual breakdown")}</p></section>
      </div>
      <h2 class="sect" id="diff">Files changed <span class="muted">+${p.additions} −${p.deletions} in ${p.files.length} files, ${S.viewed.size} viewed</span></h2>
      <p class="muted small">Select a line number to leave a comment on that line.</p>
      <div class="files">${p.files.map(fileBlock).join("")}</div>
      <h2 class="sect">Conversation on the pull request</h2>
      <div class="thread compact">${S.prComments.map((c) => turn(c)).join("")}</div>
      <form class="compose" data-act-submit="pr-comment"><textarea rows="1" aria-label="Comment on the pull request" placeholder="Comment on PR #${p.number}"></textarea><button class="btn" type="submit">Comment</button></form>
      ${merged ? "" : `<div class="mergebar"><div class="in">
        <span class="what">Merging closes #${it.issue} and deletes the branch.</span>
        <button class="btn quiet" type="button" data-act="close-pr" data-pr="${p.number}">Close without merging</button>
        <button class="btn" type="button" data-act="request-changes" data-pr="${p.number}">Request changes</button>
        <span class="split"><button class="btn go" type="button" data-act="merge" data-pr="${p.number}">${S.mergeMethod === "squash" ? "Squash and merge" : S.mergeMethod === "rebase" ? "Rebase and merge" : "Merge"}</button><select aria-label="Merge method" data-act-change="merge-method"><option value="squash" ${S.mergeMethod === "squash" ? "selected" : ""}>Squash</option><option value="merge" ${S.mergeMethod === "merge" ? "selected" : ""}>Merge commit</option><option value="rebase" ${S.mergeMethod === "rebase" ? "selected" : ""}>Rebase</option></select></span>
      </div></div>`}`;
  }

  const runActions = (r, small) => {
    const c = small ? "btn small" : "btn";
    if (r.outcome === "running") return `<button class="${c}" type="button" data-act="cancel-run" data-r="${runShort(r)}">Cancel the run</button>`;
    if (["failed", "escalated"].includes(r.outcome)) return `<button class="${c}" type="button" data-act="rerun" data-r="${runShort(r)}">Re-run the failed jobs</button>`;
    return "";
  };
  function stepsAndGates(r) {
    const steps = r.steps.length ? `<ol class="steps-tl">${r.steps.map((s) => `<li class="${s.exit}">
        <span class="rung" aria-hidden="true"></span><b>${STEP[s.role] || s.role}${s.attempt > 1 ? `, try ${s.attempt}` : ""}</b>
        <span>${s.model.replace("claude-", "")}</span><span>${s.duration_sec ? dur(s.duration_sec) : "now"}</span><span>${s.tokens.toLocaleString()} tokens</span><span>${usd(s.cost_usd)}</span>
        <span class="exit">${s.exit === "ok" ? "done" : s.exit === "running" ? "running" : s.exit}</span></li>`).join("")}</ol>`
      : `<p class="muted small">Step detail is kept for 30 days and this run is older. ${gh(`actions/runs/${r.workflow_run}`, "The Actions log")} still has it.</p>`;
    const gates = r.gates.length ? `<div class="gates">${r.gates.map((g) => `<div class="gate ${g.result}">${g.result === "pass" ? I.check : I.cross}<span><b>${g.gate === "static" ? "Static gate" : "Verification gate"}</b>, try ${g.attempt}, commit <code>${g.commit}</code>${g.coverage ? `, coverage ${g.coverage}%` : ""}${g.failures.length ? `<ul>${g.failures.map((x) => `<li><code>${esc(x)}</code></li>`).join("")}</ul>` : ""}</span></div>`).join("")}</div>` : "";
    return steps + gates;
  }
  function runCard(r, open) {
    return `<details class="run-card" ${open ? "open" : ""}><summary><span class="t">${r.outcome === "running" ? `${I.spin} ` : ""}${OUTCOME[r.outcome]}${r.pr ? `, PR #${r.pr}` : ""}</span><span class="m">${clock(r.started_at)}, ${r.duration_sec ? dur(r.duration_sec) : since(r.started_at) + " so far"}, ${usd(r.cost)}</span></summary>
      ${stepsAndGates(r)}
      <div class="acts">${runActions(r)}<a class="btn quiet" href="#run-${runShort(r)}" data-go="run-${runShort(r)}">Open the run and its transcript</a></div></details>`;
  }

  function runsPane(it) {
    const rs = S.runs.filter((r) => it.runs.includes(r.id));
    if (!rs.length) return `<p class="muted">No runs yet. ${it.status === "waiting_trust" ? "It starts once you let it." : it.status === "queued" ? "It starts when a slot frees up; two runs can go at once." : ""}</p>`;
    return rs.map((r, i) => runCard(r, i === 0)).join("");
  }

  function activityPane(it) {
    const acts = S.activity[it.issue] || [{ who: it.source.actor, at: it.created_at, text: it.source.kind === "issue" ? "Opened this request." : `Filed from ${SOURCE[it.source.kind]}.` }, ...(it.routing ? [{ who: "factory", at: it.routing.at, text: `Routed to ${PIPE[it.pipeline].toLowerCase()}. ${it.routing.reason}` }] : [])];
    return `<div class="thread compact">${acts.map((a) => turn({ ...a, by: a.who === "maraokafor" ? "You" : a.who })).join("")}</div>
      ${it.issue ? `<form class="compose" data-act-submit="issue-comment" data-n="${it.issue}"><textarea rows="1" aria-label="Comment on the issue" placeholder="Comment on #${it.issue}"></textarea><button class="btn" type="submit">Comment</button></form>` : ""}`;
  }

  function callout(it) {
    if (it.status === "escalated") return `<div class="callout stop"><h2>Stuck after three tries</h2><p class="voice small">${esc(F.issueActivity207[3].text)}</p>
      <div class="acts"><button class="btn go" type="button" data-act="comment" data-n="${it.issue}" data-title="Reply on #${it.issue}" data-placeholder="Answer its question, or tell it what to try">Reply with a decision</button><button class="btn" type="button" data-act="rerun" data-r="01jdec22">Re-run the failed jobs</button><button class="btn quiet" type="button" data-act="close-issue" data-n="${it.issue}">Close the request</button></div></div>`;
    if (it.status === "waiting_trust") return `<div class="callout"><h2>Filed by someone without write access</h2><p>${esc(it.source.actor)} isn't one of the people who can start work, so nothing is spent until you say so. Letting it start adds the <code>factory:accept</code> label.</p>
      <div class="acts"><button class="btn go" type="button" data-act="trust" data-n="${it.issue}">Let the factory start it</button><button class="btn quiet" type="button" data-act="close-issue" data-n="${it.issue}">Close it</button></div></div>`;
    if (it.status === "queued") return `<div class="callout"><h2>Queued</h2><p>${it.priority === "high" ? "High priority, so it goes next." : "It starts when a slot frees up; two runs can go at once."} ${it.fixes ? esc(it.fixes) : ""}</p>
      <div class="acts"><button class="btn" type="button" data-act="priority" data-k="${key(it)}">${it.priority === "high" ? "Make it normal priority" : "Make it high priority"}</button><button class="btn quiet" type="button" data-act="drop" data-k="${key(it)}">Drop it</button></div></div>`;
    if (it.status === "duplicate") return `<div class="callout"><h2>Closed as a duplicate of <a href="#r-${it.parent}" data-go="r-${it.parent}">#${it.parent}</a></h2><p>${esc(it.triage_reason)}</p><div class="acts"><button class="btn" type="button" data-act="reopen-issue" data-n="${it.issue}">Reopen it as its own request</button></div></div>`;
    if (it.status === "rejected") return `<div class="callout"><h2>Turned down at triage</h2><p class="voice small">${esc(it.triage_reason)}</p><div class="acts"><button class="btn" type="button" data-act="reopen-issue" data-n="${it.issue}">Reopen and let it run</button></div></div>`;
    if (it.status === "closed") return `<div class="callout"><h2>Closed</h2><p>Reopening it puts it back in the queue.</p>${it.issue ? `<div class="acts"><button class="btn" type="button" data-act="reopen-issue" data-n="${it.issue}">Reopen</button></div>` : ""}</div>`;
    return "";
  }

  function details(it) {
    const canMove = ["queued", "needs_info", "waiting_trust"].includes(it.status);
    return `<aside class="details" aria-label="Details">
      <dl>
        <dt>State</dt><dd>${badge(it.status)}</dd>
        <dt>Kind of work</dt><dd>${canMove ? `<select class="field" data-act-change="reroute" data-k="${key(it)}" aria-label="Move to another kind of work">${Object.entries(PIPE).map(([k, v]) => `<option value="${k}" ${it.pipeline === k ? "selected" : ""}>${v}</option>`).join("")}</select>` : PIPE[it.pipeline]}
          ${it.routing ? `<small>${it.routing.by === "chief_of_staff" ? "Chosen by the chief of staff" : "Chosen by you"}: ${esc(it.routing.reason)}</small>` : ""}${!canMove && OPEN.includes(it.status) ? `<small>Can't be moved once work has started.</small>` : ""}</dd>
        <dt>Priority</dt><dd>${it.priority === "high" ? "High" : "Normal"} <button class="link" type="button" data-act="priority" data-k="${key(it)}">Change</button></dd>
        <dt>Labels</dt><dd class="labels">${it.labels.map((l) => `<span class="chip">${esc(l)}${it.issue ? `<button type="button" data-act="remove-label" data-k="${key(it)}" data-l="${esc(l)}" aria-label="Remove ${esc(l)}">×</button>` : ""}</span>`).join("")}${it.issue ? `<button class="chip add" type="button" data-pop="labels" data-k="${key(it)}">Add label</button>` : `<small>Labels need an issue.</small>`}</dd>
        <dt>Asked by</dt><dd>${esc(it.source.actor === "maraokafor" ? "You" : it.source.actor)}, from ${SOURCE[it.source.kind]}${it.source.via === "dashboard" ? " (sent from here)" : ""}</dd>
        <dt>Opened</dt><dd>${new Date(it.created_at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</dd>
        ${it.merged_at ? `<dt>Merged</dt><dd>${clock(it.merged_at)}</dd>` : ""}${it.closed_at ? `<dt>Closed</dt><dd>${clock(it.closed_at)}</dd>` : ""}
        <dt>Spent</dt><dd>${usd(it.cost)} over ${it.runs.length} ${it.runs.length === 1 ? "run" : "runs"}</dd>
        ${it.goal ? `<dt>What it's for</dt><dd>${esc(it.goal)}</dd>` : ""}
        ${it.success_check ? `<dt>How you'll know</dt><dd>${esc(it.success_check)}</dd>` : ""}
        ${it.pr ? `<dt>Pull request</dt><dd><a href="#r-${key(it)}-pr" data-go="r-${key(it)}-pr">#${it.pr}</a></dd>` : ""}
        ${it.previous_prs ? `<dt>Earlier attempts</dt><dd>${it.previous_prs.map((n) => gh(`pull/${n}`, `PR #${n}, closed`)).join(" ")}</dd>` : ""}
        ${it.related ? `<dt>Related</dt><dd>${it.related.map((n) => `<a href="#r-${n}" data-go="r-${n}">#${n}</a>`).join(", ")}</dd>` : ""}
        ${it.parent ? `<dt>Duplicate of</dt><dd><a href="#r-${it.parent}" data-go="r-${it.parent}">#${it.parent}</a></dd>` : ""}
      </dl>
      <div class="side-acts">
        ${it.issue ? (["merged", "duplicate", "rejected", "closed"].includes(it.status) ? `<button class="btn" type="button" data-act="reopen-issue" data-n="${it.issue}">Reopen the issue</button>` : `<button class="btn" type="button" data-act="close-issue" data-n="${it.issue}">Close the issue</button>`) : ""}
        ${it.issue ? gh(`issues/${it.issue}`) : ""}
      </div>
      <p class="ids">${it.id}</p>
    </aside>`;
  }

  function request(route) {
    const m = route.match(/^r-([a-z0-9]+)(?:-(talk|pr|runs|activity|first|live|cold|understood))?$/);
    const it = m && itemBy(m[1]);
    if (!it) return notFound();
    let tab = m[2];
    if (["first", "live", "cold", "understood"].includes(tab)) { S.talk = tab; tab = "talk"; }
    const tabs = [];
    if (it.issue === 214 || it.issue === 203 || (!it.issue && it.status === "needs_info")) tabs.push(["talk", "Conversation"]);
    if (it.pr) tabs.push(["pr", "Pull request"]);
    tabs.push(["runs", `Runs <span>${it.runs.length}</span>`]);
    tabs.push(["activity", "Activity"]);
    if (!tab) tab = it.status === "needs_info" ? "talk" : it.pr ? "pr" : ["running", "escalated"].includes(it.status) ? "runs" : "activity";
    const pane = tab === "talk" ? talkPane(it) : tab === "pr" ? prPane(it) : tab === "runs" ? runsPane(it) : activityPane(it);
    return `<main class="wrap">
      <a class="back" href="#requests" data-go="requests">All requests</a>
      <header class="req-head"><div class="where">${badge(it.status)}<span>${it.issue ? "#" + it.issue : "no issue yet"}</span><span>${PIPE[it.pipeline]}</span>${it.pr ? `<span>PR #${it.pr}</span>` : ""}</div>
        <h1>${esc(it.title)}</h1>${it.issue === 214 ? `<p class="asked">${esc(B.request)}</p>` : ""}</header>
      <div class="tabs" role="tablist" aria-label="Request">${tabs.map(([id, label]) => `<a role="tab" href="#r-${key(it)}-${id}" data-go="r-${key(it)}-${id}" aria-selected="${tab === id}">${label}</a>`).join("")}</div>
      <div class="req-cols"><details class="m-details"><summary>Details: ${STATUS[it.status]}, ${PIPE[it.pipeline].toLowerCase()}, ${usd(it.cost)} spent</summary>${details(it)}</details><div class="req-main" data-tab="${tab}">${callout(it)}${pane}</div>${details(it)}</div>
    </main>`;
  }

  /* ------------------------------------------------------------------ runs */
  const RF = [["all", "All"], ["running", "Running"], ["draft_pr", "Opened a PR"], ["merged", "Merged"], ["escalated", "Handed to you"], ["failed", "Failed"], ["cancelled", "Cancelled"], ["other", "Other"]];
  function runs() {
    const fit = (r) => S.runFilter === "all" || (S.runFilter === "other" ? ["duplicate", "rejected", "no_action"].includes(r.outcome) : r.outcome === S.runFilter);
    const list = S.runs.filter(fit);
    return `<main class="wrap">
      <header class="page-head"><h1>Runs</h1><p class="rest">Every time the factory worked on something: what it did, how long it took and what it cost.</p></header>
      <div class="toolbar"><div class="seg" role="tablist" aria-label="Filter by outcome">${RF.map(([id, label]) => `<button type="button" role="tab" aria-selected="${S.runFilter === id}" data-act="run-filter" data-v="${id}">${label}</button>`).join("")}</div></div>
      ${S.runFilter === "other" ? `<p class="muted small">Duplicates, requests turned down at triage, and gardening runs that found nothing worth changing.</p>` : ""}
      <div class="table runs-t" role="table" aria-label="Runs">
        <div class="tr th" role="row"><span role="columnheader">Run</span><span role="columnheader">Outcome</span><span role="columnheader">Kind</span><span role="columnheader">Started</span><span role="columnheader">Took</span><span role="columnheader" class="r">Cost</span><span role="columnheader"><span class="vh">Actions</span></span></div>
        ${list.map((r) => `<div class="tr" role="row">
          <span role="cell" class="t"><a href="#run-${runShort(r)}" data-go="run-${runShort(r)}"><b>${esc(r.title)}</b></a><small>${r.issue ? "#" + r.issue : "no issue"}${r.pr ? `, PR #${r.pr}` : ""}</small></span>
          <span role="cell">${r.outcome === "running" ? `<span class="badge busy">${I.spin}Running</span>` : `<span class="badge ${r.outcome === "merged" ? "done" : ["failed", "escalated"].includes(r.outcome) ? "stop" : ""}">${OUTCOME[r.outcome]}</span>`}</span>
          <span role="cell">${PIPE[r.pipeline]}</span><span role="cell">${ago(r.started_at)}</span><span role="cell">${r.duration_sec ? dur(r.duration_sec) : since(r.started_at) + " so far"}</span><span role="cell" class="r">${usd(r.cost)}</span>
          <span role="cell" class="r">${runActions(r, true)}</span></div>`).join("")}
      </div>
    </main>`;
  }

  const transcript = (r) => r.issue === 207 ? `verifier, try 3, claude-sonnet-4-5
> Drive: sign in as demo@ledgerline.test in webkit, chromium, firefox
> Advance the clock 40 minutes with the tab hidden, then show it
chromium  session kept   GET /api/me 200
firefox   session kept   GET /api/me 200
webkit    signed out     GET /api/me 401  (cookie __session missing)
> Checked: cookie set with SameSite=Lax, Secure, Max-Age=2592000
> The sandbox WebKit drops the cookie on resume; can't tell whether real Safari would.
exit: error, escalating with the question above` : `${r.steps.length ? r.steps.filter((s) => s.exit !== "running").slice(-1)[0].role + ", " + r.steps.filter((s) => s.exit !== "running").slice(-1)[0].model : "step"}
> Read the spec and the files it names
> Wrote the change and its test
> npm test   all passed
> Static gate: types, lint   pass
exit: ok`;

  function run(route) {
    const r = runBy(route.slice(4));
    if (!r) return notFound();
    const it = S.items.find((i) => i.runs.includes(r.id));
    const live = r.outcome === "running";
    const last = r.steps[r.steps.length - 1];
    return `<main class="wrap">
      <a class="back" href="#runs" data-go="runs">All runs</a>
      <header class="req-head"><div class="where">${live ? `<span class="badge busy">${I.spin}Running</span>` : `<span class="badge">${OUTCOME[r.outcome]}</span>`}<span>${PIPE[r.pipeline]}</span><span>${r.id}</span></div>
        <h1>${esc(r.title)}</h1></header>
      <div class="req-cols"><div class="req-main">
        ${live ? `<section class="live-run"><p class="live-line">${STEP[last.role]}${last.attempt > 1 ? ", second try of three" : ""}. ${tries(last.attempt, 3)}</p>
          <div class="live-figs"><div><span class="fig" data-tick-time>${since(r.started_at)}</span><span>so far</span></div><div><span class="fig" data-tick-cost data-base="${r.cost}">${usd(r.cost)}</span><span>spent so far</span></div><div><span class="fig">10 to 40 min</span><span>usual for a change this size</span></div></div></section>` : ""}
        ${r.note ? `<p class="callout">${esc(r.note)}</p>` : ""}
        <h2 class="sect">Steps and gates</h2>${stepsAndGates(r)}
        ${r.steps.some((s) => s.exit !== "running") ? `<h2 class="sect">Transcript of the last finished step</h2><pre class="log">${esc(transcript(r))}</pre>` : ""}
        <div class="acts">${runActions(r)}</div>
      </div>
      <aside class="details"><dl>
        <dt>For</dt><dd>${it ? `<a href="#r-${key(it)}" data-go="r-${key(it)}">${esc(it.title)}</a>` : esc(r.title)}</dd>
        <dt>Started</dt><dd>${clock(r.started_at)}</dd>${r.ended_at ? `<dt>Ended</dt><dd>${clock(r.ended_at)}</dd>` : ""}
        <dt>Cost</dt><dd>${usd(r.cost)}${r.steps.length ? `<small>${r.steps.map((s) => `${SHORT[s.role] || s.role} ${usd(s.cost_usd)}`).join(", ")}</small>` : ""}</dd>
        ${r.human_interactions ? `<dt>From people</dt><dd>${r.human_interactions.total ? `${r.human_interactions.comments} comment, ${r.human_interactions.change_requests} change request` : "Nothing; it went through on its own"}</dd>` : ""}
        ${r.artifacts ? `<dt>Proof kept</dt><dd>${r.artifacts.stored} files, until ${new Date(r.artifacts.expiring).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</dd>` : ""}
        <dt>Workflow run</dt><dd>${r.workflow_run}</dd>
      </dl><div class="side-acts">${gh(`actions/runs/${r.workflow_run}`, "The Actions log")}</div></aside></div>
    </main>`;
  }

  /* ------------------------------------------------------------------ guardrails */
  function guardrails() {
    const pending = S.candidates.filter((c) => c.status === "pending");
    const past = S.candidates.filter((c) => c.status !== "pending");
    const rv = F.review, cov = F.coverage;
    return `<main class="wrap">
      <header class="page-head"><h1>Guardrails</h1><p class="rest">The checks that stop the same mistake twice. Most come from corrections you made; each runs on every change before you see it.</p></header>
      <div class="cols"><div class="main-col">
        <section><h2 class="sect">Rules it could add ${pending.length ? `<span class="count">${pending.length}</span>` : ""}</h2>
          ${pending.length ? pending.map((c) => `<article class="cand"><h3>${esc(c.problem_class)}</h3><p>Seen ${c.occurrences} times between ${c.first_seen} and ${c.last_seen}, in ${c.sources.map(esc).join(", ")}.${c.critical_logic ? " It touches money, so a slip here costs real cents." : ""}</p>
            <p class="muted small">Would become a ${c.proposed_fix === "static_rule" ? "lint rule" : c.proposed_fix.replace("_", " ")} in this repo. Adding it starts a hardening run that writes the rule with an example it must catch.</p>
            <div class="acts"><button class="btn go" type="button" data-act="candidate" data-id="${c.id}" data-d="accept">Add the rule</button><button class="btn" type="button" data-act="candidate" data-id="${c.id}" data-d="reject">Not a rule</button></div></article>`).join("") : `<p class="muted">Nothing waiting. New candidates appear when you correct the same kind of thing more than once.</p>`}
          ${past.length ? `<details class="past"><summary>${past.length} decided</summary><ul class="plain-list">${past.map((c) => `<li><b>${esc(c.problem_class)}</b>: ${c.status === "installed" ? `installed as <code>${c.installed_as}</code>` : c.status === "accepted" ? "accepted, being written" : "you said not a rule"}</li>`).join("")}</ul></details>` : ""}
        </section>
        <section><h2 class="sect">Installed rules <span class="muted">${F.rules.length} shown of ${F.guardrails.rules}</span></h2>
          <div class="table rules-t" role="table" aria-label="Rules"><div class="tr th" role="row"><span role="columnheader">Rule</span><span role="columnheader">Why it exists</span><span role="columnheader">Checked by</span><span role="columnheader" class="r">Old cases allowed</span></div>
          ${F.rules.map((r) => `<div class="tr" role="row"><span role="cell" class="t"><code>${r.id}</code><small>${esc(r.from)}</small></span><span role="cell">${esc(r.concern)}</span><span role="cell">${r.tool}</span><span role="cell" class="r">${r.baselined}</span></div>`).join("")}</div>
          <p class="muted small">"Old cases allowed" are violations that existed when the rule went in. That number may only go down.</p></section>
        <section><h2 class="sect">The factory's last self-review</h2>
          <p>${rv.window.runs} runs from ${rv.window.from} to ${rv.window.to}. Next review in 4 days, or sooner after 10 more runs. <button class="link" type="button" data-act="dispatch" data-w="factory-review.yml">Run one now</button></p>
          <div class="scores">${rv.scores.map((s) => `<div class="score"><span>${esc(s.criterion)}</span><span class="bar"><i style="width:${(s.score / 5) * 100}%"></i></span><b>${s.score.toFixed(1)}</b></div>`).join("")}</div>
          <h3 class="sub">What it found, and what it did about it</h3>
          <ul class="plain-list">${rv.problems.map((p) => `<li><b>${esc(p.title)}</b> (${p.runs} runs). Sent to hardening: ${esc(p.work_item)}${p.pr ? `, merged in PR #${p.pr}` : ", queued"}.</li>`).join("")}
          ${rv.unrouted.map((u) => `<li><b>Left for you:</b> ${esc(u.reason)} ${esc(u.detail)} <button class="link" type="button" data-act="new-request" data-kind="harden" data-title="Decide how to verify Safari-only bugs">Make it a request</button></li>`).join("")}</ul>
        </section>
      </div>
      <aside class="rail"><section><h2 class="part">Coverage</h2>
        <div class="cov"><div class="rail-bar"><i style="width:${cov.high_pct}%"></i><b style="left:${cov.floor_pct}%"></b></div>
        <p><b>${cov.high_pct}%</b> of lines are tested. A change may not take it below the floor of ${cov.floor_pct}%, and its own new lines need ${cov.diff_min_pct}%.</p>
        <p class="muted small">${cov.skips.count} of ${cov.skips.cap} allowed test skips used.</p></div></section>
        <section><h2 class="part">Corrections it learned from</h2><p class="muted">Every review comment and commit you make on a factory PR is read as a correction. ${F.metrics.human_interactions_per_pr} per PR this month.</p></section></aside></div>
    </main>`;
  }

  /* ------------------------------------------------------------------ spend */
  function spend() {
    const m = F.metrics, days = F.daily, budget = S.settings.monthly_budget;
    const W = 720, H = 180, max = 4, bw = W / days.length;
    let cum = 0; const line = days.map((d, i) => { cum += d[0]; return `${(i + .5) * bw},${H - (cum / budget) * H}`; }).join(" ");
    const bars = days.map((d, i) => `<rect x="${i * bw + 3}" y="${H - (d[0] / max) * (H * .55)}" width="${bw - 6}" height="${(d[0] / max) * (H * .55)}" rx="2" fill="currentColor" fill-opacity=".22"><title>${i + 1} Nov: ${usd(d[0])}, ${d[1]} merged</title></rect>`).join("");
    const spent = m.spend_usd / budget;
    const top = [...S.runs].sort((a, b) => b.cost - a.cost).slice(0, 5);
    return `<main class="wrap">
      <section class="money-hero">
        <div><div class="big">${usd(m.spend_usd)}<small>of your ${usd(budget)} monthly budget</small></div>
          <p>Spent on models since 1 November. At this pace the month ends near <b>$33.10</b>. The budget is a hard stop: runs end before they would pass it.</p>
          <div class="budget"><div class="rail-bar" role="img" aria-label="${pct(spent)} of the budget used"><i style="width:${spent * 100}%"></i><b style="left:${(25 / 30) * 100}%"></b></div>
          <div class="legend"><span>1 Nov</span><span>today, day 25</span><span>30 Nov</span></div></div>
          <p class="muted small"><a href="#factory-settings" data-go="factory-settings">Change the budget</a></p></div>
        <div><div class="big">${pct(m.automation_rate)}<small>merged with no edits from you</small></div><p>That's ${Math.round(m.merged * m.automation_rate)} of the ${m.merged} changes merged in the last 30 days. The other ${m.merged - Math.round(m.merged * m.automation_rate)} needed a comment or a commit from you first.</p></div>
      </section>
      <div class="cols"><div class="main-col">
        <div class="chart"><svg viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Daily spend and running total against the budget">
          <line x1="0" x2="${W}" y1="0" y2="0" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="4 4"/><text x="${W}" y="14" text-anchor="end" font-size="12" fill="currentColor" fill-opacity=".6">${usd(budget)} budget</text>
          ${bars}<polyline points="${line}" fill="none" stroke="var(--you)" stroke-width="2.5" stroke-linejoin="round"/>
          <text x="0" y="${H + 20}" font-size="12" fill="currentColor" fill-opacity=".6">1 Nov</text><text x="${W}" y="${H + 20}" font-size="12" text-anchor="end" fill="currentColor" fill-opacity=".6">25 Nov</text></svg>
          <p class="muted small">Bars are each day's spend; hover one for the figure. The line is the running total against the budget at the top.</p></div>
        <h2 class="sect">Most expensive runs</h2>
        <div class="table cost-t" role="table" aria-label="Most expensive runs">${top.map((r) => `<a class="tr" role="row" href="#run-${runShort(r)}" data-go="run-${runShort(r)}"><span role="cell" class="t"><b>${esc(r.title)}</b><small>${OUTCOME[r.outcome]}</small></span><span role="cell">${PIPE[r.pipeline]}</span><span role="cell">${r.duration_sec ? dur(r.duration_sec) : "running"}</span><span role="cell" class="r">${usd(r.cost)}</span></a>`).join("")}</div>
      </div>
      <aside class="rail">
        <section><h2 class="part">By kind of work</h2>${Object.entries(m.by_pipeline).map(([k, v]) => `<div class="lane-r"><span>${PIPE[k]}</span><b>${usd(v.spend_usd)}</b><span class="bar"><i style="width:${(v.spend_usd / m.spend_usd) * 100}%"></i></span><small>${v.merged} of ${v.runs} merged, ${v.actions_minutes} Actions minutes</small></div>`).join("")}</section>
        <section><h2 class="part">Other numbers</h2><dl class="kv">
          <dt>Typical request to PR</dt><dd>${dur(m.cycle_time_p50_sec)}</dd><dt>Slowest one in ten</dt><dd>over ${dur(m.cycle_time_p90_sec)}</dd>
          <dt>Runs</dt><dd>${m.runs}, ${m.merged} merged, ${m.escalated} handed to you</dd><dt>Reverted later</dt><dd>${pct(m.revert_rate, 1)}, one change</dd>
          <dt>Actions minutes</dt><dd>${m.actions_minutes.toLocaleString()} of ${m.actions_minutes_limit.toLocaleString()} free</dd></dl></section>
      </aside></div>
    </main>`;
  }

  /* ------------------------------------------------------------------ factory */
  const NEEDS_INPUT = ["factory-run.yml", "factory-drop.yml", "factory-intake.yml"];
  const FSEC = [["settings", "Settings"], ["goals", "Standing goals"], ["workflows", "Workflows"], ["sandbox", "Sandbox"], ["people", "People"], ["health", "Health"], ["install", "Installation"]];
  function hourLocal(utc) { return new Date(Date.UTC(2026, 10, 25, utc)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "America/New_York" }).toLowerCase(); }
  function factory() {
    const s = S.settings;
    const total = s.share_product_work + s.share_gardening + s.share_review;
    const sw = (id, label, help) => `<div class="setting"><div><label for="s-${id}"><b>${label}</b></label><p class="muted small">${help}</p></div><label class="switch"><input id="s-${id}" type="checkbox" role="switch" data-set="${id}" ${s[id] ? "checked" : ""}><span></span></label></div>`;
    const sb = F.sandbox;
    return `<main class="wrap">
      <header class="page-head"><h1>Factory</h1><p class="rest">How the factory runs on ledgerline: what it may spend, what it merges by itself, what it's focused on, and what it runs on.</p></header>
      <div class="fac"><nav class="subnav" aria-label="Factory sections">${FSEC.map(([id, label]) => `<a href="#factory-${id}" data-go="factory-${id}">${label}</a>`).join("")}</nav>
      <div class="fac-main">
        <section id="f-settings"><h2 class="sect">Settings</h2>
          <form class="settings" data-act-submit="save-settings">
            <div class="setting"><div><label for="s-budget"><b>Monthly budget</b></label><p class="muted small">A hard cap on model spend. Runs stop before they would pass it.</p></div><span class="unit-in"><span>$</span><input id="s-budget" class="field" type="number" min="1" max="100000" step="1" value="${s.monthly_budget}" data-set="monthly_budget"></span></div>
            <div class="setting"><div><b>How the budget is shared</b><p class="muted small">What each kind of work may use. ${total === 100 ? "Adds up to 100%." : `<span class="warn">Adds up to ${total}%; it has to be 100%.</span>`}</p></div>
              <div class="shares">${[["share_product_work", "Product work"], ["share_gardening", "Gardening"], ["share_review", "Hardening and review"]].map(([id, l]) => `<label>${l}<span class="unit-in"><input class="field" type="number" min="0" max="100" value="${s[id]}" data-set="${id}"><span>%</span></span></label>`).join("")}</div></div>
            ${sw("auto_merge_product_work", "Merge product work by itself", "Off: every feature and bug fix waits for you to merge it, with its proof.")}
            ${sw("auto_merge_gardening", "Merge gardening by itself", "Tidy-ups merge once both gates pass, unless you request changes first.")}
            ${sw("auto_merge_hardening", "Merge hardening by itself", "New guardrails merge the same way.")}
            <div class="setting"><div><label for="s-gprs"><b>Cleanup PRs per night</b></label><p class="muted small">Gardening opens at most this many.</p></div><input id="s-gprs" class="field narrow" type="number" min="1" max="10" value="${s.gardening_prs}" data-set="gardening_prs"></div>
            <div class="setting"><div><label for="s-ghour"><b>Cleanup time</b></label><p class="muted small">In your time zone. Stored as ${s.gardening_hour}:00 UTC.</p></div><select id="s-ghour" class="field narrow" data-set="gardening_hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.gardening_hour ? "selected" : ""}>${hourLocal(h)}</option>`).join("")}</select></div>
            <div class="acts"><button class="btn go" type="submit" ${total === 100 ? "" : "disabled"}>Save settings</button><span class="muted small" data-save-stage>Saving opens a pull request that changes the factory's settings and merges it once the policy check passes, usually within a minute.</span></div>
          </form></section>
        <section id="f-goals"><h2 class="sect">Standing goals</h2><p class="muted">A focus the factory holds for a while. It weighs requests and gardening toward it.</p>
          <ul class="goals">${S.goals.map((g) => `<li><span><b>${esc(g.text)}</b><small>${g.lane ? PIPE[g.lane] : "Any kind of work"}${g.until ? `, until ${g.until}` : ""}</small></span><button class="btn small" type="button" data-act="goal-remove" data-id="${g.id}">Remove</button></li>`).join("") || `<li class="muted">No goals. The factory works on requests in the order they come.</li>`}</ul>
          <form class="goal-form" data-act-submit="goal-add"><input class="field" name="text" required placeholder="For example: harden sign-in this month" aria-label="New goal"><select class="field narrow" name="lane" aria-label="For which kind of work"><option value="">Any kind of work</option>${Object.entries(PIPE).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select><button class="btn" type="submit">Add goal</button></form></section>
        <section id="f-workflows"><h2 class="sect">Workflows</h2><p class="muted">The GitHub Actions workflows the factory installed. Start any that can be run by hand, or re-run one whose last run failed.</p>
          <div class="table wf-t" role="table" aria-label="Workflows">${S.workflows.map((w) => `<div class="tr" role="row"><span role="cell" class="t"><b>${esc(w.name)}</b><small><code>${w.file}</code></small></span><span role="cell" class="wf-state">${w.last === "success" ? `${I.check} Passed` : w.last === "failure" ? `${I.cross} Failed` : `${I.spin} Running`}<small>${ago(w.at)}</small></span>
            <span role="cell" class="r">${w.last === "failure" ? `<button class="btn small" type="button" data-act="rerun-wf" data-w="${w.file}">Re-run failed jobs</button>` : ""}${w.dispatch && !NEEDS_INPUT.includes(w.file) ? `<button class="btn small" type="button" data-act="dispatch" data-w="${w.file}">Run now</button>` : w.dispatch ? `<small>Started from a request</small>` : ""}</span></div>`).join("")}</div></section>
        <section id="f-sandbox"><h2 class="sect">Sandbox</h2><p>${esc(sb.tier_reason)} Network out of the sandbox is <b>${sb.egress}</b>; outside services are replaced with recorded stand-ins.</p>
          <div class="two"><div><h3 class="sub">What it checks for real</h3><ul class="plain-list ok-list">${sb.capabilities.exercised.map((c) => `<li>${I.check}${esc(c)}</li>`).join("")}</ul></div>
          <div><h3 class="sub">What it can't check</h3><ul class="plain-list">${sb.capabilities.not_exercised.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div></div>
          <dl class="kv wide"><dt>App</dt><dd><code>${sb.app_url}</code>, started with <code>${sb.commands.run}</code> after <code>${sb.commands.seed}</code></dd>
          <dt>Services</dt><dd>${sb.services.map((x) => `${x.name} (${x.image}) for ${x.why}`).join("; ")}</dd>
          <dt>Stand-ins</dt><dd>${sb.stubs.map((x) => `${x.name} for ${x.replaces}, recorded ${x.captured_at}`).join("; ")}</dd></dl></section>
        <section id="f-people"><h2 class="sect">People</h2><p class="muted">Anyone with write access can start work. Requests from anyone else wait for one of you to let them start.</p>
          <ul class="goals">${F.writers.map((w) => `<li><span><b>${w.login}${w.login === "maraokafor" ? " (you)" : ""}</b><small>${w.role === "admin" ? "Admin" : "Write"} access</small></span>${gh("settings/access", "Manage on GitHub")}</li>`).join("")}</ul></section>
        <section id="f-health"><h2 class="sect">Health</h2><ul class="plain-list ok-list">
          <li>${I.check}Nightly gardening is scheduled.</li><li>${I.check}Last self-review ${ago(F.health.last_review)}.</li><li>${I.check}Workflow lock files match their sources.</li>
          <li>${I.check}Sandbox runs in Docker with the network closed.</li><li>${I.check}Branch protection requires the factory's checks on main.</li></ul></section>
        <section id="f-install"><h2 class="sect">Installation</h2><dl class="kv wide">
          <dt>Runner</dt><dd>${F.factoryInfo.runner}, set up ${new Date(F.factoryInfo.setup_completed_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}</dd><dt>Agent</dt><dd>Claude Code</dd>
          <dt>Models</dt><dd>${Object.entries(F.factoryInfo.models).map(([r, m]) => `${r.replace("_", " ")}: ${m.replace("claude-", "")}`).join("; ")}</dd>
          <dt>Data</dt><dd>Kept in this repository under <code>refs/factory/data</code>; proof for 6 months.</dd></dl>
          <p class="muted small">To remove the factory, run <code>/setup-my-software-factory uninstall</code> from your coding agent in this repository.</p></section>
      </div></div>
    </main>`;
  }

  /* ------------------------------------------------------------------ sign-in, other repos */
  function signin(pick) {
    const left = pick ? `<h1>Which repository?</h1><p>The Software Factory app is installed on three of yours.</p>
        <div class="pick">${F.installed.map((r, i) => `<button type="button" data-act="pick-repo" data-repo="${r}">${r}<span>${["factory running", "no factory yet", "factory running"][i]}</span></button>`).join("")}</div>
        <p class="muted small" style="margin-top:1.25rem">Missing one? ${gh("../../apps/software-factory/installations/new", "Install the app on another repository")}</p>`
      : `<h1>Your factory, without opening GitHub.</h1><p>See what needs you, answer the factory's questions, watch the proof and merge, all from here.</p>
        <button class="btn gh-btn" type="button" data-go="signin-pick">${I.gh} Sign in with GitHub</button>
        <details class="token"><summary>Use a token instead</summary><div class="fallback"><span class="small">Make a fine-grained token with the permissions already chosen, then paste it here.</span>
          <a class="btn" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Make the token on GitHub</a><input class="field" aria-label="Token" placeholder="github_pat_"></div></details>
        <p class="muted small" style="margin-top:2rem">Just looking? <a href="#home" data-go="home">Open a demo factory</a>.</p>`;
    return `<div class="signin"><div class="l"><span class="brand">${I.mark}<span>Build Software Factory</span></span><div class="grow">${left}</div></div>
      <div class="r">${film("signin")}<p>Filters to November, selects four invoices across three currencies, exports, and opens the file.</p><small>A recording from a factory pull request, 42 seconds.</small></div></div>`;
  }
  function noFactory() {
    return `<main class="wrap"><section class="lede"><p class="when">maraokafor/ledgerline-site</p><h1>The app is installed here, but there's no factory yet.</h1>
      <p class="rest">Set one up from your coding agent in this repository with <code>/setup-my-software-factory</code>. It takes about ten minutes and asks one question.</p>
      <div class="acts"><button class="btn" type="button" data-act="pick-repo" data-repo="maraokafor/ledgerline">Back to ledgerline</button></div></section></main>`;
  }
  const notFound = () => `<main class="wrap"><section class="lede"><h1>Nothing here.</h1><p class="rest"><a href="#home" data-go="home">Back to the briefing</a></p></section></main>`;

  /* ------------------------------------------------------------------ router */
  let current = "home";
  function page(route) {
    if (route === "signin" || route === "signin-pick") return signin(route === "signin-pick");
    let body;
    if (route === "home") body = home();
    else if (route === "requests") body = requests();
    else if (route.startsWith("r-")) body = request(route);
    else if (route === "runs") body = runs();
    else if (route.startsWith("run-")) body = run(route);
    else if (route === "guardrails") body = guardrails();
    else if (route === "spend") body = spend();
    else if (route.startsWith("factory")) body = factory();
    else if (route === "no-factory") body = noFactory();
    else body = notFound();
    return top(route) + body;
  }
  const root = $("#app");
  function render(route = current, keepScroll = false) {
    const y = window.scrollY;
    current = route;
    root.innerHTML = `<div data-screen="${route}">${page(route)}</div>`;
    wire(root);
    if (keepScroll) window.scrollTo(0, y);
    else if (route.startsWith("factory-")) { const el = document.getElementById("f-" + route.slice(8)); if (el) el.scrollIntoView(); }
    else if (route === "r-214" || /^r-214-(talk|first|live|cold|understood)$/.test(route)) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
    else window.scrollTo(0, 0);
  }
  const go = (route) => window.showScreen(route);

  /* ------------------------------------------------------------------ media and live bits */
  let ticker = 0;
  function wire(scope) {
    scope.querySelectorAll("[data-film]").forEach((el) => {
      const label = el.querySelector(".label"), bar = el.querySelector(".track i");
      const ctl = window.PROOF.video(el.querySelector(".vp"), {
        final: !!el.dataset.final,
        onTime: (s, p) => { label.textContent = `0:${String(Math.floor(s)).padStart(2, "0")}`; bar.style.width = p * 100 + "%"; },
        onEnd: () => el.classList.remove("playing"),
      });
      el.querySelector(".play").addEventListener("click", () => { if (ctl.playing) { ctl.stop(); el.classList.remove("playing"); } else { el.classList.add("playing"); ctl.play(); } });
      if (el.dataset.film === "signin" && !reduce()) setTimeout(() => { el.classList.add("playing"); ctl.play(); }, 300);
    });
    scope.querySelectorAll("[data-csv]").forEach((el) => window.PROOF.csv(el));
    scope.querySelectorAll("[data-mini]").forEach((el) => window.PROOF.mini(el, el.dataset.mini));
    clearInterval(ticker);
    const t = scope.querySelector("[data-tick-time]");
    if (t) {
      const r = runBy(current.slice(4));
      const c = scope.querySelector("[data-tick-cost]"), t0 = Date.now(), base = (Date.parse(F.now) - Date.parse(r.started_at)) / 1000, cost0 = +c.dataset.base;
      ticker = setInterval(() => { const sec = base + (Date.now() - t0) / 1000; t.textContent = `${Math.floor(sec / 60)} min ${String(Math.floor(sec % 60)).padStart(2, "0")} s`; c.textContent = usd(cost0 + (sec - base) * 0.0011); }, 1000);
    }
  }

  /* ------------------------------------------------------------------ overlays */
  const layer = document.createElement("div");
  layer.className = "layer";
  document.body.appendChild(layer);
  const toasts = document.createElement("div");
  toasts.className = "toasts";
  toasts.setAttribute("role", "status");
  document.body.appendChild(toasts);
  let lastFocus = null;
  function openDialog(html, opts = {}) {
    lastFocus = document.activeElement;
    layer.innerHTML = `<div class="scrim" data-close></div><div class="dialog ${opts.cls || ""}" role="dialog" aria-modal="true" aria-label="${esc(opts.label || "Dialog")}">${html}</div>`;
    const first = layer.querySelector("[data-autofocus], input:not([type=radio]), textarea, select, button");
    if (first) first.focus();
  }
  function closeDialog() { if (!layer.innerHTML) return; layer.innerHTML = ""; if (lastFocus && lastFocus.isConnected) lastFocus.focus(); }
  function toast(text, opts = {}) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<span>${text}</span>${opts.link ? `<button class="link" type="button" data-go="${opts.link[0]}">${opts.link[1]}</button>` : ""}`;
    toasts.appendChild(t);
    setTimeout(() => t.remove(), 5200);
  }
  function confirmAct(title, body, yes, fn, danger) {
    openDialog(`<h2>${title}</h2><p>${body}</p><div class="acts end"><button class="btn quiet" type="button" data-close>Cancel</button><button class="btn ${danger ? "danger" : "go"}" type="button" data-yes>${yes}</button></div>`, { label: title, cls: "small" });
    layer.querySelector("[data-yes]").focus();
    layer.querySelector("[data-yes]").addEventListener("click", () => { closeDialog(); fn(); });
  }
  function textDialog(title, placeholder, yes, fn, opts = {}) {
    openDialog(`<form data-dialog-form><h2>${title}</h2>${opts.intro ? `<p class="muted">${opts.intro}</p>` : ""}<textarea class="field" rows="5" required placeholder="${esc(placeholder)}" data-autofocus></textarea>
      <div class="acts end"><button class="btn quiet" type="button" data-close>Cancel</button><button class="btn go" type="submit">${yes}</button></div></form>`, { label: title });
    layer.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); e.stopPropagation(); const v = e.target.querySelector("textarea").value.trim(); closeDialog(); fn(v); });
  }
  function popover(kind, anchor) {
    const r = anchor.getBoundingClientRect();
    let html = "";
    if (kind === "repos") html = `<div role="menu" aria-label="Repositories">${F.installed.map((x) => `<button role="menuitem" type="button" data-act="pick-repo" data-repo="${x}">${x}${x === F.repo ? " <span>open now</span>" : ""}</button>`).join("")}<hr>${gh("../../apps/software-factory/installations/new", "Add a repository")}</div>`;
    if (kind === "me") html = `<div role="menu" aria-label="Account"><p class="muted small">Signed in as <b>maraokafor</b> with GitHub</p>
      <div class="theme-pick" role="radiogroup" aria-label="Appearance">${["system", "light", "dark"].map((t) => `<label><input type="radio" name="theme" value="${t}" ${S.theme === t ? "checked" : ""} data-act-change="theme">${t[0].toUpperCase() + t.slice(1)}</label>`).join("")}</div><hr>
      <button role="menuitem" type="button" data-go="factory">Factory settings</button><button role="menuitem" type="button" data-act="sign-out">Sign out</button></div>`;
    if (kind === "labels") {
      const it = itemBy(anchor.dataset.k);
      html = `<div role="menu" aria-label="Add a label">${F.labels.filter((l) => !it.labels.includes(l)).map((l) => `<button role="menuitem" type="button" data-act="add-label" data-k="${anchor.dataset.k}" data-l="${l}">${l}</button>`).join("")}</div>`;
    }
    lastFocus = anchor;
    layer.innerHTML = `<div class="scrim clear" data-close></div><div class="pop" style="top:${r.bottom + 6}px;left:${Math.max(8, Math.min(r.left, innerWidth - 290))}px">${html}</div>`;
    const first = layer.querySelector(".pop button, .pop input");
    if (first) first.focus();
  }

  /* Search or do anything: every page, every request, every common action, by typing. */
  function commands() {
    const list = [];
    NAV.forEach(([id, label]) => list.push({ label: `Go to ${label}`, go: id }));
    list.push({ label: "New request", act: "new-request" }, { label: "Merge PR #219", act: "merge", pr: 219 }, { label: "Answer the question on #214", go: "r-214" },
      { label: "Run nightly gardening now", act: "dispatch", w: "factory-garden.yml" }, { label: "Run a self-review now", act: "dispatch", w: "factory-review.yml" },
      { label: "Change the monthly budget", go: "factory-settings" }, { label: "Add a standing goal", go: "factory-goals" }, { label: "Switch repository", act: "repos" }, { label: "Sign out", act: "sign-out" });
    S.items.forEach((i) => list.push({ label: `${i.issue ? "#" + i.issue + " " : ""}${i.title}`, hint: STATUS[i.status], go: "r-" + key(i) }));
    return list;
  }
  function palette() {
    openDialog(`<div class="palette"><input class="field" type="search" placeholder="Search requests, pages and actions" aria-label="Search" data-autofocus data-pal-q aria-controls="pal-list">
      <ul role="listbox" id="pal-list" data-pal-list></ul><p class="muted small">Enter to open, arrows to move, Esc to close. Anything that matches nothing becomes a new request.</p></div>`, { cls: "pal", label: "Search or do anything" });
    const q = layer.querySelector("[data-pal-q]"), ul = layer.querySelector("[data-pal-list]");
    let sel = 0, shown = [];
    const draw = () => {
      const v = q.value.toLowerCase();
      shown = commands().filter((c) => !v || c.label.toLowerCase().includes(v)).slice(0, 9);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      ul.innerHTML = shown.map((c, i) => `<li role="option" aria-selected="${i === sel}" data-i="${i}">${esc(c.label)}${c.hint ? `<span>${c.hint}</span>` : ""}</li>`).join("") || `<li class="muted">Nothing matches. Press Enter to file "${esc(q.value)}" as a new request.</li>`;
    };
    const run = (c) => {
      closeDialog();
      if (!c) { S.prefill = q.value; actions["new-request"](document.createElement("button")); return; }
      if (c.go) go(c.go);
      else if (c.act === "repos") popover("repos", $(".repo"));
      else { const b = document.createElement("button"); if (c.pr) b.dataset.pr = c.pr; if (c.w) b.dataset.w = c.w; actions[c.act](b); }
    };
    q.addEventListener("input", () => { sel = 0; draw(); });
    q.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
      if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      if (e.key === "Enter") { e.preventDefault(); run(shown[sel]); }
    });
    ul.addEventListener("click", (e) => { const li = e.target.closest("[data-i]"); if (li) run(shown[+li.dataset.i]); });
    draw();
  }

  /* ------------------------------------------------------------------ actions */
  const issueOf = (el) => byIssue(+el.dataset.n);
  const actions = {
    palette,
    "new-request": (el) => {
      openDialog(`<h2>New request</h2>${requestForm({ kind: el.dataset.kind })}`, { cls: "sheet", label: "New request" });
      const t = layer.querySelector("#nr-title");
      if (el.dataset.title) t.value = el.dataset.title;
      if (S.prefill) { t.value = S.prefill; S.prefill = ""; }
      t.focus();
    },
    merge: (el) => {
      const pr = +el.dataset.pr || 219;
      const it = S.items.find((i) => i.pr === pr);
      confirmAct(`Merge PR #${pr}?`, `${esc(it.title)}. ${S.mergeMethod === "squash" ? "Squashed into one commit" : S.mergeMethod === "rebase" ? "Rebased onto main" : "With a merge commit"}${it.issue ? `; #${it.issue} closes` : ""} and the branch is deleted.`, "Merge", () => {
        it.status = "merged"; it.merged_at = new Date(Date.parse(F.now) + 60000).toISOString();
        S.landed.unshift({ pr, issue: it.issue, title: it.title, merged_at: it.merged_at, cost: it.cost, poster: "reminder", by: "you" });
        toast(`Merged PR #${pr}.`, { link: ["r-" + key(it) + "-pr", "See it"] });
        render(current, true);
      });
    },
    "request-changes": (el) => textDialog(`Request changes on PR #${el.dataset.pr}`, "What should change? The factory reads this and pushes a new commit.", "Request changes", (v) => {
      const it = S.items.find((i) => i.pr === +el.dataset.pr);
      if (it && it.status !== "merged") it.status = "running";
      S.prComments.push({ who: "person", by: "You", at: F.now, text: v });
      toast(`Changes requested on PR #${el.dataset.pr}. The factory has picked them up.`);
      render(current, true);
    }, { intro: "This holds the pull request until the factory has made the change." }),
    "close-pr": (el) => confirmAct(`Close PR #${el.dataset.pr} without merging?`, "The request goes back to the queue, and the next attempt starts fresh from main.", "Close the pull request", () => { const it = S.items.find((i) => i.pr === +el.dataset.pr); it.status = "queued"; it.previous_prs = [...(it.previous_prs || []), it.pr]; it.pr = null; toast(`Closed PR #${el.dataset.pr}.`); go("r-" + key(it)); }, true),
    comment: (el) => textDialog(el.dataset.title || "Comment", el.dataset.placeholder || "Write a comment", "Post", (v) => {
      const n = +el.dataset.n; S.activity[n] = [...(S.activity[n] || []), { who: "maraokafor", at: F.now, text: v }];
      toast(`Posted on #${n}.`, { link: ["r-" + n + "-activity", "See it"] });
    }),
    "close-issue": (el) => { const it = issueOf(el); confirmAct(`Close #${it.issue}?`, `${esc(it.title)}. Anything running for it stops, and it leaves the briefing. You can reopen it.`, "Close the issue", () => { it.status = "closed"; it.closed_at = F.now; toast(`Closed #${it.issue}.`, { link: ["r-" + it.issue, "Open it"] }); render(current, true); }, true); },
    "reopen-issue": (el) => { const it = issueOf(el); it.status = "queued"; it.closed_at = null; toast(`Reopened #${it.issue}. It's back in the queue.`); render(current, true); },
    trust: (el) => { const it = issueOf(el); it.status = "queued"; it.labels.push("factory:accept"); toast(`Added factory:accept to #${it.issue}. It's queued.`); render(current, true); },
    "add-label": (el) => { const it = itemBy(el.dataset.k); it.labels.push(el.dataset.l); closeDialog(); toast(`Added ${el.dataset.l}.`); render(current, true); },
    "remove-label": (el) => { const it = itemBy(el.dataset.k); it.labels = it.labels.filter((l) => l !== el.dataset.l); toast(`Removed ${el.dataset.l}.`); render(current, true); },
    priority: (el) => { const it = itemBy(el.dataset.k); it.priority = it.priority === "high" ? "normal" : "high"; if (it.issue) it.labels = it.priority === "high" ? [...it.labels, "priority:high"] : it.labels.filter((l) => l !== "priority:high"); toast(`Priority set to ${it.priority}.`); render(current, true); },
    candidate: (el) => { const c = S.candidates.find((x) => x.id === el.dataset.id); c.status = el.dataset.d === "accept" ? "accepted" : "rejected"; toast(el.dataset.d === "accept" ? "Added. A hardening run will write the rule." : "Noted. It won't be suggested again."); render(current, true); },
    rerun: (el) => { const r = runBy(el.dataset.r); toast(`Re-running the failed jobs of workflow run ${r.workflow_run}.`); r.outcome = "running"; r.started_at = F.now; r.duration_sec = null; const it = S.items.find((i) => i.runs.includes(r.id)); if (it) it.status = "running"; render(current, true); },
    "rerun-wf": (el) => { const w = S.workflows.find((x) => x.file === el.dataset.w); w.last = "in_progress"; w.at = F.now; toast(`Re-running the failed jobs of ${w.name}.`); render(current, true); },
    "cancel-run": (el) => { const r = runBy(el.dataset.r); confirmAct("Cancel this run?", `${esc(r.title)}. What it has spent so far (${usd(r.cost)}) is still charged, and the request goes back to the queue.`, "Cancel the run", () => { r.outcome = "cancelled"; r.ended_at = F.now; r.duration_sec = Math.round((Date.parse(F.now) - Date.parse(r.started_at)) / 1000); toast("Run cancelled."); render(current, true); }, true); },
    dispatch: (el) => { const w = S.workflows.find((x) => x.file === el.dataset.w); w.last = "in_progress"; w.at = F.now; toast(`Started ${w.name}.`, { link: ["factory-workflows", "See it"] }); render(current, true); },
    "goal-remove": (el) => { S.goals = S.goals.filter((g) => g.id !== el.dataset.id); toast("Goal removed."); render(current, true); },
    "open-issue-for": (el) => { const it = itemBy(el.dataset.k); it.issue = S.nextIssue++; it.source = { ...it.source, ref: "#" + it.issue }; toast(`Opened #${it.issue}. Answer the question there or here.`); go("r-" + it.issue); },
    drop: (el) => { const it = itemBy(el.dataset.k); confirmAct("Drop this request?", `${esc(it.title)}. Nothing more is spent on it.`, "Drop it", () => { it.status = "closed"; toast("Dropped."); render(current, true); }, true); },
    agree: () => { const it = byIssue(214); it.status = "running"; toast("Agreed. It's building now; next you'll see a pull request."); go("r-214-runs"); },
    "focus-compose": () => $(".compose textarea").focus(),
    "show-earlier": () => { S.talk = "live"; render("r-214-talk"); },
    "line-comment": (el) => textDialog(`Comment on ${el.dataset.f}, line ${el.dataset.l}`, "What's wrong with this line?", "Add comment", (v) => { S.lineComments.push({ file: el.dataset.f, line: +el.dataset.l, text: v }); toast("Comment added to your review."); render(current, true); }),
    "jump-file": (el) => { const d = $$("details.file").find((x) => x.querySelector(".fname").textContent === el.dataset.f); if (d) { d.open = true; d.scrollIntoView({ behavior: reduce() ? "auto" : "smooth" }); } },
    "req-filter": (el) => { S.reqFilter = el.dataset.v; render(current, true); },
    "run-filter": (el) => { S.runFilter = el.dataset.v; render(current, true); },
    "pick-repo": (el) => { closeDialog(); const r = el.dataset.repo; if (r === F.repo) go("home"); else if (r.endsWith("ledgerline-site")) go("no-factory"); else toast(`${esc(r)} has a factory too; this sketch only has data for ledgerline.`); },
    "sign-out": () => { closeDialog(); go("signin"); },
    repos: () => popover("repos", $(".repo")),
  };
  const submits = {
    answer: (f) => { const v = f.querySelector("textarea").value.trim() || B.reply.text; S.talk = "live"; go("r-214-talk"); setTimeout(() => sendTalk(v, true), 250); },
    talk: (f) => { const ta = f.querySelector("textarea"); sendTalk(ta.value.trim() || B.reply.text); ta.value = ""; ta.style.height = ""; },
    "pr-comment": (f) => { const ta = f.querySelector("textarea"); if (!ta.value.trim()) return; S.prComments.push({ who: "person", by: "You", at: F.now, text: ta.value.trim() }); toast("Commented on PR #219."); render(current, true); },
    "issue-comment": (f) => { const ta = f.querySelector("textarea"); if (!ta.value.trim()) return; const n = +f.dataset.n; const it = byIssue(n); const base = S.activity[n] || [{ who: it.source.actor, at: it.created_at, text: "Opened this request." }]; S.activity[n] = [...base, { who: "maraokafor", at: F.now, text: ta.value.trim() }]; toast(`Posted on #${n}.`); render(current, true); },
    "new-request": (f) => {
      const d = new FormData(f), title = String(d.get("title") || "").trim();
      if (!title) return;
      const kind = String(d.get("kind")), n = S.nextIssue++;
      S.items.unshift({ issue: n, id: "wi_01JDNEW" + n + "XXXXXXXXXXXXXX", title, status: "queued", pipeline: kind === "harden" ? "hardening" : kind === "tidy" ? "gardening" : "product_work", priority: "normal", created_at: F.now, source: { kind: "issue", ref: "#" + n, actor: "maraokafor", via: "dashboard" }, labels: ["factory:" + kind], pr: null, cost: 0, runs: [], goal: String(d.get("goal") || "") || undefined });
      closeDialog(); if (S.mode === "empty") S.mode = "busy";
      toast(`Opened #${n}. The factory asks its first question within a minute.`, { link: ["r-" + n, "Open it"] });
      render(current === "home" && S.mode === "busy" ? "requests" : current, true);
    },
    "goal-add": (f) => { const d = new FormData(f); S.goals.push({ id: "g" + Date.now(), text: String(d.get("text")), lane: String(d.get("lane")) || null, until: "" }); toast("Goal added. The factory weighs work toward it from the next run."); render(current, true); },
    "save-settings": (f) => {
      const stage = f.querySelector("[data-save-stage]"), btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      const steps = ["Opening a pull request with the change", "Waiting for the policy check", "Merging it"];
      steps.forEach((s, i) => setTimeout(() => (stage.innerHTML = `${I.spin} ${s}`), i * 900));
      setTimeout(() => { const n = S.nextPr++; stage.textContent = `Saved in PR #${n}, merged. It takes effect from the next run.`; btn.disabled = false; toast(`Settings saved in PR #${n}.`); }, steps.length * 900);
    },
  };
  const changes = {
    "req-pipe": (el) => { S.reqPipe = el.value; render(current, true); },
    "merge-method": (el) => { S.mergeMethod = el.value; render(current, true); },
    viewed: (el) => { if (el.checked) S.viewed.add(el.dataset.f); else S.viewed.delete(el.dataset.f); render(current, true); },
    reroute: (el) => { const it = itemBy(el.dataset.k); it.pipeline = el.value; it.routing = { by: "you", reason: "Moved from the dashboard.", at: F.now }; toast(`Moved to ${PIPE[el.value].toLowerCase()}.`); render(current, true); },
    theme: (el) => { S.theme = el.value; if (el.value === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = el.value; },
  };

  /* The live exchange: an answer goes out, the thread confirms it, the next question arrives. */
  const nearBottom = () => window.innerHeight + window.scrollY > document.body.scrollHeight - 240;
  const follow = (was) => { if (was) window.scrollTo({ top: document.body.scrollHeight, behavior: reduce() ? "auto" : "smooth" }); };
  function sendTalk(text, force) {
    const thread = $(".talk-col .thread");
    if (!thread) return;
    const cold = S.talk === "cold";
    $$(".latest", thread).forEach((t) => t.classList.remove("latest"));
    let was = nearBottom() || force;
    thread.insertAdjacentHTML("beforeend", turn({ who: "person", text, at: F.now }, { sending: true, when: "now" }));
    const mine = thread.lastElementChild;
    follow(was);
    setTimeout(() => mine.classList.remove("sending"), 900);
    const status = $("[data-status]");
    if (cold) { status.innerHTML = `<span class="cold-dot" aria-hidden="true"></span><span>Sent. The factory is waking up; the next question usually arrives in 2 to 4 minutes. You can leave; it'll be here.</span>`; return; }
    setTimeout(() => { if (!thread.isConnected) return; was = nearBottom(); thread.insertAdjacentHTML("beforeend", `<div class="turn f latest" data-typing><div class="who"><span>The factory</span></div><div class="text"><span class="typing" aria-label="The factory is writing"><i></i><i></i><i></i></span></div></div>`); follow(was); }, 1500);
    setTimeout(() => { if (!thread.isConnected) return; const t = thread.querySelector("[data-typing]"); was = nearBottom(); if (t) t.outerHTML = turn(B.next, { latest: true, when: "now" }); follow(was); }, 4800);
  }

  /* ------------------------------------------------------------------ events */
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) { closeDialog(); return; }
    const g = e.target.closest("[data-go]");
    if (g) { e.preventDefault(); closeDialog(); go(g.dataset.go); return; }
    const p = e.target.closest("[data-pop]");
    if (p) { popover(p.dataset.pop, p); return; }
    const a = e.target.closest("[data-act]");
    if (a && actions[a.dataset.act]) { e.preventDefault(); actions[a.dataset.act](a); }
  });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-act-submit]");
    if (f) { e.preventDefault(); submits[f.dataset.actSubmit](f); }
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.actChange && changes[el.dataset.actChange]) changes[el.dataset.actChange](el);
    if (el.dataset.set) {
      S.settings[el.dataset.set] = el.type === "checkbox" ? el.checked : Number(el.value);
      if (el.dataset.set.startsWith("share_") || el.dataset.set === "gardening_hour") render(current, true);
    }
  });
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.matches("textarea")) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
    if (el.dataset.actInput === "req-query") { S.reqQuery = el.value; const pos = el.selectionStart; render(current, true); const n = $("[data-act-input=req-query]"); n.focus(); n.setSelectionRange(pos, pos); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && layer.innerHTML) { closeDialog(); return; }
    if (e.key === "Enter" && !e.shiftKey && e.target.matches(".compose textarea, .answer textarea")) { e.preventDefault(); e.target.form.requestSubmit(); return; }
    const typing = e.target.matches("input, textarea, select") || e.target.isContentEditable;
    if (typing || layer.innerHTML) return;
    if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); palette(); }
    else if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); actions["new-request"](document.createElement("button")); }
  });

  /* ------------------------------------------------------------------ mount */
  const SCENARIOS = [
    ["home", "Briefing: things need you"], ["quiet", "Briefing: nothing needs you"], ["empty", "Briefing: before the first run"],
    ["r-203", "Request with a pull request and proof"], ["r-221", "Request with a run in flight"], ["run-01jd9ee0", "A run, live"],
    ["r-214-first", "Conversation: first question"], ["r-214-live", "Conversation: live"], ["r-214-cold", "Conversation: gone cold"], ["r-214-understood", "Conversation: the playback"], ["r-n000a", "Conversation: no issue to answer on"],
    ["r-207", "Request stuck after three tries"], ["r-222", "Request from someone new"], ["r-220", "Request closed as a duplicate"],
    ["requests", "All requests"], ["runs", "All runs"], ["guardrails", "Guardrails"], ["spend", "Spend and automation"], ["factory", "Factory: settings and more"],
    ["signin", "Sign in"], ["signin-pick", "Sign in: pick a repository"],
  ];
  window.addEventListener("screen", (e) => {
    let r = e.detail;
    const scen = { quiet: "quiet", empty: "empty", home: "busy" };
    if (scen[r]) { S.mode = scen[r]; r = "home"; }
    if (r === "r-214" || r === "r-214-talk") S.talk = S.talk === "understood" || S.talk === "first" ? "live" : S.talk;
    render(r);
    if (r === "r-214-live" && !new URLSearchParams(location.search).has("still")) setTimeout(() => sendTalk(B.reply.text), 700);
  });
  window.U.chrome(SCENARIOS, { name: "A. Briefing", anyRoute: true, push: true });
  const cold = document.createElement("button");
  cold.type = "button"; cold.textContent = "Let it go cold"; cold.className = "sc-cold";
  cold.addEventListener("click", () => { const s = $("[data-status]"); if (s) { S.talk = "cold"; s.innerHTML = COLD; } });
  document.querySelector(".sketch-chrome").appendChild(cold);
  const syncCold = () => (cold.hidden = !/^r-214(-live|-first|-talk)?$/.test(current));
  window.addEventListener("screen", syncCold); syncCold();
})();
