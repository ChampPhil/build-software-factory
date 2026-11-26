import { describe, expect, it } from "vitest";
import { saveButtonLabel, saveHint } from "../lib/save-copy";

describe("settings save copy on an audit repository", () => {
  it("never promises a merge within a minute, and the button says Open the pull request", () => {
    expect(saveHint("audit")).not.toContain("within a minute");
    expect(saveHint("audit")).toContain("you merge it");
    expect(saveHint("audit")).toContain("GitHub Pro or a public repository");
    expect(saveButtonLabel("audit", 2)).toBe("Open the pull request");
  });
  it("keeps the promise where the factory can merge", () => {
    expect(saveHint("branch_protection")).toContain("within a minute");
    expect(saveButtonLabel("branch_protection", 1)).toBe("Save 1 change");
  });
});
