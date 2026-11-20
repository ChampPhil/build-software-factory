import { describe, it, expect } from "vitest";
import {
  scoreCorrection, redact, parseHits, clusterCorrections, mineCorrections,
  memexAvailable, CORRECTION_THRESHOLD, QUERIES, type Correction,
  candidatesFrom, proposedFix, listSessions,
} from "../src/commands/mine.js";
import { assertValid } from "../src/lib/schema.js";

describe("scoreCorrection", () => {
  const over = (text: string): boolean => scoreCorrection(text).confidence >= CORRECTION_THRESHOLD;

  it("recognises the unambiguous corrections", () => {
    for (const text of [
      "No, don't put the migration in the build script",
      "that's wrong, the dates are in UTC not local time",
      "revert that change to the auth middleware please",
      "you broke the invoice total, it was rounding before",
      "I already told you to use the existing helper",
      "not like that — the hook has to run after render",
      "never commit the generated files",
    ]) {
      expect(over(text), text).toBe(true);
    }
  });

  it("does not fire on someone thinking aloud", () => {
    for (const text of [
      "actually that could work",
      "can you add a CSV export to the invoices page",
      "what does this function do",
      "looks good, ship it",
      "I think the second option is better for our case",
    ]) {
      expect(over(text), text).toBe(false);
    }
  });

  it("treats being told twice as strong, and a bare 'again' as not", () => {
    // Repetition is what makes a correction worth a rule, so "I already told
    // you" stands on its own. "Can you run that again" is a request.
    expect(over("I already told you to use the existing helper")).toBe(true);
    expect(over("can you run that again")).toBe(false);
  });

  it("names the signals it fired on, so a score can be argued with", () => {
    const r = scoreCorrection("No, don't do that — revert it");
    expect(r.signals).toContain("explicit_no");
    expect(r.signals).toContain("undo");
  });

  it("discounts a turn too short to carry a rule", () => {
    expect(scoreCorrection("no stop").confidence).toBeLessThan(
      scoreCorrection("no, stop putting secrets in the config file").confidence,
    );
  });

  it("discounts a very long turn, which is a specification rather than a correction", () => {
    const long = `that's wrong. ${"and here is more detail ".repeat(40)}`;
    const short = "that's wrong, the total should exclude tax";
    expect(scoreCorrection(long).confidence).toBeLessThan(scoreCorrection(short).confidence);
  });
});

describe("redact", () => {
  it("removes tokens and keys of every shape it knows", () => {
    const cases: [string, string][] = [
      ["use ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[github-token]"],
      ["key is sk-abcdefghijklmnopqrstuvwx", "[api-key]"],
      ["AKIAIOSFODNN7EXAMPLE is the id", "[aws-key-id]"],
      ["xoxb-1234567890-abcdefghij", "[slack-token]"],
      ["eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4f", "[jwt]"],
      ["clone https://user:hunter2@github.com/x/y", "[url-with-credentials]"],
    ];
    for (const [input, marker] of cases) {
      const out = redact(input);
      expect(out, input).toContain(marker);
    }
  });

  it("removes a private key block entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEoWEwIB\n-----END RSA PRIVATE KEY-----";
    const out = redact(`here it is:\n${pem}`);
    expect(out).toContain("[private-key]");
    expect(out).not.toContain("MIIEoWEwIB");
  });

  it("redacts by the name a value is assigned to, not by how the value looks", () => {
    // The name is the evidence, so the value never needs inspecting — which
    // is what catches a short or oddly-shaped secret.
    const out = redact("set password = correcthorse");
    expect(out).not.toContain("correcthorse");
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "the invoice total should exclude tax, and the date is in UTC";
    expect(redact(text)).toBe(text);
  });

  it("is applied to what is kept, not only to what is printed", async () => {
    // A mined correction is written into the repo's guardrail candidates,
    // committed and pushed. If redaction happened on the way out, the secret
    // would already be in the file.
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex 1.0.0";
      return JSON.stringify({
        role: "user",
        text: "no, don't hardcode ghp_abcdefghijklmnopqrstuvwxyz0123456789 in the config",
        session_id: "s1",
        turn_id: 1,
        source: "claude",
      });
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(r.corrections[0]?.text).toContain("[github-token]");
    expect(JSON.stringify(r)).not.toContain("ghp_abcdef");
  });
});

