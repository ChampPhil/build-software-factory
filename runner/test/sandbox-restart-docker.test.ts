import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { clearContainer } from "../src/commands/sandbox.js";

// Against a real Docker daemon, where there is one (CI has one; a laptop
// without Docker skips). The fake-docker test shows the call order; this
// shows the real daemon accepts it.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasDocker)("clearContainer against a real daemon", () => {
  const name = "bsf-restart-probe";
  const run = (): number | null =>
    spawnSync("docker", ["run", "-d", "--rm", "--name", name, "alpine:3.20", "sleep", "60"], { encoding: "utf8" }).status;

  it("lets the same container name be started twice in a row, and is harmless when nothing is there", () => {
    clearContainer(name);
    try {
      expect(run()).toBe(0);
      expect(run()).not.toBe(0); // the bug: a second start without clearing conflicts
      clearContainer(name);
      expect(run()).toBe(0);
    } finally {
      clearContainer(name);
    }
  }, 120_000);
});
