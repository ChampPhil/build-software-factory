import { describe, it, expect } from "vitest";
import { GitHubClient } from "../lib/github.js";
import { buildRequest, readFirstRequest } from "../lib/request.js";
import { questionFrom, waitingFor, waitingOn } from "../lib/questions.js";
import type { LedgerOpenItem } from "../lib/types.js";

describe("a request typed into the dashboard", () => {
  it("is shaped like the factory's own forms, with the goal in its own section", () => {
    const r = buildRequest({ kind: "feature", title: "CSV export", details: "Let me export my data.", goal: "A signed-in user can download a CSV." });
    expect(r?.title).toBe("[Feature] CSV export");
    expect(r?.body).toContain("### What do you want?\n\nLet me export my data.");
    expect(r?.body).toContain("### Goal\n\nA signed-in user can download a CSV.");
    expect(r?.labels).toEqual([]);
  });

  it("labels the two kinds of work that are not a feature or a bug", () => {
    expect(buildRequest({ kind: "harden", title: "x", details: "", goal: "" })?.labels).toEqual(["factory:harden"]);
    expect(buildRequest({ kind: "tidy", title: "x", details: "", goal: "" })?.labels).toEqual(["factory:tidy"]);
  });

  it("leaves out an empty goal, uses the title when there are no details, and refuses no title", () => {
    const r = buildRequest({ kind: "bug", title: "Crash on save", details: "  ", goal: " " });
    expect(r?.body).not.toContain("### Goal");
    expect(r?.body).toContain("Crash on save");
    expect(buildRequest({ kind: "bug", title: "  ", details: "d", goal: "" })).toBeNull();
  });

  it("sends the labels with the issue", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(new Response(JSON.stringify({ number: 3, html_url: "u" }), { status: 201 }));
    }) as unknown as typeof globalThis.fetch;
    await new GitHubClient({ token: "t", repo: "o/r" }, fetch).createIssue("t", "b", ["factory:tidy"]);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ title: "t", labels: ["factory:tidy"] });
  });
});

describe("the first request setup suggests", () => {
  it("reads a usable suggestion and ignores a broken file", () => {
    expect(readFirstRequest({ title: " Add a README badge ", details: "d", goal: "g" })).toEqual({ title: "Add a README badge", details: "d", goal: "g" });
    expect(readFirstRequest({ title: "" })).toBeNull();
    expect(readFirstRequest("nope")).toBeNull();
    expect(readFirstRequest(null)).toBeNull();
  });
});

const open = (over: Partial<LedgerOpenItem>): LedgerOpenItem => ({ work_item: "wi_1", pipeline: "product_work", status: "needs_info", ...over });

describe("questions waiting on an answer", () => {
  it("lists only items waiting on one, with the issue to answer on", () => {
    const w = waitingOn([open({ source_ref: "#12" }), open({ work_item: "wi_2", status: "queued" }), open({ work_item: "wi_3", source_ref: null })]);
    expect(w.map((x) => [x.item.work_item, x.issue])).toEqual([["wi_1", 12], ["wi_3", null]]);
  });

  it("takes the question from the factory's own newest comment", () => {
    const c = (id: number, body: string, login: string, type = "User") => ({ id, body, created_at: "t", user: { login, type } });
    expect(questionFrom([c(1, "hi", "philip"), c(2, "Which page?", "factory[bot]", "Bot"), c(3, "other", "philip")])).toBe("Which page?");
    expect(questionFrom([c(1, "hi", "philip")])).toBeNull();
  });

  it("says how long a question has waited, and never times it out", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    expect(waitingFor("2026-11-22T11:30:00Z", now)).toBe("asked just now");
    expect(waitingFor("2026-11-22T07:00:00Z", now)).toBe("asked 5 hours ago");
    expect(waitingFor("2026-11-10T12:00:00Z", now)).toBe("asked 12 days ago");
    expect(waitingFor(undefined, now)).toBeNull();
  });
});
