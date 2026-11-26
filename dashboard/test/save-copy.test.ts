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

describe("audit wording when the plan is not the reason", () => {
  it("does not blame the plan unless setup found the plan cannot require checks", () => {
    expect(saveHint("audit", false)).not.toContain("free private plan");
    expect(saveHint("audit", false)).toContain("branch protection");
    expect(saveHint("audit", true)).toContain("free private plan");
  });
});
