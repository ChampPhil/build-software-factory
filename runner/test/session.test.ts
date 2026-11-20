import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageFromSession, readSessionUsage } from "../src/lib/session.js";
import { buildStepReport } from "../src/commands/step-report.js";

describe("usageFromSession", () => {
  it("sums tokens across accounting events", () => {
    const u = usageFromSession(
      [
        { type: "usage.report", usage: { input_tokens: 100, output_tokens: 10 } },
        { type: "usage.report", usage: { input_tokens: 50, output_tokens: 5 } },
      ],
      "agent_session",
    );
    expect(u?.tokensIn).toBe(150);
    expect(u?.tokensOut).toBe(15);
  });

  it("treats camelCase and snake_case as the same metric, not two", () => {
    // gh-aw's spec is explicit: aliases identify one metric. Adding them
    // would double every count on an engine that emits both spellings.
    const u = usageFromSession([{ usage: { input_tokens: 100, inputTokens: 100 } }], "agent_session");
    expect(u?.tokensIn).toBe(100);
  });

  it("reads cache counters under either spelling", () => {
    const u = usageFromSession(
      [{ usage: { cache_read_input_tokens: 7, cacheCreationInputTokens: 3 } }],
      "agent_session",
    );
    expect(u?.cacheRead).toBe(7);
    expect(u?.cacheWrite).toBe(3);
  });

  it("returns a null cost when tokens were counted but no cost was reported", () => {
    // Absence is not zero: the budget pauses pipelines on spend, so a
    // fabricated zero silently raises what the factory may spend.
    const u = usageFromSession([{ usage: { input_tokens: 10, output_tokens: 1 } }], "agent_session");
    expect(u?.tokensIn).toBe(10);
    expect(u?.costUsd).toBeNull();
  });

  it("keeps a reported cost of zero, which is a measurement", () => {
    const u = usageFromSession([{ totalCostUsd: 0, usage: { input_tokens: 1 } }], "agent_session");
    expect(u?.costUsd).toBe(0);
  });

  it("reads the nested data.usage shape too", () => {
    const u = usageFromSession([{ type: "session.result", data: { usage: { output_tokens: 42 } } }], "agent_session");
    expect(u?.tokensOut).toBe(42);
  });

  it("returns null when no event carried any accounting at all", () => {
    expect(usageFromSession([{ type: "assistant.message" }], "agent_session")).toBeNull();
    expect(usageFromSession([], "agent_session")).toBeNull();
  });

  it("survives a truncated last line, which a log still being written has", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-"));
    writeFileSync(
      join(dir, "agent-session.jsonl"),
      `${JSON.stringify({ usage: { input_tokens: 5 } })}\n{"usage":{"inp`,
    );
    expect(readSessionUsage([dir])?.tokensIn).toBe(5);
  });
});

describe("readSessionUsage", () => {
  it("prefers gh-aw's normalized session over the proxy's metering", () => {
    // The proxy counts what crossed the firewall, which can include gh-aw's
    // own calls as well as the agent's.
    const dir = mkdtempSync(join(tmpdir(), "session-"));
    writeFileSync(join(dir, "agent-session.jsonl"), JSON.stringify({ usage: { input_tokens: 1 } }));
    writeFileSync(join(dir, "token-usage.jsonl"), JSON.stringify({ usage: { input_tokens: 999 } }));
    const u = readSessionUsage([dir]);
    expect(u?.tokensIn).toBe(1);
    expect(u?.from).toBe("agent_session");
  });

  it("falls back to the proxy's metering when the session file has no accounting", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-"));
    writeFileSync(join(dir, "agent-session.jsonl"), JSON.stringify({ type: "assistant.message" }));
    writeFileSync(join(dir, "token-usage.jsonl"), JSON.stringify({ usage: { input_tokens: 42 } }));
    const u = readSessionUsage([dir]);
    expect(u?.tokensIn).toBe(42);
    expect(u?.from).toBe("token_usage");
  });

  it("tries each candidate directory, since gh-aw's layout differs by job", () => {
    const a = mkdtempSync(join(tmpdir(), "session-a-"));
    const b = mkdtempSync(join(tmpdir(), "session-b-"));
    mkdirSync(join(b, "nested"), { recursive: true });
    writeFileSync(join(b, "agent-session.jsonl"), JSON.stringify({ usage: { output_tokens: 8 } }));
    expect(readSessionUsage([a, b])?.tokensOut).toBe(8);
  });

  it("returns null when neither file is there", () => {
    expect(readSessionUsage([mkdtempSync(join(tmpdir(), "session-"))])).toBeNull();
  });
});

describe("step report, wired to gh-aw's evidence", () => {
  const base = {
    harness: "claude-code" as const,
    role: "builder",
    model: "claude-opus-5",
    exit: "ok" as const,
    durationSec: 10,
    filesChanged: [],
    transcript: "sessions/run-1/builder.jsonl",
  };

  it("takes gh-aw's cost over the harness's own log", () => {
    const sess = mkdtempSync(join(tmpdir(), "session-"));
    writeFileSync(
      join(sess, "agent-session.jsonl"),
      JSON.stringify({ totalCostUsd: 0.25, usage: { input_tokens: 10, output_tokens: 2 } }),
    );
    const harness = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(harness, "usage.json");
    writeFileSync(p, JSON.stringify({ input_tokens: 999, output_tokens: 999, total_cost_usd: 9.99 }));

    const r = buildStepReport({ ...base, sessionDirs: [sess], usagePath: p });
    expect(r.cost_usd).toBe(0.25);
    expect(r.tokens.in).toBe(10);
    expect(r.usage_source).toBe("agent_session");
  });

  it("falls back to the harness's log when gh-aw left no accounting", () => {
    const harness = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(harness, "usage.json");
    writeFileSync(p, JSON.stringify({ input_tokens: 7, output_tokens: 1, total_cost_usd: 0.01 }));
    const r = buildStepReport({ ...base, sessionDirs: [mkdtempSync(join(tmpdir(), "empty-"))], usagePath: p });
    expect(r.usage_source).toBe("harness_log");
    expect(r.cost_usd).toBe(0.01);
  });

  it("prices gh-aw's tokens when gh-aw reported no cost", () => {
    const sess = mkdtempSync(join(tmpdir(), "session-"));
    writeFileSync(join(sess, "agent-session.jsonl"), JSON.stringify({ usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
    const r = buildStepReport({ ...base, sessionDirs: [sess], priceTable: { "claude-opus-5": { in: 3, out: 15 } } });
    expect(r.cost_usd).toBe(3);
    expect(r.cost_source).toBe("price_table");
    expect(r.usage_source).toBe("agent_session");
  });

  it("reports unknown, and no usage source, when nothing had either", () => {
    const r = buildStepReport({ ...base, sessionDirs: [mkdtempSync(join(tmpdir(), "empty-"))] });
    expect(r.cost_source).toBe("unknown");
    expect(r.usage_source).toBeUndefined();
  });
});
