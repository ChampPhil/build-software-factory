/*
 * Synthetic data for the Phase 1 sketch. One factory, one morning.
 *
 * Shapes follow schema/*.json field for field, so every value here is one the
 * real dashboard could be handed. The repository is invented: Ledgerline, an
 * invoicing app run by one developer, Mara Okafor. "Now" is Wednesday
 * 25 November 2026, 08:40 in New York; she last looked at 23:10 the night before.
 */
window.FACTORY = {
  now: "2026-11-25T13:40:00Z",
  lastSeen: "2026-11-25T04:10:00Z",
  person: { login: "maraokafor", name: "Mara Okafor" },
  repo: "maraokafor/ledgerline",
  installed: ["maraokafor/ledgerline", "maraokafor/ledgerline-site", "okafor-studio/receipts-api"],

  /* ---------- Waiting on a person ---------- */
  waiting: [
    {
      kind: "question",
      id: "wi_01JDM9S346Q3D25VT4F5V37E3S",
      issue: 214,
      pipeline: "product_work",
      title: "Let clients pay an invoice in two instalments",
      status: "needs_info",
      since: "2026-11-25T13:31:00Z",
      line: "Should the second instalment have its own due date, or a fixed number of days after the first?",
    },
    {
      kind: "review",
      id: "wi_01JD3E28JT97KB6CQ643DZVMXX",
      issue: 203,
      pr: 219,
      pipeline: "product_work",
      title: "Export invoices to CSV in the client's currency",
      status: "in_review",
      since: "2026-11-25T06:52:00Z",
      line: "Adds Export to CSV on the invoice list. Amounts come out in each client's currency, with the rate used on the day.",
      cost: 3.84,
      duration: 1560,
      proof: 4,
      checks: "pass",
    },
    {
      kind: "escalated",
      id: "wi_01JDQKFBF5KZNWJ47TAN9ZT24M",
      issue: 207,
      pipeline: "product_work",
      title: "Safari signs people out when the tab has been asleep",
      status: "escalated",
      since: "2026-11-25T09:18:00Z",
      line: "The fix works in Chrome and Firefox. Safari still drops the session after 40 minutes asleep, three attempts in a row, and the verifier can't tell whether that's the app or the sandbox's WebKit.",
      cost: 6.12,
    },
    {
      kind: "trust",
      id: "wi_01JDNPZX45HY43KWJRP1XPA7Z3",
      issue: 222,
      pipeline: "product_work",
      title: "Add Portuguese (Brazil) to the invoice languages",
      status: "waiting_trust",
      since: "2026-11-25T11:05:00Z",
      line: "Filed by jonas-albuquerque, who doesn't have write access. The factory won't spend on it until you say so.",
      actor: "jonas-albuquerque",
    },
    {
      kind: "candidate",
      id: "cand_01JDDJ8FSSZ5AWSH8VHTPRE95B",
      problem_class: "Money formatted with toFixed instead of Intl.NumberFormat",
      occurrences: 4,
      proposed_fix: "static_rule",
      line: "You corrected this four times in three weeks, most recently on #211: “use the currency formatter, never toFixed”.",
      since: "2026-11-24T22:14:00Z",
    },
  ],

  /* ---------- Running right now (refs/factory/live/*) ---------- */
  live: [
    {
      run: "run_01JD9EE0ZBGJ09TQM83XSSSS6Y",
      work_item: "wi_01JDS3C4DWA7N36096Q14DR9GP",
      issue: 221,
      title: "Bulk-archive paid invoices",
      pipeline: "product_work",
      step: "builder",
      gate: null,
      attempt: 2,
      of: 3,
      started_at: "2026-11-25T13:12:00Z",
      cost_usd_so_far: 1.92,
      path: ["triage", "spec", "builder", "verifier", "gate"],
      note: "Second attempt. The first build failed the static gate on one floating promise in archive.ts.",
    },
    {
      run: "run_01JDQY77ZXYYK596NGYA1DQ91K",
      work_item: "wi_01JD5GQAPENECFSECZP11HYGCP",
      issue: null,
      title: "Remove unused date-fns locale imports",
      pipeline: "gardening",
      step: "verifier",
      gate: null,
      attempt: 1,
      of: 3,
      started_at: "2026-11-25T13:29:00Z",
      cost_usd_so_far: 0.41,
      path: ["gardener", "verifier", "gate"],
      note: "Bundle is 38 KB smaller so far.",
    },
  ],

  queued: [
    { id: "wi_01JDWPQ5E6EYCNDY0YP57RCYBV", issue: 223, title: "Show the payment method on the receipt PDF", pipeline: "product_work", priority: "normal" },
    { id: "wi_01JDN5SXS5AA819X9YP981068V", issue: null, title: "Pin the Stripe SDK and add a contract test for webhooks", pipeline: "hardening", priority: "high" },
  ],

  mergeQueue: [
    { pr: 216, title: "Consolidate the three date helpers into one module", pipeline: "gardening", eligible_at: "2026-11-25T14:30:00Z" },
  ],

  /* ---------- Landed since she last looked ---------- */
  landed: [
    { pr: 212, issue: 198, title: "Reminder emails use the client's time zone", pipeline: "product_work", merged_at: "2026-11-25T07:48:00Z", by: "auto-merge", human_edits: 0, cost: 2.71, duration: 1320, poster: "reminder" },
    { pr: 215, issue: null, title: "Delete the unused v1 PDF renderer", pipeline: "gardening", merged_at: "2026-11-25T08:02:00Z", by: "auto-merge", human_edits: 0, cost: 0.58, duration: 640, poster: "diff" },
    { pr: 213, issue: 209, title: "Lint rule: no floating promises in API handlers", pipeline: "hardening", merged_at: "2026-11-25T05:20:00Z", by: "auto-merge", human_edits: 0, cost: 0.94, duration: 880, poster: "lint" },
  ],

  /* ---------- The pull request under review: #219 ---------- */
  pr: {
    number: 219,
    issue: 203,
    work_item: "wi_01JD3E28JT97KB6CQ643DZVMXX",
    run: "run_01JDCD1GDJFMGT83PXT891WB09",
    title: "Export invoices to CSV in the client's currency",
    branch: "factory/wi-01jd3e28-csv-export",
    head: "4e73cf5",
    opened_at: "2026-11-25T06:52:00Z",
    cost: 3.84,
    duration: 1560,
    additions: 214,
    deletions: 31,
    routing: { by: "chief_of_staff", reason: "A new capability people will see, so product work." },
    summary: [
      "Adds Export to CSV to the invoice list, for the current filter or a selection.",
      "Each amount is written in the client's own currency, with the exchange rate used on the invoice date, because your accountant asked for it in #203.",
      "You'd notice a new Export button beside Filter, and a file named invoices-2026-11.csv in your downloads.",
    ],
    blocks: [
      { type: "file", file: "export-flow.webm", kind: "video", seconds: 42, caption: "Filters to November, selects four invoices across three currencies, exports, and opens the file. Amounts stay in GBP, EUR and USD rather than being converted." },
      { type: "file", file: "csv-opened.png", kind: "image", caption: "The exported file opened in a spreadsheet. The rate column is empty for same-currency invoices, which is deliberate." },
      { type: "diagram", title: "Where the rate comes from", kind: "diagram" },
      { type: "file", file: "export-api.json", kind: "text", caption: "GET /api/invoices/export?month=2026-11 with four ids. 200 in 184 ms; content-type text/csv; charset=utf-8." },
    ],
    focus: [
      { title: "Rates are read once per invoice date", detail: "If two invoices share a date they share one lookup. Worth a look if you ever back-date invoices.", files: ["src/lib/rates.ts"] },
      { title: "Column order is fixed", detail: "Matches the template your accountant sent. Changing it later breaks their import.", files: ["src/export/csv.ts"] },
    ],
    gates: [
      { gate: "static", attempt: 1, result: "pass", detail: "Types, lint, 0 new violations" },
      { gate: "verification", attempt: 1, result: "pass", detail: "Coverage on changed lines 94%" },
    ],
    files: [
      { name: "src/export/csv.ts", status: "added", additions: 96, deletions: 0 },
      { name: "src/lib/rates.ts", status: "modified", additions: 41, deletions: 12 },
      { name: "src/app/invoices/InvoiceToolbar.tsx", status: "modified", additions: 28, deletions: 9 },
      { name: "src/app/api/invoices/export/route.ts", status: "added", additions: 37, deletions: 0 },
      { name: "src/export/csv.test.ts", status: "added", additions: 12, deletions: 10 },
    ],
    patch: [
      [" ", 18, "export function toCsvRow(inv: Invoice, rate: Rate | null): string[] {"],
      ["-", 19, "  const amount = (inv.totalCents / 100).toFixed(2);"],
      ["+", 19, "  const amount = formatMoney(inv.totalCents, inv.currency, { plain: true });"],
      ["+", 20, "  const rateUsed = rate === null ? \"\" : rate.value.toFixed(6);"],
      [" ", 21, "  return ["],
      [" ", 22, "    inv.number,"],
      [" ", 23, "    inv.client.name,"],
      ["+", 24, "    inv.currency,"],
      [" ", 25, "    amount,"],
      ["+", 26, "    rateUsed,"],
      [" ", 27, "    inv.issuedOn,"],
    ],
    steps: [
      { role: "triage", model: "claude-haiku-4-5", seconds: 41, cost: 0.03 },
      { role: "spec", model: "claude-opus-4-5", seconds: 312, cost: 1.46 },
      { role: "builder", model: "claude-sonnet-4-5", seconds: 734, cost: 1.68 },
      { role: "verifier", model: "claude-sonnet-4-5", seconds: 402, cost: 0.62 },
      { role: "scorer", model: "claude-haiku-4-5", seconds: 71, cost: 0.05 },
    ],
  },

  /* ---------- The conversation on #214 ---------- */
  brainstorm: {
    work_item: "wi_01JDM9S346Q3D25VT4F5V37E3S",
    issue: 214,
    title: "Let clients pay an invoice in two instalments",
    request: "Some of my bigger clients want to pay half up front and half later. Right now I send two separate invoices and it messes up my reports.",
    turns: [
      { at: "2026-11-25T13:24:10Z", who: "factory", text: "Thanks, this is clear on the why. One question to start: who decides that an invoice is split — you when you send it, or the client when they pay?" },
      { at: "2026-11-25T13:26:02Z", who: "person", text: "Me, when I send it. Clients shouldn't be able to choose on their own." },
      { at: "2026-11-25T13:26:14Z", who: "factory", kind: "frame", text: "After the first instalment is paid, what should the invoice say: Partially paid with the balance due, or Sent until it's paid in full?" },
      { at: "2026-11-25T13:28:40Z", who: "person", text: "Partially paid, and show what's still owed." },
      { at: "2026-11-25T13:28:52Z", who: "factory", text: "Should the second instalment have its own due date, or a fixed number of days after the first?" },
    ],
    reply: { at: "2026-11-25T13:31:05Z", who: "person", text: "Its own date. Usually 30 days later, but I want to pick." },
    next: { at: "2026-11-25T13:31:11Z", who: "factory", text: "Last one. Do reminders go out per instalment, on each one's own due date, or once for the invoice as a whole?" },
    open: ["Do reminders follow each instalment, or the invoice as a whole?"],
    understood: "When you send an invoice, you can give it a payment schedule of two instalments, each with its own amount and due date; the second defaults to 30 days after the first and you can change it. It stays one invoice with one number. Clients pay each instalment separately and can't change the schedule. Once the first is paid, the invoice shows Partially paid with the balance due. Dunning follows each instalment, on its own due date. Invoices without a schedule behave exactly as they do today, and because your reports are on a cash basis, each instalment counts in the month it's paid.",
    /* The words the conversation taught, ranked by how much each changes what
       gets built. Unverified: the conversation has no web access, and the spec
       stage confirms or cuts each one. Seven here, four on screen. */
    frame: {
      named: "A payment schedule: one invoice whose total falls due in two parts, each with its own date.",
      terms: [
        { term: "Payment schedule", means: "One invoice whose total is due in parts, each part with its own amount and due date", names: "\u201chalf up front and half later\u201d", unlocks: "one invoice with two due dates, instead of two invoices that split your reports", prior_art: "Stripe Invoicing and Xero, which both use the name" },
        { term: "Balance due", means: "What is still owed after part of an invoice has been paid", names: "the weeks between the two payments, when the invoice is neither unpaid nor paid", unlocks: "a Partially paid state that shows the amount still outstanding" },
        { term: "Cash basis", means: "Counting income in the month the money arrives, not the month it was invoiced", names: "\u201cit messes up my reports\u201d", unlocks: "choosing which month each instalment counts in, which is what your revenue report will show", prior_art: "small-business bookkeeping, as opposed to the accrual basis" },
        { term: "Dunning", means: "The sequence of reminders sent while an amount is overdue", names: "nothing yet. It is what reminders become once one invoice has two due dates", unlocks: "reminders per instalment rather than per invoice" },
        { term: "Deposit", means: "An amount paid before work starts, usually credited against a later invoice", names: "the first half, if it is paid before the work rather than for it", unlocks: "a different design: a deposit invoice and a final invoice, if that is what you mean" },
        { term: "Credit note", means: "A document that reduces what a client owes on an invoice already sent", names: "what a refund on a split invoice would need", unlocks: "refunding part of a scheduled invoice without breaking its schedule" },
        { term: "Ageing report", means: "Outstanding amounts grouped by how long they have been overdue", names: "where an unpaid second instalment would show up", unlocks: "seeing late instalments next to late invoices" },
      ],
      neighbors: [
        { field: "Buy now, pay later (Klarna, Afterpay)", carries_over: "One purchase split into scheduled parts, each tracked and reminded on its own", breaks_down: "There a lender pays the merchant in full and carries the risk; here you are owed the second half yourself, so a missed instalment is your loss", terms: ["instalment plan", "missed payment"] },
        { field: "Progress billing in construction", carries_over: "One contract billed in stages, with what has been paid and what is left always visible", breaks_down: "Stages there fall due when work is finished; your instalments fall due on dates, whatever happens to the work", terms: ["retainage"] },
      ],
      unmentioned: [
        "What happens when a client pays both instalments at once",
        "Whether tax is split across the instalments or charged on the first",
        "What a partial refund does to an instalment that has not been paid yet",
      ],
      readings: [
        { problem: "One invoice paid in two parts", term: "payment schedule", tells_it_apart: "one invoice number, one total, two due dates" },
        { problem: "A deposit, then a final invoice", term: "deposit invoice", tells_it_apart: "two invoice numbers, the second reduced by the first" },
      ],
      reading_taken: "One invoice in two parts, because you said the trouble is that two invoices mess up your reports.",
    },
    holder: "run_01JDB9Y73MY63FCH26W14WMCHW",
  },

  /* ---------- Rollup (index.json) ---------- */
  metrics: {
    window_days: 30,
    automation_rate: 0.83,
    cycle_time_p50_sec: 6720,
    cycle_time_p90_sec: 22200,
    spend_usd: 27.4,
    budget_usd: 35,
    actions_minutes: 1184,
    actions_minutes_limit: 3000,
    runs: 58,
    merged: 41,
    escalated: 4,
    revert_rate: 0.024,
    human_interactions_per_pr: 0.6,
    by_pipeline: {
      product_work: { runs: 22, merged: 17, spend_usd: 21.1, actions_minutes: 702 },
      gardening: { runs: 24, merged: 18, spend_usd: 3.9, actions_minutes: 318 },
      hardening: { runs: 12, merged: 6, spend_usd: 2.4, actions_minutes: 164 },
    },
  },
  // Spend per day, 1 to 25 November, oldest first; sums to spend_usd. Merges per day alongside.
  daily: [
    [0.42,1],[1.10,1],[0.00,0],[2.96,2],[0.61,1],[0.38,1],[1.85,2],[0.55,1],[3.40,2],[0.47,1],[0.00,0],[0.00,0],[1.21,1],[0.52,1],[2.18,2],[0.44,1],[0.91,1],[1.62,2],[0.36,1],[0.00,0],[0.73,1],[2.44,2],[0.49,1],[1.08,1],[3.68,1],
  ],
  guardrails: { rules: 31, baselined: 7, coverage_floor_pct: 78, candidates_pending: 1 },
  goals: [{ id: "g1", text: "Get the invoice list under 1 second on 500 invoices", lane: "product_work", until: "2026-12-15" }],
};

