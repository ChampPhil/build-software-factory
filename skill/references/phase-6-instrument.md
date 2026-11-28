# Phase 6 — Instrument

These are your notes. The person does not hear a phase number or a file name.

The Anthropic secret, the development env secret `FACTORY_SANDBOX_ENV`, and
the GitHub App were done at the start, before the long job. Do not ask for
them again. If one is missing, that is the one chore, with a watch. Do not
start or follow the long job until all three are true. A bootstrap pull
request merging does not count.

Set up everything the factory needs to record itself and measure its work from
the first run.

## 1. The data and media refs

`node ../scripts/init-data-refs.mjs`

They live at `refs/factory/data` and `refs/factory/media`, outside
`refs/heads/`. That is load-bearing: a push to a non-branch ref starts no
`push` workflow, so the factory writing its own records never triggers the
repo's CI, and neither ref clutters the branch list.

The script creates them through the git data API — blobs, tree, a parentless
commit, then the ref — so it needs no clone and no push.

**On a public repo, offer the private data repo here.** It is the only way to
keep session transcripts, because a public repo cannot hold them. If the user
takes it: install the App on that repo too, and add every collaborator with
write access on the main repo as a collaborator on the data repo, or their
session hooks cannot push.

## 2. The GitHub App

Already created and installed at the start, on this repository only. Do not
run `scripts/create-app.mjs` again unless that install is missing. If it is
missing, that is the one chore: create it, then install it on this
repository only, and watch until the script confirms the install. The name
it fills in is Factory plus a short label for the repository. The owner is
not in that label.

The notes below are how that script behaves, for when you do have to run it.

The script prints one localhost link and does not open a browser. Put that
link in the message once. They open it and press Create. Do not send the
link again while the script is waiting; a reminder names the tab already
open and does not include the link. After Create, the same tab moves to
the install page. Paste the install link only if they say that tab was
closed. A second open of the first link is the page that says the manifest
could not be found.

**One App per account that owns repositories.** A GitHub App can only be
installed on repositories owned by whoever owns the App, so a user with repos
under their own account *and* under an organization needs one App for each.
The script derives the owner from `--repo` and refuses a `--org` that
disagrees, because the failure is otherwise silent: the App is created, looks
correct, and the install page simply does not list the repository, with
nothing saying why.

If the user has already set a factory up elsewhere, do not reuse that App —
check who owns it. Making the first App public would also work and is one
toggle, but it lists the App publicly and widens who can install it, so a
second App is the better default for a personal repository.

The App requests no `workflows` permission — absent, not "none", because a
permission that is not requested cannot be granted. That is what stops the
factory editing `.github/workflows` and so tampering with its own gates. Say
this to the user; it is the reason they can leave it running.

**Optionally, the recompiler App** (`--recompiler`). It holds `contents` and
`workflows` and nothing else, and exists to run `gh aw compile` in Actions when
gh-aw updates. Without it, lock files are updated by re-running this skill.
Offer it; do not insist.

## 3. The model API key

Already set at the start, as the Actions secret `ANTHROPIC_API_KEY`. Confirm
it is in `gh secret list`. Do not ask for it again. If it is missing, name
that one chore and start `node scripts/wait-for.mjs secret ANTHROPIC_API_KEY`
in the background. It checks every few seconds. A multi-minute gap is a
failed watch.

**Never ask the user for the key, and never accept it if they offer it.** Not
in the conversation, not in a file, not as an argument you pass on. Whatever
you are told about how this conversation is stored, a key pasted into a chat
is in that chat for as long as it exists, and in whatever that chat is backed
up to. On the first live install the agent asked for it in chat and the user
pasted it, which is exactly the failure this paragraph exists to stop. If a
key does end up in the conversation, say so plainly and tell them to revoke it
in the Anthropic Console and issue a new one.

They paste it on GitHub, not in the chat. One of these, and you watch:

- In their own terminal, which keeps it out of this conversation:

  ```
  gh secret set ANTHROPIC_API_KEY --repo <owner/name>
  ```

  It prompts, reads from stdin, and echoes nothing.
- Or in the browser: **Settings → Secrets and variables → Actions → New
  repository secret**. Name it exactly `ANTHROPIC_API_KEY`, paste the key as
  the value, **Add secret**.

Then confirm it landed, which tells you it exists and never shows you a value:

```
gh secret list --repo <owner/name>
```

The watch is what confirms it. Do not wait minutes between checks. If
`ANTHROPIC_API_KEY` is not in that list, say which of the two routes they
should try again. Do not offer a third route that involves you holding the key.

Suggest, once, that they make this key in its own Anthropic Console workspace
with a monthly spend limit at or a little above the factory's budget. The
factory's budget already stops before it can be passed; the workspace limit is
Anthropic stopping it too, if anything were ever wrong in the factory.

## 4. Estimate the budget

`node ../scripts/estimate-spend.mjs --repo <owner/name>`

It reads the repo's last 90 days and estimates product runs, nightly gardening
and the scheduled reviews, as model spend **and** Actions minutes separately.

Minutes are usually the binding limit, not dollars. A private Free-plan repo
gets 2,000 minutes a month, and nightly gardening at 5 PRs a night can use
most of that on its own — the script lowers the nightly cap rather than letting
it overrun, and says so. Show the user that number. It is the one most likely
to surprise them.

The user confirms or changes the budget, the minutes limit and the shares
(default: $35 a month; product 60%, gardening 25%, reviews and practices 15%).

Say what the budget guarantees, in these words or close to them: **the
factory will stop before it spends more than this, even if that means
stopping with some money left.** Each agent step reserves the most it could
cost before it starts (its credit cap, plus one request past it), and does not
start if that could pass the month's budget or its pipeline's share. Afterwards
it is charged what it measured. So the last few dollars of a month may go
unused; they are never overspent.

## 5. Scorers

Installed with their rubrics. They first run at the first scheduled review.

## 6. Record the starting point

Current guardrail counts, the coverage floor, and the open issue count go into
`index.json`, so the dashboard shows progress from day one. The counts are
the ones in `baselines.json`. The floor is the coverage the suite measured.
If tests exist and the floor is 0, setup is not finished. An empty counts
file while violations remain means setup is not finished.

## 7. Offer the local correction hook

Corrections made in a developer's own Claude Code sessions are as valuable as
PR comments. Offer, and only with the user's consent, to run
`bsf local-hook --install`. It writes to `.claude/settings.local.json` (personal,
not committed), sends only prompts that read as corrections, redacts secrets,
and refuses public repos unless the user passes `--allow-public`. Say plainly
what leaves their machine. If they decline, nothing is lost: PR corrections
are still captured.

## What to watch for

- **Re-running setup must not reset the records.** If the data ref exists,
  leave it alone.
- **Do not store a key the user has not given you.** If a secret already
  exists, confirm rather than overwrite.
