/**
 * Reading what a person wrote in a request.
 *
 * An issue made from one of the factory's forms, or from the dashboard's New
 * request box, has a "Goal" section: what should be true when the work is
 * done. GitHub renders a form field as a `### Label` heading followed by the
 * answer, and the dashboard writes the same shape, so one reader handles both.
 */

/** The label a tidy request carries, which sends it to the gardening pipeline. */
export const TIDY_LABEL = "factory:tidy";
/** The dashboard's "Ask the factory" box: a change to how the factory is set up, in a person's own words. */
export const ASK_LABEL = "factory:ask";

const MAX_GOAL = 500;

/** What a person left in a form field they did not fill in. */
const BLANK = /^(_no response_|n\/a|none|-)$/i;

/** The goal written in a request, or null when there is none. */
export function extractGoal(body: string | null | undefined): string | null {
  if (body == null) return null;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s*goal\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    out.push(line);
  }
  const text = out.join("\n").trim();
  if (text === "" || BLANK.test(text)) return null;
  return text.length > MAX_GOAL ? `${text.slice(0, MAX_GOAL - 1)}…` : text;
}
