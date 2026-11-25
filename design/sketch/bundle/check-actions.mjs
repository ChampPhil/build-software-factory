/*
 * Proves the Briefing sketch can do everything the dashboard has to do, and
 * shows everything it has to show, by driving it in a real browser.
 *
 *   node design/sketch/bundle/check-actions.mjs
 *   PLAYWRIGHT_PATH=/path/to/playwright CHROME=/usr/bin/google-chrome-stable node ...
 *
 * Each action is performed from a fresh page, the way a person would: open the
 * screen, use the control, confirm, and see the dashboard say what it did.
 * Each piece of data is checked by finding it on the screen that shows it.
 * Exits 1 if anything is missing.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".jpg": "image/jpeg" };

const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(root)) throw new Error("outside");
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/a-briefing/index.html?bare&screen=`;

/* What the dashboard must let a person do. `contract` names the action in the handoff, or the GitHub capability it covers. */
const ACTIONS = [
  ["Merge a pull request (squash)", "r-203-pr", async (p) => { await p.click(".mergebar [data-act=merge]"); await p.click("[data-yes]"); }, /Merged PR #219/],
  ["Merge a pull request (merge commit)", "r-203-pr", async (p) => { await p.selectOption("[data-act-change=merge-method]", "merge"); await p.click(".mergebar [data-act=merge]"); await p.click("[data-yes]"); }, /Merged PR #219/],
  ["Merge a pull request (rebase)", "r-203-pr", async (p) => { await p.selectOption("[data-act-change=merge-method]", "rebase"); await p.click(".mergebar [data-act=merge]"); await p.click("[data-yes]"); }, /Merged PR #219/],
  ["Merge from the briefing", "home", async (p) => { await p.click(".item.proof [data-act=merge]"); await p.click("[data-yes]"); }, /Merged PR #219/],
  ["Request changes on a PR", "r-203-pr", async (p) => { await p.click(".mergebar [data-act=request-changes]"); await p.fill(".dialog textarea", "Put the rate column after the amount."); await p.click(".dialog [type=submit]"); }, /Changes requested on PR #219/],
  ["Comment on a PR", "r-203-pr", async (p) => { await p.fill("[data-act-submit=pr-comment] textarea", "Looks right."); await p.click("[data-act-submit=pr-comment] [type=submit]"); }, /Commented on PR #219/],
  ["Comment on one line of a PR's diff", "r-203-pr", async (p) => { await p.click("details.file[open] .ln >> nth=1"); await p.fill(".dialog textarea", "Use the formatter here."); await p.click(".dialog [type=submit]"); }, /Comment added to your review/],
  ["Read a PR's diff file by file", "r-203-pr", async (p) => { const n = await p.locator("details.file").count(); if (n !== 5) throw new Error(`${n} files`); await p.click("details.file >> nth=2 >> summary"); await p.check("details.file >> nth=0 >> [data-act-change=viewed]"); }, null, async (p) => (await p.textContent("h2#diff")).includes("1 viewed")],
  ["Close a PR without merging", "r-203-pr", async (p) => { await p.click("[data-act=close-pr]"); await p.click("[data-yes]"); }, /Closed PR #219/],
  ["Comment on an issue", "r-207-activity", async (p) => { await p.fill("[data-act-submit=issue-comment] textarea", "Move it to a refresh token."); await p.click("[data-act-submit=issue-comment] [type=submit]"); }, /Posted on #207/],
  ["Answer the factory's question (live)", "r-214-talk", async (p) => { await p.fill(".compose textarea", "Its own date."); await p.press(".compose textarea", "Enter"); await p.waitForSelector(".turn.f.latest:not([data-typing]) >> text=Last one", { timeout: 8000 }); }, null, async () => true],
  ["Answer from the briefing", "home", async (p) => { await p.fill(".answer textarea", "Its own date."); await p.click(".answer [type=submit]"); await p.waitForSelector(".turn.p >> text=Its own date.", { timeout: 4000 }); }, null, async () => true],
  ["Answer a cold conversation", "r-214-cold", async (p) => { await p.fill(".compose textarea", "Its own date."); await p.press(".compose textarea", "Enter"); }, null, async (p) => (await p.textContent("[data-status]")).includes("waking up")],
  ["Agree to the playback", "r-214-understood", async (p) => { await p.click("[data-act=agree]"); }, /building now/],
  ["Open an issue for a request that has none", "r-n000a", async (p) => { await p.click(".req-main [data-act=open-issue-for]"); }, /Opened #224/],
  ["File a new request", "requests", async (p) => { await p.click(".top [data-act=new-request]"); await p.check(".dialog input[value=bug]"); await p.fill("#nr-title", "Receipt total rounds the wrong way"); await p.fill("#nr-body", "INV-0418 shows 780.01."); await p.click(".dialog [type=submit]"); }, /Opened #224/],
  ["File a request from the empty factory", "empty", async (p) => { await p.click(".request-form [type=submit]"); }, /Opened #224/],
  ["File a request from search", "home", async (p) => { await p.keyboard.press("/"); await p.fill("[data-pal-q]", "Dark mode for receipts"); await p.keyboard.press("Enter"); await p.click(".dialog [type=submit]"); }, /Opened #224/],
  ["Close an issue", "r-222", async (p) => { await p.click(".callout [data-act=close-issue]"); await p.click("[data-yes]"); }, /Closed #222/],
  ["Reopen an issue", "r-220", async (p) => { await p.click(".callout [data-act=reopen-issue]"); }, /Reopened #220/],
  ["Add a label", "r-221", async (p) => { await p.click(".req-cols > aside.details [data-pop=labels]"); await p.click(".pop >> text=priority:high"); }, /Added priority:high/],
  ["Remove a label", "r-221", async (p) => { await p.click(".req-cols > aside.details [data-act=remove-label]"); }, /Removed factory:feature/],
  ["Let someone without write access start", "r-222", async (p) => { await p.click(".callout [data-act=trust]"); }, /factory:accept/],
  ["Change a request's priority", "r-223", async (p) => { await p.click(".callout [data-act=priority]"); }, /Priority set to high/],
  ["Re-route from the conversation's details drawer", "r-214", async (p) => { await p.click(".tabs-row [data-act=details]"); await p.selectOption(".dialog.drawer [data-act-change=reroute]", "hardening"); }, /Moved to hardening/, async (p) => (await p.textContent(".dialog.drawer")).includes("Chosen by you")],
  ["Re-route a request to another pipeline", "r-223", async (p) => { await p.selectOption(".req-cols > aside.details [data-act-change=reroute]", "gardening"); }, /Moved to gardening/],
  ["Re-run the failed jobs of a run", "runs", async (p) => { await p.click("[data-act=rerun] >> nth=0"); }, /Re-running the failed jobs/],
  ["Re-run the failed jobs of a workflow", "factory-workflows", async (p) => { await p.click("[data-act=rerun-wf]"); }, /Re-running the failed jobs of Gates/],
  ["Cancel a running run", "run-01jd9ee0", async (p) => { await p.click(".req-main [data-act=cancel-run]"); await p.click("[data-yes]"); }, /Run cancelled/],
  ["Accept a guardrail candidate", "guardrails", async (p) => { await p.click(".cand [data-d=accept]"); }, /hardening run will write the rule/],
  ["Reject a guardrail candidate", "home", async (p) => { await p.click("[data-act=candidate][data-d=reject]"); }, /won't be suggested again/],
  ["Add a standing goal", "factory-goals", async (p) => { await p.fill(".goal-form [name=text]", "Harden sign-in this month"); await p.selectOption(".goal-form [name=lane]", "hardening"); await p.click(".goal-form [type=submit]"); }, /Goal added/],
  ["Remove a standing goal", "factory-goals", async (p) => { await p.click("[data-act=goal-remove]"); }, /Goal removed/],
  ["Dispatch a factory workflow", "factory-workflows", async (p) => { await p.click("[data-act=dispatch][data-w='factory-garden.yml']"); }, /Started Nightly gardening/],
  ["Dispatch the self-review", "guardrails", async (p) => { await p.click("[data-act=dispatch][data-w='factory-review.yml']"); }, /Started Self-review/],
  ["Change the factory's settings", "factory-settings", async (p) => { await p.fill("#s-budget", "40"); await p.check("#s-auto_merge_product_work"); await p.click(".settings [type=submit]"); await p.waitForTimeout(3000); }, /Settings saved in PR #225/],
  ["List and switch repositories", "home", async (p) => { await p.click(".top .repo"); const n = await p.locator(".pop [data-act=pick-repo]").count(); if (n !== 3) throw new Error(`${n} repos`); await p.click(".pop >> text=maraokafor/ledgerline-site"); }, null, async (p) => (await p.textContent("h1")).includes("no factory yet")],
  ["Drop a request", "r-1068v", null, null, async () => true],
  ["Search and jump to a request", "home", async (p) => { await p.keyboard.press("/"); await p.fill("[data-pal-q]", "safari"); await p.keyboard.press("Enter"); }, null, async (p) => (await p.textContent("h1")).includes("Safari")],
  ["Sign in with GitHub, then pick a repository", "signin", async (p) => { await p.click(".gh-btn"); await p.click(".pick >> text=maraokafor/ledgerline"); }, null, async (p) => (await p.textContent("h1")).includes("need you")],
  ["Sign out", "home", async (p) => { await p.click(".top .avatar"); await p.click(".pop [data-act=sign-out]"); }, null, async (p) => (await p.textContent("h1")).includes("without opening GitHub")],
  ["Choose light or dark", "home", async (p) => { await p.click(".top .avatar"); await p.click(".theme-pick >> text=Dark"); }, null, async (p) => (await p.getAttribute("html", "data-theme")) === "dark"],
];

/* What the dashboard must show, and where. */
const DATA = [
  ["Every work item status", "requests", async (p) => { await p.click("[data-act=req-filter][data-v=all]"); }, ["Question for you", "Stuck, needs you", "Ready to merge", "Waiting for your OK", "Running", "Merging itself", "Queued", "Merged", "Duplicate", "Turned down"]],
  ["Every run outcome", "runs", null, ["Running", "Opened a PR", "Merged", "Handed to you", "Failed", "Cancelled", "Duplicate", "Turned down", "Nothing to do"]],
  ["A run's steps, tokens, cost, gates and transcript", "run-01jdec22", null, ["Building, try 3", "152,000 tokens", "Verification gate", "session-survives-sleep (webkit)", "Transcript of the last finished step", "The Actions log"]],
  ["Live run: step, attempt, time and cost so far", "run-01jd9ee0", null, ["second try of three", "so far", "spent so far"]],
  ["Proof blocks in order, summary, focus, checks, read more", "r-203-pr", null, ["Adds Export to CSV", "Filters to November", "The exported file opened", "Where the rate comes from", "GET /api/invoices/export", "Where to look", "Rates are read once per invoice date", "static gate", "the full spec", "technical breakdown", "conceptual breakdown"]],
  ["Request details: routing, source, goal, check, labels, related", "r-203", null, ["Chosen by the chief of staff", "What it's for", "How you'll know", "factory:feature", "Related"]],
  ["Escalation with the factory's own explanation and earlier PRs", "r-207", null, ["Stuck after three tries", "real Safari", "PR #217, closed"]],
  ["Duplicate and triage reason", "r-220", null, ["duplicate of", "Same request as #203"]],
  ["Conversation: first question, live, cold, playback, no issue", "r-214-first", null, ["who decides that an invoice is split", "Listening. Replies come back"]],
  ["Conversation gone cold", "r-214-cold", null, ["Gone quiet since yesterday"]],
  ["Conversation details in a drawer", "r-214", async (p) => { await p.click(".tabs-row [data-act=details]"); }, ["Details", "Chosen by the chief of staff", "What it's for", "factory:feature"]],
  ["Conversation playback", "r-214-understood", null, ["Here's what I'll build", "That's right, build it", "Correct something"]],
  ["Conversation with nowhere to answer", "r-n000a", null, ["nowhere to answer it yet", "Open an issue for it"]],
  ["Briefing: needs you, going now, up next, landed, month, goal", "home", null, ["need you", "Going now", "Up next", "Landed overnight", "This month", "Standing goal", "merges itself at"]],
  ["Quiet briefing", "quiet", null, ["Nothing needs you."]],
  ["Empty factory", "empty", null, ["ready for its first request", "Send to the factory"]],
  ["Spend, budget, automation, cycle time, reverts, Actions minutes, by pipeline, daily", "spend", null, ["$27.40", "monthly budget", "83%", "Typical request to PR", "Reverted later", "Actions minutes", "By kind of work", "Most expensive runs"]],
  ["Guardrails: candidates, rules, baselines, coverage, self-review, unrouted", "guardrails", null, ["Rules it could add", "Installed rules", "Old cases allowed", "Coverage", "self-review", "Did what was asked", "Left for you", "2 decided"]],
  ["All nine settings", "factory-settings", null, ["Monthly budget", "How the budget is shared", "Merge product work by itself", "Merge gardening by itself", "Merge hardening by itself", "Cleanup PRs per night", "Cleanup time"]],
  ["Standing goals, workflows, sandbox, people, health, installation", "factory", null, ["Standing goals", "Nightly gardening", "Self-review", "What it checks for real", "What it can't check", "devon-reyes", "Branch protection", "Runner", "Models"]],
  ["Sign-in with the token behind a disclosure", "signin", null, ["Sign in with GitHub", "Use a token instead", "Open a demo factory"]],
];

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const errors = [];
let failed = 0;
const line = (ok, what, why = "") => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${what}${why ? `: ${why}` : ""}`); };

console.log("Actions\n");
for (const [what, route, act, expected, check] of ACTIONS) {
  let toast = expected;
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${what}: ${e.message}`));
  try {
    await p.goto(base + route);
    await p.waitForTimeout(150);
    if (what === "Drop a request") { await p.click(".callout [data-act=drop]"); await p.click("[data-yes]"); toast = /Dropped/; }
    else if (act) await act(p);
    if (toast) { await p.waitForSelector(".toast", { timeout: 6000 }); const t = await p.textContent(".toasts"); if (!toast.test(t)) throw new Error(`toast said "${t.trim()}"`); }
    if (check && !(await check(p))) throw new Error("result not shown");
    line(true, what);
  } catch (e) { line(false, what, e.message.split("\n")[0]); }
  await p.close();
}

console.log("\nData\n");
for (const [what, route, before, texts] of DATA) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${what}: ${e.message}`));
  await p.goto(base + route);
  await p.waitForTimeout(150);
  if (before) await before(p);
  const body = await p.evaluate(() => document.body.innerText);
  const missing = texts.filter((t) => !body.includes(t));
  line(!missing.length, what, missing.length ? `missing ${missing.map((m) => `"${m}"`).join(", ")}` : "");
  await p.close();
}

await browser.close();
server.close();
if (errors.length) { failed += errors.length; console.log("\nPage errors\n" + errors.join("\n")); }
console.log(`\n${ACTIONS.length + DATA.length - failed} of ${ACTIONS.length + DATA.length} passed`);
process.exit(failed ? 1 : 0);
