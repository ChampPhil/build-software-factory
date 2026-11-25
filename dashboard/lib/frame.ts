/** Reading the frame turn the runner writes into a conversation. */

/** Ends a fragment the agent wrote, so two of them never run together. */
export const sentence = (t: string): string => (/[.!?:)\u201d"]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/**
 * Is this the turn the runner wrote from the frame? It renders the frame as
 * Markdown into an ordinary turn, so the log has no flag; these are the
 * headings only that renderer writes.
 */
export function isFrameTurn(text: string): boolean {
  return /^Before I ask anything else/.test(text) || /^The (word that matters most here|\w+ words that change what gets built here):/m.test(text) || /^Where this has been solved before/m.test(text) || /^Things you did not mention that will decide something:/m.test(text);
}

/** The question a frame turn ends on: its last paragraph. */
export const questionOf = (text: string): string => text.trim().split(/\n\s*\n/).at(-1)?.trim() ?? text;

/** A factory comment as prose: no Markdown emphasis and no hidden markers. */
export const plain = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