describe("parseHits", () => {
  it("reads JSONL, which is memex's default", () => {
    const out = `{"session_id":"a"}\n{"session_id":"b"}\n`;
    expect(parseHits(out)).toHaveLength(2);
  });

  it("reads a JSON array too", () => {
    expect(parseHits('[{"session_id":"a"}]')).toHaveLength(1);
  });

  it("ignores a progress line among the results", () => {
    const out = `indexing...\n{"session_id":"a"}\nwarning: slow\n`;
    expect(parseHits(out)).toHaveLength(1);
  });

  it("returns nothing for empty or unparseable output", () => {
    expect(parseHits("")).toHaveLength(0);
    expect(parseHits("not json at all")).toHaveLength(0);
  });
});

describe("mineCorrections", () => {
  it("reports memex missing without failing, so setup can continue", async () => {
    const run = async (): Promise<string> => {
      throw new Error("ENOENT");
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(r.available).toBe(false);
    expect(r.corrections).toHaveLength(0);
    expect(r.note).toContain("not installed");
  });

  it("only keeps the user's own turns", async () => {
    const seen: string[][] = [];
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      seen.push([...args]);
      return "";
    };
    await mineCorrections({ repoPath: "/repo", runMemex: run });
    // An agent apologizing is not a correction.
    for (const args of seen) expect(args).toContain("--role");
    for (const args of seen) expect(args[args.indexOf("--role") + 1]).toBe("user");
  });

  it("scopes the search to this repository", async () => {
    const seen: string[][] = [];
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      seen.push([...args]);
      return "";
    };
    await mineCorrections({ repoPath: "/home/p/trinsports", runMemex: run });
    expect(seen[0]?.[seen[0].indexOf("--cwd") + 1]).toBe("/home/p/trinsports");
  });

  it("runs every query, so one phrasing's ranking does not decide everything", async () => {
    let searches = 0;
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      searches++;
      return "";
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(searches).toBe(QUERIES.length);
    expect(r.searched).toBe(QUERIES.length);
  });

  it("survives one query failing", async () => {
    let n = 0;
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      n++;
      if (n === 2) throw new Error("unknown source");
      return JSON.stringify({ role: "user", text: "no, don't do that", session_id: `s${n}`, turn_id: n });
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(r.corrections.length).toBeGreaterThan(0);
  });

  it("does not report the same turn twice when several queries find it", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      return JSON.stringify({ role: "user", text: "no, don't do that", session_id: "s1", turn_id: 7 });
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(r.corrections).toHaveLength(1);
  });

  it("drops turns below the threshold, whatever the search ranked them", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      return JSON.stringify({ role: "user", text: "can you add a CSV export", session_id: "s1", turn_id: 1 });
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(r.corrections).toHaveLength(0);
    expect(r.note).toContain("no corrections");
  });
});

