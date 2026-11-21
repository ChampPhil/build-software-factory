import { describe, it, expect } from "vitest";
import { effectiveAssociation } from "../src/lib/github.js";

const gh = (permission: string | Error) => ({
  repo: "o/r",
  get: async <T,>(): Promise<T> => {
    if (permission instanceof Error) throw permission;
    return { permission, role_name: permission } as T;
  },
});
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

describe("trust by permission, not only by association", () => {
  it("trusts a private org member GitHub reports as NONE when they can write to the repo", async () => {
    expect(await effectiveAssociation(gh("admin"), "owner-with-private-membership", "NONE", TRUSTED)).toBe("COLLABORATOR");
    expect(await effectiveAssociation(gh("write"), "someone", "CONTRIBUTOR", TRUSTED)).toBe("COLLABORATOR");
  });

  it("keeps the association for read access, bots, and when the permission cannot be read", async () => {
    expect(await effectiveAssociation(gh("read"), "reader", "NONE", TRUSTED)).toBe("NONE");
    expect(await effectiveAssociation(gh("admin"), "app[bot]", "NONE", TRUSTED)).toBe("NONE");
    expect(await effectiveAssociation(gh(new Error("403")), "x", "NONE", TRUSTED)).toBe("NONE");
  });
});
