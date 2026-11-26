/**
 * Secret-looking placeholders in the sandbox manifest.
 *
 * The setup agent invents plausible values for the keys a sandbox needs
 * (an AWS-shaped key, a Stripe-shaped key). Secret scanners, GitHub's push
 * protection among them, cannot tell an invented key from a real one, and the
 * setup PR is then blocked on a value that was never a secret. Every value
 * that has the *shape* of a credential is replaced with a plain marker.
 */

export const NOT_A_KEY = "not-a-real-key";

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

/** Returns the manifest text with credential-shaped string values replaced. */
export function scrubPlaceholders(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (looksLikeSecret(v)) {
        replaced++;
        return NOT_A_KEY;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(JSON.parse(text));
  return { text: `${JSON.stringify(out, null, 2)}\n`, replaced };
}