/*
 * The rest of what the dashboard can read: every work item in the ledger (one
 * in each of the ten statuses), every run with its steps and gates, and the
 * guardrail, review, sandbox, settings, workflow and people data.
 */
Object.assign(window.FACTORY, {
  labels: ["factory:feature", "factory:bug", "factory:harden", "factory:tidy", "factory:accept", "priority:high", "billing", "reports", "safari", "i18n", "needs-design"],

  /* Ledger: open and recent, joined with each work item's own file. */
  items: [
    { issue: 214, id: "wi_01JDM9S346Q3D25VT4F5V37E3S", title: "Let clients pay an invoice in two instalments", status: "needs_info", pipeline: "product_work", priority: "normal", created_at: "2026-11-25T13:20:00Z", source: { kind: "issue", ref: "#214", actor: "maraokafor", via: "dashboard" }, labels: ["factory:feature", "billing"], pr: null, cost: 0.06, runs: ["run_01JDB9Y7"], routing: { by: "chief_of_staff", reason: "A change customers will see, so product work.", at: "2026-11-25T13:21:00Z" }, goal: "Bigger clients can pay half up front without me sending two invoices.", success_check: "An invoice split into two instalments shows Partially paid after the first payment." },
    { issue: 203, id: "wi_01JD3E28JT97KB6CQ643DZVMXX", title: "Export invoices to CSV in the client's currency", status: "in_review", pipeline: "product_work", priority: "normal", created_at: "2026-11-23T15:02:00Z", source: { kind: "issue", ref: "#203", actor: "maraokafor", via: "github" }, labels: ["factory:feature", "reports"], pr: 219, cost: 3.84, runs: ["run_01JDCD1G"], routing: { by: "chief_of_staff", reason: "A new capability people will see, so product work.", at: "2026-11-23T15:03:00Z" }, goal: "My accountant gets November's invoices in a file she can import.", success_check: "A CSV with one row per invoice, amounts in the client's currency.", related: [220] },
    { issue: 207, id: "wi_01JDQKFBF5KZNWJ47TAN9ZT24M", title: "Safari signs people out when the tab has been asleep", status: "escalated", pipeline: "product_work", priority: "high", created_at: "2026-11-24T16:40:00Z", source: { kind: "issue", ref: "#207", actor: "devon-reyes", via: "github" }, labels: ["factory:bug", "priority:high", "safari"], pr: null, cost: 6.12, runs: ["run_01JDE7A1", "run_01JDE9K4", "run_01JDEC22"], routing: { by: "chief_of_staff", reason: "A bug customers hit, so product work, high priority.", at: "2026-11-24T16:41:00Z" }, previous_prs: [217], triage_reason: "Reproducible from the steps in the issue." },
    { issue: 222, id: "wi_01JDNPZX45HY43KWJRP1XPA7Z3", title: "Add Portuguese (Brazil) to the invoice languages", status: "waiting_trust", pipeline: "product_work", priority: "normal", created_at: "2026-11-25T11:05:00Z", source: { kind: "issue", ref: "#222", actor: "jonas-albuquerque", via: "github" }, labels: ["factory:feature", "i18n"], pr: null, cost: 0, runs: [] },
    { issue: 221, id: "wi_01JDS3C4DWA7N36096Q14DR9GP", title: "Bulk-archive paid invoices", status: "running", pipeline: "product_work", priority: "normal", created_at: "2026-11-24T21:12:00Z", source: { kind: "issue", ref: "#221", actor: "maraokafor", via: "dashboard" }, labels: ["factory:feature"], pr: null, cost: 1.92, runs: ["run_01JD9EE0"], routing: { by: "chief_of_staff", reason: "A new capability people will see, so product work.", at: "2026-11-24T21:13:00Z" }, goal: "Clear out last year's paid invoices in one go." },
    { issue: null, id: "wi_01JD5GQAPENECFSECZP11HYGCP", title: "Remove unused date-fns locale imports", status: "running", pipeline: "gardening", priority: "normal", created_at: "2026-11-25T13:28:00Z", source: { kind: "schedule", ref: "nightly gardening", actor: "factory", via: "schedule" }, labels: ["factory:tidy"], pr: null, cost: 0.41, runs: ["run_01JDQY77"] },
    { issue: 223, id: "wi_01JDWPQ5E6EYCNDY0YP57RCYBV", title: "Show the payment method on the receipt PDF", status: "queued", pipeline: "product_work", priority: "normal", created_at: "2026-11-25T12:10:00Z", source: { kind: "issue", ref: "#223", actor: "maraokafor", via: "dashboard" }, labels: ["factory:feature"], pr: null, cost: 0, runs: [] },
    { issue: null, id: "wi_01JDN5SXS5AA819X9YP981068V", title: "Pin the Stripe SDK and add a contract test for webhooks", status: "queued", pipeline: "hardening", priority: "high", created_at: "2026-11-24T08:02:00Z", source: { kind: "review", ref: "review 2026-11-22", actor: "factory", via: "review" }, labels: ["factory:harden"], pr: null, cost: 0, runs: [], fixes: "Two runs this week broke on a Stripe SDK minor bump." },
    { issue: null, id: "wi_01JDF0Y0Q1B4NQ6V3R2T8W9Z7A", title: "Consolidate the three date helpers into one module", status: "queued_to_merge", pipeline: "gardening", priority: "normal", created_at: "2026-11-25T07:05:00Z", source: { kind: "schedule", ref: "nightly gardening", actor: "factory", via: "schedule" }, labels: ["factory:tidy"], pr: 216, cost: 0.74, runs: ["run_01JDF0Y1"] },
    { issue: 198, id: "wi_01JD0BX3RRCZ0D7S7V9QKA2W1H", title: "Reminder emails use the client's time zone", status: "merged", pipeline: "product_work", priority: "normal", created_at: "2026-11-24T19:30:00Z", merged_at: "2026-11-25T07:48:00Z", source: { kind: "issue", ref: "#198", actor: "maraokafor", via: "dashboard" }, labels: ["factory:bug"], pr: 212, cost: 2.71, runs: ["run_01JD0BX4"] },
    { issue: null, id: "wi_01JD4T7M2YB0QH6XG4N8C5D3PZ", title: "Delete the unused v1 PDF renderer", status: "merged", pipeline: "gardening", priority: "normal", created_at: "2026-11-25T07:01:00Z", merged_at: "2026-11-25T08:02:00Z", source: { kind: "schedule", ref: "nightly gardening", actor: "factory", via: "schedule" }, labels: ["factory:tidy"], pr: 215, cost: 0.58, runs: ["run_01JD4T7N"] },
    { issue: 209, id: "wi_01JD7P2K9F3VAX0BRSM6QN4E8D", title: "Lint rule: no floating promises in API handlers", status: "merged", pipeline: "hardening", priority: "normal", created_at: "2026-11-25T03:40:00Z", merged_at: "2026-11-25T05:20:00Z", source: { kind: "correction", ref: "PR #211 review", actor: "maraokafor", via: "correction" }, labels: ["factory:harden"], pr: 213, cost: 0.94, runs: ["run_01JD7P2L"] },
    { issue: 220, id: "wi_01JDK1D8BS0W4R7YH2CT5M9QPX", title: "CSV export for the accountant", status: "duplicate", pipeline: "product_work", priority: "normal", created_at: "2026-11-24T10:12:00Z", closed_at: "2026-11-24T10:13:00Z", source: { kind: "issue", ref: "#220", actor: "devon-reyes", via: "github" }, labels: ["factory:feature"], pr: null, cost: 0.02, runs: ["run_01JDK1D9"], parent: 203, triage_reason: "Same request as #203, which is already being built." },
    { issue: 218, id: "wi_01JDH6Z2A7T9C1M4KQ8P0XW3VN", title: "Accept crypto payments", status: "rejected", pipeline: "product_work", priority: "normal", created_at: "2026-11-23T22:01:00Z", closed_at: "2026-11-23T22:02:00Z", source: { kind: "issue", ref: "#218", actor: "unknown-visitor-42", via: "github" }, labels: [], pr: null, cost: 0.02, runs: ["run_01JDH6Z3"], triage_reason: "Needs a payment provider decision and new credentials; that's yours to make, not the factory's." },
    { issue: null, id: "wi_01JDSLACK0LATEFEE0PLAN000A", title: "Late fee should stop accruing once a payment plan is agreed", status: "needs_info", pipeline: "product_work", priority: "normal", created_at: "2026-11-25T12:00:00Z", source: { kind: "slack", ref: "#billing", actor: "maraokafor", via: "slack" }, labels: [], pr: null, cost: 0.04, runs: [] },
  ],

  /* Runs (run.json), newest first. Steps and gates are complete for the ones a person opens. */
  runs: [
    { id: "run_01JD9EE0", issue: 221, title: "Bulk-archive paid invoices", pipeline: "product_work", outcome: "running", started_at: "2026-11-25T13:12:00Z", cost: 1.92, workflow_run: 11873420311,
      steps: [{ role: "triage", model: "claude-haiku-4-5", attempt: 1, duration_sec: 38, tokens: 6120, cost_usd: 0.02, exit: "ok" }, { role: "spec", model: "claude-opus-4-5", attempt: 1, duration_sec: 294, tokens: 48200, cost_usd: 1.12, exit: "ok" }, { role: "builder", model: "claude-sonnet-4-5", attempt: 1, duration_sec: 512, tokens: 61400, cost_usd: 0.71, exit: "ok" }, { role: "builder", model: "claude-sonnet-4-5", attempt: 2, duration_sec: null, tokens: 4100, cost_usd: 0.07, exit: "running" }],
      gates: [{ gate: "static", attempt: 1, commit: "75dcad6", result: "fail", failures: ["no-floating-promises  src/app/invoices/archive.ts:58"] }] },
    { id: "run_01JDQY77", issue: null, title: "Remove unused date-fns locale imports", pipeline: "gardening", outcome: "running", started_at: "2026-11-25T13:29:00Z", cost: 0.41, workflow_run: 11873466702, steps: [{ role: "gardener", model: "claude-sonnet-4-5", attempt: 1, duration_sec: 402, tokens: 22800, cost_usd: 0.33, exit: "ok" }, { role: "verifier", model: "claude-sonnet-4-5", attempt: 1, duration_sec: null, tokens: 5200, cost_usd: 0.08, exit: "running" }], gates: [{ gate: "static", attempt: 1, commit: "be19f02", result: "pass", failures: [] }] },
    { id: "run_01JDB9Y7", issue: 214, title: "Let clients pay an invoice in two instalments", pipeline: "product_work", outcome: "running", started_at: "2026-11-25T13:21:00Z", cost: 0.06, workflow_run: 11873391204, steps: [{ role: "triage", model: "claude-haiku-4-5", attempt: 1, duration_sec: 31, tokens: 5400, cost_usd: 0.02, exit: "ok" }, { role: "brainstorm", model: "claude-haiku-4-5", attempt: 1, duration_sec: null, tokens: 9100, cost_usd: 0.04, exit: "running" }], gates: [] },
    { id: "run_01JDF0Y1", issue: null, title: "Consolidate the three date helpers into one module", pipeline: "gardening", outcome: "draft_pr", pr: 216, started_at: "2026-11-25T07:05:00Z", ended_at: "2026-11-25T07:24:00Z", duration_sec: 1140, cost: 0.74, workflow_run: 11869201117, steps: [{ role: "gardener", model: "claude-sonnet-4-5", attempt: 1, duration_sec: 610, tokens: 40100, cost_usd: 0.52, exit: "ok" }, { role: "verifier", model: "claude-sonnet-4-5", attempt: 1, duration_sec: 388, tokens: 15200, cost_usd: 0.22, exit: "ok" }], gates: [{ gate: "static", attempt: 1, commit: "c41e9a7", result: "pass", failures: [] }, { gate: "verification", attempt: 1, commit: "c41e9a7", result: "pass", failures: [], coverage: 91 }] },
    { id: "run_01JDCD1G", issue: 203, title: "Export invoices to CSV in the client's currency", pipeline: "product_work", outcome: "draft_pr", pr: 219, started_at: "2026-11-25T06:26:00Z", ended_at: "2026-11-25T06:52:00Z", duration_sec: 1560, cost: 3.84, workflow_run: 11868840455, human_interactions: { comments: 0, change_requests: 0, human_commits: 0, total: 0 },
      steps: [{ role: "triage", model: "claude-haiku-4-5", attempt: 1, duration_sec: 41, tokens: 6900, cost_usd: 0.03, exit: "ok" }, { role: "spec", model: "claude-opus-4-5", attempt: 1, duration_sec: 312, tokens: 61200, cost_usd: 1.46, exit: "ok" }, { role: "builder", model: "claude-sonnet-4-5", attempt: 1, duration_sec: 734, tokens: 140300, cost_usd: 1.68, exit: "ok" }, { role: "verifier", model: "claude-sonnet-4-5", attempt: 1, duration_sec: 402, tokens: 41800, cost_usd: 0.62, exit: "ok" }, { role: "scorer", model: "claude-haiku-4-5", attempt: 1, duration_sec: 71, tokens: 12100, cost_usd: 0.05, exit: "ok" }],
      gates: [{ gate: "static", attempt: 1, commit: "4e73cf5", result: "pass", failures: [] }, { gate: "verification", attempt: 1, commit: "4e73cf5", result: "pass", failures: [], coverage: 94 }], artifacts: { stored: 4, expiring: "2027-05-25" } },
    { id: "run_01JD4T7N", issue: null, title: "Delete the unused v1 PDF renderer", pipeline: "gardening", outcome: "merged", pr: 215, started_at: "2026-11-25T07:01:00Z", ended_at: "2026-11-25T07:12:00Z", duration_sec: 640, cost: 0.58, workflow_run: 11869188031, steps: [], gates: [] },
    { id: "run_01JD0BX4", issue: 198, title: "Reminder emails use the client's time zone", pipeline: "product_work", outcome: "merged", pr: 212, started_at: "2026-11-25T03:12:00Z", ended_at: "2026-11-25T03:34:00Z", duration_sec: 1320, cost: 2.71, workflow_run: 11866012570, steps: [], gates: [] },
    { id: "run_01JD7P2L", issue: 209, title: "Lint rule: no floating promises in API handlers", pipeline: "hardening", outcome: "merged", pr: 213, started_at: "2026-11-25T04:40:00Z", ended_at: "2026-11-25T04:55:00Z", duration_sec: 880, cost: 0.94, workflow_run: 11866520113, steps: [], gates: [] },
    { id: "run_01JDEC22", issue: 207, title: "Safari signs people out when the tab has been asleep", pipeline: "product_work", outcome: "escalated", started_at: "2026-11-25T08:31:00Z", ended_at: "2026-11-25T09:18:00Z", duration_sec: 2820, cost: 2.41, workflow_run: 11870110942, escalated: true,
      steps: [{ role: "builder", model: "claude-sonnet-4-5", attempt: 3, duration_sec: 1180, tokens: 152000, cost_usd: 1.79, exit: "ok" }, { role: "verifier", model: "claude-sonnet-4-5", attempt: 3, duration_sec: 1340, tokens: 60100, cost_usd: 0.62, exit: "error" }],
      gates: [{ gate: "static", attempt: 3, commit: "9d02b17", result: "pass", failures: [] }, { gate: "verification", attempt: 3, commit: "9d02b17", result: "fail", failures: ["session-survives-sleep (webkit): signed out after 40 min idle", "session-survives-sleep (chromium): pass", "session-survives-sleep (firefox): pass"] }] },
    { id: "run_01JDE9K4", issue: 207, title: "Safari signs people out when the tab has been asleep", pipeline: "product_work", outcome: "failed", started_at: "2026-11-25T02:02:00Z", ended_at: "2026-11-25T02:48:00Z", duration_sec: 2760, cost: 2.02, workflow_run: 11865480027, steps: [], gates: [{ gate: "verification", attempt: 2, commit: "61ac0e3", result: "fail", failures: ["session-survives-sleep (webkit): signed out after 40 min idle"] }] },
    { id: "run_01JDE7A1", issue: 207, title: "Safari signs people out when the tab has been asleep", pipeline: "product_work", outcome: "draft_pr", pr: 217, started_at: "2026-11-24T16:42:00Z", ended_at: "2026-11-24T17:20:00Z", duration_sec: 2280, cost: 1.69, workflow_run: 11858913460, steps: [], gates: [], human_interactions: { comments: 1, change_requests: 1, human_commits: 0, total: 2 } },
    { id: "run_01JDK1D9", issue: 220, title: "CSV export for the accountant", pipeline: "product_work", outcome: "duplicate", started_at: "2026-11-24T10:12:00Z", ended_at: "2026-11-24T10:13:00Z", duration_sec: 52, cost: 0.02, workflow_run: 11851200314, steps: [], gates: [] },
    { id: "run_01JDH6Z3", issue: 218, title: "Accept crypto payments", pipeline: "product_work", outcome: "rejected", started_at: "2026-11-23T22:01:00Z", ended_at: "2026-11-23T22:02:00Z", duration_sec: 47, cost: 0.02, workflow_run: 11842007711, steps: [], gates: [] },
    { id: "run_01JDA0C9", issue: null, title: "Nightly gardening: nothing worth changing in src/lib", pipeline: "gardening", outcome: "no_action", started_at: "2026-11-24T07:00:00Z", ended_at: "2026-11-24T07:06:00Z", duration_sec: 360, cost: 0.19, workflow_run: 11846650092, steps: [], gates: [] },
    { id: "run_01JD8X3Q", issue: 196, title: "Show overdue invoices first", pipeline: "product_work", outcome: "cancelled", started_at: "2026-11-23T18:10:00Z", ended_at: "2026-11-23T18:14:00Z", duration_sec: 240, cost: 0.31, workflow_run: 11839930518, steps: [], gates: [], note: "Cancelled by maraokafor from the dashboard." },
  ],

  /* Workflows the factory installed; the ones with workflow_dispatch can be run from here. */
  workflows: [
    { file: "factory-run.yml", name: "Run a request", dispatch: true, last: "in_progress", at: "2026-11-25T13:12:00Z" },
    { file: "factory-gates.yml", name: "Gates", dispatch: false, last: "failure", at: "2026-11-25T13:24:00Z", run_id: 11873420311 },
    { file: "factory-intake.yml", name: "Take in a request", dispatch: true, last: "success", at: "2026-11-25T12:10:00Z" },
    { file: "factory-merge.yml", name: "Merge queue", dispatch: true, last: "success", at: "2026-11-25T08:02:00Z" },
    { file: "factory-garden.yml", name: "Nightly gardening", dispatch: true, last: "success", at: "2026-11-25T07:00:00Z" },
    { file: "factory-review.yml", name: "Self-review", dispatch: true, last: "success", at: "2026-11-22T09:00:00Z" },
    { file: "factory-rollup.yml", name: "Rollup for this dashboard", dispatch: true, last: "success", at: "2026-11-25T13:35:00Z" },
    { file: "factory-conflicts.yml", name: "Fix merge conflicts", dispatch: true, last: "success", at: "2026-11-24T20:11:00Z" },
    { file: "factory-audit.yml", name: "Audit merged changes", dispatch: true, last: "success", at: "2026-11-25T08:05:00Z" },
    { file: "factory-budget-settle.yml", name: "Settle the budget", dispatch: false, last: "success", at: "2026-11-25T13:30:00Z" },
    { file: "factory-policy.yml", name: "Policy check", dispatch: false, last: "success", at: "2026-11-25T06:52:00Z" },
    { file: "factory-recompile.yml", name: "Recompile workflows", dispatch: true, last: "success", at: "2026-11-20T15:40:00Z" },
    { file: "factory-sync.yml", name: "Sync with the factory runner", dispatch: true, last: "success", at: "2026-11-21T10:02:00Z" },
    { file: "factory-drop.yml", name: "Drop a request", dispatch: true, last: "success", at: "2026-11-23T18:14:00Z" },
  ],

  /* PR #219's conversation, and checks, as GitHub has them. */
  prComments: [
    { who: "factory", at: "2026-11-25T06:52:00Z", text: "Ready for you. The recording is the first proof block; the rate column is empty for same-currency invoices on purpose." },
  ],
  checkRuns: [
    { name: "static gate", status: "success", detail: "types, lint, 0 new violations" },
    { name: "verification gate", status: "success", detail: "4 proof files, coverage on changed lines 94%" },
    { name: "policy", status: "success", detail: "no protected files touched" },
    { name: "ci / test", status: "success", detail: "212 tests in 41 s" },
  ],
  issueActivity207: [
    { who: "devon-reyes", at: "2026-11-24T16:40:00Z", text: "Repro: sign in on Safari 18, close the laptop for 45 min, open it. You're on the sign-in page." },
    { who: "factory", at: "2026-11-24T17:20:00Z", text: "Opened PR #217. The session cookie now refreshes on visibilitychange." },
    { who: "maraokafor", at: "2026-11-24T18:02:00Z", text: "Still signs me out on my MacBook. Changes requested on #217." },
    { who: "factory", at: "2026-11-25T09:18:00Z", text: "I've stopped after three tries. Chrome and Firefox keep the session; the sandbox's WebKit still drops it at 40 minutes. I can't tell whether that's Safari's cookie policy or the sandbox's WebKit build. What would settle it: a run on a real Safari, or permission to move the session to a refresh token." },
  ],

  candidates: [
    { id: "cand_01JDDJ8F", problem_class: "Money formatted with toFixed instead of Intl.NumberFormat", occurrences: 4, first_seen: "2026-11-04", last_seen: "2026-11-24", proposed_fix: "static_rule", status: "pending", sources: ["PR #211 review", "PR #204 review", "PR #199 commit", "PR #188 review"], contributed_by: "maraokafor", target: "repo", critical_logic: true },
    { id: "cand_01JD8NC2", problem_class: "Dates parsed without a time zone", occurrences: 3, first_seen: "2026-11-02", last_seen: "2026-11-19", proposed_fix: "static_rule", status: "installed", installed_as: "no-naive-date-parse", sources: ["PR #190", "PR #195", "PR #201"], contributed_by: "maraokafor", target: "repo" },
    { id: "cand_01JD2RT7", problem_class: "Prefer named exports in components", occurrences: 2, first_seen: "2026-11-10", last_seen: "2026-11-15", proposed_fix: "static_rule", status: "rejected", sources: ["PR #193", "PR #197"], contributed_by: "devon-reyes", target: "repo" },
  ],
  rules: [
    { id: "no-floating-promises", tool: "eslint", concern: "An unawaited promise fails silently, after the response has gone out.", from: "correction on #211", baselined: 0 },
    { id: "no-naive-date-parse", tool: "eslint", concern: "new Date(string) reads the time zone of whoever runs it, so the same invoice shows different due dates.", from: "candidate, accepted 19 Nov", baselined: 2 },
    { id: "no-explicit-any", tool: "eslint", concern: "any switches off the type checker for everything it touches.", from: "universal pack", baselined: 3 },
    { id: "no-secrets-in-client", tool: "semgrep", concern: "Anything imported into a client component ships to every browser.", from: "universal pack", baselined: 0 },
    { id: "sql-tagged-template-only", tool: "semgrep", concern: "String-built SQL is an injection waiting for an unusual client name.", from: "universal pack", baselined: 0 },
    { id: "money-in-cents", tool: "semgrep", concern: "Floats lose cents; money is stored and summed as integers.", from: "setup, from your history", baselined: 2 },
  ],
  coverage: { high_pct: 86, floor_pct: 78, tolerance_pts: 1, diff_min_pct: 80, skips: { count: 3, cap: 10 } },
  review: {
    id: "review_2026-11-22", window: { from: "2026-11-15", to: "2026-11-22", runs: 19 },
    scores: [{ criterion: "Did what was asked", score: 4.6 }, { criterion: "Tests would catch a regression", score: 3.9 }, { criterion: "Proof shows the change working", score: 4.4 }, { criterion: "Stayed in scope", score: 4.8 }],
    problems: [
      { title: "Stripe SDK minor bumps broke two runs", runs: 2, route: "hardening", work_item: "Pin the Stripe SDK and add a contract test for webhooks" },
      { title: "Verifier screenshots taken before fonts loaded", runs: 3, route: "hardening", work_item: "Wait for document.fonts.ready before capturing", pr: 206 },
    ],
    unrouted: [{ tag: "sandbox", reason: "Safari-only failure; the sandbox's WebKit may not match real Safari.", detail: "Needs a person to decide whether a hosted Safari is worth paying for." }],
  },
  sandbox: {
    tier: "renders", tier_reason: "The app builds, seeds and serves; the verifier drives it in three browsers.",
    commands: { install: "npm ci", build: "npm run build", run: "npm start", test: "npm test", seed: "npm run db:seed" },
    app_url: "http://localhost:3000",
    services: [{ name: "postgres", image: "postgres:16", port: 5432, why: "invoices and clients" }, { name: "mailpit", image: "axllent/mailpit", port: 8025, why: "catches reminder emails" }],
    stubs: [{ name: "stripe", replaces: "api.stripe.com", captured_at: "2026-11-18" }, { name: "rates", replaces: "api.exchangerate.host", captured_at: "2026-11-18" }],
    egress: "closed",
    capabilities: { exercised: ["Sign in", "Invoices list and filters", "Export", "Reminder emails", "PDF receipts"], not_exercised: ["Live Stripe webhooks", "Real email delivery", "Safari (WebKit build only)"] },
  },
  settings: { monthly_budget: 35, share_product_work: 70, share_gardening: 20, share_review: 10, auto_merge_product_work: false, auto_merge_gardening: true, auto_merge_hardening: true, gardening_prs: 1, gardening_hour: 7 },
  writers: [{ login: "maraokafor", role: "admin" }, { login: "devon-reyes", role: "write" }],
  factoryInfo: { runner: "1.0.0", harness: "claude-code", setup_completed_at: "2026-10-28T19:02:00Z", schema_versions: 14,
    models: { triage: "claude-haiku-4-5", chief_of_staff: "claude-haiku-4-5", spec: "claude-opus-4-5", builder: "claude-sonnet-4-5", verifier: "claude-sonnet-4-5", gardener: "claude-sonnet-4-5", hardener: "claude-sonnet-4-5", scorer: "claude-haiku-4-5" } },
  health: { gardening_schedule_active: true, last_review: "2026-11-22T09:00:00Z", lock_files_current: true, sandbox_profile: "docker", enforcement: "branch_protection" },
});
