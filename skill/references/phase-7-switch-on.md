# Phase 7 — Switch it on

The factory goes live when the user merges the setup PR.

1. **Open the setup PR** from `factory/setup`, pushed with the user's own
   credentials — the App cannot push workflow files, by design. It holds the
   guardrails, the mechanical fixes (the formatter as its own commit), the
   factory definition, the workflows, the hooks and `assessment.md`.
2. **Run the gates on the setup PR itself**, so the user watches every gate
   pass before merging. This is the first evidence the factory works, and it is
   evidence about their repo rather than a claim about the product.
3. **The user merges.** On merge, `factory-sync` adds the factory's required
   checks where the plan allows, **keeping every existing protection rule**,
   and gardening picks up the seeded cleanup that night.
4. **Smoke test.** Open one small issue — "Add a factory badge to the README"
   — wait for the factory to produce a draft PR, and show the user the
   dashboard link. A real run on their repo, end to end, while they are still
   watching.
5. **Hand off.**

## The hand-off message

Keep it to what they need to know:

- **What is running**, and what it will do tonight (gardening) and in three
  days (the first review).
- **Where to watch it** — the dashboard link.
- **How to ask for work**: an issue, or Slack or Linear if connected.
- **That every auto-merge toggle is off**, so nothing merges without them, and
  where to change that when they are ready.
- **Their enforcement level** and what it means: branch protection, or the
  audit fallback with its revert PR.
- **What it will cost**, from phase 6's estimate, and that the dashboard shows
  real spend from the first run.

## What to watch for

- **If the smoke test does not produce a draft PR, that is a failure.** Say so
  and diagnose it. Do not hand off a factory whose first run did not work.
- **Do not describe the factory as finished.** It starts with a human approving
  every draft PR in all three pipelines, which is the right place to start.
- **Say nothing about the dashboard you have not checked.** If it has not
  loaded, say that instead.
