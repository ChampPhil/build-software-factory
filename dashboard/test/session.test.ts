import { describe, it, expect } from "vitest";
import { connectRepo, looksLikeToken, selectRepo, validRepo } from "../lib/session.js";

describe("repo validation", () => {
  it("accepts owner/name", () => {
    expect(validRepo("ChampPhil/trinsports")).toBe(true);
    expect(validRepo("bsf-fixtures/ts-webapp")).toBe(true);
    expect(validRepo("  owner/name  ")).toBe(true);
  });

  it("rejects a URL, a bare name, or a path with extra segments", () => {
    expect(validRepo("https://github.com/owner/name")).toBe(false);
    expect(validRepo("name")).toBe(false);
    expect(validRepo("owner/name/tree/main")).toBe(false);
    expect(validRepo("")).toBe(false);
  });
});

describe("which repository the pages show", () => {
  it("starts the list with the first connection and appends the next", () => {
    const first = connectRepo([], "acme/widgets");
    expect(first).toEqual(["acme/widgets"]);
    expect(connectRepo(first, "other/name")).toEqual(["acme/widgets", "other/name"]);
    expect(connectRepo(first, "acme/widgets")).toEqual(["acme/widgets"]);
    expect(connectRepo(first, "not a repo")).toEqual(["acme/widgets"]);
  });

  it("switches only to a repository that is already connected", () => {
    const repos = ["acme/widgets", "other/name"];
    expect(selectRepo(repos, "acme/widgets", "other/name")).toBe("other/name");
    expect(selectRepo(repos, "acme/widgets", "missing/repo")).toBe("acme/widgets");
    expect(selectRepo(repos, "acme/widgets", "acme/widgets")).toBe("acme/widgets");
  });
});

describe("token shape", () => {
  it("recognises a fine-grained token", () => {
    expect(looksLikeToken(`github_pat_${"a".repeat(40)}`)).toBe(true);
  });

  it("recognises a classic token", () => {
    expect(looksLikeToken(`ghp_${"b".repeat(36)}`)).toBe(true);
  });

  it("rejects something obviously not a token, so the user is told before a 401", () => {
    expect(looksLikeToken("")).toBe(false);
    expect(looksLikeToken("my password")).toBe(false);
    expect(looksLikeToken("short")).toBe(false);
  });
});
