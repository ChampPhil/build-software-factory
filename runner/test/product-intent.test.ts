import { describe, it, expect } from "vitest";
import { intentBlock, mergeProductIntent, INTENT_HEADING } from "../src/lib/product-intent.js";
import { looksLikePastedSecret, pastedSecrets } from "../src/lib/placeholders.js";

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

describe("pasted passwords in the sandbox recipe", () => {
  it("recognises vendor password prefixes and leaves paths alone", () => {
    expect(looksLikePastedSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikePastedSecret("sk_test_4eC39HqLyjWDarjtT1zdp7dc")).toBe(true);
    expect(looksLikePastedSecret("a".repeat(40))).toBe(false);
    expect(looksLikePastedSecret("/api/backend/customer-workspaces/owned")).toBe(false);
    expect(looksLikePastedSecret("http://127.0.0.1:5432")).toBe(false);
  });

  it("reports an env value that is a password and does not rewrite the recipe", () => {
    const problems = pastedSecrets([
      { name: "AWS_KEY", kind: "self", value: "AKIAIOSFODNN7EXAMPLE", why: "x" },
      { name: "MODE", kind: "self", value: "test", why: "x" },
      { name: "CLERK_SECRET_KEY", kind: "test_mode", secret: "CLERK_SECRET_KEY", why: "x" },
      { name: "OPENAI_API_KEY", kind: "test_mode", value: "plain-word", why: "x" },
    ]);
    expect(problems.some((p) => p.includes("AWS_KEY"))).toBe(true);
    expect(problems.some((p) => p.includes("OPENAI_API_KEY"))).toBe(true);
    expect(problems.some((p) => p.includes("MODE"))).toBe(false);
    expect(problems.some((p) => p.startsWith("CLERK_SECRET_KEY"))).toBe(false);
  });
});
