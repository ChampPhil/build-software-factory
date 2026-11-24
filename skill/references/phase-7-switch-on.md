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

   Then check two things actually happened, because both are claimed elsewhere
   in this skill and neither is verified anywhere:

   ```
   gh api repos/OWNER/NAME/contents/assessment.md --jq .name
   ```

   That should be a 404. `assessment.md` is meant to be deleted by this merge —
   it exists to be read in the PR, and the factory does not leave unrequested
   markdown in a repository. If it is still there, the delete did not make it
   into the setup PR; remove it on a `factory/fix-*` branch.

   And `factory-audit` will run on this merge and may fail. The setup PR
   touches protected paths, which is what the audit watches, and the commit can
   land before GitHub has linked it to its pull request. Re-run it; if it
   passes, nothing was wrong. Tell the user that, so a red tick on their first
   merge does not read as a broken factory.
   Before they merge, create the three labels the request forms apply, so a
   form never silently drops one: `gh label create factory:accept`,
   `factory:harden` and `factory:tidy` with `--force`. The forms themselves
   (Feature, Bug, Harden this, Tidy this) are already in the setup PR under
   `.github/ISSUE_TEMPLATE/`.
4. **Write the first request.** Save one suggestion drawn from this repo to
   `.factory/first-request.json` as `{"title", "details", "goal"}`: something
   small, safe and visible that phase 1 or 4 turned up (a missing README
   section, a rough edge in the feature map). Say what should be true when it
   is done in `goal`. The dashboard offers it on an empty factory, so the
   user's first PR needs no thinking. Do not invent work the repo does not need.
5. **Smoke test.** Open that first request as an issue (or a small one like
   "Add a factory badge to the README"), wait for the factory to comment that it
   has read it and produce a draft PR, and show the user the dashboard link. A
   real run on their repo, end to end, while they are still watching.
6. **Hand off, and make sure the dashboard link is in it.** This is a step,
   not a courtesy: nobody starts at the website, so the link you give here is
   the only way the person ever finds the dashboard. On the first live install
   the hand-off went out without it — `bsf dashboard-link` silently printed
   nothing on Windows, and the rule below about never inventing a link meant
   the agent said nothing at all. The user only learned the dashboard existed
   by asking.

   So: run it, and check you actually got a URL.

   ```
   bsf dashboard-link --repo OWNER/NAME
   ```

   If it prints nothing, that is a failure, not an empty result — the command
   always has an address to print. Say that the dashboard link could not be
   produced and that `https://buildsoftwarefactory.com` is where it lives, and
   do not treat the hand-off as complete.

## The hand-off message

Keep it to what they need to know:

- **What is running**, and what it will do tonight (gardening) and in three
  days (the first review).
- **Where to watch it** — the dashboard link, from `bsf dashboard-link --repo OWNER/NAME`. It opens the shared dashboard with the repository already filled in; signing in is one button, "Sign in with GitHub", which asks them to approve the dashboard's GitHub App; if it is not installed on this repository yet, the page links to the install step itself, so there is nothing to do ahead of time. If the command genuinely reports that there is no address, say so and point them at `https://buildsoftwarefactory.com`; never invent a repository-specific link. The dashboard also has a demo they can open without signing in.
- **How to change how it runs**: the dashboard's Factory page has a control for the budget, merge by itself, and the nightly cleanup, and an Ask the factory box for anything else. Never point them at a file.
- **How to ask for work**: the New request button on the dashboard, one of the four issue forms, or Slack or Linear if connected. If the factory needs something clarified it asks one question on the issue, before any code, and waits: nothing times out, and the dashboard's Home has an answer box.
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
