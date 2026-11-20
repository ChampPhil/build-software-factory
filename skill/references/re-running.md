# Re-running the skill

The skill is safe to run again. It detects an existing factory —
`.factory/definition/factory.yaml` — and switches to update mode.

## First: find out which mode you are in

```
bsf doctor --repo OWNER/REPO
```

It changes nothing. `installed=false` means plain setup. `installed=true` with
nothing broken means update mode. `installed=true` with broken findings means
repair mode, and the findings are the diagnosis to show the user before
touching anything.

## Update mode

**Keep what the user has changed.** Their `factory.yaml`, their `policy.yaml`,
their context files and their rubrics are theirs; they may have been edited by
hand or by a definition PR. Treat the templates as a source for *new* things,
not as the truth.

So:

- **Workflows and lock files** are regenerated and recompiled, because those
  track the runner version.
- **Definition and context files** are left alone unless the user asked for a
  change, or a new runner version needs a field they do not have — in which
  case add the field with its default and say which you added.
- **Guardrails** are extended, never reset. A baseline gardening has been
  lowering is not re-recorded at today's count: that would undo the work.
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

## Failure handling, in any mode

- **Stop at the phase that failed.** Say which step, what you tried, and what
  you would need. Do not continue with a half-installed factory; a factory
  missing its gates is worse than no factory, because it looks like one.
- **Never leave the repo half-changed on a branch the user might merge.** If
  you stop, say plainly whether the branch is safe to merge, and if it is not,
  say so first.
- **A phase 2 failure is terminal for setup.** Without a sandbox that runs the
  app there is no runtime verification, and the factory's core claim does not
  hold.
