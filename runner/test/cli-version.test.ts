import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the runner's version", () => {
  it("is the same in cli.ts and package.json, so a release says what it is", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(/^const VERSION = "([^"]+)";$/m.exec(src)?.[1]).toBe(pkg.version);
  });
});
