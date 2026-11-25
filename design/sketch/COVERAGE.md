# What the dashboard does, and where

The dashboard is where the owner spends almost all their time with the
factory, so it has to show everything the factory knows and do everything
the owner would otherwise open GitHub for. This is the list, checked against
`dashboard/lib/github.ts`, `dashboard/lib/settings.json` and `schema/*.json`.

`bundle/check-actions.mjs` proves it in a browser: it performs every action
below from a fresh page and finds every piece of data on the screen that
shows it.

```bash
node design/sketch/bundle/check-actions.mjs
```

## Actions

| Action | Where in the Briefing | Client method |
| --- | --- | --- |
| Merge a pull request: squash, merge commit or rebase | Briefing screening; request page, merge bar with method | `mergePull` |
| Request changes on a pull request | Briefing; merge bar | `requestChanges` |
| Comment on a pull request | Request page, Pull request tab | `comment` |
| Comment on one line of the diff | Line numbers in Files changed | **add** `createReviewComment` |
| Read the diff file by file, mark files viewed | Files changed | `pullFiles` (viewed is local) |
| Close a pull request without merging | Merge bar | **add** `closePull` |
| Answer the factory's question | Briefing reply box; Conversation tab | `comment` |
| Agree to the playback, or correct it | Conversation tab | `comment` |
| Comment on an issue | Activity tab; escalation reply | `comment` |
| File a new request: feature, bug, harden or tidy | New request (button, `N`, search, empty state) | `createIssue` with `buildRequest` |
| Open an issue for a request that has none (Slack) | Briefing; Conversation tab | `createIssue` |
| Close or reopen an issue | Request details; callouts | `setIssueState` |
| Add or remove labels | Request details | `addLabels`, `removeLabel` |
| Let a request from someone without write access start | Briefing; request callout | `addLabels` (`factory:accept`) |
| Change priority | Request details; queued callout | `addLabels`, `removeLabel` (`priority:high`) |
| Move a request to another kind of work | Request details, while it hasn't started | `moveRequest` |
| Drop a request, with or without an issue | Queued callout; Briefing (Slack request) | `dispatchWorkflow` of `factory-drop.yml` (work item ids and a reason) |
| Re-run the failed jobs of a run | Runs; request Runs tab; escalation | `rerunFailedJobs` |
| Re-run a failed factory workflow | Factory, Workflows | `rerunFailedJobs` |
| Cancel a running run | Runs; run page; request Runs tab | **add** `cancelWorkflowRun` |
| Accept or reject a guardrail candidate | Briefing; Guardrails | `decideCandidate` |
| Add or remove a standing goal, optionally for one kind of work | Factory, Standing goals | `addStandingGoal`, `removeStandingGoal` |
| Run any factory workflow that can be started by hand | Factory, Workflows; Guardrails (self-review); search | `dispatchWorkflow` |
| Change any of the nine settings | Factory, Settings | `applySettingsChange` |
| List and switch repositories | Repository menu; sign-in | `installedRepos` |
| Sign in with GitHub, token as a fallback, demo, sign out | Sign-in; account menu | `session.ts`, `github-login.ts` |
| Search and jump to anything, or file what you typed | `/` or Ctrl+K anywhere | none (client side) |
| Choose light, dark or system | Account menu | none (client side) |

Three methods are new and go into `dashboard/lib/github.ts` in Phase 2:
`closePull` (`PATCH /pulls/{n}` with `state: closed`), `createReviewComment`
(`POST /pulls/{n}/comments`), and `cancelWorkflowRun`
(`POST /actions/runs/{id}/cancel`). Everything else is already there.

Things the dashboard deliberately sends to GitHub instead: managing who has
write access (People links to the repository's access settings), installing
the app on another repository, and the raw Actions log of a run. Each is a
link in the place you'd look for it.

## Data

| Data | Where |
| --- | --- |
| Every work item, in all ten statuses, with source, routing and its reason, priority, labels, goal, success check, parent, related, previous PRs, triage reason, cost, timestamps, id | Requests (filters by state, kind, text); request page details |
| The conversation: turns, open questions, the playback, live or cold, and requests with nowhere to answer | Briefing; Conversation tab |
| Every run, in all eight outcomes plus running, with steps (role, model, attempt, time, tokens, cost, exit), gates (attempt, commit, result, failures, coverage), artifacts kept, people's interactions, transcript | Runs; run page; request Runs tab |
| What's running this second: step, attempt, time and cost so far | Briefing rail; run page (ticks live) |
| The pull request report: three-line summary, proof blocks in order with captions, diagram, where to look, read-more documents | Briefing screening; Pull request tab |
| Checks on the pull request, conflicts, the diff | Pull request tab |
| Merge queue: what merges itself, and when | Briefing rail; request page |
| Metrics: automation rate, spend against budget, projection, daily spend, by kind of work, cycle time, reverts, Actions minutes, people's edits per PR | Spend; Briefing rail |
| Guardrails: candidates and their sources, decided candidates, installed rules and why, baselined counts, coverage floor and skips | Guardrails |
| The factory's self-review: scores, problems and where they went, what it left for you | Guardrails |
| Sandbox: tier, app, services, stand-ins, egress, what it can and can't check | Factory, Sandbox |
| Settings, standing goals, workflows and their last runs, people with write access, health, runner, models | Factory |
