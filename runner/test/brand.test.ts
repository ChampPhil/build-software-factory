import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, attributionMarkdown } from "../src/lib/brand.js";
import { renderReport } from "../src/commands/pr-report.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

describe("the credit line says the same thing everywhere", () => {
  it("the dashboard's own markup uses the link label, not the product name", () => {
    // These are two renderings of one line — Markdown for the pull requests
    // the factory opens, JSX for the dashboard footer — and nothing but a
    // test stops one being changed without the other. That is how the footer
    // kept saying "Build Software Factory" after the link text had changed.
    const jsx = read("dashboard/components/brand-credit.tsx");
    expect(jsx).toContain("{BRAND.linkLabel}");
    expect(jsx).not.toContain("{BRAND.name}");
    expect(attributionMarkdown()).toContain("Build Your Software Factory");
  });
});

describe("visible attribution", () => {
  it("is the same in the dashboard and the runner", () => {
    const dash = read("dashboard/lib/brand.ts");
    expect(dash).toContain(`name: "${BRAND.name}"`);
    expect(dash).toContain(`author: "${BRAND.author}"`);
    expect(dash).toContain(`url: "${BRAND.url}"`);
  });

  it("names the author and links the project", () => {
    const line = attributionMarkdown();
    expect(line).toContain("Philip Valcin");
    expect(line).toContain(BRAND.url);
  });

  it("shows in the README, the bootstrap PR instructions and the dashboard", () => {
    expect(read("README.md")).toContain("Built by Philip Valcin");
    // The literal is gone on purpose: the bootstrap PR body is generated, and
    // the skill tells the agent to use it rather than retyping the line.
    expect(read("skill/references/phase-2-sandbox.md")).toContain(".factory/bootstrap-pr.md");
    expect(read("dashboard/components/shell.tsx")).toContain("<BrandCredit />");
  });

  it("is on a setup PR and not on an ordinary change PR", () => {
    const stored = {
      role: "setup", attempt: 1, media_commit: null, media_prefix: "p", inline: {}, problems: [], stored_at: "2026-11-22T00:00:00Z",
      report: { summary: ["a", "b", "c"], blocks: [{ type: "diagram", title: "t", mermaid: "graph TD; A-->B" }], focus: [{ title: "f", detail: "d" }] },
    };
    const setup = renderReport({ repo: "o/r", kind: "setup", reports: [stored as never], footer: "Setup run 1" });
    const change = renderReport({ repo: "o/r", kind: "change", reports: [{ ...stored, role: "builder" } as never], footer: "Work item 1" });
    expect(setup.body).toContain(attributionMarkdown());
    expect(change.body).not.toContain(attributionMarkdown());
  });
});
