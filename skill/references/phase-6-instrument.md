# Phase 6 — Instrument

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

`node ../scripts/create-app.mjs --repo <owner/name>`

The user clicks **Create**, then **Install**. The script does the rest: posts
the manifest, catches GitHub's redirect on a local server, exchanges the
single-use code, and stores the credentials. The whole flow expires after an
hour.

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

One repo secret, `ANTHROPIC_API_KEY`: the factory's agents all run on Claude
Code. `gh secret set` reads from stdin, so the key never appears in a process
list.

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
(default: $35 a month; product 60%, gardening 25%, review and benchmarks 15%).

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

Current guardrail counts, the coverage floor and the open issue count go into
`index.json`, so the dashboard shows progress from day one rather than from
whenever someone first looks.

## What to watch for

- **Re-running setup must not reset the records.** If the data ref exists,
  leave it alone.
- **Do not store a key the user has not given you.** If a secret already
  exists, confirm rather than overwrite.
