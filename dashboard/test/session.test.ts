import { describe, it, expect, beforeEach, vi } from "vitest";
import { validRepo, looksLikeToken } from "../lib/session.js";

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
