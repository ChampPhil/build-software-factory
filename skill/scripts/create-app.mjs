#!/usr/bin/env node
/**
 * Creates the factory's GitHub App and stores its credentials on the repo.
 *
 * Phase 6 of setup. Runs on the user's own machine, with their own `gh`
 * credentials, because creating an App is something only a person can
 * authorize and the private key must never pass through anywhere else.
 *
 * The flow is GitHub's App Manifest flow:
 *   1. POST a manifest to github.com. GitHub shows a page with the name
 *      filled in and a Create button.
 *   2. GitHub redirects back with a temporary code.
 *   3. Exchange that code for the app id, client id and private key.
 *   4. Store them on the repo, and send the user to install the App.
 *
 * Step 2 needs something listening, so this starts a local server and opens
 * the browser at it. All three steps must finish within an hour.
 *
 * The App's name is chosen before that page opens. It is "Factory" plus a
 * short label for the repository only. Hyphens and underscores become
 * initials (vibecoding-for-marketing becomes VFM). A single word keeps its
 * first five letters. The GitHub owner is not mixed into the label, and the
 * name is not sliced through the middle of a word.
 *
 * Usage:
 *   node create-app.mjs --repo owner/name [--recompiler] [--port 8787]
 *                       [--org ORG] [--dry-run]
 */

import { createServer } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, createSign } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS = join(HERE, "..", "manifests");

/* ----------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const args = { port: 8787, recompiler: false, dryRun: false, preview: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--org") args.org = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--recompiler") args.recompiler = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--preview") args.preview = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `
Create the factory's GitHub App and store its credentials on the repo.

  --repo owner/name   The repository the factory runs on (required)
  --org ORG           The organization that owns the App. It must be the owner
                      of --repo: an App can only be installed on repositories
                      its owner owns. Derived from --repo when that owner is an
                      organization, so you rarely need to pass it
  --recompiler        Create the recompiler App instead of the factory App
  --port N            Local port for GitHub's redirect (default 8787)
  --dry-run           Print what would happen; create nothing
  --preview           Run the whole flow — the local server, the page GitHub
                      posts to, the state check — but stop before exchanging
                      a code. Creates nothing, stores nothing, and needs no
                      gh login, so you can read what it will do first
`;

/* --------------------------------------------------------------------- utils */

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

function gh(args, { input, allowFail = false } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr || err.message || "").toString().trim();
    fail(`\`gh ${args.join(" ")}\` failed:\n${detail}`);
  }
}

function openBrowser(url) {
  // On Windows `start` is a cmd builtin, not an executable, so spawning it
  // directly fails — and fails *asynchronously*, which would leave the script
  // saying "opening your browser" while nothing opened. The empty string is
  // the window title `start` expects before the URL; without it, a URL
  // containing `&` is read as the title and nothing loads.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    // spawn reports a missing binary on the error event, not by throwing, so
    // without this a headless machine looks like a successful launch.
    let failed = false;
    child.on("error", () => {
      failed = true;
      log(`  Could not open a browser. Open this yourself:\n    ${url}`);
    });
    child.unref();
    return !failed;
  } catch {
    return false;
  }
}


/** GitHub's hard limit on a GitHub App's name. */
export const APP_NAME_MAX = 34;

/**
 * GitHub accepts letters, numbers, spaces, hyphens and the parentheses we add;
 * an underscore is rejected outright. A repository name may hold anything, so
 * the slug is cleaned before it goes anywhere near the name — otherwise the
 * default name is refused on the Create page with nothing explaining why, and
 * the user is left editing a field they were not told they could edit.
 *
 * The installed name does not use this slug as its label. `repoShortLabel`
 * shortens the repository on purpose. This helper remains for a caller that
 * still needs a GitHub-safe slug.
 *
 * @param {string} slug raw repository text that may hold underscores or other marks
 * @returns {string} a slug of letters, numbers, spaces, and single hyphens
 */
