import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

/**
 * Verifying a rule pack.
 *
 * Phase 3 installs a rule only once it has been shown to discriminate: it must
 * fail on the `bad` example and pass on the `good` one. A rule that fails on
 * both blocks correct code; a rule that passes on both is decoration. Neither
 * is worth installing, and neither is obvious from reading the config.
 */

export interface RulePackTool {
  readonly id: string;
  readonly kind: "linter" | "formatter" | "typechecker" | "deps" | "coverage";
  readonly detect?: readonly string[];
  readonly config_file?: string;
  readonly base_config?: Record<string, unknown>;
  readonly install?: string;
  readonly check?: string;
  readonly fix?: string | null;
  readonly native_baseline?: string | null;
}

export interface RulePackRule {
  readonly id: string;
  readonly concern: string;
  readonly tool: string;
  readonly config: Record<string, unknown>;
  readonly bad: string;
  readonly good: string;
  readonly autofixable?: boolean;
  readonly severity?: "error" | "warn";
  readonly critical_logic?: boolean;
}

export interface RulePack {
  readonly schema: "rulepack/1";
  readonly language: string;
  readonly extensions?: readonly string[];
  readonly tools: readonly RulePackTool[];
  readonly rules: readonly RulePackRule[];
}

export type RuleVerdict =
  | { readonly rule: string; readonly ok: true }
  | {
      readonly rule: string;
      readonly ok: false;
      readonly reason: "accepted_the_bad_example" | "rejected_the_good_example" | "tool_error";
      readonly detail: string;
    };

/** How a tool is driven for one rule, in a throwaway directory. */
export interface ToolRunner {
  /** Returns true when the tool reports a violation. */
  violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }>;
}

export async function verifyRule(rule: RulePackRule, runner: ToolRunner): Promise<RuleVerdict> {
  let bad: { violates: boolean; detail: string };
  let good: { violates: boolean; detail: string };
  try {
    bad = await runner.violates(rule, rule.bad);
    good = await runner.violates(rule, rule.good);
  } catch (err) {
    return { rule: rule.id, ok: false, reason: "tool_error", detail: (err as Error).message };
  }

  if (!bad.violates) {
    return {
      rule: rule.id,
      ok: false,
      reason: "accepted_the_bad_example",
      detail:
        `the rule did not fire on its own bad example, so it would not catch ` +
        `what it exists to catch.\n${bad.detail}`,
    };
  }
  if (good.violates) {
    return {
      rule: rule.id,
      ok: false,
      reason: "rejected_the_good_example",
      detail:
        `the rule fired on the dominant pattern, so installing it would block ` +
        `correct code.\n${good.detail}`,
    };
  }
  return { rule: rule.id, ok: true };
}

export async function verifyPack(
  pack: RulePack,
  runnerFor: (tool: RulePackTool) => ToolRunner | null,
): Promise<readonly RuleVerdict[]> {
  const byId = new Map(pack.tools.map((t) => [t.id, t]));
  const out: RuleVerdict[] = [];
  for (const rule of pack.rules) {
    const tool = byId.get(rule.tool);
    if (tool === undefined) {
      out.push({
        rule: rule.id,
        ok: false,
        reason: "tool_error",
        detail: `rule names tool "${rule.tool}", which this pack does not declare`,
      });
      continue;
    }
    const runner = runnerFor(tool);
    if (runner === null) continue; // tool not available here; skipped by the caller
    out.push(await verifyRule(rule, runner));
  }
  return out;
}

/* ------------------------------------------------------------ eslint runner */

/**
 * Runs eslint with only this rule turned on, in a throwaway directory, so the
 * verdict is about the rule and not about the repo's other settings.
 */
export class EslintRunner implements ToolRunner {
  constructor(
    private readonly repoRoot: string,
    private readonly ext: string = "ts",
    /** The pack's tool-level config: parser, source type, globals. */
    private readonly baseConfig: Record<string, unknown> = {},
  ) {}

