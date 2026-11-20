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
 * Usage:
 *   node create-app.mjs --repo owner/name [--recompiler] [--port 8787]
 *                       [--org ORG] [--dry-run]
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS = join(HERE, "..", "manifests");

/* ----------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const args = { port: 8787, recompiler: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--org") args.org = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--recompiler") args.recompiler = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `
Create the factory's GitHub App and store its credentials on the repo.

  --repo owner/name   The repository the factory runs on (required)
  --org ORG           Create the App under this organization instead of your
                      personal account
  --recompiler        Create the recompiler App instead of the factory App
  --port N            Local port for GitHub's redirect (default 8787)
  --dry-run           Print what would happen; create nothing
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
 * Build an App name that fits GitHub's 34-character limit.
 *
 * Truncating the finished string is what produced names like
 * `Build Software Factory (bsf-fixtur` — cut mid-word, closing paren gone.
 * The repo suffix is the part that makes the name unique across GitHub, so it
 * is the part to protect: shorten the prefix until the whole suffix fits, and
 * only cut into the repo as a last resort, keeping the paren either way.
 */
export function appName(base, slug) {
  const prefixes = /recompiler/i.test(base)
    ? ["Factory Recompiler", "Recompiler", "Recomp"]
    : ["Build Software Factory", "Software Factory", "Factory"];

  for (const prefix of prefixes) {
    const full = `${prefix} (${slug})`;
    if (full.length <= APP_NAME_MAX) return full;
  }

  // Still too long: keep the shortest prefix, which leaves the most room, and
  // cut the repo rather than the structure.
  const shortest = prefixes[prefixes.length - 1];
  const room = APP_NAME_MAX - shortest.length - " ()".length;
  return `${shortest} (${slug.slice(0, Math.max(1, room))})`;
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
  const substitute = (v) =>
    typeof v === "string" ? v.replace("{{REPO_URL}}", repoUrl).replace("{{REDIRECT_URL}}", redirectUrl) : v;

  for (const [k, v] of Object.entries(manifest)) {
    if (typeof v === "string") manifest[k] = substitute(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) v[k2] = substitute(v2);
    }
  }

  // The name has to be unique across GitHub, so suffix it with the repo.
  const slug = repo.replace("/", "-");
  manifest.name = appName(manifest.name, slug);

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
<form id="f" method="post" action="${action}">
  <input type="hidden" name="manifest" value="${json}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;
}

function donePage({ appName, installUrl }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>App created</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#111}
a.btn{display:inline-block;background:#1f883d;color:#fff;padding:.6rem 1.1rem;border-radius:6px;text-decoration:none}</style>
</head><body>
<h1>${escapeHtml(appName)} is created</h1>
<p>Its credentials are being stored on the repository. One step left: install it.</p>
<p><a class="btn" href="${escapeHtml(installUrl)}">Install the App</a></p>
<p>Pick the repository the factory runs on. You can close this tab afterwards.</p>
</body></html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Something went wrong</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#111}</style>
</head><body><h1>Something went wrong</h1><p>${escapeHtml(message)}</p>
<p>Nothing was stored. Run the script again.</p></body></html>`;
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

  // A dry run creates nothing and stores nothing, so it needs no credentials.
  // Checking them first would stop someone reading what this will do before
  // they sign in.
  if (!args.dryRun) {
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
  storeCredentials({ repo: args.repo, kind, app: result, dryRun: false });

  log("");
  log(`✓ ${result.name} created, and its credentials stored on ${args.repo}.`);
  log("");
  log("  Stored as repository secrets and variables:");
  for (const line of storedNames(kind)) log(`    ${line}`);
  log("");
  log(`  Install it here, picking ${args.repo}:`);
  log(`    ${result.html_url}/installations/new`);
  log("");
  if (!args.recompiler) {
    log("  The App deliberately has no `workflows` permission, so it cannot edit");
    log("  .github/workflows and cannot tamper with the gates that judge its work.");
    log("");
  }
}

function runFlow({ manifest, state, args, kind }) {
  return new Promise((resolve) => {
    let settled = false;

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${args.port}`);

      if (url.pathname === "/" || url.pathname === "/start") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(postPage({ manifest, state, org: args.org }));
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

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(donePage({ appName: app.name, installUrl: `${app.html_url}/installations/new` }));

      settled = true;
      server.close();
      resolve(app);
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
      if (openBrowser(start)) log("  Opening your browser. Press Create GitHub App when it loads.");
      else log(`  Open this in your browser:\n    ${start}`);
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
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly || process.env["BSF_CREATE_APP_RUN"] === "1") {
  main().catch((err) => fail(err?.message ?? String(err)));
}
