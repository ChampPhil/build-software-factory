/**
 * Secret-looking placeholders in the sandbox manifest.
 *
 * Purpose:
 *     The setup agent invents plausible values for the keys a sandbox needs
 *     (an AWS-shaped key, a Stripe-shaped key). Secret scanners, GitHub's
 *     push protection among them, cannot tell an invented key from a real
 *     one, and the setup pull request is then blocked on a value that was
 *     never a secret. Every credential-shaped value is replaced with a plain
 *     marker before that pull request is opened.
 *
 * Key terms:
 *     - Manifest: the sandbox JSON that names the app's environment, commands,
 *       and stand-in services.
 *     - Env name: the `name` field on an environment entry, such as
 *       NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY. It is an identifier, not a secret,
 *       even when it is longer than 32 characters.
 *     - Secret field: the `secret` field, which names a repository secret.
 *       The name stays. The value of that secret is never written here.
 *
 * Non-obvious behavior:
 *     - The walk replaces string values only. Keys `name` and `secret` are
 *       left as written, because a long SCREAMING_SNAKE name matches the same
 *       character class as a base64 token, and replacing it makes the
 *       manifest fail its own name pattern.
 *
 * Exports:
 *     - NOT_A_KEY: the marker written in place of a credential-shaped value.
 *     - looksLikeSecret: whether one string has a credential shape.
 *     - scrubPlaceholders: the manifest text with those values replaced.
 */

export const NOT_A_KEY = "not-a-real-key";

/** JSON keys whose string values are identifiers, never credentials. */
const IDENTIFIER_KEYS = new Set(["name", "secret"]);

const SHAPES: readonly RegExp[] = [
  /^(AKIA|ASIA)[0-9A-Z]{12,}$/,
  /^sk_(live|test)_[A-Za-z0-9]+$/,
  /^pk_(live|test)_[A-Za-z0-9]+$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^[A-Za-z0-9+/_-]{32,}={0,2}$/,
];

export function looksLikeSecret(v: string): boolean {
  // A URL or a path is long and base64-ish in places, but it is not a key.
  if (/[:.\s]/.test(v) && !/^sk_|^pk_/.test(v)) return false;
  return SHAPES.some((r) => r.test(v));
}

/**
 * The manifest text with credential-shaped string values replaced.
 *
 * text: the sandbox manifest as JSON text.
 * Returns the rewritten text and how many values were replaced.
 * `name` and `secret` strings are kept, so a long environment name survives.
 */
export function scrubPlaceholders(text: string): { text: string; replaced: number } {
  let replaced = 0;
  // `key` is the object field this value sits under, or null inside an array.
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      // An identifier such as an env name can be 32+ characters of
      // letters and underscores, which is also the shape of a bare token.
      if (key !== null && IDENTIFIER_KEYS.has(key)) return v;
      if (looksLikeSecret(v)) {
        replaced++;
        return NOT_A_KEY;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, null));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  const out = walk(JSON.parse(text), null);
  return { text: `${JSON.stringify(out, null, 2)}\n`, replaced };
}
