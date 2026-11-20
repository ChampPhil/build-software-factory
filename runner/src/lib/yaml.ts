import { parse } from "yaml";

/**
 * Parse YAML.
 *
 * A static import. This used to load `yaml` through `createRequire`, because
 * two bare require calls had shipped in this ESM codebase and broken on
 * the code paths that reached them. A static import fixes that at the root —
 * Node's CJS interop handles it, the type checker sees it — and, unlike a
 * runtime require, a bundler can follow it, which is what lets the runner be
 * vendored into a user's repo as one file.
 */
export function parseYaml(text: string): unknown {
  return parse(text);
}
