/**
 * Checks the boot enforces before it believes the recipe.
 *
 * Purpose:
 *     The writer is told the rules. This file is what makes them true. It
 *     reads the recipe, the repo, and the names in the secret. It does not
 *     start the app, and it never prints a secret value.
 *
 * Key terms:
 *     - Machine-only value: a credential that only the person's computer can
 *       reach, such as localhost or a file on their disk. The boot replaces
 *       it with something this boot started.
 *     - Thinner test: a command that runs part of the suite, such as one
 *       file or a name filter. The boot runs the script the repo already
 *       declares.
 *     - Marker: a word the seed writes into the empty store. A journey has
 *       to show it. An app with no store skips this check.
 *     - Client name: a setting the browser bundle reads. It has to be present
 *       when the app is built, not only when the server starts.
 *     - Vendor login widget: a page still waiting on Clerk, Google, or
 *       another site's sign-in box. The boot fails that page and does not
 *       type into it.
 *
 * Exports:
 *     - staticRecipeProblems: reasons the recipe is not ready that need no
 *       secret blob. The writer's `bsf setup submit` runs these so a missing
 *       NEXT_PUBLIC name or a thinner test is refused before the boot.
 *     - bootProblems: every reason this recipe is not ready, including the
 *       ones that need the secret blob.
 *     - signedInJourneyProblem: the journey list is missing a sign-in.
 *     - vendorLoginWaiting: the page is still a vendor's login.
 *     - namesFromBootLog: a name the running app asked for and did not get,
 *       or a development key the vendor rejected.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SandboxManifest } from "./sandbox.js";
import { isClientName, scanConfigNames } from "./env-names.js";
import { finishLineJourneys } from "./env-state.js";
import { pastedSecrets } from "../lib/placeholders.js";

/**
 * The test scripts the repository already declares.
 *
 * root: the repository checkout. A nested package.json counts, and so does
 * a Python, Go, or Rust manifest beside it. A repo with a frontend test
 * script and pytest declares both.
 * Returns one command per declared suite. An empty list means the repo
 * declares no tests.
 */
export function repoTestCommands(root: string): readonly string[] {
  const commands: string[] = [];
  const pkg = readTestScript(join(root, "package.json"));
  if (pkg !== null) commands.push(pkg);
  const nested = findNestedPackageTest(root, 0);
  if (nested !== null && !commands.includes(nested)) commands.push(nested);
  if (existsSync(join(root, "go.mod"))) commands.push("go test ./...");
  if (existsSync(join(root, "Cargo.toml"))) commands.push("cargo test");
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini")) || existsSync(join(root, "setup.cfg"))) commands.push("pytest");
  const composer = readTestScript(join(root, "composer.json"));
  if (composer !== null && !commands.includes(composer)) commands.push(composer);
  return commands;
}

/**
 * The test script in one package file.
 *
 * path: package.json or composer.json.
 * Returns the script, or null when there is none.
 */
function readTestScript(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { scripts?: { test?: unknown } };
    if (typeof doc.scripts?.test === "string" && doc.scripts.test.trim() !== "") return doc.scripts.test.trim();
  } catch { /* not JSON */ }
  return null;
}

/**
 * A package.json below the root, for a repo whose app is in a subfolder.
 *
 * dir: where to look.
 * depth: how many directories down. The search stops at 3.
 * Returns the first test script, or null.
 */
