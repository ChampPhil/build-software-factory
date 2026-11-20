import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  ADAPTERS, readyHarnesses, blockedHarnesses, keysNeeded, resolveMemexSource,
  GH_AW_ENGINES_NOT_YET_ADOPTED, type HarnessId,
} from "../../adapters/adapters.js";

/**
 * memex's own source names, from `SourceKind` in its `src/types.rs`. Copied
 * rather than resolved at test time because memex is not installed here; the
 * runtime check against the installed memex is `resolveMemexSource`, and this
 * list is what catches a typo in an adapter entry.
 */
const MEMEX_SOURCES = [
  "claude", "codex", "opencode", "cursor", "pi", "openclaw", "copilot", "omp",
  "grok", "hermes", "jcode", "muse", "antigravity", "bob", "zcode", "kiro",
  "kilocode", "kimi", "goose",
] as const;

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

  it("the built-in engines are the two gh-aw ships in its compiler", () => {
    const builtins = IDS.filter((id) => ADAPTERS[id].status.kind === "builtin").sort();
    expect(builtins).toEqual(["claude-code", "pi"]);
    expect(ADAPTERS["claude-code"].engineId).toBe("claude");
    expect(ADAPTERS["pi"].engineId).toBe("pi");
  });

  it("three harnesses can run a role today: the two built in, plus Cursor from gh-aw's own definition", () => {
    expect([...readyHarnesses()].sort()).toEqual(["claude-code", "cursor-cli", "pi"]);
    expect(ADAPTERS["cursor-cli"].status.kind).toBe("vendored");
  });

  it("the two that are blocked are blocked on the CLI, and say so", () => {
    const blocked = blockedHarnesses();
    expect(blocked.map((b) => b.id).sort()).toEqual(["hermes-agent", "kilo-code"]);
    for (const b of blocked) {
      // The first reason is the one that matters: gh-aw has no engine for it,
      // so there is nothing to vendor and the definition has to be written.
      expect(b.needs[0], b.id).toContain("gh-aw ships no engine");
    }
  });

  it("a vendored definition uses the engine id gh-aw's own file declares", () => {
    // gh-aw's file says `id: cursor`, and the id in the definition is what a
    // role workflow must set — not this project's name for the harness.
    expect(ADAPTERS["cursor-cli"].engineId).toBe("cursor");
    expect(ADAPTERS["cursor-cli"].id).toBe("cursor-cli");
  });

  it("records the gh-aw engines not yet adopted, since that is how the set grows cheaply", () => {
    const ids = GH_AW_ENGINES_NOT_YET_ADOPTED.map((e) => e.engineId);
    expect(ids).toContain("codex");
    expect(ids).toContain("opencode");
    expect(ids).toContain("goose");
    // None of them is already a harness here, or the list is stale.
    for (const e of GH_AW_ENGINES_NOT_YET_ADOPTED) {
      expect(IDS.map((id) => ADAPTERS[id].engineId), e.engineId).not.toContain(e.engineId);
    }
    // Any memex source named must be one memex actually has.
    for (const e of GH_AW_ENGINES_NOT_YET_ADOPTED) {
      if (e.memexSource !== null) expect(MEMEX_SOURCES, e.engineId).toContain(e.memexSource);
    }
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

  it("every memex source name is one memex actually has", () => {
    // These were read from memex's own SourceKind enum rather than guessed. A
    // name that is not memex's fails silently at runtime — no tokens, and a
    // cost of zero the budget would believe — so it is checked here too.
    for (const id of IDS) {
      expect(MEMEX_SOURCES, `${id} names a source memex does not have`).toContain(
        ADAPTERS[id].memex.source,
      );
    }
  });

  it("still verifies the name against the installed memex rather than trusting it", () => {
    // A rename upstream would otherwise be invisible until the step reports
    // zero tokens.
    const text = readFileSync(join(ROOT, "adapters/adapters.ts"), "utf8");
    expect(text).toContain("resolveMemexSource");
    expect(resolveMemexSource("pi", [{ name: "claude" }]).ok).toBe(false);
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
  it("matches memex's own source name first", () => {
    const r = resolveMemexSource("claude-code", [{ name: "claude", engine: "Claude Code" }]);
    expect(r.ok && r.source).toBe("claude");
    expect(r.ok && r.how).toBe("recorded_name");
  });

  it("falls back to the engine label when the name has changed", () => {
    const r = resolveMemexSource("claude-code", [{ name: "claude-code-v2", engine: "Claude Code" }]);
    expect(r.ok && r.source).toBe("claude-code-v2");
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
      expect(doc.engine?.behaviors).toHaveProperty("execution");
      // The CLI has to get onto the runner somehow: either gh-aw's installer
      // block, or a harness script that fetches it (which is what gh-aw's own
      // Cursor definition does).
      const b = doc.engine?.behaviors as Record<string, unknown>;
      const installs = "installation" in b || "harness-script" in b;
      if (!installs) {
        // A definition that never installs the CLI cannot run a step. That is
        // allowed only while the adapter says the install is unresolved — as
        // Hermes Agent's is, because its installer builds its own toolchain
        // and pins nothing.
        const id = IDS.find((x) => ADAPTERS[x].engineDefinition === f)!;
        expect(
          ADAPTERS[id].status.needs.join(" "),
          `${f} never installs the CLI and the adapter does not say so`,
        ).toMatch(/install/i);
      }
    }
  });

  it("a vendored definition ships gh-aw's log parser, which is how tokens reach the step report", () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, "cursor-cli.md"), "utf8"))![1]!;
    const doc = parseYaml(fm) as { engine: { behaviors: Record<string, unknown> } };
    expect(doc.engine.behaviors).toHaveProperty("log-parser");
  });

  it("records where a vendored definition came from, so it can be updated", () => {
    expect(existsSync(join(dir, "VENDORED-FROM-GH-AW")), "no commit recorded").toBe(true);
    expect(readFileSync(join(dir, "VENDORED-FROM-GH-AW"), "utf8").trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(dir, "cursor-cli.NOTES.md"))).toBe(true);
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
      const text = readFileSync(join(dir, f), "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)![1]!;
      const doc = parseYaml(fm) as {
        engine: { version?: string; behaviors?: { installation?: { version?: string } } };
      };
      // A pin can be in the frontmatter or, as in gh-aw's Cursor definition,
      // in the harness script that downloads the archive.
      const pinned =
        doc.engine.version ??
        doc.engine.behaviors?.installation?.version ??
        /const version = "([^"]+)"/.exec(fm)?.[1];
      expect(pinned, `${f} pins no version`).toBeTruthy();
      expect(String(pinned), `${f} pins a floating version`).not.toMatch(/latest|\*/);
    }
  });

  it("the vendored Cursor definition pins the exact archive it was reviewed with", () => {
    // A silent change to this pin is a different CLI running the factory's
    // builder, so it is asserted rather than merely required to exist.
    const text = readFileSync(join(dir, "cursor-cli.md"), "utf8");
    expect(text).toContain('const version = "2026.10.14-941492e"');
  });

  it("a definition this project wrote says in the file that it is unverified", () => {
    // Our own definitions are written from gh-aw's schema and samples, not
    // from a CLI that has been run, and saying so in the file is the point. A
    // vendored definition is exempt: gh-aw verifies its own, with conformance
    // and smoke workflows.
    for (const id of IDS) {
      const f = ADAPTERS[id].engineDefinition;
      if (f === null || ADAPTERS[id].status.kind === "vendored") continue;
      const text = readFileSync(join(dir, f), "utf8");
      expect(text.toLowerCase(), `${f} does not say it is unverified`).toMatch(
        /unverified|not verified|not been run|unconfirmed/,
      );
    }
  });
});
