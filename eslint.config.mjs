// @ts-check
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * The factory lints other people's repos; for a long time it did not lint
 * itself. This config closes that, and it is deliberately short: the rules
 * here are the ones that have actually caught a bug in this codebase.
 *
 * `no-restricted-syntax` on `require(` is the clearest example. A bare
 * `require()` in an ESM module throws only on the code path that reaches it,
 * so two of them shipped — one broke `bsf validate` on every YAML file, the
 * other would only have failed inside Actions. A test now forbids them in
 * cli.ts; this forbids them everywhere.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "dashboard/out/**",
      "runner/vendor/**",
      "fixtures/**",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    // tsconfig.json takes in test/ as well as src/, and the build uses
    // tsconfig.build.json. Before this, test files were never type-checked
    // by anything: vitest strips types without checking them.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          defaultProject: "runner/tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='require']",
          message:
            "Bare require() throws at runtime in an ESM module. Use a top-level import, or createRequire if the module really must be loaded lazily.",
        },
      ],
      // Reading a process.env key that is not set gives undefined, and the
      // runner's whole job is to behave when a secret is missing.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // An async function with no await is a legitimate signature when it
      // implements an interface whose other cases do await. Every hit was one
      // of those, so the rule only taught people to add pointless awaits.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The dashboard is React, and its hooks had `eslint-disable
    // react-hooks/exhaustive-deps` comments pointing at a rule nothing
    // defined — so the suppressions were dead and the rule never ran.
    files: ["dashboard/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Plain JS — the .mjs helpers the skill runs on the user's machine and
    // the promptfoo provider, which has to be CommonJS. No types to check
    // against, so the type-aware rules do not apply to them.
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // provider/pipeline.cjs has to be CommonJS: promptfoo loads a custom
      // provider with require().
      "@typescript-eslint/no-require-imports": "off",
      "no-restricted-syntax": "off",
    },
  },
  {
    // Tests reach for `!` constantly on indexed access into fixtures, and a
    // banned `any` in a test is usually a deliberate bad input.
    files: ["**/test/**", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