function findNestedPackageTest(dir: string, depth: number): string | null {
  if (depth > 3) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist" || name === "build") continue;
    const path = join(dir, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const script = readTestScript(join(path, "package.json"));
    if (script !== null) return script;
    const nested = findNestedPackageTest(path, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Whether the recipe runs a thinner slice than the repo's own test scripts.
 *
 * declared: the scripts the repo already has. An empty list means the repo
 * declares none, and the check does not apply.
 * actual: the recipe's commands.test.
 * Returns a sentence when the recipe skips a declared suite or narrows one
 * with a file or a filter. Null when it runs each declared script whole.
 */
export function thinnerTest(declared: readonly string[], actual: string | null): string | null {
  if (declared.length === 0) return null;
  if (actual === null || actual.trim() === "") return "the repo has a test script and the recipe does not run it";
  const cmd = actual.trim();
  for (const one of declared) {
    if (!cmd.includes(one) && !coversPackageTest(cmd, one)) {
      return "the recipe runs a thinner slice than the repo's own test script";
    }
  }
  if (/ -- |(?:^|\s)(?:-k|-m|--filter)\s/.test(cmd)) return "the recipe runs a thinner slice than the repo's own test script";
  for (const tok of cmd.split(/\s+/)) {
    if (/\.(py|ts|tsx|js|jsx|go|rb)$/.test(tok) || /\/(tests?|__tests__)\//.test(tok)) {
      return "the recipe runs a thinner slice than the repo's own test script";
    }
  }
  return null;
}

/**
 * Whether a package-manager test command runs the declared script.
 *
 * cmd: the recipe's test command.
 * declared: the script from package.json, such as "vitest run".
 * Returns true when the recipe is `npm test` (or pnpm, yarn, bun) and does
 * not add a filter. The package manager then runs the declared script.
 */
function coversPackageTest(cmd: string, declared: string): boolean {
  if (!/^(npm|pnpm|yarn|bun) (run )?test( |$)/.test(cmd)) return false;
  if (cmd.includes(" -- ")) return false;
  return declared !== "pytest" && declared !== "go test ./..." && declared !== "cargo test";
}

/**
 * Whether a secret value can only be reached from the person's computer.
 *
 * value: one value from FACTORY_SANDBOX_ENV. The value is not logged.
 * Returns true for localhost, loopback, and a file on their disk.
 */
export function isMachineOnly(value: string): boolean {
  const v = value.toLowerCase();
  if (v.includes("localhost") || v.includes("127.0.0.1") || v.includes("0.0.0.0") || v.includes("host.docker.internal")) return true;
  if (v.startsWith("file://") || v.startsWith("/users/") || v.startsWith("/home/") || v.startsWith("/tmp/")) return true;
  if (/^[a-z]:[\\/]/i.test(v)) return true;
  return false;
}

/**
 * Names whose machine-only value was copied into the app unchanged.
 *
 * secret: the parsed FACTORY_SANDBOX_ENV. Values are not included in the result.
 * env: the environment the recipe gives the app.
 * Returns the names. An empty list means every machine-only value was replaced.
 */
export function localValuesLeft(secret: Readonly<Record<string, string>>, env: Readonly<Record<string, string>>): readonly string[] {
  const left: string[] = [];
  for (const [name, value] of Object.entries(secret)) {
    if (!isMachineOnly(value)) continue;
    if (env[name] === value) left.push(name);
  }
  return left.sort();
}

/**
 * Configuration files that still contain a machine-only secret value.
 *
 * root: the checkout. node_modules and .git are not read.
 * secret: the parsed blob. The result names the key, never the value.
 * Returns the names whose value still appears in a config file.
 */
export function localValuesInConfig(root: string, secret: Readonly<Record<string, string>>): readonly string[] {
  const wanted = Object.entries(secret).filter(([, value]) => isMachineOnly(value) && value.length >= 8);
  if (wanted.length === 0) return [];
  const hit = new Set<string>();
  const consider = (text: string): void => {
    for (const [name, value] of wanted) {
      if (text.includes(value)) hit.add(name);
    }
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name === ".next" || name === "dist" || name.startsWith(".")) continue;
      const path = join(dir, name);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (info.size > 500_000) continue;
      if (!/(\.env|compose\.ya?ml|next\.config\.|appsettings.*\.json|settings\.py)$/i.test(name) && name !== "docker-compose.yml") continue;
      if (/\.example$|\.sample$|\.template$/i.test(name)) continue;
      try {
        consider(readFileSync(path, "utf8"));
      } catch { /* unreadable */ }
    }
  };
  walk(root, 0);
  return [...hit].sort();
}

/**
 * The store check. An app with no store skips it.
 *
 * manifest: the recipe.
 * Returns a sentence when a store was started without a seeded marker a
 * journey shows. Null when there is no store, or the marker is declared.
 */
export function storeMarkerProblem(manifest: SandboxManifest): string | null {
  const store = manifest.services.some((s) => /postgres|mysql|mariadb|mongo/i.test(s.image))
    || manifest.env.some((e) => typeof e.value === "string" && /postgres:\/\/|mysql:\/\/|mongodb:\/\//i.test(e.value));
  if (!store) return null;
  if (manifest.commands.seed == null || manifest.commands.seed.trim() === "") return "this boot starts a store but does not seed it";
  const shown = (manifest.dependencies ?? []).some((d) => (d.probe?.expect_text ?? "").trim() !== "");
  if (!shown) return "the seed must write a marker and a journey must show that marker";
  return null;
}

/**
 * Browser-bundle names that are not in the recipe, and a build that would miss them.
 *
 * manifest: the recipe.
 * root: the checkout, scanned for names the client reads.
 * Returns one sentence when a public name is missing or the recipe has no
 * build. Null when there is no such name, or each one is in the recipe and
 * a build command will see it.
 */
export function clientBuildProblem(manifest: SandboxManifest, root: string): string | null {
  const scan = scanConfigNames(root);
  const client = [...scan.names.keys()].filter((name) => isClientName(name)).sort();
  if (client.length === 0) return null;
  const present = new Set(manifest.env.map((e) => e.name));
  const missing = client.filter((name) => !present.has(name));
  if (missing.length > 0) return `the browser bundle reads ${missing.join(", ")} and the recipe does not set them at build`;
  if (manifest.commands.build == null || manifest.commands.build.trim() === "") {
    return `the browser bundle reads ${client.join(", ")} and the recipe has no build command`;
  }
  return null;
}

/**
 * A stand-in is only allowed for a key the person marked to fake.
 *
 * manifest: the recipe.
 * fake: the names marked to fake, or null when nobody has saved a decision
 * yet and the check should not run.
 * Returns a sentence when the recipe stubs a host and nothing was marked to
 * fake. Null when there is no stub, or at least one name is marked to fake.
 */
export function stubWithoutFake(manifest: SandboxManifest, fake: readonly string[] | null): string | null {
  if (fake === null) return null;
  const stubs = manifest.stubs ?? [];
  if (stubs.length === 0) return null;
  if (fake.length > 0) return null;
  return "a local stand-in is only for a key marked to fake";
}

/**
 * A library, or a repo with no server, does not get a fake website.
 *
 * manifest: the recipe.
 * Returns a sentence when the recipe starts a one-line file server instead
 * of the repo's own server. Null when it does not start a server, or the
 * start command is the repo's own.
 */
export function fakeWebsiteProblem(manifest: SandboxManifest): string | null {
  const run = (manifest.commands.run ?? "").trim();
  if (run === "") return null;
  // A one-line file server is a website the repo did not have. The repo's own
  // start command is a real server, and a recipe with no server just runs tests.
  if (/http\.server|npx serve\b|busybox httpd/i.test(run)) {
    return "a repo with no server does not get a fake website; run its tests";
  }
  return null;
}

/**
 * Reasons the recipe is not ready that can be seen without the secret blob.
 *
 * These are the checks a writer can correct from `bsf setup submit`: a
 * thinner test than the repo already declares, a store with no seeded
 * marker, a browser-bundle name missing from the recipe, or a fake
 * website. The boot still runs `bootProblems`, which includes these plus
 * the ones that need FACTORY_SANDBOX_ENV. Putting them on submit stops
 * the boot from skipping install and then starting `next start` on a
 * tree that was never built.
 *
 * manifest: the recipe.
 * root: the checkout, for the declared test scripts and the client names.
 * Returns one sentence per problem.
 */
export function staticRecipeProblems(manifest: SandboxManifest, root: string): readonly string[] {
  const problems: string[] = [];
  const thin = thinnerTest(repoTestCommands(root), manifest.commands.test);
  if (thin !== null) problems.push(thin);
  const marker = storeMarkerProblem(manifest);
  if (marker !== null) problems.push(marker);
  const client = clientBuildProblem(manifest, root);
  if (client !== null) problems.push(client);
  const site = fakeWebsiteProblem(manifest);
  if (site !== null) problems.push(site);
  return problems;
}

/**
 * Reasons the recipe is not ready to boot.
 *
 * manifest: the recipe.
 * root: the repository checkout, used to read the test script and the client names.
 * secret: the parsed FACTORY_SANDBOX_ENV. Values are not included in the result.
 * fake: names marked to fake, or null when that check is not in force.
 * Returns one sentence per problem.
 */
export function bootProblems(
  manifest: SandboxManifest,
  root: string,
  secret: Readonly<Record<string, string>>,
  fake: readonly string[] | null = null,
): readonly string[] {
  const problems: string[] = [];
  problems.push(...pastedSecrets(manifest.env));
  problems.push(...staticRecipeProblems(manifest, root));
  const env = resolveNames(manifest, secret);
  const left = [...new Set([...localValuesLeft(secret, env), ...localValuesInConfig(root, secret)])];
  if (left.length > 0) problems.push(`these values only work on the person's computer and were not replaced: ${left.join(", ")}`);
  const stub = stubWithoutFake(manifest, fake);
  if (stub !== null) problems.push(stub);
  return problems;
}

/**
 * The environment the recipe gives the app.
 *
 * manifest: the recipe. A secret field is looked up by name.
 * secret: the parsed blob.
 * Returns the resolved environment. A missing secret name is left unset.
 */
function resolveNames(manifest: SandboxManifest, secret: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of manifest.env) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
    else if (entry.secret !== undefined && secret[entry.secret] !== undefined) env[entry.name] = secret[entry.secret] ?? "";
  }
  return env;
}

