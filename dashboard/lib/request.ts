/**
 * A request typed into the dashboard becomes an issue shaped like the ones the
 * factory's own forms make, so intake reads both the same way: a `### What`
 * section, a `### Goal` section, and a label for the two kinds of work that
 * are not a feature or a bug.
 */

export type RequestKind = "feature" | "bug" | "harden" | "tidy";

export const REQUEST_KINDS: readonly { readonly kind: RequestKind; readonly label: string; readonly hint: string }[] = [
  { kind: "feature", label: "Feature", hint: "Add or change something" },
  { kind: "bug", label: "Bug", hint: "Something is broken" },
  { kind: "harden", label: "Harden", hint: "A mistake that keeps happening" },
  { kind: "tidy", label: "Tidy", hint: "Clean up without changing behaviour" },
];

const PREFIX: Record<RequestKind, string> = {
  feature: "[Feature]",
  bug: "[Bug]",
  harden: "[Harden]",
  tidy: "[Tidy]",
};

const LABEL: Partial<Record<RequestKind, string>> = {
  harden: "factory:harden",
  tidy: "factory:tidy",
};

const WHAT: Record<RequestKind, string> = {
  feature: "What do you want?",
  bug: "What goes wrong?",
  harden: "What went wrong, and where?",
  tidy: "What should be tidied?",
};

export interface RequestInput {
  readonly kind: RequestKind;
  readonly title: string;
  readonly details: string;
  readonly goal: string;
}

export interface BuiltRequest {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** The title, body and labels of the issue for a request, or null when it has no title. */
export function buildRequest(input: RequestInput): BuiltRequest | null {
  const title = input.title.trim();
  if (title === "") return null;
  const details = input.details.trim();
  const goal = input.goal.trim();
  const parts = [`### ${WHAT[input.kind]}\n\n${details === "" ? title : details}`];
  if (goal !== "") parts.push(`### Goal\n\n${goal}`);
  const label = LABEL[input.kind];
  return {
    title: `${PREFIX[input.kind]} ${title}`,
    body: parts.join("\n\n"),
    labels: label === undefined ? [] : [label],
  };
}

/** A suggestion setup left for the first run, or null when the file is not usable. */
export interface FirstRequest {
  readonly title: string;
  readonly details: string;
  readonly goal: string;
}

export function readFirstRequest(raw: unknown): FirstRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["title"] !== "string" || r["title"].trim() === "") return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return { title: r["title"].trim(), details: str(r["details"]), goal: str(r["goal"]) };
}
