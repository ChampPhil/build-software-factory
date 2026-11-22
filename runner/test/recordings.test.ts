import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hasTool, probe, processRecordings, findRecordings } from "../src/lib/recordings.js";

const haveFfmpeg = hasTool("ffmpeg") && hasTool("ffprobe");
const scratch = mkdtempSync(join(tmpdir(), "bsf-rec-"));
const sample = join(scratch, "sample.mp4");

beforeAll(() => {
  if (!haveFfmpeg) return;
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=6", "-pix_fmt", "yuv420p", sample]);
});

function fresh(name: string): { dir: string; raw: string } {
  const root = mkdtempSync(join(scratch, `${name}-`));
  const dir = join(root, "media");
  mkdirSync(dir, { recursive: true });
  return { dir, raw: join(root, "raw") };
}

describe("recordings", () => {
  it("finds videos and skips ones already made for a PR", () => {
    const { dir } = fresh("find");
    mkdirSync(join(dir, "recordings"));
    for (const n of ["a.webm", "b.mp4", "recordings/c.pr.mp4", "shot.png"]) copyFileSync(process.execPath, join(dir, n));
    expect(findRecordings(dir).map((f) => f.replace(`${dir}/`, "")).sort()).toEqual(["a.webm", "b.mp4"]);
  });

  describe.skipIf(!haveFfmpeg)("with ffmpeg", () => {
    it("re-encodes to a small mp4 with a gif preview and moves the original out", () => {
      const { dir, raw } = fresh("ok");
      copyFileSync(sample, join(dir, "verification.mp4"));
      const r = processRecordings(dir, { rawDir: raw });
      expect(r.problems).toEqual([]);
      expect(r.items).toHaveLength(1);
      const v = r.items[0]!;
      expect(v.file).toMatch(/\.pr\.mp4$/);
      expect(v.poster).toMatch(/\.pr\.gif$/);
      expect(existsSync(join(dir, v.file))).toBe(true);
      expect(existsSync(join(dir, v.poster!))).toBe(true);
      expect(existsSync(join(dir, "verification.mp4"))).toBe(false);
      expect(existsSync(join(raw, "verification.mp4"))).toBe(true);
      expect(v.seconds).toBeGreaterThan(5);
      expect(probe(join(dir, v.file))).not.toBeNull();
    });

    it("is idempotent: a second pass does not re-encode its own output", () => {
      const { dir, raw } = fresh("twice");
      copyFileSync(sample, join(dir, "v.mp4"));
      processRecordings(dir, { rawDir: raw });
      expect(processRecordings(dir, { rawDir: raw }).items).toEqual([]);
    });

    it("leaves a recording out, and says so, when it cannot fit the per-clip cap", () => {
      const { dir, raw } = fresh("big");
      copyFileSync(sample, join(dir, "v.mp4"));
      const r = processRecordings(dir, { rawDir: raw, limits: { clipBytes: 200 } });
      expect(r.items).toEqual([]);
      expect(r.problems.join(" ")).toMatch(/v\.mp4/);
    });

    it("speeds up, rather than cuts, a recording longer than the preview", () => {
      const { dir, raw } = fresh("fast");
      copyFileSync(sample, join(dir, "v.mp4"));
      const r = processRecordings(dir, { rawDir: raw, limits: { previewSeconds: 2 } });
      const gif = r.items[0]!.poster!;
      expect(statSync(join(dir, gif)).size).toBeGreaterThan(0);
      expect(probe(join(dir, gif))?.seconds ?? 0).toBeLessThanOrEqual(3);
    });
  });

  it("keeps the raw file and says so when ffmpeg is missing", () => {
    const { dir, raw } = fresh("noff");
    copyFileSync(process.execPath, join(dir, "v.webm"));
    const saved = process.env["PATH"];
    process.env["PATH"] = "/nonexistent";
    try {
      const r = processRecordings(dir, { rawDir: raw });
      expect(r.problems.join(" ").toLowerCase()).toContain("ffmpeg");
    } finally {
      process.env["PATH"] = saved;
    }
  });
});
