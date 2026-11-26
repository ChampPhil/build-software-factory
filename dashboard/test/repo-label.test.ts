import { describe, expect, it } from "vitest";
import { REPO_NAME_FITS, repoBarLabel } from "../lib/repo-label";

describe("repository name in the top bar", () => {
  it("turns a long hyphenated name into initials", () => {
    expect(repoBarLabel("vibecoding-for-marketing")).toBe("VFM");
  });

  it("keeps a short name, so the owner and Briefing link are not given initials", () => {
    expect(repoBarLabel("widgets")).toBe("widgets");
    expect(repoBarLabel("my-app")).toBe("my-app");
    expect(repoBarLabel("a".repeat(REPO_NAME_FITS))).toBe("a".repeat(REPO_NAME_FITS));
  });

  it("uses the first five letters of a single long word", () => {
    expect(repoBarLabel("a".repeat(REPO_NAME_FITS + 1))).toBe("aaaaa");
    expect(repoBarLabel("ExtraordinaryLongName")).toBe("Extra");
  });

  it("takes one initial from each separator-separated word", () => {
    expect(repoBarLabel("alpha_beta.gamma-delta")).toBe("ABGD");
  });
});