describe("clusterCorrections", () => {
  const c = (text: string, confidence = 0.6): Correction => ({
    text, source: "claude", session: "s", at: null, confidence, signals: [],
  });

  it("groups corrections about the same thing", () => {
    const clusters = clusterCorrections([
      c("no, don't put the migration in the build script"),
      c("stop running migration commands during build"),
      c("that's wrong, the dates should be UTC"),
    ]);
    expect(clusters[0]?.occurrences).toBe(2);
    expect(clusters).toHaveLength(2);
  });

  it("puts the repeated theme first, because repetition is the signal", () => {
    // One correction is a preference. The same correction three times is
    // something the user should not have had to say three times.
    const clusters = clusterCorrections([
      c("the dates should be UTC"),
      c("no, don't put the migration in the build script"),
      c("stop running migration during build"),
      c("never run migration commands in build"),
    ]);
    expect(clusters[0]?.occurrences).toBe(3);
  });

  it("names a cluster in the user's own words", () => {
    const clusters = clusterCorrections([c("no, don't hardcode the API base url")]);
    expect(clusters[0]?.theme).toContain("hardcode");
  });

  it("does not let clusters drift through a chain of shared words", () => {
    // Single-link clustering drifts: A shares two words with B, B shares two
    // different words with C, and C lands in A's cluster having nothing to do
    // with it. On a real repository's history that pulled nine unrelated
    // commits into one group, so the match is against the seed, not a growing
    // union.
    const clusters = clusterCorrections([
      c("never hardcode the database migration command"),
      c("the migration command must be behind a flag"),
      c("the flag parsing should use the shared parser"),
      c("the shared parser belongs in the utils module"),
    ]);
    const first = clusters.find((cl) => cl.corrections[0]?.text.includes("hardcode"))!;
    expect(first.corrections.every((x) => x.text.includes("migration"))).toBe(true);
    expect(clusters.length).toBeGreaterThan(1);
  });

  it("ignores a term common to most of the corpus, which distinguishes nothing", () => {
    // Forty "fix: ..." subjects must not collapse on the word "fix". Derived
    // from the corpus rather than a hand list, because the common words
    // differ per repository — "fix" here, "migration" elsewhere.
    const subjects = ["parser", "router", "cache", "logger", "scheduler", "serializer"];
    const items = Array.from({ length: 24 }, (_, i) =>
      c(`handler the ${subjects[i % subjects.length]} ${subjects[(i + 1) % subjects.length]} issue${i}`),
    );
    const clusters = clusterCorrections(items);
    // "handler" is in all 24 and so distinguishes nothing; the subject words
    // are in four each and still do.
    expect(clusters.length).toBeGreaterThan(3);
  });

  it("applies no frequency filter to a small corpus, where the common term is the signal", () => {
    // In four corrections the commonest word is usually what they have in
    // common, so filtering it would destroy the only grouping available.
    const clusters = clusterCorrections([
      c("never run migration during build"),
      c("keep migration out of the build script"),
      c("migration must not be in build"),
    ]);
    expect(clusters[0]?.occurrences).toBe(3);
  });

  it("drops issue and PR references, which group nothing and clutter a name", () => {
    const clusters = clusterCorrections([c("never commit generated files (#12345)")]);
    expect(clusters).toHaveLength(1);
  });

  it("ignores a correction with nothing significant in it", () => {
    expect(clusterCorrections([c("no stop that")])).toHaveLength(0);
  });
});

describe("memexAvailable", () => {
  it("is false when memex is not on the path", async () => {
    expect(await memexAvailable(async () => { throw new Error("ENOENT"); })).toBe(false);
  });
  it("is true when it answers", async () => {
    expect(await memexAvailable(async () => "memex 1.2.3")).toBe(true);
  });
});

