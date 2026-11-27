# Make the app runnable in a private copy

These are your notes. The person does not hear a phase number, a file name,
the word freeze, or the word tier.

Nothing here runs on the person's machine. You do not invent a thinner finish
line than the one below. A note inside the sandbox that says to add no tools
does not cancel later checkers.

## Done

Done when the pull request contains all of this, and every journey on the
journey list has been driven on the running app. The journey list is the
things a person does. It is not the folder map.

- The app's database is rebuilt on every boot from a seed, in a private data
  directory. That seed already holds the records each journey needs: the
  users, workspaces, and sample records the screen has to already have, or
  the screen never appears. A missing precondition belongs in the seed. Do
  not shorten a journey to make the boot pass. Do not drop a journey to make
  the boot pass.
- Prefer a vendor's test mode (Clerk dev, Stripe test) when a test-mode
  secret exists. Use a local stub only when it does not. No production keys.
  Ask once for a test-mode secret. They paste it on GitHub, not in the chat.
  Objects this run created at a vendor are cleaned up as a best effort. If
  that cleanup cannot finish, say so and continue. Do not stall setup, and
  do not stall a later sandbox pull request, on a vendor leftover.
- While a run is going, an agent may arrange the case under test: an extra
  row, a declined Stripe test card, a Clerk test user. That arrangement is
  scratch. It is for this run only. It is not written into the shared
  launch. The proof of a scratched run says what was added. The shared
  launch must perform every listed journey with no scratch. After the run,
  the app database is rebuilt from the seed. A leftover vendor object is
  not the only way into a screen.
- The writer checks every change on the running app before the next change.
  A change that was not clicked there is not done.
- The verifier gets a fresh boot, checked out to the pull request, with the
  app database rebuilt from the seed. It signs in as a test user and clicks
  the journeys the change touches. The writer's clicks do not replace that
  pass.
- Proof on the pull request: a screenshot, the side effect (a row or a sent
  message), and at least one diagram. An on-screen "saved" is not that
  proof. A short video is encouraged. Its absence does not fail the gate.
  The files are attached to the pull request.
- The test command is the repository's own suite. Deselecting or ignoring
  tests to go green means this phase is not done. The coverage floor is the
  coverage that suite measured. A floor of 0 while tests exist means this
  phase is not done.
- A public page, or an unclaimed-workspace token, is not the finish line
  unless the feature map has no further journey. An unclaimed-workspace
  token is one step inside a journey when that journey is on the map.
- Do not freeze a partial trial. A trial that only renders a public page is
  a failed setup. Repair the recipe and rerun until the journeys have been
  driven. The disk is saved. Running processes are not. Later runs start
  from that disk and start the app again.
- The gate reads the sandbox recipe in the pull request, not only the copy
  on the default branch. Do not merge to the default branch just so a check
  can see the recipe.
- The factory does not hand the person a pull request that is red on its
  own checks. Repair the change, or the check, until those checks are green.

The pull request is not cleared when the start check fails, when a journey
was skipped, when the diagram is missing, or when the only evidence is a
screenshot of the public page.

A sandbox-only pull request does not finish this phase. The same pull
request also has to carry the checkers and the switch-on, or a later pull
request in the same setup does, before you call setup finished. Do not
postpone the checkers. If the cloud job dies at the last lock-in step,
repair the recipe and rerun. Do not build a thinner pull request by hand
and move on. Do not cancel a second factory-setup run that still has to
commit the checkers.

## When the long job starts

The long GitHub setup job starts only after the Anthropic secret exists and
the GitHub App is installed on this repository. A bootstrap pull request
merging must not start that job. If a run appears because that pull request
merged, and the secret or the app is not in place yet, that run is not the
job. Do not follow it. Do not treat it as setup. If that early run is still
going and it blocks the real one, cancel the early run only. Do not cancel
a later run that still has to commit the checkers. Start the job yourself,
with `gh workflow run factory-setup.yml`, only after both are true.

## How you get there

