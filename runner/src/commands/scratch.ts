/**
 * The scratch layer on top of a frozen sandbox recipe.
 *
 * Purpose
 * -------
 * An agent may arrange the case it is testing: an extra row, an extra test
 * user, a declined card. That arrangement is for this run only. It is written
 * here, never into the recipe (`manifest.json`). Cleanup deletes the local
 * record. Objects that live at a vendor (a Clerk dev user, a Stripe test
 * customer) are a best effort: if they cannot be deleted, the run still ends.
 *
 * Key terms
 * ---------
 * Recipe: the shared sandbox manifest. Every run starts from it. Scratch
 * does not change it.
 * Note: one sentence saying what this run added, so the proof can say it.
 * Best effort: cleanup tried, and a failure to reach the vendor is recorded
 * rather than treated as a failed run.
 *
 * Exports
 * -------
 * SCRATCH_PATH, noteScratch, clearScratch, scratchProof.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The per-run notes. Gitignored by the sandbox start, and never the recipe. */
export const SCRATCH_PATH = ".factory/sandbox/scratch.json";

export interface ScratchFile {
  readonly schema: "sandbox-scratch/1";
  readonly notes: readonly { readonly added: string; readonly at: string }[];
}

/**
 * Append one note. Refuses to write the recipe.
 *
 * root: the repository checkout.
 * added: what this run created, in one sentence.
 * at: when the note was written, ISO time.
 */
export function noteScratch(root: string, added: string, at: string): ScratchFile {
  const text = added.trim();
  if (text === "") throw new Error("a scratch note says what this run added");
  const current = readScratch(root);
  const next: ScratchFile = {
    schema: "sandbox-scratch/1",
    notes: [...current.notes, { added: text, at }],
  };
  const path = join(root, SCRATCH_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * The notes so far. An unreadable file is an empty list: a broken scratch
 * file must not block the run, and it must not be treated as the recipe.
 *
 * root: the repository checkout.
 */
export function readScratch(root: string): ScratchFile {
  const path = join(root, SCRATCH_PATH);
  if (!existsSync(path)) return { schema: "sandbox-scratch/1", notes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ScratchFile>;
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((n): n is { added: string; at: string } => typeof n?.added === "string" && typeof n?.at === "string")
      : [];
    return { schema: "sandbox-scratch/1", notes };
  } catch {
    return { schema: "sandbox-scratch/1", notes: [] };
  }
}

/**
 * Delete the local scratch record and return the proof line.
 *
 * Vendor objects are not deleted from here. The caller may try; a failure
 * of that try is best effort and does not change this result. The recipe
 * is not opened.
 *
 * root: the repository checkout.
 */
export function clearScratch(root: string): { readonly proof: string; readonly cleanup: "best-effort" } {
  const notes = readScratch(root).notes;
  const path = join(root, SCRATCH_PATH);
  if (existsSync(path)) rmSync(path, { force: true });
  return { proof: scratchProof(notes.map((n) => n.added)), cleanup: "best-effort" };
}

/**
 * The sentence a scratched run puts in its proof. An empty list means the
 * run used the seed alone.
 *
 * added: the sentences this run recorded, in order.
 */
export function scratchProof(added: readonly string[]): string {
  if (added.length === 0) return "This run used the seed alone.";
  return `This run added, for this run only: ${added.join("; ")}. Cleanup of vendor test objects is best effort.`;
}
