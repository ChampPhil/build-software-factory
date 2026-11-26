import { describe, it, expect } from "vitest";
import { intentBlock, mergeProductIntent, INTENT_HEADING } from "../src/lib/product-intent.js";
import { scrubPlaceholders, looksLikeSecret, NOT_A_KEY } from "../src/lib/placeholders.js";

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
});
