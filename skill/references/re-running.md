# Re-running the skill

The skill is safe to run again. It detects an existing factory —
the factory's definition under `.factory/definition/` — and switches to update mode.

## First: find out which mode you are in

```
bsf doctor --repo OWNER/REPO
```

It changes nothing. `installed=false` means plain setup. `installed=true` with
nothing broken means update mode. `installed=true` with broken findings means
repair mode, and the findings are the diagnosis to show the user before
touching anything.

## Update mode

**Keep what the user has changed.** Their settings, their trust rules, their
context files and their rubrics are theirs; they were changed from the
dashboard or by a definition PR. Treat the templates as a source for *new* things,
not as the truth.

So:

- **Workflows and lock files** are regenerated and recompiled, because those
  track the runner version.
- **Definition and context files** are left alone unless the user asked for a
  change, or a new runner version needs a field they do not have — in which
  case add the field with its default and say which you added.
- **Guardrails** are extended, never reset. A rule that is already enforced
  stays enforced. Never loosen one. Record a new rule's count, then clean
  until that count is zero. Do not leave the new violation standing.
- **Data refs** are left alone entirely.
- **Candidates** are re-mined, but only new corrections are shown. One the user
  already rejected is not offered again:

  ```
  bsf mine-corrections --merge-into .factory/guardrails/candidates.json
  ```

  It keeps every existing candidate and its status, folds a problem that is
  already pending into that candidate's occurrence count, and leaves anything
  accepted, rejected or installed alone. It reports the three numbers, so the
  user can see that re-mining found four new problems rather than re-offering
  forty old ones.

Everything still arrives as one PR, and the diff is the point: the user should
be able to see exactly what an update changed.

## Repair mode

This section is for a factory that is already set up. While setup is still
going, the setup skill owns the repair: diagnose it and fix it in the same
turn, and do not stop to agree a fix.

Use this when something is broken rather than out of date — a lock file too
stale for gh-aw to run, a missing secret, a ref that was deleted.

1. **Diagnose first and say what is wrong**, before changing anything. A repair
   that silently fixes three things teaches the user nothing about their
   factory. `bsf doctor --repo OWNER/REPO` is the diagnosis; show the user its
   findings, each with what would put it right, and agree what to fix.
2. Fix only what is broken. A finding whose `repair` is `null` is one only the
   user can deal with — a secret's value must never pass through the runner,
   and a definition file holds their own choices, so overwriting it with a
   template would discard them.
3. **Recompile the lock files** if gh-aw's version check is failing them. This
   is the path for a user who declined the recompiler App.

## What looks broken but is not

A first run throws up several things that look like failures and are not. During
setup, say so in the same turn and keep going. On a later visit, say so when
the user asks, rather than investigating them as bugs.

- **`factory/policy` on a private free repository.** That plan cannot require
  checks, so the check finishes as not required instead of staying yellow.
  Merge when **`factory/gates`** passes; that is the check that means something
  here. Do not wait on `factory/policy`. `bsf doctor` reports the repository's
  enforcement mode, and `audit` is this one.
- **`factory-audit` runs on every push and may report `gate_pending` or
  `unconfirmed`.** Both are informational and neither fails the run. The audit
  is the fallback for repositories that cannot require checks: it reads what
  actually landed on the default branch and only fails on a commit that really
  did bypass the gates. A revert PR follows only where
  `enforcement.audit_revert_pr` is on.
- **`factory-audit` failing right after the setup merge.** Re-run the audit.
  If it goes green, continue. If it stays red, setup is not done. Repair
  the cause. Do not send the closing message while it is red.
- **`assessment.md` still on the default branch.** It is meant to be deleted
  when the setup PR merges. If it is still there, the delete did not make it
  into that PR — remove it on a `factory/fix-*` branch rather than by pushing
  to the default branch.
- **Guardrails reporting 0 rules.** On a repository with no linter, formatter
  or test runner, the gates have nothing to check and pass vacuously. That is
  a real problem, not a cosmetic one: phase 3 §0 installs a minimum toolchain
  so the gates mean something.

## Filing a smoke-test request from the command line

The issue forms are the normal way in, but a repository's forms are not always
reachable yet, and `gh` is more reliable to script:

```
gh issue create --title "Smoke test: say hello on the home page" --body-file -
```

with a body of:

```
What should be true when this is done:
The home page shows the word "hello" somewhere visible.

Where it should go (if you know):
The home page template.
```

Then label it so intake picks it up:

```
gh issue edit <number> --add-label factory:accept
```

The label is what starts the factory, not the form.

## Requests to change the factory

People ask for changes to how the factory runs on the dashboard's **Ask the
factory** box, which files an issue labelled `factory:ask`. No agent works on
those; they wait for you. In update mode, and whenever the user says "update my
factory", list them first:

```
gh issue list --label factory:ask --state open --json number,title,body
```

For each one:

1. Say what was asked, in the person's own words.
2. If it is a setting the dashboard controls (`bsf settings` lists them), make
   it on a branch with `bsf settings --set id=value[,id=value]`, then open a pull
   request labelled `factory:settings`. The factory's policy check passes it on
   its author's say-so, because only settings a person may change were
   touched, and it merges like any other pull request. Do not edit the file by
   hand.
3. Anything else (a model, a limit, the trusted list, the name of the repo's own
   test check) is a change to the factory's definition. Make it as a pull
   request without that label, so a trusted person's approval is required, and
   say in the description what it changes and why.
4. Put `Closes #N` in the pull request and reply on the issue with the link.
5. If you cannot do what was asked, say so on the issue, in plain words, and
   leave it open. Never ask the person to edit a file themselves.

## Failure handling, in any mode

- **Repair and continue.** A failed lock-in of the private copy is repaired
  and rerun. Do not ship a private-copy-only pull request and postpone the
  checkers. Do not cancel a second factory-setup run that still has to
  commit the checkers. Do not ask if a partial result is enough.
- **Do not say setup is done** while a factory pull request is red on its
  own checks, the coverage floor is 0 while tests exist, or an audit is
  red. File the smoke-test request yourself and repair until that pull
  request is green.
- **Never leave the repo half-changed on a branch the person might merge.**
  If a branch is not safe to merge, say so, and keep working until the
  pull request is green. Do not hand them a red one.
- **A partial private copy is not a place to stop.** Without the journeys
  running, the checkers installed, and the counts at zero, setup is still
  open.
