import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hasTool, probe, processRecordings, findRecordings, FILE_CAP_BYTES, RECORDING_LIMITS } from "../src/lib/recordings.js";

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
      // A recording that would not fit is diminished proof, not a report
      // claiming something that is not there, so it does not fail the PR.
      expect(r.degraded.join(" ")).toMatch(/v\.mp4/);
      expect(r.problems).toEqual([]);
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
      // A missing package is the factory's own plumbing, not the report
      // claiming what is not there. It is said, and it does not fail the PR.
      expect(r.degraded.join(" ").toLowerCase()).toContain("ffmpeg");
      expect(r.problems).toEqual([]);
    } finally {
      process.env["PATH"] = saved;
    }
  });

  /**
   * A PR on CS2_Rob_The_Bobber arrived with a 19.7 MB recording of the feature
   * working and a check that said "The PR does not show its proof". The
   * recording was dropped for being over an 8 MB encode target with no ffmpeg
   * to shrink it, and the one piece of proof that mattered most was gone. Then
   * a summary line being successfully shortened from 282 to 200 characters was
   * listed as something missing, under the same heading.
   */
  describe("what counts as the report failing", () => {
    /** A file of a known size; nothing probes it on the no-ffmpeg path. */
    const sized = (dir: string, name: string, bytes: number): void =>
      writeFileSync(join(dir, name), Buffer.alloc(bytes, 7));

    const withoutFfmpeg = <T,>(fn: () => T): T => {
      const saved = process.env["PATH"];
      process.env["PATH"] = "/nonexistent";
      try {
        return fn();
      } finally {
        process.env["PATH"] = saved;
      }
    };

    it("stores a recording over the encode target but under the hard cap", () => {
      const { dir, raw } = fresh("overtarget");
      sized(dir, "v.webm", 2 * 1024 * 1024);
      // The encode target describes what an encode aims for. Without ffmpeg
      // there is no encode, and a watchable file is better than none: a 9 MB
      // recording of the feature working used to be thrown away for being
      // over a number that only ever described an encode.
      const r = withoutFfmpeg(() => processRecordings(dir, { rawDir: raw, limits: { clipBytes: 1024 * 1024 } }));
      expect(r.items).toHaveLength(1);
      expect(r.problems).toEqual([]);
      expect(r.degraded.join(" ")).toMatch(/stored as it was written/);
    });

    it("drops one over the hard cap, because it cannot be stored at all", () => {
      const { dir, raw } = fresh("overcap");
      sized(dir, "v.webm", FILE_CAP_BYTES + 1024);
      const r = withoutFfmpeg(() => processRecordings(dir, { rawDir: raw }));
      // Still not a failure: the PR says the video would not fit, and
      // whatever other proof the report carries stands on its own.
      expect(r.items).toEqual([]);
      expect(r.problems).toEqual([]);
      expect(r.degraded.join(" ")).toMatch(/could not be stored/);
    });

    it("counts the hard cap as one number, not two", () => {
      // 8 MB in the recordings module and 10 MB hardcoded in pr-report meant a
      // 9 MB file was dropped by one and then separately complained about by
      // the other.
      expect(FILE_CAP_BYTES).toBeGreaterThan(RECORDING_LIMITS.clipBytes);
    });

    it("still fails a recording that got no frames", () => {
      // The role said it recorded and it did not. That is the report being
      // wrong about itself, which is the one thing here that has to fail.
      const { dir, raw } = fresh("empty");
      writeFileSync(join(dir, "v.webm"), "");
      const r = processRecordings(dir, { rawDir: raw });
      expect(r.problems.join(" ")).toMatch(/never got any frames/);
    });
  });
});
