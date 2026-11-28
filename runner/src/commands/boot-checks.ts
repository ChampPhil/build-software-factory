/**
 * Checks the boot enforces before it believes the recipe.
 *
 * Purpose:
 *     The writer is told to use a throwaway store, the repo's own tests, and
 *     the development credentials. This file is what makes those instructions
 *     true. It reads the recipe and the repo. It does not start the app, and
 *     it never prints a secret value.
 *
 * Key terms:
 *     - Machine-only value: a credential that only the person's computer can
 *       reach, such as localhost or a file on their disk. The boot must
 *       replace it with something this boot started.
 *     - Thinner test: a command that runs part of the suite, such as one
 *       file or a name filter. The boot runs the script the repo already
 *       declares.
 *     - Marker: a word the seed writes into the empty store. A journey has
 *       to show it. An app with no store skips this check.
 *
 * Exports:
 *     - bootProblems: every reason this recipe is not ready to boot.
 *     - signedInJourneyProblem: the journey list is missing a sign-in when
 *       the app has one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxManifest } from "./sandbox.js";
import { pastedSecrets } from "../lib/placeholders.js";

/**
 * The test script the repository already declares.
 *
 * root: the repository checkout.
 * Returns the script text, or null when the repo does not declare one.
 */
export function repoTestCommand(root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: { test?: unknown } };
      if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() !== "") return pkg.scripts.test.trim();
    } catch { /* not JSON; try the other manifests */ }
  }
  if (existsSync(join(root, "go.mod"))) return "go test ./...";
  if (existsSync(join(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini")) || existsSync(join(root, "setup.cfg"))) return "pytest";
  const composer = join(root, "composer.json");
  if (existsSync(composer)) {
    try {
      const doc = JSON.parse(readFileSync(composer, "utf8")) as { scripts?: { test?: unknown } };
      if (typeof doc.scripts?.test === "string" && doc.scripts.test.trim() !== "") return doc.scripts.test.trim();
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Whether the recipe runs a thinner slice than the repo's own test script.
 *
 * declared: the script the repo already has, or null when it has none.
 * actual: the recipe's commands.test.
 * Returns a sentence when the recipe narrows the suite. Null when it runs
 * the whole script, or when the repo declares no script.
 */
export function thinnerTest(declared: string | null, actual: string | null): string | null {
  if (declared === null) return null;
  if (actual === null || actual.trim() === "") return "the repo has a test script and the recipe does not run it";
  const cmd = actual.trim();
  if (/^(npm|pnpm|yarn|bun) (run )?test( |$)/.test(cmd) && !cmd.includes(" -- ")) return null;
  if (cmd === declared) return null;
  const known = new Set(declared.split(/\s+/));
  for (const tok of cmd.split(/\s+/)) {
    if (known.has(tok)) continue;
    if (tok.startsWith("-") || tok.includes("/") || /\.(py|ts|tsx|js|jsx|go|rb)$/.test(tok)) {
      return "the recipe runs a thinner slice than the repo's own test script";
    }
  }
  return null;
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
  if (v.startsWith("c:\\") || v.startsWith("c:/")) return true;
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
 * Reasons the recipe is not ready to boot.
 *
 * manifest: the recipe.
 * root: the repository checkout, used to read the test script.
 * secret: the parsed FACTORY_SANDBOX_ENV. Values are not included in the result.
 * Returns one sentence per problem.
 */
export function bootProblems(manifest: SandboxManifest, root: string, secret: Readonly<Record<string, string>>): readonly string[] {
  const problems: string[] = [];
  const passwords = pastedSecrets(manifest.env);
  problems.push(...passwords);
  const thin = thinnerTest(repoTestCommand(root), manifest.commands.test);
  if (thin !== null) problems.push(thin);
  const { env } = resolveNames(manifest, secret);
  const left = localValuesLeft(secret, env);
  if (left.length > 0) problems.push(`these values only work on the person's computer and were not replaced: ${left.join(", ")}`);
  const marker = storeMarkerProblem(manifest);
  if (marker !== null) problems.push(marker);
  return problems;
}

/**
 * The environment the recipe gives the app, names only in the result of the caller.
 *
 * manifest: the recipe. A secret field is looked up by name.
 * secret: the parsed blob.
 * Returns the resolved environment. A missing secret name is left unset.
 */
function resolveNames(manifest: SandboxManifest, secret: Readonly<Record<string, string>>): { env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const entry of manifest.env) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
    else if (entry.secret !== undefined && secret[entry.secret] !== undefined) env[entry.name] = secret[entry.secret] ?? "";
  }
  return { env };
}

const AUTH = ["@clerk/", "next-auth", "@auth/", "auth0", "@auth0/", "lucia"];

/**
 * Whether an app with sign-in has a signed-in journey on the list.
 *
 * list: the journey list markdown.
 * root: the repository checkout, read for auth dependencies.
 * Returns a sentence when sign-in is missing from the list. Null when the
 * app has no sign-in, or the list has one.
 */
export function signedInJourneyProblem(list: string, root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  let text = "";
  try {
    text = readFileSync(pkgPath, "utf8");
  } catch {
    return null;
  }
  const hasAuth = AUTH.some((name) => text.includes(`"${name}`) || text.includes(`"${name.slice(0, -1)}"`));
  if (!hasAuth) return null;
  if (/sign[ -]?in/i.test(list)) return null;
  return "this app has sign-in, and the journey list has no signed-in journey";
}
