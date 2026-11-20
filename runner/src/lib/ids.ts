import { randomBytes } from "node:crypto";

/**
 * The factory's ids, which the schemas pin to an exact shape (doc 09):
 * `wi_`, `run_` and `cand_` followed by 26 characters of Crockford base32,
 * and `rev_` followed by a date.
 *
 * They are ULIDs: 48 bits of millisecond timestamp then 80 bits of randomness,
 * encoded so that lexicographic order is chronological order. That property is
 * doing real work here — the data ref is read back as a sorted list of paths,
 * so sorting work items or runs by id sorts them by when they started, with no
 * index to maintain and no clock to trust beyond the one that wrote them.
 *
 * Crockford base32 leaves out I, L, O and U, so an id cannot contain a
 * character that reads as a digit or spells a word.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** A ULID for a given instant. Exported so tests can pin the time. */
export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isFinite(now) || now < 0) throw new Error(`invalid timestamp: ${now}`);
  if (random.length < 10) throw new Error("a ULID needs 10 random bytes");

  let time = "";
  let t = Math.floor(now);
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }

  // 80 random bits as 16 base32 characters, five bits at a time.
  let bits = 0n;
  for (const b of random.slice(0, 10)) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < RANDOM_CHARS; i++) {
    rand = ALPHABET[Number(bits & 31n)]! + rand;
    bits >>= 5n;
  }

  return time + rand;
}

export const workItemId = (now?: number): string => `wi_${ulid(now)}`;
export const runId = (now?: number): string => `run_${ulid(now)}`;
export const candidateId = (now?: number): string => `cand_${ulid(now)}`;
export const benchmarkTaskId = (now?: number): string => `bt_${ulid(now)}`;
export const benchmarkResultId = (now?: number): string => `bench_${ulid(now)}`;

/** `rev_YYYYMMDD`, from an ISO timestamp. */
export function reviewId(iso: string): string {
  const day = iso.slice(0, 10).replace(/-/g, "");
  if (!/^\d{8}$/.test(day)) throw new Error(`cannot make a review id from ${iso}`);
  return `rev_${day}`;
}

/** A fingerprint as the schemas spell it: `sha256:` then 64 lowercase hex. */
export function sha256Id(hex: string): string {
  const bare = hex.startsWith("sha256:") ? hex.slice("sha256:".length) : hex;
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error(`not a sha256 digest: ${hex}`);
  return `sha256:${bare}`;
}
