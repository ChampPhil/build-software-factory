import { describe, it, expect } from "vitest";
import { GitHubClient } from "../lib/github.js";
import { evidenceOf, kindOf } from "../lib/evidence.js";
import type { StoredRoleReport } from "../lib/types.js";

const report: StoredRoleReport = {
  role: "verifier",
  attempt: 1,
  media_prefix: "reports/wi-1/verifier-1",
  report: {
    blocks: [
      { type: "summary" },
      { type: "file", file: "shots/a.png", caption: "Before" },
      { type: "file", file: "recordings/verification.pr.mp4", caption: "Walkthrough", poster: "recordings/verification.pr.gif" },
      { type: "file", file: "console.log", caption: "Console" },
    ],
  },
  videos: [{ file: "recordings/verification.pr.mp4", seconds: 42.4, bytes: 2_000_000 }],
};

describe("evidence", () => {
  it("classifies files by extension", () => {
    expect(kindOf("x.mp4")).toBe("video");
    expect(kindOf("x.WEBM")).toBe("video");
    expect(kindOf("x.gif")).toBe("image");
    expect(kindOf("x.log")).toBe("text");
  });

  it("puts recordings first and carries their length, size and poster", () => {
    const items = evidenceOf(report);
    expect(items.map((i) => i.kind)).toEqual(["video", "image", "text"]);
    expect(items[0]).toMatchObject({
      path: "reports/wi-1/verifier-1/recordings/verification.pr.mp4",
      posterPath: "reports/wi-1/verifier-1/recordings/verification.pr.gif",
      seconds: 42.4,
      bytes: 2_000_000,
    });
  });

  it("is empty with no report", () => {
    expect(evidenceOf(null)).toEqual([]);
  });
});

describe("reading media from the media ref", () => {
  const auth = { token: "github_pat_test", repo: "owner/name" };
  it("asks for the raw bytes on the media ref and returns a blob", async () => {
    const calls: { url: string; accept: string | undefined }[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, accept: (init?.headers as Record<string, string>)["accept"] });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const blob = await new GitHubClient(auth, impl).mediaFile("reports/wi 1/v.mp4");
    expect(blob?.size).toBe(3);
    expect(calls[0]?.url).toContain("contents/reports/wi%201/v.mp4?ref=refs%2Ffactory%2Fmedia");
    expect(calls[0]?.accept).toBe("application/vnd.github.raw+json");
  });

  it("returns null for a file that is gone", async () => {
    const impl = async () => new Response("{}", { status: 404 });
    expect(await new GitHubClient(auth, impl as typeof fetch).mediaFile("x.mp4")).toBeNull();
  });
});
