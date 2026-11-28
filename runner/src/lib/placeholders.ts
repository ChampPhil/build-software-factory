/**
 * Pasted passwords in a sandbox recipe.
 *
 * Purpose:
 *     The recipe that gets committed names configuration. A real password
 *     lives in the GitHub secret FACTORY_SANDBOX_ENV, and the recipe only
 *     stores that name. An older cleaner walked the whole file and rewrote
 *     any long string, which turned a URL path into the words not-a-real-key
 *     and the path check then rejected a valid recipe. This file does not
 *     rewrite anything. It looks only at environment value fields.
 *
 * Key terms:
 *     - Recipe: the sandbox manifest JSON. It is committed. It must not
 *       contain a password.
 *     - Env entry: one variable the sandbox gives the app. It has a name,
 *       a kind, and either a literal value or the name of a secret.
 *     - Value field: the literal. A local address, a plain flag, or a plain
 *       word is fine. A vendor password such as a Stripe or AWS key is not.
 *     - Secret field: the name looked up in FACTORY_SANDBOX_ENV. The name
 *       stays. The password never appears in the recipe.
 *
 * Non-obvious behavior:
 *     - Only known password prefixes are refused. A long path is not a
 *       password, and the file is left exactly as written.
 *     - A test_mode entry must use the secret field. A literal there is a
 *       pasted password even when it does not match a prefix.
 *
 * Exports:
 *     - looksLikePastedSecret: whether one string is a vendor password.
 *     - pastedSecrets: the env entries whose value must not be committed.
 */

/** Prefixes of vendor passwords. A path or a plain word does not match these. */
const PASTED: readonly RegExp[] = [
  /^(AKIA|ASIA)[0-9A-Z]{12,}$/,
  /^sk_(live|test)_[A-Za-z0-9]+$/,
  /^pk_(live|test)_[A-Za-z0-9]+$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
];

/**
 * Whether a literal is a vendor password that must not be committed.
 *
 * value: the string stored in an env entry's value field.
 * Returns true for Stripe, AWS, Slack, and GitHub token shapes. A URL, a
 * path, and a plain word return false.
 */
export function looksLikePastedSecret(value: string): boolean {
  return PASTED.some((r) => r.test(value));
}

export interface EnvEntry {
  readonly name?: string;
  readonly kind?: string;
  readonly value?: string;
  readonly secret?: string;
}

/**
 * Env entries that would commit a password.
 *
 * entries: the recipe's env array. Anything that is not an object is skipped.
 * Returns one line per problem. An empty list means the recipe's env fields
 * are safe to commit. The recipe text is not modified.
 */
export function pastedSecrets(entries: readonly unknown[]): readonly string[] {
  const problems: string[] = [];
  for (const raw of entries) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as EnvEntry;
    const name = entry.name ?? "(unnamed)";
    if (entry.kind === "test_mode" && entry.value !== undefined) {
      problems.push(`${name} is a test-mode key and must be a secret name, not a value`);
    } else if (entry.value !== undefined && looksLikePastedSecret(entry.value)) {
      problems.push(`${name} has a pasted password in its value; put the name in the recipe and the password in FACTORY_SANDBOX_ENV`);
    }
  }
  return problems;
}
