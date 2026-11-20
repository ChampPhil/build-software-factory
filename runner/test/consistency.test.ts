import { describe, it, expect } from "vitest";
import {
  checkConsistency,
  envVarsUsed,
  envVarsDeclared,
  documentedScripts,
} from "../src/commands/consistency.js";

/** A repo as a map of path to contents, so no files are written. */
function repo(files: Record<string, string>, scan?: readonly string[]) {
  return checkConsistency({
    root: "/repo",
    files: scan ?? Object.keys(files).filter((f) => /\.(ts|py|go|ya?ml)$/.test(f)),
    read: (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`no such file: ${p}`);
      return text;
    },
  });
}

describe("envVarsUsed", () => {
  it("reads the shapes each language uses", () => {
    expect(envVarsUsed('process.env.DATABASE_URL')).toEqual(["DATABASE_URL"]);
    expect(envVarsUsed('process.env["RESEND_API_KEY"]')).toEqual(["RESEND_API_KEY"]);
    expect(envVarsUsed('os.environ["SECRET_KEY"]')).toEqual(["SECRET_KEY"]);
    expect(envVarsUsed('os.getenv("API_TOKEN")')).toEqual(["API_TOKEN"]);
    expect(envVarsUsed('os.Getenv("PORT_NUMBER")')).toEqual(["PORT_NUMBER"]);
    expect(envVarsUsed("${{ secrets.FACTORY_APP_PRIVATE_KEY }}")).toEqual(["FACTORY_APP_PRIVATE_KEY"]);
  });

  it("ignores a lowercase or too-short name, which is usually not a variable", () => {
    expect(envVarsUsed("process.env.ab")).toEqual([]);
    expect(envVarsUsed("process.env.nodeEnv")).toEqual([]);
  });

  it("lists each name once however often it is read", () => {
    expect(envVarsUsed("process.env.A_TOKEN; process.env.A_TOKEN")).toEqual(["A_TOKEN"]);
  });
});

describe("envVarsDeclared", () => {
  it("reads names and ignores values, comments and blank lines", () => {
    const text = ["# a comment", "", "DATABASE_URL=postgres://x", "export API_KEY=abc", "  SPACED = 1"].join("\n");
    expect(envVarsDeclared(text)).toEqual(["API_KEY", "DATABASE_URL", "SPACED"]);
  });

  it("does not treat a commented-out variable as declared", () => {
    expect(envVarsDeclared("# DATABASE_URL=x")).toEqual([]);
  });
});

describe("documentedScripts", () => {
  it("reads commands out of fenced blocks", () => {
    const md = ["# Thing", "", "```bash", "npm install", "npm run dev", "```"].join("\n");
    expect(documentedScripts(md)).toEqual(["dev"]);
  });

  it("ignores a command mentioned in prose", () => {
    // "the npm run build step" is a sentence, not an instruction to run it,
    // and treating it as one produced noise.
    expect(documentedScripts("Run the `npm run build` step when ready.")).toEqual([]);
  });

  it("reads several blocks and several commands", () => {
    const md = "```sh\nnpm run a\n```\ntext\n```\nnpm run b:c\n```";
    expect(documentedScripts(md)).toEqual(["a", "b:c"]);
  });
});

describe("environment variables against the example file", () => {
  it("reports one the code reads that the example does not name", () => {
    const f = repo({
      ".env.example": "RESEND_API_KEY=\nDATABASE_URL=\n",
      "lib/mail.ts": "const key = process.env.RESEND_API_KEY; process.env.DATABASE_URL;\nprocess.env.MAIL_FROM;\n",
    });
    const undocumented = f.filter((x) => x.check === "env_undocumented");
    expect(undocumented).toHaveLength(1);
    expect(undocumented[0]?.detail).toContain("MAIL_FROM");
    // A mismatch is never a fault in one file alone.
    expect(undocumented[0]?.between).toEqual(["lib/mail.ts", ".env.example"]);
  });

  it("reports both directions at once when both are wrong", () => {
    const f = repo({
      ".env.example": "DATABASE_URL=\n",
      "lib/mail.ts": "const key = process.env.RESEND_API_KEY;\n",
    });
    expect(f.map((x) => x.check).sort()).toEqual(["env_undocumented", "env_unused"]);
  });

  it("reports one the example asks for that nothing reads", () => {
    const f = repo({ ".env.example": "OLD_FLAG=1\n", "lib/a.ts": "export const x = 1;\n" });
    expect(f.map((x) => x.check)).toEqual(["env_unused"]);
    expect(f[0]?.detail).toContain("OLD_FLAG");
  });

  it("says nothing when they agree", () => {
    expect(repo({ ".env.example": "DATABASE_URL=\n", "lib/db.ts": "process.env.DATABASE_URL;" })).toEqual([]);
  });

  it("ignores variables the platform sets, which no project writes down", () => {
    const f = repo({
      ".env.example": "DATABASE_URL=\n",
      "lib/a.ts": "process.env.NODE_ENV; process.env.CI; process.env.GITHUB_SHA; process.env.DATABASE_URL;",
    });
    expect(f).toEqual([]);
  });

  it("accepts any of the usual names for the example file", () => {
    for (const name of [".env.example", ".env.sample", ".env.template"]) {
      const f = repo({ [name]: "A_KEY=\n", "lib/a.ts": "process.env.B_KEY;" });
      expect(f[0]?.between[1], name).toBe(name);
    }
  });
});

