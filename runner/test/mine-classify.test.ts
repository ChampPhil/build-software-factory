import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitLabels, labelsFrom, miningSummary, splitFindings, assembleMine,
} from "../src/commands/mine-classify.js";
import type { Correction } from "../src/commands/mine.js";
import type { RepoMining } from "../src/commands/mine-repo.js";
import type { GithubMining } from "../src/commands/mine-github.js";

const emptyRepo = (): RepoMining => ({ reverts: [], fixes: [], prose: [], asCorrections: [] });
const emptyGithub = (): GithubMining => ({ reviews: [], bugs: [], note: "" });

describe("labelsFrom", () => {
  const pending = [{
    id: "fix:abc",
    source: "fix_commit" as const,
    text: "fix: the invoice total was off by one",
    at: null,
    session: "abc",
  }];

  it("drops a quote that was not copied from the finding", () => {
    const raw = JSON.stringify({
      labels: [{ id: "fix:abc", kind: "rule", enforcement: "verification", quote: "always round half away from zero" }],
    });
    const parsed = labelsFrom(raw, pending);
    expect(parsed.labels).toHaveLength(0);
    expect(parsed.missing).toEqual(["fix:abc"]);
  });

  it("keeps a quote that is a span of the finding", () => {
    const raw = JSON.stringify({
      labels: [{ id: "fix:abc", kind: "once", enforcement: "context", quote: "invoice total was off" }],
    });
    const parsed = labelsFrom(raw, pending);
    expect(parsed.missing).toEqual([]);
    expect(parsed.labels[0]?.kind).toBe("once");
  });
});

describe("admitLabels", () => {
  it("admits only rules", () => {
    const pending = [{
      id: "fix:abc",
      source: "fix_commit" as const,
      text: "fix: the invoice total was off by one",
      at: null,
      session: "abc",
    }];
    const kept = admitLabels(pending, [{
      id: "fix:abc",
      kind: "once",
      enforcement: "context",
      quote: "invoice total was off",
    }]);
    expect(kept).toHaveLength(0);
    const rule = admitLabels(pending, [{
      id: "fix:abc",
      kind: "rule",
      enforcement: "verification",
      quote: "invoice total was off",
    }]);
    expect(rule[0]?.enforcement).toBe("verification");
    expect(rule[0]?.text).toBe("invoice total was off");
  });
});

describe("splitFindings", () => {
  it("holds a fix subject for the classifier and keeps a revert", () => {
    const revert: Correction = {
      text: "Revert the invoice change",
      source: "revert",
      session: "aaaa",
      at: "2026-01-01T00:00:00Z",
      confidence: 0.9,
      signals: ["revert"],
    };
    const split = splitFindings({
      session: [],
      repo: { ...emptyRepo(), reverts: [], fixes: [{
        commit: "abc",
        subject: "fix login",
        at: "2026-01-02T00:00:00Z",
        files: ["a.ts"],
        fixes: ["def"],
      }], asCorrections: [revert] },
      github: emptyGithub(),
    });
    expect(split.clear.map((c) => c.source)).toEqual(["revert"]);
    expect(split.pending.map((p) => p.id)).toEqual(["fix:abc"]);
  });
});

describe("assembleMine", () => {
  it("finishes when nothing is waiting for a label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mine-"));
    const done = await assembleMine({
      session: { available: false, corrections: [], searched: 0, note: "no sessions" },
      clear: [],
      pending: [],
      counts: { session_searches: 0, reverts: 0, fixes: 0, reviews: 0, bugs: 0, prose: 0 },
      notes: [],
      out: join(dir, "candidates.json"),
      reportPath: join(dir, "mining-report.json"),
      now: "2026-11-28T00:00:00Z",
    });
    expect(done.code).toBe(0);
    expect(done.lines.join("\n")).toContain(miningSummary({
      session_searches: 0, reverts: 0, fixes: 0, reviews: 0, bugs: 0, prose: 0,
    }));
  });

  it("stops setup while a finding has no label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mine-"));
    const done = await assembleMine({
      session: { available: false, corrections: [], searched: 0, note: "no sessions" },
      clear: [],
      pending: [{ id: "fix:abc", source: "fix_commit", text: "fix: the invoice total was off by one", at: null, session: "abc" }],
      counts: { session_searches: 0, reverts: 0, fixes: 1, reviews: 0, bugs: 0, prose: 0 },
      notes: [],
      out: join(dir, "candidates.json"),
      reportPath: join(dir, "mining-report.json"),
      now: "2026-11-28T00:00:00Z",
    });
    expect(done.code).toBe(2);
  });
});
