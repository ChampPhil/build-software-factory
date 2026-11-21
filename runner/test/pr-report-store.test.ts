import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const media: { path: string; content: string; encoding?: string }[] = [];
const data = new Map<string, string>();
vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FactoryStore {
    constructor(_gh: unknown, private readonly ref?: string) {}
    data = {
      commit: async (changes: { path: string; content: string; encoding?: string }[]) => { media.push(...changes); return "mediasha"; },
      readJson: async () => null,
    };
    async put(changes: { path: string; content: string }[]) { for (const c of changes) data.set(c.path, c.content); return "sha"; }
  }
  return { ...real, FactoryStore };
});

const { storeReport } = await import("../src/commands/pr-report.js");

describe("storing a role's report", () => {
  it("stores the files it names as bytes, keeps text inline, and says what it named but did not write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-report-"));
    mkdirSync(join(dir, "files"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(dir, "files/after.png"), png);
    writeFileSync(join(dir, "api.json"), '{"ok":true}');
    writeFileSync(join(dir, "technical.md"), "# How");
    writeFileSync(join(dir, "report.json"), JSON.stringify({
      schema: "pr-report/1",
      summary: ["One."],
      blocks: [
        { type: "file", file: "files/after.png", caption: "after" },
        { type: "file", file: "api.json", caption: "api" },
        { type: "file", file: "files/missing.png", caption: "never written" },
      ],
      technical: "technical.md",
    }));
    const r = await storeReport({ gh: { repo: "o/r" } as never, dir, role: "builder", workItem: "wi_X", attempt: 2, now: "2026-11-21T00:00:00Z" });
    expect(r!.problems).toEqual(["builder names files/missing.png, which it did not write"]);
    expect(r!.inline).toEqual({ "api.json": '{"ok":true}' });
    const shot = media.find((m) => m.path === "reports/wi_X/builder-2/files/after.png")!;
    // Bytes, not base64 text of base64: the screenshot has to open.
    expect(shot.encoding).toBe("base64");
    expect(Buffer.from(shot.content, "base64").equals(png)).toBe(true);
    expect(JSON.parse(data.get("reports/wi_X/builder.json")!).media_commit).toBe("mediasha");
  });

  it("refuses a report whose shape is wrong, which shortening cannot fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-report-"));
    // A path that climbs out of the report directory is never accepted.
    writeFileSync(join(dir, "report.json"), JSON.stringify({ schema: "pr-report/1", summary: ["a"], blocks: [], technical: "../secrets.md" }));
    await expect(storeReport({ gh: { repo: "o/r" } as never, dir, role: "builder", workItem: "wi_X", attempt: 1, now: "x" })).rejects.toThrow();
  });
});
