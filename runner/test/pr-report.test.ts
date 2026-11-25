import { describe, it, expect } from "vitest";
import { renderReport, renderBlock, readReportFile, attachRecordings, needsVideo, MARKER, CONTINUED_MARKER, type StoredReport } from "../src/commands/pr-report.js";
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

describe("recordings on a PR", () => {
  const clip = { source: "verification.webm", file: "recordings/verification.pr.mp4", poster: "recordings/verification.pr.gif", seconds: 42, bytes: 2_500_000 };

  it("puts an unreferenced recording at the front, captioned", () => {
    const r = attachRecordings({ schema: "pr-report/1", summary: ["x"], blocks: [{ type: "file", file: "a.png", caption: "A" }] }, [clip]);
    expect(r.blocks[0]).toEqual({
      type: "file",
      file: "recordings/verification.pr.mp4",
      caption: "Screen recording of the running app (verification)",
      poster: "recordings/verification.pr.gif",
    });
    expect(r.blocks).toHaveLength(2);
  });

  it("swaps a block that names the original for the stored copy, keeping the caption", () => {
    const r = attachRecordings(
      { schema: "pr-report/1", summary: ["x"], blocks: [{ type: "file", file: "verification.webm", caption: "The whole flow" }] },
      [clip],
    );
    expect(r.blocks).toEqual([
      { type: "file", file: "recordings/verification.pr.mp4", caption: "The whole flow", poster: "recordings/verification.pr.gif" },
    ]);
  });

  it("changes nothing when there are no recordings", () => {
    const rep = { schema: "pr-report/1" as const, summary: ["x"], blocks: [] };
    expect(attachRecordings(rep, [])).toBe(rep);
  });

  it("shows the poster linking to the video, with its length and size", () => {
    const v = stored("verifier", {
      schema: "pr-report/1",
      summary: ["ok"],
      blocks: [{ type: "file", file: "recordings/verification.pr.mp4", caption: "Walkthrough", poster: "recordings/verification.pr.gif" }],
    });
    const out = renderBlock("o/r", { ...v, videos: [{ file: "recordings/verification.pr.mp4", seconds: 75, bytes: 2_621_440 }] }, v.report.blocks[0]!);
    expect(out).toMatch(/\[!\[Walkthrough — play the video\]\([^)]*verification\.pr\.gif\?raw=true\)\]\([^)]*verification\.pr\.mp4\?raw=true\)/);
    expect(out).toContain("1:15");
    expect(out).toContain("2.5 MB");
  });

  it("asks for a video when the change touches the UI and none was recorded", () => {
    const withoutVideo = renderReport({ repo: "o/r", kind: "change", reports: [verifier], needsVideo: true });
    expect(withoutVideo.problems.join(" ")).toContain("no role recorded a video");
    const withVideo = renderReport({
      repo: "o/r",
      kind: "change",
      reports: [stored("verifier", { schema: "pr-report/1", summary: ["ok"], blocks: [{ type: "file", file: "r/v.pr.mp4", caption: "Walk" }] })],
      needsVideo: true,
    });
    expect(withVideo.problems.join(" ")).not.toContain("no role recorded a video");
  });

  it("does not ask for one when the change has no UI", () => {
    expect(renderReport({ repo: "o/r", kind: "change", reports: [verifier] }).problems.join(" ")).not.toContain("video");
  });

  it("needs a video only for product work the spec says touches the UI", () => {
    expect(needsVideo({ pipeline: "product_work", spec: { ui_change: true } } as never)).toBe(true);
    expect(needsVideo({ pipeline: "product_work", spec: { ui_change: false } } as never)).toBe(false);
    expect(needsVideo({ pipeline: "gardening", spec: { ui_change: true } } as never)).toBe(false);
    expect(needsVideo(null)).toBe(false);
  });
});

/**
 * A PR on a real repository arrived carrying a 19.7 MB recording of the
 * feature working, and the check on it said **"The PR does not show its
 * proof"**. The recording had been dropped for being over an 8 MB encode
 * target with no ffmpeg on the runner to shrink it, so the one piece of proof
 * that mattered most was gone. In the same list, under the heading "What is
 * missing", was this: `summary line 1 was shortened to fit (282 → 200)` — a
 * thing the tooling had done successfully.
 *
 * The check asks one question now: is the proof there? Not whether the tooling
 * had an easy time of it.
 */
describe("whether the proof check passes", async () => {
  const { reportCheck } = await import("../src/commands/pr-report.js");

  const check = async (problems: readonly string[], degraded: readonly string[] = []) => {
    let sent: { conclusion: string; title: string; summary: string } | undefined;
    const gh = {
      repo: "o/r",
      pull: async () => ({ head: { sha: "abc" } }),
      reportCheck: async (c: { conclusion: string; title: string; summary: string }) => { sent = c; },
    } as never;
    await reportCheck(gh, 14, problems, degraded);
    return sent!;
  };

  it("passes a PR whose proof is all there", async () => {
    const r = await check([]);
    expect(r.conclusion).toBe("success");
    expect(r.title).toBe("The PR shows its proof");
  });

  it("passes a PR whose video could not be shrunk, and says so", async () => {
    const r = await check([], [
      "ffmpeg is not installed on this runner, so recordings are kept as they were written, with no preview",
    ]);
    expect(r.conclusion).toBe("success");
    expect(r.title).toMatch(/shows its proof, with notes/);
    expect(r.summary).toMatch(/not a reason to hold the PR/i);
    expect(r.summary).toContain("ffmpeg");
  });

  it("passes a PR whose summary line was shortened", async () => {
    // This was the whole failure once: a successful automatic fixup, listed
    // under "What is missing", rejecting a PR with perfect proof.
    const r = await check([], ["summary line 1 was shortened to fit (282 → 200)"]);
    expect(r.conclusion).toBe("success");
  });

  it("fails a PR that names a file nobody wrote", async () => {
    // The report being wrong about itself is the one thing that has to fail.
    const r = await check(["builder names recordings/run.webm, which it did not write"]);
    expect(r.conclusion).toBe("failure");
    expect(r.title).toBe("The PR does not show its proof");
    expect(r.summary).toMatch(/What is missing/);
  });

  it("fails a PR with no proof at all", async () => {
    const r = await check(["there is no proof: no screenshot, recording, log or diagram"]);
    expect(r.conclusion).toBe("failure");
  });

  it("fails on a real absence even when there are notes too", async () => {
    const r = await check(["there is no proof: no screenshot, recording, log or diagram"], ["ffmpeg is not installed"]);
    expect(r.conclusion).toBe("failure");
    expect(r.summary).toMatch(/What is missing/);
    // The notes still get said: they may be why the proof is absent.
    expect(r.summary).toContain("ffmpeg");
  });

  it("does not call a PR with notes alone 'missing' anything", async () => {
    const r = await check([], ["v.webm has no preview: the GIF and the still both failed"]);
    expect(r.summary).not.toMatch(/What is missing/);
  });
});
