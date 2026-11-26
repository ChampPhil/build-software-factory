import { describe, expect, it } from "vitest";
import { detectEnforcement, enforcementFromConfig, withBranchProtection } from "../src/lib/enforcement.js";
import type { GitHub } from "../src/lib/github.js";

const gh = (priv: boolean, protection: "ok" | "upgrade" | "none"): GitHub =>
  ({
    repo: "o/r",
    get: (path: string) => {
      if (path.endsWith("/protection")) {
        if (protection === "ok") return Promise.resolve({});
        if (protection === "upgrade") return Promise.reject(new Error("HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature."));
        return Promise.reject(new Error("HTTP 404: Branch not protected"));
      }
      return Promise.resolve({ private: priv });
    },
  }) as unknown as GitHub;

describe("enforcement at setup", () => {
  it("a public repository can require checks", async () => {
    expect(await detectEnforcement(gh(false, "upgrade"), "main")).toBe("on");
  });
  it("a private repository on the free plan cannot", async () => {
    expect(await detectEnforcement(gh(true, "upgrade"), "main")).toBe("off");
  });
  it("a private repository on a paid plan can, protected or not yet", async () => {
    expect(await detectEnforcement(gh(true, "none"), "main")).toBe("on");
    expect(await detectEnforcement(gh(true, "ok"), "main")).toBe("on");
  });
  it("writes only the one line in factory.yaml", () => {
    const yaml = "x: 1\nenforcement:\n  merge_queue: auto\n  branch_protection: auto\n  audit_revert_pr: false\ny: 2\n";
    expect(withBranchProtection(yaml, "off")).toBe("x: 1\nenforcement:\n  merge_queue: auto\n  branch_protection: off\n  audit_revert_pr: false\ny: 2\n");
  });
  it("maps the stored value to what the dashboard shows", () => {
    expect(enforcementFromConfig("off")).toBe("audit");
    expect(enforcementFromConfig("on")).toBe("branch_protection");
    expect(enforcementFromConfig("auto")).toBeNull();
  });
});
