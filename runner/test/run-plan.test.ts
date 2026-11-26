import { describe, it, expect } from "vitest";
import { planRun, afterGates, ROLE_SEQUENCE } from "../src/commands/run-plan.js";

describe("planRun", () => {
  it("runs the full sequence on the first attempt", () => {
    expect(planRun({ pipeline: "product_work", attempt: 1 }).roles).toEqual([
      "triage", "spec", "builder", "verifier",
    ]);
  });

  it("does not re-triage or re-spec a later attempt", () => {
    // The intent has not changed, only the code. Re-running them would pay
    // for two models to reach the same plan — or, worse, a different one.
    const plan = planRun({ pipeline: "product_work", attempt: 2 });
    expect(plan.roles).toEqual(["builder", "verifier"]);
    expect(plan.skipped).toEqual(["triage", "spec"]);
  });

  it("treats a human revision the same way", () => {
    expect(planRun({ pipeline: "product_work", attempt: 1, revision: true }).roles).toEqual([
      "builder", "verifier",
    ]);
  });

  it("escalates past the attempt cap rather than spending another run", () => {
    const plan = planRun({ pipeline: "product_work", attempt: 4 });
    expect(plan.escalate).toBe(true);
    expect(plan.roles).toHaveLength(0);
  });

  it("every pipeline ends in a verifier, except definition and factory_health", () => {
    for (const [pipeline, roles] of Object.entries(ROLE_SEQUENCE)) {
      if (pipeline === "definition" || pipeline === "factory_health") continue;
      expect(roles[roles.length - 1], `${pipeline} does not end in verification`).toBe("verifier");
    }
  });

  it("no pipeline has the builder verify its own work", () => {
    for (const roles of Object.values(ROLE_SEQUENCE)) {
      expect(roles.filter((r) => r === "verifier").length).toBeLessThanOrEqual(1);
      if (roles.includes("verifier")) {
        expect(roles.indexOf("verifier")).toBeGreaterThan(roles.indexOf("builder"));
      }
    }
  });
});

describe("afterGates", () => {
  it("clears when both gates are satisfied", () => {
    expect(afterGates({ staticGate: "passed", verificationGate: "passed", attempt: 1 }).next).toBe("clear");
  });

  it("treats a skipped gate as satisfied, because skipped means already decided for this commit", () => {
    expect(afterGates({ staticGate: "skipped", verificationGate: "skipped", attempt: 2 }).next).toBe("clear");
  });

  it("moves to verification when only the static gate has run", () => {
    expect(afterGates({ staticGate: "passed", verificationGate: "not_run", attempt: 1 }).next).toBe("verify");
  });

  it("retries a failure below the cap and escalates at it", () => {
    const retry = afterGates({ staticGate: "failed", verificationGate: "not_run", attempt: 1 });
    expect(retry.next).toBe("retry");
    expect(retry.next === "retry" && retry.attempt).toBe(2);
    expect(afterGates({ staticGate: "failed", verificationGate: "not_run", attempt: 3 }).next).toBe("escalate");
  });

  it("counts the cap per work item, not per gate", () => {
    // Otherwise a run gets six attempts by failing each gate three times.
    expect(afterGates({ staticGate: "passed", verificationGate: "failed", attempt: 3 }).next).toBe("escalate");
  });
});