  async violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }> {
    // The scratch directory lives inside the repo, not in /tmp: eslint only
    // lints files under its working directory, and the generated config has to
    // resolve `typescript-eslint` by walking up to the repo's node_modules.
    const scratchRoot = join(this.repoRoot, ".bsf-rule-check");
    mkdirSync(scratchRoot, { recursive: true });
    const dir = mkdtempSync(join(scratchRoot, `${rule.id}-`));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      const file = join(dir, "src", `example.${this.ext}`);
      writeFileSync(file, source, "utf8");
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
          strict: true, noEmit: true, jsx: "react-jsx", skipLibCheck: true,
        },
        include: ["src/**/*"],
      }), "utf8");

      // Typed rules need type information, so the config points at the
      // throwaway tsconfig.
      writeFileSync(join(dir, "eslint.config.mjs"), eslintConfigFor(rule, dir, this.baseConfig), "utf8");

      const eslintBin = join(this.repoRoot, "node_modules", "eslint", "bin", "eslint.js");
      const { stdout } = await exec(
        process.execPath,
        [eslintBin, "src", "--format", "json", "--no-config-lookup", "--config", "eslint.config.mjs"],
        { cwd: dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
      ).catch((err: { stdout?: string; stderr?: string; message?: string }) => {
        // eslint exits non-zero when it finds problems, which is the normal
        // case here, so its output still has to be read.
        if (typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
          return { stdout: err.stdout };
        }
        throw new Error(err.stderr ?? err.message ?? "eslint failed");
      });

      const results = JSON.parse(String(stdout)) as {
        messages: { ruleId: string | null; message: string; severity: number }[];
      }[];
      const messages = results.flatMap((r) => r.messages);
      const fatal = messages.filter((m) => m.ruleId === null);
      if (fatal.length > 0) {
        throw new Error(`eslint could not parse the example: ${fatal[0]?.message ?? ""}`);
      }
      const hits = messages.filter((m) => m.severity >= 1);
      return {
        violates: hits.length > 0,
        detail: hits.map((m) => `${m.ruleId ?? "?"}: ${m.message}`).join("\n") || "(no messages)",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function eslintConfigFor(
  rule: RulePackRule,
  dir: string,
  baseConfig: Record<string, unknown>,
): string {
  const needsTypes = JSON.stringify(rule.config).includes("no-floating-promises")
    || JSON.stringify(rule.config).includes("require-await");

  // The pack's own languageOptions come first; the rule fragment goes on top.
  // A rule is verified against the config it will actually run under, which is
  // the only way `no-undef` can be told apart from a missing globals list.
  const base = (baseConfig["languageOptions"] ?? {}) as Record<string, unknown>;
  const languageOptions = {
    ...base,
    parserOptions: {
      ...((base["parserOptions"] ?? {}) as Record<string, unknown>),
      ...(needsTypes ? { project: join(dir, "tsconfig.json") } : {}),
      ecmaFeatures: { jsx: true },
    },
  };

  return `import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  languageOptions: { parser: tseslint.parser, ...${JSON.stringify(languageOptions)} },
  plugins: { "@typescript-eslint": tseslint.plugin },
  linterOptions: { reportUnusedDisableDirectives: false },
  rules: ${JSON.stringify(rule.config)},
});
`;
}

/* -------------------------------------------------------------- ruff runner */

/** Runs ruff with only this rule selected, in a throwaway directory. */
export class RuffRunner implements ToolRunner {
  async violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }> {
    const dir = mkdtempSync(join(tmpdir(), `bsf-rule-${rule.id}-`));
    try {
      const file = join(dir, "example.py");
      writeFileSync(file, source, "utf8");

      const select = (rule.config["select"] as string[] | undefined) ?? [];
      if (select.length === 0) {
        throw new Error(`rule ${rule.id} has no \`select\` codes for ruff`);
      }

      const { stdout } = await exec(
        "ruff",
        ["check", "--no-cache", "--isolated", "--output-format", "json", "--select", select.join(","), file],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      ).catch((err: { stdout?: string; stderr?: string; message?: string }) => {
        if (typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
          return { stdout: err.stdout };
        }
        throw new Error(err.stderr ?? err.message ?? "ruff failed");
      });

      const hits = JSON.parse(String(stdout)) as { code: string; message: string }[];
      return {
        violates: hits.length > 0,
        detail: hits.map((h) => `${h.code}: ${h.message}`).join("\n") || "(no messages)",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/* ------------------------------------------------------- data-flow rules */

/**
 * Semgrep in taint mode, for the data-flow rules.
 *
 * This is the kind the other runners cannot express. An eslint rule can ban
 * `execSync`; it cannot say "this particular call is wrong because the string
 * came from the request". A taint rule says exactly that, which means the
 * same call stays allowed when the value is a literal — so it discriminates
 * where a ban would simply forbid a useful function.
 *
 * The rule's own `config` carries a whole semgrep rule body, because sources
 * and sinks have no shorter honest form.
 */
export class SemgrepRunner implements ToolRunner {
  constructor(private readonly language: string) {}

  async violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }> {
    const dir = mkdtempSync(join(tmpdir(), `bsf-rule-${rule.id}-`));
    try {
      const body = rule.config["semgrep"];
      if (typeof body !== "object" || body === null) {
        throw new Error(`rule ${rule.id} has no \`semgrep\` rule body`);
      }

      const config = {
        rules: [{ id: rule.id, languages: [this.language], severity: "ERROR", message: rule.concern, ...body }],
      };
      const configPath = join(dir, "rule.json");
      writeFileSync(configPath, JSON.stringify(config), "utf8");

      const file = join(dir, `example${extensionFor(this.language)}`);
      writeFileSync(file, source, "utf8");

      const { stdout } = await exec(
        "semgrep",
        ["--config", configPath, "--json", "--quiet", "--disable-version-check", "--metrics", "off", file],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      ).catch((err: { stdout?: string; stderr?: string; message?: string }) => {
        // semgrep exits non-zero when it finds something, and its findings
        // are still on stdout.
        if (typeof err.stdout === "string" && err.stdout.trim().startsWith("{")) return { stdout: err.stdout };
        throw new Error(err.stderr ?? err.message ?? "semgrep failed");
      });

      const out = JSON.parse(String(stdout)) as {
        results?: { check_id: string; extra?: { message?: string } }[];
        errors?: { message?: string }[];
      };
      const errors = out.errors ?? [];
      if (errors.length > 0 && (out.results ?? []).length === 0) {
        // A rule semgrep could not parse reports zero findings, which would
        // otherwise read as "the bad example is fine".
        throw new Error(errors.map((e) => e.message ?? "semgrep error").join("; "));
      }

      const hits = out.results ?? [];
      return {
        violates: hits.length > 0,
        detail: hits.map((h) => `${h.check_id}: ${h.extra?.message ?? ""}`.trim()).join("\n") || "(no findings)",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function extensionFor(language: string): string {
  switch (language) {
    case "typescript":
      return ".ts";
    case "javascript":
      return ".js";
    case "python":
      return ".py";
    case "go":
      return ".go";
    case "java":
      return ".java";
    case "ruby":
      return ".rb";
    case "csharp":
      return ".cs";
    case "rust":
      return ".rs";
    default:
      return ".txt";
  }
}

/* ------------------------------------------- the toolchain-native runners */

/**
 * Three languages whose linter ships with the toolchain, so a rule can be
 * verified wherever the language itself is installed — no package registry,
 * no separate linter to pin.
 *
 * Each had its own trap, and each trap is the reason these are tested by
 * running the tool rather than by reading its documentation.
 */

/** clippy, for Rust. */
export class ClippyRunner implements ToolRunner {
  async violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }> {
    const lint = rule.config["lint"] as string | undefined;
    if (lint === undefined) throw new Error(`rule ${rule.id} has no \`lint\` for clippy`);

    const dir = mkdtempSync(join(tmpdir(), `bsf-rule-${rule.id}-`));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "Cargo.toml"),
        `[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\n`,
      );
      writeFileSync(join(dir, "src/lib.rs"), `#![warn(${lint})]\n${source}`, "utf8");

      const out = await capture("cargo", ["clippy", "--quiet", "--message-format=json"], dir);

      // JSON, not `--message-format=short`: the short form prints a lint's
      // message and never its name, so matching a lint name against short
      // output misses every time — which is what it did.
      const codes: string[] = [];
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const doc = JSON.parse(t) as { message?: { code?: { code?: string } } };
          const code = doc.message?.code?.code;
          if (code !== undefined) codes.push(code);
        } catch {
          /* cargo interleaves other JSON; only diagnostics matter */
        }
      }
      return {
        violates: codes.includes(lint),
        detail: codes.length === 0 ? "(clippy reported nothing)" : [...new Set(codes)].join(", "),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** `go vet`, for Go. */
export class GoVetRunner implements ToolRunner {
  async violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }> {
    const analyser = rule.config["analyser"] as string | undefined;
    if (analyser === undefined) throw new Error(`rule ${rule.id} has no \`analyser\` for go vet`);

    const dir = mkdtempSync(join(tmpdir(), `bsf-rule-${rule.id}-`));
    try {
      writeFileSync(join(dir, "go.mod"), "module probe\n\ngo 1.21\n");
      writeFileSync(join(dir, "a.go"), source, "utf8");
      const out = await capture("go", ["vet", "./..."], dir);
      // vet does not print analyser names, so a non-empty report is the
      // signal; the analyser is recorded in the rule so a count can be
      // attributed to something a developer can run on its own.
      const lines = out.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
      return { violates: lines.length > 0, detail: lines.slice(0, 3).join("\n") || "(vet reported nothing)" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** `javac -Xlint`, for Java. */
export class JavacLintRunner implements ToolRunner {
  async violates(rule: RulePackRule, source: string): Promise<{ violates: boolean; detail: string }> {
    const category = rule.config["category"] as string | undefined;
    if (category === undefined) throw new Error(`rule ${rule.id} has no \`category\` for javac`);

    const dir = mkdtempSync(join(tmpdir(), `bsf-rule-${rule.id}-`));
    try {
      const file = join(dir, "Probe.java");
      writeFileSync(file, source, "utf8");
      const out = await capture("javac", ["-Xlint:all", "-d", join(dir, "out"), file], dir);
      // javac tags each warning with its category in brackets, which is the
      // only reliable way to tell one rule's warning from another's.
      return {
        violates: out.includes(`[${category}]`),
        detail: out.split("\n").filter((l) => l.includes("warning:")).slice(0, 3).join("\n") || "(javac reported nothing)",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Both streams, whatever the exit code: these tools report on stderr. */
async function capture(bin: string, args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec(bin, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return `${String(stdout)}\n${String(stderr)}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
}