1. **Bootstrap.** `node scripts/install-factory.mjs --into <checkout>` on a
   branch. Open the bootstrap pull request with the body the installer
   wrote, at `.factory/bootstrap-pr.md`. Do not compose that body yourself.

   ```
   gh pr create --title "Install the software factory" --body-file .factory/bootstrap-pr.md
   ```

   Merging it does not start the long job. If the person is merging setup
   pull requests by hand, start `node scripts/wait-for.mjs pr-merged <number>`
   in the background when you ask them to merge it. Do not tell them to come
   back and say they merged. If setup pull requests merge on their own, merge
   this one when its checks are green, and still watch until it has merged.

2. **The long job, after the secret and the app.** It reads the repository's
   start command, Compose file, migrations, and seed. It writes a feature
   map of the main journeys, from the user's side, with the steps and the
   traps. It writes how to start the app, how to check that this boot is
   usable, how to drive a journey, how to keep the proof, and how to delete
   the scratch data while leaving the screenshots. It builds an image that
   already has the toolchains, Docker, and a browser, and it runs that start
   command until a person could use the app. Migrations are applied. The
   seed is loaded.

   The image boots on a virtual machine the GitHub Actions job starts. The
   factory's own credentials stay outside that machine. The same image can
   boot on a hypervisor service when someone wants that boundary. The
   definition of the app is the same in both places.

   While it runs, start `node scripts/progress.mjs` in the background and
   relay each line as one plain sentence. It speaks once a minute, not only
   when the stage changes. If it exits at once, or a minute passes with no
   line, it is on an old run. Start it again so it follows the live one.

3. **Repair.** A failed lock-in stays your job. Repair and rerun until the
   pull request contains the private copy, the checkers, and the switch-on.
   A hand-built pull request of the sandbox alone does not close the run.

## The environment is closed

The sandbox gives the app exactly the manifest's variables and nothing from
the runner. A variable the agent missed is absent, so the app fails loudly
instead of quietly reaching something real. A test sets a variable on the
runner and asserts it never arrives.

## No production credentials

A value is the app's own correct configuration, a throwaway service, a
standing test surface, or the name of a test-mode secret. Never a
production key. Never the person's own key. Production data and live
payment keys are never on the machine, and they are never copied into the
test accounts.

If the repository's database URL points at a hosted database, the app gets
a throwaway database instead. The closed environment is a positive list. A
forgotten production value is absent, not inherited.

The pull request lists any step that was proved only on this local boot, so
that boot is described as itself. A step that still needs the remote
environment stays on that list until a run there covers it.

## What the writer and the verifier read

The verification bar stays in the instructions the builder and the verifier
read on every change. Moving it to a side document so a size check passes
is a failed check. A new markdown file the request did not name fails.

They bring the app up from the recipe in the pull request they are judging,
not only from the copy on the default branch. The browser is signed in as
the test user. Where the machine has to mint that session, it hands it over
as a session file the role loads. The browser reaches the app and nothing
else.

## After setup, when a change needs more

A builder or verifier that cannot exercise what a change needs writes a
report: what it needed, which paths, why. That report starts another setup
run from the current recipe. One such change at a time.

- It waits for the product change to merge only when the need comes from
  that change itself. Otherwise it starts at once.
- It may merge on its own when it changes only the sandbox, reaches no new
  host, needs no new secret, and the trial proves at least what the default
  branch already proved. Anything else waits for the person. You still watch
  the pull request. You do not tell them to come back and say they merged.
- After two tries, put it to the person as one issue saying what is missing.

## What to watch for

- **A fake key or a forgetful stub.** If the only proof is that the process
  booted, the integration is not done. Ask once for the test-mode secret.
- **A partial trial treated as success.** Do not save it. Do not open it as
  the pull request you ask them to merge and then postpone the checkers.
- **A check that can only see the default branch.** Do not merge to make
  that check pass. The gate has to read the recipe in the pull request.
- **A red pull request.** Repair it. Do not hand it to the person.
- **Tests turned off to go green.** That means this phase is not done.
- **Services and isolation.** Services run on the runner, on localhost. A
  repository whose private copy needs them gets a weaker isolation level
  than one with none. Tell the person that, in everyday words, and why.
