export const PLACEHOLDER: string;
export function inlineScripts(html: string): string[];
export function hashSource(body: string): string;
export function applyHashes(headers: string, hashes: Set<string>): string;
