# Triggers

Five kinds of triggers start factory work. The first three make it reactive. The last two make it proactive. Every trigger becomes one work item before anything is routed, so routing sees the work and not where it came from.

## The five kinds

Five kinds of triggers start factory work; the first three make it reactive, the last two make it proactive and self-improving.

1. **Request triggers** → a human explicitly asks for work.
2. **Development-event triggers** → something changes in the development process: a review comment on a factory PR, CI broken on main, a merge conflict.
3. **Signal triggers** → the outside world reports a problem: production errors and user reports, arriving as GitHub issues.
4. **Scheduled triggers** → time-based upkeep that keeps the garden pristine without anyone asking.
5. **Self triggers** → the factory's own data creates work: human corrections, repeated failures, failures found in the scheduled review.

- Every trigger becomes **one standard work item** before routing → routing only sees what the work is, not where it came from.
- **The factory is also a trigger source** → anything it sets off goes back through routing, never straight into a workflow.
- **Only trusted people can start work** → agent work starts only from repo collaborators; outside issues, and issues an integration's bot creates, wait until a trusted person accepts them.
- **Later:** releases and security advisories as triggers.
- **Requests arrive as GitHub issues** → Slack (free GitHub app for Slack), Linear (GitHub Issues sync) and Sentry (GitHub integration) all create issues, so nothing extra has to be hosted.

## Intake

`bsf intake` turns every trigger into one work item, after checking who sent it and whether the work already exists.

1. **Trust check.** The event's author must be an owner, member or collaborator with write access. Trust belongs to people, never integrations: an issue authored by an integration's bot account (Linear, Sentry) waits like an outside issue, and shows on Home for a one-click accept. Otherwise the item waits, untouched, until a trusted person adds `factory:accept`. Fork events never start agent work.
2. **Normalize** the event into a work item ([Schemas](Schemas.md)) and write it as its own file, `work-items/<id>.json`: source, trigger class, title, body, fingerprint. Intake runs in a single concurrency group with `queue: max`, so events are handled one after the other, and each intake run processes every event not yet processed, so none is lost even if a pending run is dropped.
2a. **Say so.** As soon as intake has read an issue (a dashboard request is one too) the factory comments on it: which kind of work it took it for, the goal it will check against, how to unblock it if an untrusted author is waiting for `factory:accept`, and that it will ask one question here before writing any code if something is unclear. A CI failure, a schedule and a correction have nobody waiting, so they get no comment.
2b. **Kind and goal.** The four issue forms (Feature, Bug, Harden this, Tidy this) apply the label for them: `factory:harden` sends the request to hardening, `factory:tidy` sends it to gardening, and the other two go to product work. A `### Goal` section, from a form or the dashboard, is kept on the work item as `goal` and the spec treats it as the success check. A goal from someone the factory does not act for is not kept.
2c. **Questions before a run.** Triage is the only step that asks, and only before any code: one specific question as a comment on the issue, the item in `needs_info`, no run or branch yet. A trusted person's comment answers it and puts the item back in the queue with the answer in its body; `/retry` does the same without an answer. **A question never times out and never escalates.** It waits, however long, and Home shows how long and gives an answer box that posts the comment for the person.
3. **Shortlist duplicates.** The fingerprint finds open items that might be the same request; they're passed to triage, which decides (step 1 of product work). An item that matches work merged recently is never dropped: it becomes a high-priority follow-up linked to the earlier PR (`related`), which triage gets as context.
4. **Route** by trigger to one pipeline. Requests that a person created (issue, comment asking for work, dashboard request) are routed by the **chief of staff** (4a); every other trigger uses the table:

| Trigger | Pipeline |
| --- | --- |
| Issue, comment asking for work, Slack/Linear/Sentry issue, dashboard request | Product work |
| CI failure on main | Product work (high priority) |
| Review comment on a factory PR | Back to that PR's run as a revision (not a new item) |
| Correction from a trusted person on a factory PR (review comment, change request, or a push to its branch) or in a local Claude Code session | A hardening item at once, linked to the correction and the run it corrects; the same correction said twice folds into the open item. Comments on a hardening or definition PR are revisions of that PR, never new corrections |
| Nightly schedule | Gardening |
| Problem routed by the scheduled review | Hardening |
| `/practice` comment declaring a practice | Definition change (human-approved) |
| Conflict on an open factory PR | Conflict resolution |

4a. **Chief of staff.** For each accepted request, intake makes one tool-less call to the model named at `models.chief_of_staff` (default `claude-haiku-5-5`) with the request, the feature map and the tail of `history.md`. It answers with the pipeline (product work, gardening or hardening), a specific goal, a success check the verifier can test, a priority and a one-line reason. A feature goes to product work, a mistake that keeps recurring to hardening, and a vague cleanup to gardening. The request text is data: nothing in it can change the answer's shape, and the answer is validated strictly. Trust stays deterministic: only requests intake has already accepted are routed, and nothing the model says can admit an untrusted author. If something is genuinely unclear it asks **one** question as an issue comment; the item waits in `needs_info` and an answer routes it, never with a second question. A person's own `factory:harden` or `factory:tidy` choice is kept (tidy stays gardening); a person's own goal is kept; priority is only ever raised. If the call fails, there is no `ANTHROPIC_API_KEY`, or the product-work budget is paused, the table's route stands and the work proceeds. The call is charged to the budget. The decision, its reason, who made it and the success check are on the work item and in the acknowledgement comment; nothing in it rewrites a role prompt.
4b. **Overrides and standing goals.** Any pipeline choice can be changed in one step from the dashboard's Work items page (a request that has not started; the move is recorded with who and when, and the dashboard shows how often people move what the chief of staff chose). Standing goals ("tighten auth this month") are set by asking: the dashboard's Factory page, or `/focus [lane:] text` in a comment by a trusted person. They are kept on the data ref (`standing-goals.json`, at most 20) and handed to the chief of staff, the spec, the gardener and the hardener as tie-breakers; they never override a request.
5. **Dispatch** `factory-run` if a concurrency slot is free (default 5); otherwise the item stays `queued`, high priority first, then oldest first. Every `factory-run` ends by dispatching the next queued item, and every rollup (including the daily sweep) dispatches queued items when slots are free, so the queue drains without a timer even if a run crashes.
6. **Budget shares:** gardening (25% by default) and reviews and practices (15%) each stay within their share of the monthly budget; product work may use what they leave, never past the total. A pipeline whose largest step no longer fits what is left keeps its items queued until it does ([Budget](Budget.md)).