const AUTH = ["@clerk/", "next-auth", "@auth/", "auth0", "@auth0/", "lucia"];

/**
 * Whether an app with sign-in has a signed-in journey on the list.
 *
 * list: the journey list markdown.
 * root: the repository checkout, read for auth dependencies.
 * skipped: vendors the person took off the finish line. When this is not
 * empty, a missing signed-in journey is allowed.
 * Returns a sentence when sign-in is missing from the list. Null when the
 * app has no sign-in, the person skipped it, or the list has one.
 */
export function signedInJourneyProblem(list: string, root: string, skipped: readonly string[] = []): string | null {
  if (skipped.length > 0) return null;
  if (!appHasSignIn(root)) return null;
  if (/sign[ -]?in/i.test(list)) return null;
  return "this app has sign-in, and the journey list has no signed-in journey";
}

/**
 * Whether the checkout uses a sign-in library.
 *
 * root: the repository checkout.
 * Returns true when a package.json names a known sign-in package.
 */
export function appHasSignIn(root: string): boolean {
  const files = [join(root, "package.json")];
  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const nested = join(root, name, "package.json");
      if (existsSync(nested)) files.push(nested);
    }
  } catch { /* unreadable */ }
  for (const path of files) {
    if (!existsSync(path)) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (AUTH.some((name) => text.includes(`"${name}`) || text.includes(`"${name.slice(0, -1)}"`))) return true;
  }
  return false;
}

