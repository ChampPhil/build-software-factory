/** The words around the settings Save button, which depend on whether the factory can merge by itself. */
export function saveButtonLabel(enforcement: "branch_protection" | "audit" | null, pending: number): string {
  if (pending === 0) return "No changes";
  if (enforcement === "audit") return "Open the pull request";
  return `Save ${pending} ${pending === 1 ? "change" : "changes"}`;
}

/**
 * `planLimited` is true only when setup found that GitHub will not let this
 * repository require checks at all (a free private repository). When it did
 * not find that, "audit" just means the checks are not switched on as required,
 * and saying the plan is the reason would be wrong.
 */
export function saveHint(enforcement: "branch_protection" | "audit" | null, planLimited = true): string {
  if (enforcement === "audit" && !planLimited) {
    return "Saving opens a pull request. GitHub is not set to require the factory's checks on this repository yet, so the factory cannot merge it by itself: you merge it. Turning on branch protection for the default branch lets the factory merge by itself.";
  }
  return enforcement === "audit"
    ? "Saving opens a pull request. On this repository GitHub does not offer required checks (free private plan), so the factory cannot merge it by itself: you merge it. GitHub Pro or a public repository lets the factory merge by itself."
    : "Saving opens a pull request that changes the factory's settings and merges it once the policy check passes, usually within a minute.";
}
