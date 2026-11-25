export interface DiffLine {
  readonly kind: "+" | "-" | " " | "@";
  readonly text: string;
  readonly old: number | null;
  readonly now: number | null;
}

/** A unified diff as rows with both line numbers, so a comment lands on the right side. */
export function parsePatch(patch: string): readonly DiffLine[] {
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk !== null) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      out.push({ kind: "@", text: raw, old: null, now: null });
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const k = raw[0];
    if (k === "+") out.push({ kind: "+", text: raw.slice(1), old: null, now: b++ });
    else if (k === "-") out.push({ kind: "-", text: raw.slice(1), old: a++, now: null });
    else out.push({ kind: " ", text: raw.slice(1), old: a++, now: b++ });
  }
  return out;
}

