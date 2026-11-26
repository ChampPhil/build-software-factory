# Phase 7 — Switch it on

These are your notes. The person does not hear a phase number or a file name.

Do not send the closing message until every line in "Not done yet" is clear.
"Setup is done" before that is forbidden.

## Not done yet

Setup is still open while any of these is true:

- The private copy has not driven the journeys in the feature map. A public
  page, or an unclaimed-workspace token, is not enough unless the map has
  no further journey.
- The checkers are missing, a rule was not proved on a bad example and a
  good example, or a candidate is still pending.
- The violation counts are missing, or any count is still above zero.
- Tests exist and the coverage floor is 0. The floor is the coverage the
  suite measured. Deselected or ignored tests do not count as green.
- A factory pull request is red on its own checks. Repair it. Do not leave
  it for the person. Do not merge to the default branch so a check can see
  a recipe that exists only on the pull request.
- The audit is red. Re-run it. If it stays red, repair it. A red audit is
  not a story you tell them on the way out.
- You have not filed the smoke-test request yourself, or its pull request
  is not green.

1. **Open the setup pull request** from the setup branch, pushed with the
   person's own credentials. The app cannot push workflow files, by design.
   It holds the checkers, the format as its own commit, the lint fixes
   after that, the factory definition, the workflows, the hooks, and the
   assessment. If one pull request would be unreviewable, you already named
   the sequence and opened them in order. This is the last of that sequence,
   not a sandbox-only pull request with the checkers postponed.
2. **Run the checks on the setup pull request itself.** If a check is red,
   repair it and run it again. The factory does not hand the person a pull
   request that is red on its own checks. The check that judges the private
   copy reads the recipe in this pull request. Do not merge to the default
   branch so that check can see the recipe.
3. **The pull request merges when it is green.** If they said they will merge
   setup pull requests by hand, name this one pull request and start
   `node scripts/wait-for.mjs pr-merged <number>` in the background. Wake
   when it exits. Do not tell them to come back and say they merged. If
   they only said yes to setup, merge it yourself when the checks are green,
   and still watch until the merge has happened.

   On merge, `factory-sync` adds the factory's required checks where the
   plan allows, keeping every existing protection rule, and gardening picks
   up the seeded cleanup that night. Pipeline switches stay off. Setup's
   own pull requests were the exception, and only those.

   Then check the assessment file is gone from the default branch, because
   it is unrequested markdown and the merge is meant to delete it:

   ```
   git fetch origin
   git cat-file -e origin/main:assessment.md
   ```

   That should fail (non-zero exit: the file is gone). If it is still there,
   the delete did not make it into the setup pull request. Remove it on a
   `factory/fix-*` branch. Do not push to the default branch.

   `factory-audit` runs on this merge. Re-run it. If it passes, continue.
   If it stays red, setup is not done. Repair the cause. Do not tell the
   person a red audit is normal, and do not send the closing message while
   it is red.

   Before the merge, create the three labels the request forms apply, so a
   form never silently drops one: `gh label create factory:accept`,
   `factory:harden` and `factory:tidy` with `--force`. The forms themselves
   (Feature, Bug, Harden this, Tidy this) are already in the setup pull
   request under `.github/ISSUE_TEMPLATE/`.
4. **Write the first request.** Save one suggestion drawn from this repo to
   `.factory/first-request.json` as `{"title", "details", "goal"}`: something
   small, safe and visible that phase 1 or 4 turned up (a missing README
   section, a rough edge in the feature map). Say what should be true when it
   is done in `goal`. The dashboard offers it on an empty factory, so the
   user's first PR needs no thinking. Do not invent work the repo does not need.
5. **Smoke test.** You file the first request yourself, as an issue. Do not
   ask them to file it. Wait until the factory has read it and opened a pull
   request. Repair that pull request until it is green on the factory's own
   checks. A draft that is red is not done. Do not leave it for the person.
   Show them the dashboard link only as part of the closing message, after
   you have checked the link loads.
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

## The closing message

End setup with one formal message, in this order, and nothing after it:

1. **"Setup is done. Your factory is running."** as the first line. Send this
   only after "Not done yet" is clear. If a factory pull request is red, the
   coverage floor is 0 while tests exist, or the audit is red, this is not
   the closing message.
2. **The dashboard link, verified.** Only the address `bsf dashboard-link`
   printed, after you have opened it or fetched it and seen it load. If you
   could not verify it, say that instead of giving a link.
3. **What runs on its own,** in two or three lines: gardening tonight, the
   first review in three days, and every request they file from now on.
4. **Two things they can say whenever they like:** `/practice <anything>` on an
   issue or PR adds a standing instruction; `/retry` hands back anything the
   factory stopped on once they have done what it needed.
5. **No loose ends.** Say that nothing else is waiting on them. If something is
   (an unmerged PR, a failed check), it is not the closing message yet: fix it
   or say exactly what is left and why.

## What to include in it

Keep it to what they need to know:

- **What is running**, and what it will do tonight (gardening) and in three
  days (the first review).
- **Where to watch it** — the dashboard link, from `bsf dashboard-link --repo OWNER/NAME`. It opens the shared dashboard with the repository already filled in; signing in is one button, "Sign in with GitHub", which asks them to approve the dashboard's GitHub App; if it is not installed on this repository yet, the page links to the install step itself, so there is nothing to do ahead of time. If the command genuinely reports that there is no address, say so and point them at `https://buildsoftwarefactory.com`; never invent a repository-specific link. The dashboard also has a demo they can open without signing in.
- **How to change how it runs**: the dashboard's Factory page has a control for the budget, merge by itself, and the nightly cleanup, and an Ask the factory box for anything else. Never point them at a file.
- **How to ask for work**: the New request button on the dashboard, one of the four issue forms, or Slack or Linear if connected. If the factory needs something clarified it asks one question on the issue, before any code, and waits: nothing times out, and the dashboard's Home has an answer box.
- **Pipeline switches are off.** Product work, gardening, hardening, a
  change to the factory's own definition, and fixing a merge conflict each
  wait for a person to merge. Each has a switch, on the dashboard's Factory
  page. Do not say those switches are on. Do not say the person chose
  automatic merge for them. Setup's own pull requests were the only
  exception, and only if they did not say they would merge those by hand.
- **Their enforcement level** and what it means: branch protection, or the
  audit fallback with its revert PR.
- **What it will cost**, from phase 6's estimate, and that the dashboard shows
  real spend from the first run.

## What to watch for

- **If the smoke test's pull request is not green, that is a failure.** Repair
  it. Do not hand off a factory whose first pull request is red. Do not leave
  that pull request for the person to find.
- **The pipelines are not on automatic merge.** They start with a person
  merging each one. Say that. Do not claim more.
- **Say nothing about the dashboard you have not checked.** If it has not
  loaded, say that instead.