/**
 * Journeys on the finish line that the boot did not click.
 *
 * list: the journey list.
 * probed: names or paths the boot actually requested.
 * Returns the headings that were not clicked. An empty list means each
 * remaining journey was clicked. A repo with no server passes an empty
 * probed list and a note; the caller skips this when there is no server.
 */
export function unclickedJourneys(list: string, probed: readonly string[]): readonly string[] {
  const needles = probed.map((p) => p.toLowerCase());
  return finishLineJourneys(list).filter((heading) => {
    const h = heading.toLowerCase();
    return !needles.some((p) => p.includes(h) || h.includes(p));
  });
}

/**
 * Headings removed from a journey list that was already accepted.
 *
 * original: the headings saved when the journey list was first written.
 * current: the list the writer wants to boot.
 * Returns a sentence when a heading is gone. Null when every original
 * heading is still there. The writer cannot delete a journey to get past it.
 */
export function deletedJourneyProblem(original: readonly string[], current: string): string | null {
  if (original.length === 0) return null;
  const now = new Set(finishLineJourneys(current).map((h) => h.toLowerCase()));
  const gone = original.filter((h) => !now.has(h.toLowerCase()));
  if (gone.length === 0) return null;
  return `a journey was removed from the finish line: ${gone.join(", ")}`;
}

/**
 * Whether a page is still waiting on a vendor's login box.
 *
 * html: the page the boot fetched. It is not typed into.
 * Returns true when the page is a Clerk, Google, or other vendor login
 * widget rather than the app.
 */
export function vendorLoginWaiting(html: string): boolean {
  const text = html.slice(0, 200_000);
  if (/accounts\.google\.com\/o\/oauth|accounts\.google\.com\/v3\/signin|login\.microsoftonline\.com/i.test(text)) return true;
  if (/data-clerk|clerk-js|cl-component|id=["']clerk-/i.test(text) && /sign[ -]?in/i.test(text)) return true;
  if (/Continue with Google|Sign in with Google|Sign in with GitHub/i.test(text) && /<(form|button|iframe)\b/i.test(text)) return true;
  return false;
}

/**
 * Names the running app asked for, and development keys a vendor rejected.
 *
 * log: the boot's output. Secret values are not returned.
 * Returns missing names (the app stopped because they were absent) and
 * rejected names (the vendor refused the development key). Either list
 * sends the person back to the screen. The writer is not asked to invent
 * the value.
 */
export function namesFromBootLog(log: string): { readonly missing: readonly string[]; readonly rejected: readonly string[] } {
  const missing = new Set<string>();
  const rejected = new Set<string>();
  const name = "([A-Za-z_][A-Za-z0-9_]*)";
  const missingRes = [
    new RegExp(`(?:missing|undefined|unset) (?:required )?(?:environment |env )?(?:variable |var )?["']?${name}`, "gi"),
    new RegExp(`environment variable ["']?${name}["']? (?:is )?(?:not set|missing|required)`, "gi"),
    new RegExp(`KeyError: ['"]${name}['"]`, "g"),
    new RegExp(`\\b${name}\\b is not set`, "gi"),
  ];
  for (const re of missingRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(log)) !== null) {
      const found = m[1];
      if (found !== undefined) missing.add(found);
    }
  }
  const rejectedRes = [
    new RegExp(`(?:invalid|rejected|unauthorized) (?:api )?key(?: for)? ["']?${name}`, "gi"),
    new RegExp(`${name}[^\\n]{0,80}(?:invalid api key|key was rejected|401)`, "gi"),
  ];
  for (const re of rejectedRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(log)) !== null) {
      const found = m[1];
      if (found !== undefined && /KEY|SECRET|TOKEN/i.test(found)) rejected.add(found);
    }
  }
  return { missing: [...missing].sort(), rejected: [...rejected].sort() };
}
