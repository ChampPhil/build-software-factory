import { createRequire } from "node:module";

/**
 * Parse YAML.
 *
 * This codebase is ESM and the `yaml` package is CommonJS, so it is loaded
 * through `createRequire` rather than imported at the top. It is in one place
 * because a bare `require()` in an ESM module throws only on the code path
 * that reaches it — two of them shipped that way, one of which broke
 * `bsf validate` on every YAML file.
 */
export function parseYaml(text: string): unknown {
  const require_ = createRequire(import.meta.url);
  const { parse } = require_("yaml") as typeof import("yaml");
  return parse(text);
}
