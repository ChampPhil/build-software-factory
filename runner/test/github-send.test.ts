import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub } from "../src/lib/github.js";

/**
 * These tests run against a fake `gh` on PATH that records how it was called
 * and what reached its stdin.
 *
 * They exist because every request with a body went out empty for weeks.
 * `promisify(execFile)` ignores an `input` option, so `gh api --input -` waited
 * on a stdin nobody wrote. Nothing caught it: the unit tests stubbed the
 * client's methods, and the one path that would have shown it —
 * `reportCheck`, which is how every gate reports its verdict — needs a GitHub
 * App to try for real.
 */

let dir: string;
let oldPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bsf-fake-gh-"));
  const record = join(dir, "record.json");
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      "# Records argv and stdin, then answers with a plausible REST response.",
      'stdin=$(cat)',
      `printf '%s' "$stdin" > ${JSON.stringify(join(dir, "stdin.txt"))}`,
      `printf '%s\\n' "$*" > ${JSON.stringify(join(dir, "argv.txt"))}`,
      `echo '{"number":7,"html_url":"https://example.invalid/pull/7","commit":{"sha":"abc"}}' > ${JSON.stringify(record)}`,
      `cat ${JSON.stringify(record)}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  oldPath = process.env["PATH"];
  process.env["PATH"] = `${dir}:${oldPath ?? ""}`;
});

afterAll(() => {
  if (oldPath !== undefined) process.env["PATH"] = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

const gh = () => new GitHub({ repo: "owner/repo" });
const stdin = () => (existsSync(join(dir, "stdin.txt")) ? readFileSync(join(dir, "stdin.txt"), "utf8") : "");
const argv = () => readFileSync(join(dir, "argv.txt"), "utf8").trim();

describe("GitHub.send", () => {
  it("writes the body to the child's stdin", async () => {
    await gh().send("POST", "repos/owner/repo/pulls", { title: "a title", body: "a body" });
    expect(JSON.parse(stdin())).toEqual({ title: "a title", body: "a body" });
    expect(argv()).toContain("--input -");
  });

  it("sends a body containing newlines and quotes intact", async () => {
    // Why the body goes on stdin rather than as -f pairs.
    const body = { body: 'line one\nline "two"\n| a table cell |\n`backticks`' };
    await gh().send("POST", "repos/owner/repo/issues", body);
    expect(JSON.parse(stdin())).toEqual(body);
  });

  it("passes no --input when there is no body", async () => {
    writeFileSync(join(dir, "stdin.txt"), "");
    await gh().send("DELETE", "repos/owner/repo/issues/1/labels/x");
    expect(argv()).not.toContain("--input");
    expect(stdin()).toBe("");
  });

  it("reports a check run with the output GitHub expects", async () => {
    await gh().reportCheck({
      name: "factory/gates",
      headSha: "f".repeat(40),
      conclusion: "failure",
      title: "two gates failed",
      summary: "| gate | verdict |\n| --- | --- |\n| static | failed |",
    });
    const sent = JSON.parse(stdin()) as Record<string, unknown>;
    expect(sent["name"]).toBe("factory/gates");
    expect(sent["head_sha"]).toBe("f".repeat(40));
    expect(sent["conclusion"]).toBe("failure");
    expect(sent["status"]).toBe("completed");
    expect((sent["output"] as { summary: string }).summary).toContain("| static | failed |");
  });

  it("truncates a summary to GitHub's limit rather than being rejected", async () => {
    await gh().reportCheck({
      name: "factory/gates",
      headSha: "a".repeat(40),
      conclusion: "success",
      title: "t",
      summary: "x".repeat(100_000),
    });
    const sent = JSON.parse(stdin()) as { output: { summary: string } };
    expect(sent.output.summary.length).toBe(65_000);
  });

  it("sends workflow inputs, which a dispatch without them silently ignores", async () => {
    await gh().dispatchWorkflow("factory-garden.yml", "main", { reason: "nightly" });
    expect(JSON.parse(stdin())).toEqual({ ref: "main", inputs: { reason: "nightly" } });
  });

  it("opens a pull request with its body", async () => {
    const pr = await gh().openPull({ title: "t", head: "h", base: "main", body: "why" });
    expect(pr.number).toBe(7);
    expect(JSON.parse(stdin())).toEqual({ title: "t", head: "h", base: "main", body: "why" });
  });

  it("surfaces the child's stderr when it fails", async () => {
    const failing = mkdtempSync(join(tmpdir(), "bsf-fail-gh-"));
    writeFileSync(join(failing, "gh"), '#!/bin/sh\ncat > /dev/null\necho "gh: Not Found" >&2\nexit 1\n', {
      mode: 0o755,
    });
    const saved = process.env["PATH"];
    process.env["PATH"] = `${failing}:${saved ?? ""}`;
    try {
      await expect(gh().send("POST", "repos/owner/repo/pulls", { a: 1 })).rejects.toThrow(/Not Found/);
    } finally {
      process.env["PATH"] = saved ?? "";
      rmSync(failing, { recursive: true, force: true });
    }
  });
});

describe("a gh that never finishes", () => {
  it("is killed rather than holding the job open", async () => {
    const slow = mkdtempSync(join(tmpdir(), "bsf-slow-gh-"));
    writeFileSync(join(slow, "gh"), "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
    const saved = process.env["PATH"];
    process.env["PATH"] = `${slow}:${saved ?? ""}`;
    try {
      // The real timeout is fifteen minutes; this proves the mechanism.
      const client = new GitHub({ repo: "owner/repo", timeoutMs: 300 });
      await expect(client.get("repos/owner/repo")).rejects.toThrow(/did not finish in time/);
    } finally {
      process.env["PATH"] = saved ?? "";
      rmSync(slow, { recursive: true, force: true });
    }
  }, 20_000);
});
