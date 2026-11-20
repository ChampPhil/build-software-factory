/**
 * Build a fixture from a base plus overrides, where an override of
 * `undefined` means the field is **absent** rather than present-and-undefined.
 *
 * Several tests say things like `ev({ title: undefined })` to describe an
 * event that arrived with no title. Under `exactOptionalPropertyTypes` a
 * spread of that object is not assignable to the fixture's own type, and the
 * runtime result — a key that exists holding undefined — is not what the real
 * payload looks like either. Deleting the key gives both the type and the
 * shape the test meant.
 */
export type Override<T> = { -readonly [K in keyof T]?: T[K] | undefined };

export function withOverride<T extends object>(base: T, over: Override<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as T;
}
