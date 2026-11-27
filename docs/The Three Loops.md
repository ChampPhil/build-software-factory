# The Three Loops

After setup, three loops run at once, each slower and each improving something deeper. A person sets how much of each loop merges on its own.

1. **The work loop (hours) → ships the product.**
   - Trigger → work item → pipeline → factory clear → draft PR → approved → merge queue → merged.
   - Monitoring after release produces new signals → new work.
2. **The codebase loop (days to weeks) → keeps the code pristine.**
   - Gardening cleans up drift on a schedule; hardening turns corrections into guardrails.
   - The codebase gets stricter over time.
3. **The factory loop (scheduled, every few days) → improves the factory itself.**
   - Instrumentation traces everything continuously. Every few days a scheduled review grades recent work and sends each failure to hardening ([Self-Improvement](Self-Improvement.md)).

**Autonomy toggles** (each on or off):

- ☐ Auto-merge product work PRs
- ☐ Auto-merge gardening PRs
- ☐ Auto-merge hardening PRs (safe to turn on: hardening only adds or tightens guardrails; any weakening is blocked by a gate and needs a human)

Off → a human approves by looking at the verification artifacts. On → PRs that pass factory-clear merge on their own.

**What humans do:**

- **Product engineers** → put work into the factory and approve its PRs where auto-merge is off.
- **Factory engineers** → watch the dashboard (automation rate, cycle time, spend, failures), approve changes to the factory, and decide when to flip the toggles.

**Where humans see everything** → the dashboard: what every agent and human is doing, every run's transcript and artifacts, and the factory's metrics.

**Everything reaches main through the gates** → the factory merges its own PRs, and only after its gates pass; human PRs pass the deterministic gates (static rules, tests, coverage) and merge through the team's normal flow. Branch protection blocks bypasses where the GitHub plan allows; on free private repos a post-push audit flags them. Local agent sessions are captured by hooks, only for developers who opt in and only when the factory's data is stored privately; local human work is captured at the PR level.
