import { describe, it, expect } from "vitest";
import { renderReport, renderBlock, readReportFile, MARKER, CONTINUED_MARKER, type StoredReport } from "../src/commands/pr-report.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stored = (role: string, report: StoredReport["report"], inline: Record<string, string> = {}): StoredReport => ({
  role, attempt: 1, report, media_commit: "abc123", media_prefix: `reports/wi_X/${role}-1`, inline, problems: [], stored_at: "2026-11-21T00:00:00Z",
});

const builder = stored("builder", {
  schema: "pr-report/1",
  summary: ["Invoices can be filtered by status.", "Finding unpaid invoices took scrolling.", "Chips above the table narrow it."],
  blocks: [
    { type: "file", file: "files/after.png", caption: "The table filtered to Sent" },
    { type: "diagram", title: "How a choice reaches the table", mermaid: "sequenceDiagram\n  User->>Page: Sent" },
    { type: "file", file: "files/walk.mp4", caption: "Each status in turn", poster: "files/walk.gif" },
  ],
  focus: [{ title: "The filter is in the URL", detail: "Links keep it.", files: ["app/invoices/page.tsx"] }],
  technical: "technical.md",
  conceptual: "conceptual.md",
});
const verifier = stored("verifier", {
  schema: "pr-report/1",
  summary: ["All four checks passed."],
  blocks: [{ type: "file", file: "check2.json", caption: "The API returned only sent invoices" }],
}, { "check2.json": '[{"id":1,"status":"sent"}]' });

describe("a factory PR, rendered from the roles' reports", () => {
  const r = renderReport({ repo: "o/r", kind: "change", reports: [builder, verifier], links: [{ label: "Full spec", url: "https://x/spec" }] });

  it("leads with the summary, then proof, then the focus, then the links, in that order", () => {
    const at = (s: string) => r.body.indexOf(s);
    expect(r.body.startsWith(MARKER)).toBe(true);
    expect(at("### Summary")).toBeLessThan(at("### Proof"));
    expect(at("### Proof")).toBeLessThan(at("### Key things to focus on"));
    expect(at("### Key things to focus on")).toBeLessThan(at("### Read more"));
    expect(r.problems).toEqual([]);
  });

  it("keeps each role's files and diagrams in the order it chose, the builder's before the verifier's", () => {
    const at = (s: string) => r.body.indexOf(s);
    expect(at("files/after.png")).toBeLessThan(at("```mermaid"));
    expect(at("```mermaid")).toBeLessThan(at("files/walk.gif"));
    expect(at("files/walk.gif")).toBeLessThan(at("Checked independently by the verifier"));
  });

  it("shows images inline, a video as its poster linking to it, and an API response as text", () => {
    expect(r.body).toContain("![The table filtered to Sent](https://github.com/o/r/blob/abc123/reports/wi_X/builder-1/files/after.png?raw=true)");
    expect(r.body).toMatch(/\[!\[Each status in turn — play the video\]\([^)]*walk\.gif\?raw=true\)\]\([^)]*walk\.mp4\?raw=true\)/);
    expect(r.body).toContain('```json\n[{"id":1,"status":"sent"}]\n```');
  });

  it("links the spec and both breakdowns under Read more", () => {
    expect(r.body).toMatch(/\[Full spec\]\(https:\/\/x\/spec\) · \[Technical breakdown\]\([^)]*technical\.md\) · \[Conceptual breakdown\]\([^)]*conceptual\.md\)/);
  });
});

describe("the factory/pr-report check's findings", () => {
  it("names what is missing", () => {
    const thin = stored("builder", { schema: "pr-report/1", summary: ["Did a thing."], blocks: [] });
    const r = renderReport({ repo: "o/r", kind: "change", reports: [thin] });
    expect(r.problems).toEqual([
      "there is no proof: no screenshot, recording, log or diagram",
      "there are no key things to focus on",
      "there is no technical breakdown",
      "there is no conceptual breakdown",
    ]);
    expect(renderReport({ repo: "o/r", kind: "change", reports: [] }).problems).toContain("no role wrote a report");
  });
});

describe("a PR with more proof than one body holds", () => {
  it("continues the rest in a comment, every file still on the PR", () => {
    const many = stored("verifier", {
      schema: "pr-report/1",
      summary: ["Lots of evidence."],
      blocks: Array.from({ length: 400 }, (_, i) => ({ type: "file" as const, file: `shot-${i}.png`, caption: `Check ${i}: ${"x".repeat(150)}` })),
    });
    const r = renderReport({ repo: "o/r", kind: "change", reports: [builder, many] });
    expect(r.body.length).toBeLessThan(65_536);
    expect(r.continued).not.toBeNull();
    expect(r.continued!.startsWith(CONTINUED_MARKER)).toBe(true);
    for (let i = 0; i < 400; i++) expect(`${r.body}${r.continued}`).toContain(`shot-${i}.png`);
  });
});

describe("a file with no inline form", () => {
  it("is a link, never dropped", () => {
    expect(renderBlock("o/r", builder, { type: "file", file: "trace.zip", caption: "Playwright trace" })).toMatch(/📎 \[Playwright trace\]/);
  });
});

describe("the setup agent's report file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bsf-rf-"));
  const write = (v: unknown): string => {
    const f = join(dir, `r${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
    return f;
  };

  it("cuts a summary line that runs over its limit instead of refusing the report", () => {
    const r = readReportFile(write({ schema: "pr-report/1", summary: ["x".repeat(223), "ok"], blocks: [] }));
    expect(r.report?.summary[0]).toHaveLength(200);
    expect(r.report?.summary[0]?.endsWith("…")).toBe(true);
    expect(r.clamped).toHaveLength(1);
  });

  it("returns no report, with a reason, when the file is not JSON or breaks the schema another way", () => {
    expect(readReportFile(write("{nope")).report).toBeNull();
    const bad = readReportFile(write({ schema: "pr-report/1", blocks: [] }));
    expect(bad.report).toBeNull();
    expect(bad.why).not.toBe("");
  });
});
