import { describe, expect, it } from "vitest";
import { ago, dur, issueOf, needsFrom, pipelineOfLabels, requestsFrom, sortRequests, summaryOf, titleOf, usd, day, countWord } from "../lib/view";
import { parsePatch } from "../lib/diff";
import type { LedgerFile, WorkItemDoc } from "../lib/types";
import type { IssueSummary, PullSummary } from "../lib/github";

const ledger = (over: Partial<LedgerFile> = {}): LedgerFile => ({ schema: "ledger/1", updated_at: "", open: [], recent: [], merge_queue: [], ...over });
const pull = (number: number, labels: string[], draft = false): PullSummary => ({
  number, title: `PR ${number}`, draft, html_url: "", created_at: "", updated_at: "", user: null, labels: labels.map((name) => ({ name })), head: { ref: "b", sha: "s" },
});
const issue = (number: number, association: string, labels: string[] = [], pr = false): IssueSummary => ({
  number, title: `Issue ${number}`, html_url: "", created_at: "", user: { login: "x" }, labels: labels.map((name) => ({ name })), author_association: association, ...(pr ? { pull_request: {} } : {}),
});
const doc = (id: string, title: string, ref: string | null = null): WorkItemDoc => ({
  id, created_at: "2026-11-20T10:00:00Z", pipeline: "product_work", title, body: null, status: "queued", pr: null, parent: null, source: { kind: "issue", ref, actor: "maya" },
});

describe("what is waiting on a person", () => {
  it("puts questions first, then finished work, then practices, stuck work, strangers and candidates", () => {
    const needs = needsFrom({
      ledger: ledger({
        open: [
          { work_item: "wi-3", pipeline: "product_work", status: "escalated", source_ref: "#3" },
          { work_item: "wi-1", pipeline: "product_work", status: "needs_info", source_ref: "#1" },
          { work_item: "wi-2", pipeline: "product_work", status: "in_review", pr: 20 },
          { work_item: "wi-4", pipeline: "product_work", status: "waiting_trust", source_ref: "#4" },
        ],
      }),
      pulls: [pull(20, ["factory:product-work", "factory:cleared"]), pull(21, ["factory:definition"])],
      issues: [issue(4, "NONE"), issue(5, "NONE")],
      candidates: [{ id: "c", problem_class: "p", occurrences: 2, sources: [], proposed_fix: "static_rule", status: "pending" }],
    });
    expect(needs.map((n) => n.kind)).toEqual(["question", "review", "practice", "escalated", "trust", "outside", "candidate"]);
    const review = needs[1];
    expect(review?.kind === "review" && review.item?.work_item).toBe("wi-2");
  });

  it("does not ask a person to merge a draft, an uncleared PR, or one that merges itself", () => {
    const needs = needsFrom({
      ledger: ledger({ merge_queue: [{ pr: 32, eligible_at: "" }] }),
      pulls: [pull(30, ["factory:product-work"], true), pull(31, ["factory:product-work"]), pull(32, ["factory:gardening", "factory:cleared"]), pull(33, [])],
      issues: [],
      candidates: [],
    });
    expect(needs).toEqual([]);
  });

  it("leaves out trusted people, accepted issues and pull requests listed among issues", () => {
    const needs = needsFrom({
      ledger: null,
      pulls: [],
      issues: [issue(1, "OWNER"), issue(2, "COLLABORATOR"), issue(3, "NONE", ["factory:accept"]), issue(4, "NONE", [], true)],
      candidates: [],
    });
    expect(needs).toEqual([]);
  });
});

describe("requests", () => {
  it("joins the ledger with the work item files, open ones before finished ones", () => {
    const list = requestsFrom(
      ledger({
        open: [{ work_item: "wi-1", pipeline: "gardening", status: "queued", source_ref: "#7", priority: "high" }],
        recent: [{ work_item: "wi-0", status: "merged", merged_at: "2026-11-20T10:00:00Z", pr: 9 }, { work_item: "wi-1", status: "merged" }],
      }),
      { "wi-1": doc("wi-1", "[Tidy] Remove helpers"), "wi-0": doc("wi-0", "Show totals", "#2") },
    );
    expect(list.map((r) => [r.id, r.title, r.status, r.issue, r.open])).toEqual([
      ["wi-1", "Remove helpers", "queued", 7, true],
      ["wi-0", "Show totals", "merged", 2, false],
    ]);
    expect(list[0]?.priority).toBe("high");
    expect(list[1]?.pr).toBe(9);
  });

  it("names a request without a file by its issue, then by its id", () => {
    expect(titleOf(undefined, issue(4, "OWNER"), "wi-9")).toBe("Issue 4");
    expect(titleOf(null, undefined, "wi-9")).toBe("Request wi-9");
  });

  it("sorts what needs a person to the top", () => {
    const sorted = sortRequests(
      requestsFrom(ledger({ open: [
        { work_item: "a", pipeline: "product_work", status: "queued" },
        { work_item: "b", pipeline: "product_work", status: "needs_info" },
        { work_item: "c", pipeline: "product_work", status: "escalated" },
      ] }), {}),
    );
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("the words", () => {
  it("reads an issue reference and nothing else", () => {
    expect(issueOf("#42")).toBe(42);
    expect(issueOf("https://slack.com/x")).toBeNull();
    expect(issueOf(null)).toBeNull();
  });

  it("finds a pull request's pipeline from its labels", () => {
    expect(pipelineOfLabels([{ name: "bug" }, { name: "factory:gardening" }])).toBe("gardening");
    expect(pipelineOfLabels([])).toBeNull();
  });

  it("says durations and money the way a person would", () => {
    expect(dur(40)).toBe("40 s");
    expect(dur(1860)).toBe("31 min");
    expect(dur(5400)).toBe("1 h 30 min");
    expect(usd(2.5)).toBe("$2.50");
    expect(usd(1234)).toBe("$1,234");
    expect(countWord(2)).toBe("Two");
    expect(countWord(12)).toBe("12");
  });

  it("says how long ago, and never a negative time", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(ago("2026-11-25T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-25T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-11-24T12:00:00Z", now)).toBe("a day ago");
    expect(ago("2026-11-25T14:00:00Z", now)).toBe("in 2 hours");
  });

  it("keeps a bare date on its own day", () => {
    expect(day("2026-11-03")).toBe("Nov 3");
  });

  it("takes a pull request's summary from the lines before its first heading", () => {
    expect(summaryOf("Adds **Export** to the list.\n- Keeps `currency`.\n- See [docs](http://x).\n\n## Proof\nignored")).toEqual(["Adds Export to the list.", "Keeps currency.", "See docs."]);
    expect(summaryOf(null)).toEqual([]);
  });
});

describe("a diff", () => {
  it("numbers both sides, so a comment lands on the line it was written about", () => {
    const lines = parsePatch("@@ -10,3 +10,4 @@ fn\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file");
    expect(lines.map((l) => [l.kind, l.old, l.now])).toEqual([
      ["@", null, null],
      [" ", 10, 10],
      ["-", 11, null],
      ["+", null, 11],
      ["+", null, 12],
      [" ", 12, 13],
    ]);
  });
});
