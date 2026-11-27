# The Merge Queue

A cleared pull request reaches main through an approval and a queue. The queue re-checks it against the latest main, so two changes that each pass alone cannot break main together.

## Approval

A cleared pull request reaches main only through approval, a person or a toggle, and the factory's merge queue.

1. **Approval.** Auto-merge off for the pipeline means a trusted person approves the pull request on GitHub or from the dashboard. Approvals from the factory App never count. Submitting a review re-runs only the `factory/policy` check, so the approval registers without re-running the gates. Auto-merge on means the pull request is eligible as soon as its gates pass. Definition pull requests, and anything the weakening check flags, always need a trusted person, whatever the toggles say. The one exception is a settings change a trusted person made from the dashboard, labelled `factory:settings`, touching only the settings file and the cleanup schedule's cron line, and only keys on the list of settings a person may change. Its author counts as the approver, because they cannot approve their own pull request ([The Dashboard](<The Dashboard.md>)).
2. **An automatic request for changes from the factory App is a gate signal.** gh-aw's protected-file check makes the App reject a pull request that touches a protected path: every top-level dot-folder, `.factory/` included, plus dependency manifests and `.github/`. The queue treats that as a gate signal. If the path is one this pipeline is allowed to change, the role's `protected-files` policy was wrong and that is a definition fix. If it is not, the attempt failed correctly. App approvals are ignored.

## How the queue runs

Every factory PR reaches main through a merge queue that re-checks it against the latest main.

- **Native first.** GitHub's merge queue is available in public repos owned by an organization and in private repos of organizations on Enterprise Cloud. There, `factory-sync` turns it on in the ruleset, `factory-gates` runs on `merge_group`, and `factory-merge` only enables auto-merge on eligible PRs; GitHub does the queueing, batching and merging.
- **Fallback elsewhere** (personal-account repos, private repos without Enterprise Cloud): the factory's own one-at-a-time queue below. Existing open-source alternatives were evaluated: Bors-NG is archived, Kodiak and Mergify need a hosted service, and merge-queue-action is too young to depend on.

**Entering the queue** — a PR is queued when its gates pass and either a trusted human approved it or its pipeline's auto-merge toggle is on. Queue order is the time it became eligible; the queue lives in `ledger.json`. `factory-merge` starts on the events that can change eligibility (an approval, a check finishing, a toggle), works through the queue in one job, and exits when it's empty.

**Fallback queue: processing one PR** (`factory-merge`, single concurrency):

1. **Fast path:** if the PR's branch already contains the current main and its gates passed on that exact commit, mark it ready for review and squash-merge it now.
2. Otherwise update the branch from main through GitHub's update-branch API.
3. Re-run the gates on the new commit (timeout 60 minutes): static rules and tests always; agent runtime verification only if the changes that came in from main touch the PR's feature folders.
4. Gates pass → mark ready for review, squash-merge. Gates fail → remove from the queue and send it back to its pipeline as a gate failure (counts toward the retry cap).
5. Update fails with a conflict → remove from the queue and dispatch a conflict resolution run.

**Conflict rebuild** (started by `factory-conflicts` whenever a push to main makes an open factory PR conflict, by the merge queue when updating a PR from main conflicts, and by the check's button):

1. The builder makes the same change again on the current main, from the old PR's diff and what main has since done to the same files (`bsf conflicts context`). It opens as a new PR; the old one is closed with a pointer to it and kept on the work item as `previous_prs`.
2. Rebuilding, rather than merging main into the branch, means the App never pushes main's workflow changes, so it never needs the `workflows` permission.
3. The new PR goes through the gates like any change.
4. A person's approval on the old PR carries to the new one when the rebuilt change touches the same files, adds exactly the lines the approved change added, and removes only lines it removed. Anything else — an extra line, a dropped change from main, a file GitHub will not diff — asks for approval again.
5. A rebuild that cannot finish escalates like any run, and the button on the PR's `factory/conflicts` check starts it again.