describe("candidates from corrections", () => {
  const cluster = (texts: string[], source = "claude") => ({
    theme: texts[0]!,
    occurrences: texts.length,
    corrections: texts.map((text, i) => ({
      text, source, session: `s${i}`, at: `2026-11-0${i + 1}T00:00:00.000Z`,
      confidence: 0.6, signals: [],
    })),
  });

  it("produces candidates that validate against the schema", () => {
    const cs = candidatesFrom([cluster(["no, don't use any here", "stop using any"])], "2026-11-19T00:00:00Z");
    assertValid("candidates", { schema: "candidates/1", candidates: cs });
  });

  it("mints ids in the shape the schema pins", () => {
    const cs = candidatesFrom([cluster(["no, don't use any"])], "2026-11-19T00:00:00Z");
    expect(cs[0]?.id).toMatch(/^cand_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("gives every candidate a distinct id even in one batch", () => {
    const cs = candidatesFrom(
      [cluster(["no, don't use any"]), cluster(["that's wrong, dates are UTC"])],
      "2026-11-19T00:00:00Z",
    );
    expect(new Set(cs.map((c) => c.id)).size).toBe(2);
  });

  it("maps memex's source name to the harness the schema names", () => {
    expect(candidatesFrom([cluster(["no, stop"], "kilocode")], "t")[0]?.sources[0]?.harness).toBe("kilo-code");
    expect(candidatesFrom([cluster(["no, stop"], "cursor")], "t")[0]?.sources[0]?.harness).toBe("cursor-cli");
  });

  it("leaves the harness off rather than guessing one the enum rejects", () => {
    // `harness` is a closed enum, so a wrong value invalidates the whole file.
    const c = candidatesFrom([cluster(["no, stop"], "some-new-agent")], "t")[0]!;
    expect(c.sources[0]).not.toHaveProperty("harness");
    assertValid("candidates", { schema: "candidates/1", candidates: [c] });
  });

  it("records the span the corrections cover", () => {
    const c = candidatesFrom([cluster(["no, don't", "stop that", "wrong again"])], "t")[0]!;
    expect(c.first_seen).toBe("2026-11-01T00:00:00.000Z");
    expect(c.last_seen).toBe("2026-11-03T00:00:00.000Z");
  });

  it("proposes the strongest fix the correction points at", () => {
    // Mirrors hardening's ordered check: an API change beats a rule, a rule
    // beats a scenario, and only what none can hold becomes context.
    expect(proposedFix("the function signature should take a type not a string")).toBe("api_change");
    expect(proposedFix("stop leaving console.log in the code")).toBe("static_rule");
    expect(proposedFix("you broke the checkout flow, it does not render")).toBe("verification");
    expect(proposedFix("we prefer to ship on Thursdays")).toBe("context");
  });

  it("caps how many quotes a candidate carries", () => {
    const c = candidatesFrom([cluster(Array.from({ length: 12 }, (_, i) => `no, don't do ${i}`))], "t")[0]!;
    expect(c.sources.length).toBeLessThanOrEqual(5);
    expect(c.occurrences).toBe(12);
  });
});

describe("consent before reading", () => {
  it("listing reads no session contents beyond the opening line", async () => {
    const calls: string[][] = [];
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      calls.push([...args]);
      return JSON.stringify({ session_id: "s1", source: "claude", ts: 1763600000000, text: "add a CSV export" });
    };
    const r = await listSessions({ repoPath: "/repo", runMemex: run });
    expect(r.sessions[0]?.opening).toBe("add a CSV export");
    // `sessions`, not `search`: no query is run against their content.
    expect(calls.every((c) => c[0] === "sessions")).toBe(true);
  });

  it("redacts even the opening line it shows", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      return JSON.stringify({ session_id: "s1", text: "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    };
    const r = await listSessions({ repoPath: "/repo", runMemex: run });
    expect(r.sessions[0]?.opening).not.toContain("ghp_abcdef");
  });

  it("says nothing was read when memex is absent", async () => {
    const r = await listSessions({ repoPath: "/repo", runMemex: async () => { throw new Error("ENOENT"); } });
    expect(r.available).toBe(false);
    expect(r.sessions).toHaveLength(0);
  });

  it("mining skips the sessions the user excluded", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      return [
        JSON.stringify({ role: "user", text: "no, don't do that", session_id: "keep", turn_id: 1 }),
        JSON.stringify({ role: "user", text: "no, don't do this either", session_id: "private", turn_id: 1 }),
      ].join("\n");
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run, excludeSessions: ["private"] });
    expect(r.corrections.map((c) => c.session)).toEqual(["keep"]);
  });

  it("drops a turn whose session cannot be identified, once anything is excluded", async () => {
    // The user excluded something, and this might be it.
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      return JSON.stringify({ role: "user", text: "no, don't do that", turn_id: 1 });
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run, excludeSessions: ["private"] });
    expect(r.corrections).toHaveLength(0);
  });

  it("keeps an unidentifiable turn when nothing was excluded", async () => {
    const run = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "--version") return "memex";
      return JSON.stringify({ role: "user", text: "no, don't do that", turn_id: 1 });
    };
    const r = await mineCorrections({ repoPath: "/repo", runMemex: run });
    expect(r.corrections).toHaveLength(1);
  });
});
