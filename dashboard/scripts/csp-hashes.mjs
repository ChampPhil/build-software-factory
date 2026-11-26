/**
 * Fills the script-src of the Content-Security-Policy with the hash of every
 * inline script in the built pages, so the policy no longer needs
 * 'unsafe-inline' for scripts.
 *
 *   node scripts/csp-hashes.mjs          (run by `npm run build`, after `next build`)
 *
 * A static Next export puts a few inline scripts in every page (the bootstrap
 * and the page's data). A hash allows exactly that text and nothing else, so an
 * injected `<script>` or `onclick=` is blocked even if some bug let one into the
 * page. The hashes are the union over all pages, in one rule: Cloudflare Pages
 * joins the values when two header rules both match, which would enforce two
 * policies and break the page, so there is one `/*` rule.
 *
 * Styles keep 'unsafe-inline': React writes style attributes, which cannot be
 * hashed, and a style is not a way to run code.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER = "__INLINE_SCRIPT_HASHES__";

/** Bodies of the inline scripts that the browser would run (not data blocks, not `src=`). */
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type !== undefined && type !== "text/javascript" && type !== "module" && type !== "application/javascript") continue;
    out.push(m[2] ?? "");
  }
  return out;
}

export function hashSource(body) {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

function htmlFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...htmlFiles(p));
    else if (name.endsWith(".html")) found.push(p);
  }
  return found;
}

export function applyHashes(headers, hashes) {
  if (!headers.includes(PLACEHOLDER)) throw new Error(`_headers has no ${PLACEHOLDER} to fill`);
  const filled = headers.replace(PLACEHOLDER, [...hashes].sort().join(" "));
  if (/script-src[^;\n]*'unsafe-inline'/.test(filled)) throw new Error("script-src still allows 'unsafe-inline'");
  return filled;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  const file = join(out, "_headers");
  if (!existsSync(file)) throw new Error("out/_headers is missing; run `next build` first");
  const hashes = new Set();
  for (const f of htmlFiles(out)) for (const body of inlineScripts(readFileSync(f, "utf8"))) hashes.add(hashSource(body));
  writeFileSync(file, applyHashes(readFileSync(file, "utf8"), hashes));
  console.log(`script-src: ${hashes.size} inline script hash(es), no 'unsafe-inline'`);
}
