/**
 * The person's own words in `fundamentals.md`.
 *
 * Setup asks the person about the product and records the answers under a
 * heading of their own. The workflow agent then writes the rest of
 * `fundamentals.md` from the code. Without a rule, that second write replaced
 * the whole file and the person's answers vanished. This is the rule: the
 * "Product intent (from you)" block is carried over untouched, and the
 * incoming file is merged around it.
 */

export const INTENT_HEADING = "## Product intent (from you)";

/** The block from its heading to the next `## ` heading (or the end). */
export function intentBlock(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === INTENT_HEADING);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

/**
 * `existing` is the file as it stands (with the person's block, if any);
 * `incoming` is what the workflow agent wrote. The result is the incoming
 * file with the existing block in place of any block it wrote, or inserted
 * after its title when it wrote none.
 */
export function mergeProductIntent(existing: string | null, incoming: string): string {
  const keep = existing === null ? null : intentBlock(existing);
  if (keep === null) return incoming;

  const lines = incoming.split("\n");
  const start = lines.findIndex((l) => l.trim() === INTENT_HEADING);
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    const after = lines.slice(end).join("\n");
    return `${lines.slice(0, start).join("\n")}${start > 0 ? "\n" : ""}${keep}\n${after === "" ? "" : `\n${after}`}`.replace(/\n*$/, "\n");
  }
  // No block written: put it right after the title, or at the top.
  const title = lines.findIndex((l) => /^# /.test(l));
  const at = title === -1 ? 0 : title + 1;
  const head = lines.slice(0, at).join("\n");
  const tail = lines.slice(at).join("\n").replace(/^\n+/, "");
  return `${head}${head === "" ? "" : "\n\n"}${keep}\n\n${tail}`.replace(/\n*$/, "\n");
}