describe("a repo with no example file at all", () => {
  it("reports it once, not once per variable", () => {
    const f = repo({
      "lib/a.ts": "process.env.DATABASE_URL; process.env.API_TOKEN; process.env.MAIL_KEY;",
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.check).toBe("env_no_example");
    expect(f[0]?.detail).toContain("3 environment variable");
    expect(f[0]?.between).toEqual(["the source files scanned", ".env.example"]);
  });

  it("stays quiet for a repo that reads one or two, which needs no file", () => {
    expect(repo({ "lib/a.ts": "process.env.DATABASE_URL; process.env.API_TOKEN;" })).toEqual([]);
  });

  it("does not count the platform's own variables towards it", () => {
    expect(repo({ "lib/a.ts": "process.env.CI; process.env.NODE_ENV; process.env.GITHUB_SHA;" })).toEqual([]);
  });
});

describe("documented commands against the manifest", () => {
  it("reports a command the README gives that the manifest does not define", () => {
    const f = repo(
      {
        "README.md": "```bash\nnpm run dev\nnpm run seed\n```",
        "package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
      },
      [],
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.check).toBe("documented_script_missing");
    expect(f[0]?.detail).toContain("npm run seed");
  });

  it("says nothing when every documented command exists", () => {
    const f = repo(
      {
        "README.md": "```bash\nnpm run dev\n```",
        "package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
      },
      [],
    );
    expect(f).toEqual([]);
  });

  it("says nothing when the manifest does not parse, rather than claiming it defines nothing", () => {
    // Treating an unreadable manifest as empty would report every documented
    // command as missing — a confident claim built on a file we could not read.
    const f = repo({ "README.md": "```\nnpm run dev\n```", "package.json": "{oops" }, []);
    expect(f).toEqual([]);
  });
});

describe("the manifest against the lockfile", () => {
  it("reports a dependency the lockfile does not carry", () => {
    const f = repo(
      {
        "package.json": JSON.stringify({ dependencies: { next: "^16", left: "^1" } }),
        "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/next": { version: "16.4.6" } } }),
      },
      [],
    );
    expect(f).toHaveLength(1);
    expect(f[0]?.check).toBe("dependency_unlocked");
    expect(f[0]?.detail).toContain("left");
  });

  it("checks devDependencies too", () => {
    const f = repo(
      {
        "package.json": JSON.stringify({ devDependencies: { vitest: "^5" } }),
        "package-lock.json": JSON.stringify({ packages: { "": {} } }),
      },
      [],
    );
    expect(f[0]?.detail).toContain("vitest");
  });

  it("says nothing when the lockfile carries everything", () => {
    const f = repo(
      {
        "package.json": JSON.stringify({ dependencies: { next: "^16" } }),
        "package-lock.json": JSON.stringify({ packages: { "node_modules/next": {} } }),
      },
      [],
    );
    expect(f).toEqual([]);
  });

  it("stays quiet for a lockfile in a format it does not know", () => {
    // Guessing from an unrecognised shape would report every dependency as
    // unlocked, which is worse than reporting nothing.
    const f = repo(
      {
        "package.json": JSON.stringify({ dependencies: { next: "^16" } }),
        "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: { next: {} } }),
      },
      [],
    );
    expect(f).toEqual([]);
  });
});

describe("every finding", () => {
  it("names both artifacts, because the fix depends on which one is right", () => {
    const f = repo({
      ".env.example": "GONE=1\n",
      "README.md": "```\nnpm run missing\n```",
      "package.json": JSON.stringify({ scripts: {}, dependencies: { a: "1" } }),
      "package-lock.json": JSON.stringify({ packages: {} }),
      "lib/a.ts": "process.env.NEEDED_KEY;",
    });
    expect(f.length).toBeGreaterThanOrEqual(4);
    for (const finding of f) {
      expect(finding.between[0], finding.check).not.toBe("");
      expect(finding.between[1], finding.check).not.toBe("");
      expect(finding.between[0]).not.toBe(finding.between[1]);
    }
  });
});