export function slugForAppName(slug) {
  return slug
    .replace(/[^A-Za-z0-9 -]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Short label for a repository, used inside the GitHub App's name.
 *
 * The owner is not included. Hyphens and underscores are the separators.
 * Two or more words become their initials, in capitals, so
 * vibecoding-for-marketing and vibecoding_for_marketing both become VFM.
 * One word keeps its first five letters, and a shorter word keeps all of
 * them. Initials are one letter each, so a long name is never cut through
 * the middle of a word.
 *
 * @param {string} repoName repository name, or owner/name. Only the name is used.
 * @returns {string} the short label. Empty input becomes "repo".
 */
export function repoShortLabel(repoName) {
  const raw = String(repoName ?? "");
  // owner/name would put the account in the label. Keep the repository only.
  const nameOnly = raw.includes("/") ? (raw.split("/").filter(Boolean).pop() ?? "") : raw;
  const parts = nameOnly
    .split(/[-_]+/)
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "repo";
  if (parts.length === 1) return parts[0].slice(0, 5);
  return parts.map((part) => part[0].toUpperCase()).join("");
}

/**
 * The GitHub App's name: Factory, plus the repository's short label.
 *
 * The label is computed before the name is sent to GitHub, so the Create
 * page never shows a name sliced through a word. The owner is not mixed in.
 * A recompiler App uses Recomp so the two Apps can both exist. If the
 * initials are so long that the name would pass 34 characters, whole
 * initials are dropped from the end. A word is never cut in half to fit.
 *
 * @param {string} base the manifest's name. A recompiler base is detected from this string.
 * @param {string} rawSlug repository name, or owner/name. The owner is ignored.
 * @returns {string} a name GitHub will accept, at most APP_NAME_MAX characters
 */
export function appName(base, rawSlug) {
  const prefix = /recompiler/i.test(base) ? "Recomp" : "Factory";
  let label = repoShortLabel(rawSlug);
  // "Factory (" + label + ")" . Drop whole initials, never a slice through a word.
  while (prefix.length + 3 + label.length > APP_NAME_MAX && label.length > 1) {
    label = label.slice(0, -1);
  }
  return `${prefix} (${label})`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ manifest */

function buildManifest({ recompiler, repo, redirectUrl }) {
  const file = recompiler ? "recompiler-app.json" : "factory-app.json";
  const raw = readFileSync(join(MANIFESTS, file), "utf8");
  const manifest = JSON.parse(raw);
  delete manifest._comment;

  const repoUrl = `https://github.com/${repo}`;
  // GitHub sends the user to `setup_url` after they install the App, which is
  // what lets this script notice the install and carry on by itself. Without
  // it the user is left sitting on GitHub's "all set" page with no idea that
  // anything is waiting on them.
  const setupUrl = redirectUrl.replace(/\/callback$/, "/installed");
  const substitute = (v) =>
    typeof v === "string"
      ? v.replace("{{REPO_URL}}", repoUrl).replace("{{REDIRECT_URL}}", redirectUrl).replace("{{SETUP_URL}}", setupUrl)
      : v;

  for (const [k, v] of Object.entries(manifest)) {
    if (typeof v === "string") manifest[k] = substitute(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) v[k2] = substitute(v2);
    }
  }

  // Shorten the repository on purpose, before GitHub shows the Create page.
  // The owner is left out. Initials stand in for a hyphenated name so the
  // label is never sliced through the middle of a word.
  const repoName = repo.includes("/") ? repo.split("/")[1] : repo;
  manifest.name = appName(manifest.name, repoName);

  if (!recompiler && "workflows" in (manifest.default_permissions ?? {})) {
    fail(
      "the factory App manifest requests `workflows`, which it must never hold — " +
        "that permission is what would let it rewrite its own gates",
    );
  }
  return manifest;
}

/* ------------------------------------------------------------- the two pages */

function postPage({ manifest, state, org }) {
  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const json = escapeHtml(JSON.stringify(manifest));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Create the factory's GitHub App</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#111}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:3px}button{font:inherit;padding:.6rem 1rem;cursor:pointer}</style>
</head><body>
<h1>Creating the factory's GitHub App</h1>
<p>Sending you to GitHub. You will see a page with the name already filled in — press
<strong>Create GitHub App</strong>, and you will land back here.</p>
<p>The name is already short: <strong>Factory</strong>, then a short label for this repository.
The account name is not part of it. A name with hyphens or underscores uses initials.</p>
<p><strong>The name is yours to change.</strong> It only has to be unique across GitHub.
If you edit it, GitHub allows letters, numbers, spaces and hyphens, up to
<strong>34 characters</strong> — no underscores. Those two rules are the only reason a
name is ever refused on that page.</p>
<form id="f" method="post" action="${action}">
  <input type="hidden" name="manifest" value="${json}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;
}

/**
 * One page, one look. These are the dashboard's own tokens, so the last thing
 * the person sees in the browser belongs to the same product as the dashboard
 * they are about to open.
 */
const PAGE_CSS = `:root{--paper:#f4f5f2;--sheet:#ffffff;--ink:#16181b;--rule:#dcdfd9;--done:#1d6b4c;--done-wash:#e3f2ea;--stop:#b3261e;--stop-wash:#fbeceb}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{background:var(--sheet);border:1px solid var(--rule);border-radius:10px;padding:2rem 2.25rem;max-width:30rem;margin:1.5rem}
.chip{display:inline-block;font-size:.8rem;font-weight:600;padding:.15rem .6rem;border-radius:999px}
.ok .chip{background:var(--done-wash);color:var(--done)}.bad .chip{background:var(--stop-wash);color:var(--stop)}
h1{font-size:1.4rem;margin:.9rem 0 .4rem}p{margin:.4rem 0;color:#3d4147}`;

function statusPage({ ok, heading, body, closeAfterMs }) {
  const script = closeAfterMs ? `<script>setTimeout(function(){window.close()},${closeAfterMs})</script>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title><style>${PAGE_CSS}</style></head>
<body><main class="${ok ? "ok" : "bad"}"><span class="chip">${ok ? "Connected" : "Stopped"}</span>
<h1>${escapeHtml(heading)}</h1>${body}</main>${script}</body></html>`;
}

function installedPage() {
  return statusPage({
    ok: true,
    heading: "Your factory is connected",
    body: "<p>You can close this tab. Setup continues in your terminal.</p>",
    closeAfterMs: 2000,
  });
}

function errorPage(message) {
  return statusPage({
    ok: false,
    heading: "Something went wrong",
    body: `<p>${escapeHtml(message)}</p><p>Nothing was stored. Run the script again.</p>`,
  });
}

/* ------------------------------------------------- installing, and checking it */

/**
 * The install page, already pointed at the one repository. Without the
 * repository id GitHub opens its generic picker, where "All repositories" is
 * one click away and the person has to find the right repo by hand.
 */
export function installUrlFor({ htmlUrl, ownerId, repoId }) {
  const q = ownerId && repoId ? `/permissions?target_id=${ownerId}&repository_ids[]=${repoId}` : "";
  return `${htmlUrl}/installations/new${q}`;
}

/** A GitHub App JWT: RS256, ten minutes at most, issued by the client id. */
export function appJwt({ pem, clientId, now = Math.floor(Date.now() / 1000) }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ iat: now - 60, exp: now + 540, iss: clientId });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/**
 * Confirm the installation is on exactly the repository, using the App's own
 * credentials. Returns {ok:true} or {ok:false, message} with the exact fix.
 */
export async function confirmInstallation({ installationId, repo, jwt, fetchImpl = fetch }) {
  const h = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "bsf-create-app" };
  const inst = await fetchImpl(`https://api.github.com/app/installations/${installationId}`, { headers: h });
  if (!inst.ok) return { ok: false, message: `GitHub did not recognise installation ${installationId} (${inst.status}).` };
  const fix = `https://github.com/settings/installations/${installationId}`;
  const info = await inst.json();
  if (info.repository_selection === "all") {
    return { ok: false, message: `The App was installed on all of your repositories. Open ${fix}, choose "Only select repositories", and pick ${repo}.` };
  }
  const tok = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, { method: "POST", headers: h });
  if (!tok.ok) return { ok: false, message: `Could not check which repositories the install covers (${tok.status}). Open ${fix}.` };
  const { token } = await tok.json();
  const list = await fetchImpl("https://api.github.com/installation/repositories", { headers: { ...h, authorization: `Bearer ${token}` } });
  if (!list.ok) return { ok: false, message: `Could not list the install's repositories (${list.status}). Open ${fix}.` };
  const names = ((await list.json()).repositories ?? []).map((r) => r.full_name.toLowerCase());
  if (!names.includes(repo.toLowerCase())) {
    return { ok: false, message: `The App is installed, but not on ${repo}. Open ${fix} and add ${repo} under "Repository access".` };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return log(USAGE);
  if (!args.repo || !/^[^/]+\/[^/]+$/.test(args.repo)) fail("--repo owner/name is required");

  const redirectUrl = `http://localhost:${args.port}/callback`;
  const manifest = buildManifest({ recompiler: args.recompiler, repo: args.repo, redirectUrl });
  const state = randomBytes(16).toString("hex");
  const kind = args.recompiler ? "recompiler" : "factory";

  // A GitHub App can only be installed on repositories owned by the account
  // that owns the App. Creating one under the wrong owner produces an App that
  // looks correct and can never be installed where it is needed — the install
  // page simply does not offer the repository, with nothing saying why.
  //
  // The --org mismatch is pure string comparison, so it runs even in a preview
  // or a dry run: a preview that does not catch an impossible configuration is
  // a preview that lies about what would happen.
  const repoOwner = args.repo.split("/")[0];
  if (args.org && args.org !== repoOwner) {
    fail(
      `--org ${args.org} does not own ${args.repo}. An App owned by ${args.org} can never be ` +
        `installed on it. Drop --org, or pass --org ${repoOwner}.`,
    );
  }

  // A dry run and a preview both create nothing and store nothing, so neither
  // needs credentials. Checking them first would stop someone reading what
  // this will do before they sign in.
  if (!args.dryRun && !args.preview) {
    // `gh` is how the credentials reach the repo, so check it before sending
    // the user to GitHub — failing afterwards would waste a created App.
    // `gh api user` rather than `gh auth status`, because what matters is
    // whether API calls work, and in some setups a token is supplied by the
    // environment and `auth status` reports nothing.
    if (!gh(["api", "user", "--jq", ".login"], { allowFail: true })) {
      fail("GitHub CLI cannot reach the API. Run `gh auth login` first.");
    }
    // REST rather than `gh repo view`, which goes through GraphQL — some
    // networks and tokens allow one and not the other.
    if (!gh(["api", `repos/${args.repo}`, "--jq", ".full_name"], { allowFail: true })) {
      fail(`cannot see ${args.repo}. Check the name, and that your gh login can read it.`);
    }

    // Which of the two the owner is decides where the App must be created.
    // Derived rather than demanded: naming the repo already settles it.
    const ownerType = gh(["api", `users/${repoOwner}`, "--jq", ".type"], { allowFail: true });
    if (!args.org && ownerType === "Organization") {
      args.org = repoOwner;
      log(`${repoOwner} is an organization, so the App will be created there — it has to be.`);
    }
    if (args.org && ownerType === "User") {
      fail(`${repoOwner} is a user account, not an organization. Drop --org.`);
    }

  }

  if (args.dryRun) {
    log(`\nWould create the ${kind} App:\n`);
    log(JSON.stringify(manifest, null, 2));
    log(`\nPermissions: ${Object.entries(manifest.default_permissions).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    log(`Redirect:    ${redirectUrl}`);
    log(`Owner:       ${args.org ?? "your personal account"}`);
    log(`Secrets:     would be written to ${args.repo}\n`);
    return;
  }

  const result = await runFlow({ manifest, state, args, kind });
  if (result === null) {
    // A preview. The server ran and the callback was checked, but no code was
    // exchanged, so there is nothing to store.
    log("");
    log("Preview over. Nothing was created and nothing was stored.");
    log(`Run the same command without --preview to create the ${kind} App.`);
    return;
  }
  const app = result.app;
  storeCredentials({ repo: args.repo, kind, app, dryRun: false });

  log("");
  log(`✓ ${app.name} created, and its credentials stored on ${args.repo}.`);
  log("");
  log("  Stored as repository secrets and variables:");
  for (const line of storedNames(kind)) log(`    ${line}`);
  log("");
  if (!args.recompiler) {
    log("  The App deliberately has no `workflows` permission, so it cannot edit");
    log("  .github/workflows and cannot tamper with the gates that judge its work.");
    log("");
  }

  // The App exists; it is not installed on the repository yet. The install
  // page is already "Only select repositories" with this repository selected.
  // The person clicks Install. This process does not drive their browser.
  log(`  One step left: install it on ${args.repo} only.`);
  log(`  Open this link and press Install. Nothing here will click it for you:`);
  log(`    ${result.installUrl}`);
  openBrowser(result.installUrl);
  log("");
  log("  Waiting for the install… (this continues by itself)");

  const installationId = await waitForInstall({ installedAt: result.installedAt });
  result.close();

  if (installationId === null) {
    fail(
      `the App was created and its credentials stored, but it is not installed on ${args.repo} yet. ` +
        `Install it at ${result.installUrl}, then run this command again — it will see the existing App.`,
    );
  }
  const check = await confirmInstallation({
    installationId,
    repo: args.repo,
    jwt: appJwt({ pem: result.app.pem, clientId: result.app.client_id }),
  });
  if (!check.ok) fail(check.message);
  log("");
  log(`✓ installed on ${args.repo}, and only on ${args.repo}. Nothing else here needs you.`);
}

/**
 * Wait for the installation id. GitHub's setup_url redirect carries it, so
 * there is nothing to poll: the local /installed page resolves this promise.
 * Resolves null if nothing arrives in the time allowed.
 */
async function waitForInstall({ installedAt, forMs = 15 * 60 * 1000 }) {
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(null), forMs);
  });
  const id = await Promise.race([installedAt, timeout]);
  clearTimeout(timer);
  return id ?? null;
}

function runFlow({ manifest, state, args, kind }) {
  return new Promise((resolve) => {
    let settled = false;

    // Resolved when GitHub redirects to setup_url, or when polling sees the
    // installation — whichever happens first. The poll is the fallback for a
    // user who finishes the install in a different browser or profile, where
    // the redirect never reaches this server.
    let installed = () => {};
    const installedAt = new Promise((r) => {
      installed = r;
    });

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${args.port}`);

      if (url.pathname === "/" || url.pathname === "/start") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(postPage({ manifest, state, org: args.org }));
        return;
      }

      if (url.pathname === "/installed") {
        // GitHub's setup_url redirect, after the user pressed Install.
        const id = url.searchParams.get("installation_id");
        if (!id || !/^\d+$/.test(id)) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(errorPage("GitHub did not say which installation this was."));
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(installedPage());
        installed(id);
        return;
      }

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");

      if (gotState !== state) {
        // Not our request. Store nothing.
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage("The redirect did not carry the expected state value."));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage("GitHub redirected back without a code."));
        return;
      }

      if (args.preview) {
        // The one thing a preview must not do. The code is single-use, so
        // exchanging it here would spend it and create a real App.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage("Preview: the redirect arrived with a valid state and a code, which was not exchanged. Nothing was created and nothing was stored."));
        settled = true;
        server.close();
        resolve(null);
        return;
      }

      // Exchange the code. This is the only chance: the code is single-use and
      // the private key is returned exactly once.
      const raw = gh(
        ["api", "-X", "POST", `/app-manifests/${code}/conversions`],
        { allowFail: true },
      );
      if (!raw) {
        res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage("Exchanging the code with GitHub failed. Nothing was stored."));
        return;
      }

      let app;
      try {
        app = JSON.parse(raw);
      } catch {
        res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage("GitHub's response could not be read. Nothing was stored."));
        return;
      }

      const ids = JSON.parse(gh(["api", `repos/${args.repo}`, "--jq", "{repo: .id, owner: .owner.id}"], { allowFail: true }) || "{}");
      const installUrl = installUrlFor({ htmlUrl: app.html_url, ownerId: ids.owner, repoId: ids.repo });
      res.writeHead(302, { location: installUrl });
      res.end();

      settled = true;
      // The server stays up: the App exists, but it is not installed on the
      // repository yet, and the install is the step the user was previously
      // left stranded on. It closes in `main`, once the install is confirmed.
      resolve({ app, installUrl, installedAt, close: () => server.close() });
    });

    server.listen(args.port, "127.0.0.1", () => {
      const start = `http://localhost:${args.port}/start`;
      log("");
      log(`Creating the ${kind} App for ${args.repo}.`);
      log("");
      log("  Permissions it will ask for:");
      for (const [k, v] of Object.entries(manifest.default_permissions)) log(`    ${k}: ${v}`);
      if (!args.recompiler) log("    workflows: not requested — so it can never edit your gates");
      log("");
      // Print the link either way. Opening a tab is optional. Nothing in this
      // script clicks, types, or drives the page. The person does that.
      log(`  Open this link and press Create GitHub App. Nothing here will click it for you:\n    ${start}`);
      openBrowser(start);
      log("");
      log("  Waiting… (GitHub's manifest flow expires after an hour)");
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        fail(`port ${args.port} is already in use. Pass a different --port.`);
      }
      fail(`could not start the local server: ${err.message}`);
    });

    // GitHub's flow expires after an hour; don't sit open past that.
    const timer = setTimeout(() => {
      if (!settled) {
        server.close();
        fail("timed out after an hour without a response from GitHub. Nothing was stored.");
      }
    }, 60 * 60 * 1000);
    timer.unref();
  });
}

