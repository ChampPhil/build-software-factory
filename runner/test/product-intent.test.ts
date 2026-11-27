import { describe, it, expect } from "vitest";
import { intentBlock, mergeProductIntent, INTENT_HEADING } from "../src/lib/product-intent.js";
import { scrubPlaceholders, looksLikeSecret, NOT_A_KEY } from "../src/lib/placeholders.js";
import { validate } from "../src/lib/schema.js";

const PERSON = [
  INTENT_HEADING,
  "",
  "- We sell cakes to people who hate waiting.",
  "- Never email customers after 8pm.",
].join("\n");

describe("the person's product intent survives the setup workflow", () => {
  const existing = `# Fundamentals\n\n${PERSON}\n\n## Architecture\n\nold text\n`;

  it("is extracted from its heading to the next heading", () => {
    expect(intentBlock(existing)).toBe(PERSON);
  });

  it("replaces a block the agent rewrote, keeping every person-sourced line", () => {
    const incoming = `# Fundamentals\n\n${INTENT_HEADING}\n\n- (agent's invented summary)\n\n## Architecture\n\nnew text\n`;
    const out = mergeProductIntent(existing, incoming);
    for (const line of PERSON.split("\n").filter((l) => l.startsWith("- "))) expect(out).toContain(line);
    expect(out).not.toContain("invented summary");
    expect(out).toContain("new text");
  });

  it("inserts the block when the agent wrote none, after the title", () => {
    const out = mergeProductIntent(existing, "# Fundamentals\n\n## Architecture\n\nnew text\n");
    expect(out.indexOf(INTENT_HEADING)).toBeGreaterThan(out.indexOf("# Fundamentals"));
    expect(out.indexOf(INTENT_HEADING)).toBeLessThan(out.indexOf("## Architecture"));
    expect(out).toContain("Never email customers after 8pm.");
  });

  it("leaves the incoming file alone when there is nothing to keep", () => {
    expect(mergeProductIntent(null, "# F\n\ntext\n")).toBe("# F\n\ntext\n");
    expect(mergeProductIntent("# F\n\nno block\n", "# F\n\ntext\n")).toBe("# F\n\ntext\n");
  });

  it("is idempotent", () => {
    const incoming = "# Fundamentals\n\n## Architecture\n\nnew text\n";
    const once = mergeProductIntent(existing, incoming);
    expect(mergeProductIntent(once, once)).toBe(once);
  });
});

describe("secret-shaped placeholders in the sandbox manifest", () => {
  it("recognises the shapes scanners refuse", () => {
    expect(looksLikeSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeSecret("sk_test_4eC39HqLyjWDarjtT1zdp7dc")).toBe(true);
    expect(looksLikeSecret("a".repeat(40))).toBe(true);
  });

  it("leaves URLs, paths, ports and ordinary words alone", () => {
    for (const v of ["http://localhost:3000", "postgres://u:p@localhost/db", "/var/lib/data", "development", "3000", "tcp://127.0.0.1:5432"]) {
      expect(looksLikeSecret(v)).toBe(false);
    }
  });

  it("replaces them anywhere in the manifest and counts them", () => {
    const text = JSON.stringify({ env: { AWS_KEY: "AKIAIOSFODNN7EXAMPLE", MODE: "test" }, nested: [{ k: "sk_live_abcdefghijkl" }] });
    const out = scrubPlaceholders(text);
    expect(out.replaced).toBe(2);
    expect(out.text).toContain(NOT_A_KEY);
    expect(out.text).not.toContain("AKIA");
    expect(out.text).toContain('"MODE": "test"');
  });

  it("keeps a long env name and a long secret name, and still scrubs the value", () => {
    const envName = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY";
    const secretName = `A${"B".repeat(33)}`;
    const token = "a".repeat(40);
    expect(envName.length).toBeGreaterThanOrEqual(32);
    expect(secretName.length).toBeGreaterThanOrEqual(32);
    const manifest = {
      schema: "sandbox/1",
      tier: "static",
      tier_reason: null,
      commands: { install: null, build: null, run: null, test: null },
      app_url: null,
      env: [
        { name: envName, kind: "inert", value: token, why: "the publishable key the page reads" },
        { name: "CLERK_SECRET_KEY", kind: "test_mode", secret: secretName, why: "the test-mode secret's name" },
      ],
      services: [],
      egress: [],
      stubs: [],
      dropped: [],
      capabilities: { exercised: ["x"], not_exercised: [] },
      episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
      frozen_at: "2026-11-20T00:00:00Z",
    };
    const out = scrubPlaceholders(JSON.stringify(manifest));
    const parsed = JSON.parse(out.text) as { env: { name: string; value?: string; secret?: string }[] };
    expect(out.replaced).toBe(1);
    expect(parsed.env[0]?.name).toBe(envName);
    expect(parsed.env[0]?.value).toBe(NOT_A_KEY);
    expect(parsed.env[1]?.secret).toBe(secretName);
    const checked = validate("sandbox", parsed);
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors, null, 2));
  });
});
