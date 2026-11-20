import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ADAPTERS, readyHarnesses, keysNeeded, resolveMemexSource, type HarnessId,
} from "../../adapters/adapters.js";

/**
 * Adapter conformance, as far as it can go without a model key and a runner.
 *
 * The part that needs a real step — "this harness's step yields token data" —
 * is what each adapter's `status.needs` records, and it is the gate on calling
 * a harness shippable (doc 07). What is checked here is everything that can be
 * checked for free, including that no adapter claims to be conformant before
 * that run has happened.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "adapters")) && existsSync(join(dir, "schema"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const ROOT = repoRoot();
const IDS = Object.keys(ADAPTERS) as HarnessId[];

describe("adapter registry", () => {
  it("has an entry for each of the five harnesses the docs name", () => {
    expect(IDS.sort()).toEqual(["claude-code", "cursor-cli", "hermes-agent", "kilo-code", "pi"]);
  });

  it("every id matches the harness enum the schemas use", () => {
    const common = JSON.parse(readFileSync(join(ROOT, "schema/_common.json"), "utf8")) as {
      $defs: { harness: { enum: string[] } };
    };
    expect(IDS.sort()).toEqual([...common.$defs.harness.enum].sort());
  });

  it("no adapter claims conformance before a real step has run", () => {
    // A harness whose step yields no token data is not shippable, and the
    // only way to know is to run one.
    for (const id of IDS) {
      if (ADAPTERS[id].status.conformance === "passed") {
        expect(ADAPTERS[id].status.needs, `${id} claims conformance`).toHaveLength(0);
      } else {
        expect(ADAPTERS[id].status.needs.length, `${id} is not conformant but needs nothing`).toBeGreaterThan(0);
      }
    }
  });

  it("the built-in engines are the two gh-aw actually ships", () => {
    expect([...readyHarnesses()].sort()).toEqual(["claude-code", "pi"]);
    expect(ADAPTERS["claude-code"].engineId).toBe("claude");
    expect(ADAPTERS["pi"].engineId).toBe("pi");
  });

  it("every non-built-in adapter names a definition file, and built-ins name none", () => {
    for (const id of IDS) {
      const a = ADAPTERS[id];
      if (a.status.kind === "builtin") expect(a.engineDefinition, id).toBeNull();
      else expect(a.engineDefinition, id).toMatch(/\.md$/);
    }
  });

  it("four harnesses share one key and Cursor needs its own", () => {
    expect([...keysNeeded(IDS)].sort()).toEqual(["ANTHROPIC_API_KEY", "CURSOR_API_KEY"]);
    expect(ADAPTERS["cursor-cli"].keySecret).toBe("CURSOR_API_KEY");
  });

  it("no adapter hardcodes a memex source name", () => {
    // memex documents store paths but not its full --source list, so a
    // guessed name fails silently: no tokens, and a cost of zero the budget
    // would believe. The name is resolved from the installed memex instead.
    const text = readFileSync(join(ROOT, "adapters/adapters.ts"), "utf8");
    expect(text).not.toMatch(/memexSource\s*:/);
    for (const id of IDS) {
      expect(ADAPTERS[id].memex).toHaveProperty("engineLabel");
      expect(ADAPTERS[id].memex).not.toHaveProperty("source");
    }
  });

  it("records only the token-usage support memex documents", () => {
    for (const id of IDS) {
      expect(["yes", "credits_only", "no"]).toContain(ADAPTERS[id].memex.tokenUsage);
    }
    // All five are "yes" in memex's own table; a "no" would make the harness
    // unshippable, which the needs list would then have to say.
    for (const id of IDS) expect(ADAPTERS[id].memex.tokenUsage, id).toBe("yes");
  });
});

describe("resolveMemexSource", () => {
  it("matches on the engine label memex uses in its own table", () => {
    const r = resolveMemexSource("claude-code", [{ name: "claude", engine: "Claude Code" }]);
    expect(r.ok && r.source).toBe("claude");
    expect(r.ok && r.how).toBe("engine_label");
  });

  it("matches a name that differs only in punctuation and case", () => {
    const r = resolveMemexSource("kilo-code", [{ name: "kilocode-cli" }]);
    expect(r.ok && r.source).toBe("kilocode-cli");
  });

  it("falls back to the documented store path", () => {
    const r = resolveMemexSource("kilo-code", [
      { name: "some-internal-name", path: "/home/p/.local/share/kilo/kilo.db" },
    ]);
    expect(r.ok && r.how).toBe("store_path");
  });

  it("refuses rather than guessing when memex has no source for the harness", () => {
    const r = resolveMemexSource("cursor-cli", [{ name: "claude" }, { name: "codex" }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("refuses the harness");
  });

  it("names the sources it did find, so the failure is diagnosable", () => {
    const r = resolveMemexSource("cursor-cli", [{ name: "claude" }, { name: "codex" }]);
    expect(!r.ok && r.reason).toContain("claude, codex");
  });
});

describe("engine definition files", () => {
  const dir = join(ROOT, "adapters");

  it("each definition a non-built-in adapter names exists", () => {
    for (const id of IDS) {
      const f = ADAPTERS[id].engineDefinition;
      if (f === null) continue;
      expect(existsSync(join(dir, f)), `adapters/${f} is missing`).toBe(true);
    }
  });

  /** The definition files, which is not every .md in the directory. */
  const definitions = (): readonly string[] =>
    IDS.map((id) => ADAPTERS[id].engineDefinition).filter((f): f is string => f !== null);

  it("each definition is a gh-aw behaviour-defined engine, not an engine.command", () => {
    // engine.command skips gh-aw's installer and leaves us owning setup steps
    // and log parsing; a behaviour-defined engine keeps both with gh-aw.
    expect(definitions().length).toBeGreaterThan(0);
    for (const f of definitions()) {
      const text = readFileSync(join(dir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
      expect(fm, `${f} has no frontmatter`).toBeDefined();
      const doc = parseYaml(fm!) as { engine?: { id?: string; behaviors?: Record<string, unknown> } };
      expect(doc.engine?.id, `${f} declares no engine id`).toBeTruthy();
      expect(doc.engine?.behaviors, `${f} has no behaviors block`).toBeDefined();
      expect(doc.engine?.behaviors).toHaveProperty("installation");
      expect(doc.engine?.behaviors).toHaveProperty("execution");
    }
  });

  it("every definition's id matches the adapter that names it", () => {
    for (const id of IDS) {
      const f = ADAPTERS[id].engineDefinition;
      if (f === null) continue;
      const text = readFileSync(join(dir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)![1]!;
      const doc = parseYaml(fm) as { engine: { id: string } };
      expect(doc.engine.id).toBe(ADAPTERS[id].engineId);
    }
  });

  it("every definition pins a version, so a CLI release cannot change a run", () => {
    for (const f of definitions()) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, f), "utf8"))![1]!;
      const doc = parseYaml(fm) as { engine: { version?: string; behaviors?: { installation?: { version?: string } } } };
      const pinned = doc.engine.version ?? doc.engine.behaviors?.installation?.version;
      expect(pinned, `${f} pins no version`).toBeTruthy();
    }
  });

  it("no definition is marked ready while its adapter still needs CLI facts", () => {
    // The definitions are written from gh-aw's schema and its own samples, not
    // from a CLI that has been run. Saying so in the file is the point.
    for (const id of IDS) {
      const f = ADAPTERS[id].engineDefinition;
      if (f === null) continue;
      const text = readFileSync(join(dir, f), "utf8");
      if (ADAPTERS[id].status.conformance === "not_run") {
        expect(text.toLowerCase(), `${f} does not say it is unverified`).toMatch(/unverified|not been run|unconfirmed/);
      }
    }
  });
});