function storedNames(kind) {
  return kind === "recompiler"
    ? ["variable  RECOMPILER_APP_CLIENT_ID", "secret    RECOMPILER_APP_PRIVATE_KEY"]
    : [
        "variable  FACTORY_APP_CLIENT_ID",
        "variable  FACTORY_APP_ID",
        "secret    FACTORY_APP_PRIVATE_KEY",
      ];
}

function storeCredentials({ repo, kind, app }) {
  const prefix = kind === "recompiler" ? "RECOMPILER_APP" : "FACTORY_APP";

  // The private key goes in on stdin, never as an argument, so it cannot show
  // up in a process list or a shell history.
  gh(["secret", "set", `${prefix}_PRIVATE_KEY`, "--repo", repo], { input: app.pem });

  gh(["variable", "set", `${prefix}_CLIENT_ID`, "--repo", repo, "--body", String(app.client_id)]);
  if (kind !== "recompiler") {
    gh(["variable", "set", `${prefix}_ID`, "--repo", repo, "--body", String(app.id)]);
  }
}

// Only run when executed directly, so the pure helpers above can be imported
// and tested without the script trying to create an App.
//
// This has to hold when the skill folder is reached through a symlink, which is
// how every agent's skills directory is set up: Node resolves `import.meta.url`
// to the real path while `process.argv[1]` keeps the link's path, so comparing
// the two strings says "not direct" and the script exits 0 having done nothing.
// A hand-built `file://` string got Windows backslashes wrong on top of that.
// So: compare real paths through `pathToFileURL`, and fall back to the file's
// own name, which is the thing that actually identifies this entry point.
export function runningAsEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (argv1 === undefined) return false;
  // Split on both separators rather than using `path.basename`, which only
  // treats a backslash as one when it is itself running on Windows — and this
  // check has to give the same answer wherever it is read from.
  const lastSegment = (p) => p.split(/[\\/]/).pop() ?? p;
  if (lastSegment(argv1) === lastSegment(fileURLToPath(moduleUrl))) return true;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  try {
    return pathToFileURL(real(fileURLToPath(moduleUrl))).href === pathToFileURL(real(argv1)).href;
  } catch {
    return false;
  }
}

if (runningAsEntryPoint(import.meta.url)) {
  // Printed before anything can fail, because the bug this replaces made
  // silence look like success: the script exited 0, created no App, stored no
  // secrets, and said nothing at all.
  log("create-app: starting…");
  main().catch((err) => fail(err?.message ?? String(err)));
}
