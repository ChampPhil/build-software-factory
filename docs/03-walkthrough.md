# Software Factory — Technical Walkthrough

Nov 18, 2026 · @Philip

This walkthrough takes a complete beginner to understanding every technical concept the software factory uses. Read it in order: each section builds on the ones before it.

Every section has the same three parts:

- **What it is** → the concept in plain language.
- **Analogy** → a picture from everyday life.
- **How the factory uses it** → where it shows up in the factory.

Section 15 ties everything together by following one piece of work from start to finish.

## 1. Git basics

**What it is.** Git records the full history of a set of files.

- A **repository** (repo) is a project folder whose history git tracks.
- A **commit** is a saved snapshot of the files, with a message describing what changed.
- A **branch** is a separate line of commits where you can change things without affecting anyone else.
- **Main** is the official branch: the version of the code that counts.

**Analogy.** A repo is a shared document with a perfect undo history. Each commit is a saved version with a note attached. A branch is your own draft copy, where you edit freely before proposing your changes to the official version.

**How the factory uses it.** Everything the factory does goes through git. Agents work on branches. The factory's own definition (rules, pipelines, context) lives in the repo as files. The factory's data lives in git too, under a hidden ref called `factory-data`: like a branch, but kept out of the branch list so writing to it never sets off the team's own automation. Because it's all in git, every change to the code *or* to the factory has a history and can be undone.

## 2. Pull requests and code review

**What it is.**

- A **pull request (PR)** is a proposal to merge a branch's changes into main.
- It shows the **diff** (exactly which lines changed), a description, and a discussion thread.
- **Code review** is someone examining the PR and either approving it or asking for changes.
- **Merging** applies the PR's changes to main.
- A **draft PR** is a PR marked as not yet ready to merge.

**Analogy.** A PR is like handing an edited draft to an editor. The editor sees your tracked changes, leaves comments in the margins, and either accepts the draft into the official document or sends it back.

**How the factory uses it.** Every pipeline ends in a draft PR. The human control point is approving that PR, and the human does it by looking at the **verification artifacts** (screenshots, videos, plain-language summaries), not by reading the code line by line. Past PR review comments are also one of the main sources of corrections that get mined into guardrails during setup.

## 3. Merging, conflicts, rebasing and merge queues

**What it is.**

- While you work on a branch, other PRs merge into main, so your branch falls behind.
- Usually git combines both sets of changes automatically.
- A **merge conflict** happens when your branch and something already in main changed the *same lines*. Git can't tell which version to keep.
- **Rebasing** means taking your changes and re-applying them on top of the *latest* main, as if you had started from it. It's how you bring a branch up to date and resolve conflicts.
- A **merge queue** lines approved PRs up and merges them one at a time. Each one is tested against main *plus everything ahead of it in the line* before it lands.

**Analogy.** Two editors both rewrote the same paragraph. Someone has to read both versions and write one that keeps both intentions; that's resolving a conflict. A merge queue is a single-file line at the editor's desk, where each draft is checked against the latest official version before it's accepted.

**How the factory uses it.**

1. **Detect** → GitHub marks a PR as conflicting; that's a development-event trigger.
2. **Resolve** → an agent rebases the PR onto the latest main, reads *why* each side made its change (both PR descriptions or specs), and writes a version that does both.
3. **Re-clear** → the combined code is new and unchecked, so it goes through the factory-clear loop again.
4. **Re-approve** → back to a human, or automatic if auto-merge is on.
5. **Escalate** → if the two changes truly contradict each other, a human decides.

The merge queue catches a sneakier case: two PRs that don't conflict, each pass alone, but break the app when combined. GitHub's built-in merge queue only exists for public repos owned by an organization and for Enterprise Cloud, so the factory uses GitHub's queue where it's available and runs its own elsewhere: one approved PR at a time, updated from main, static checks and tests re-run (and runtime verification too if main's new changes touch the same features), then merged.

## 4. CI and GitHub Actions

**What it is.**

- **Continuous integration (CI)** automatically runs checks on code whenever something happens, such as a PR being opened.
- **GitHub Actions** is GitHub's built-in automation system:
  - A **workflow** is a file in the repo (`.github/workflows/*.yml`) describing what to run and when.
  - Workflows start from **events**: a PR opened, an issue created, a comment posted, a schedule (cron), or a manual run.
  - A **runner** is the computer that executes the workflow; GitHub provides fresh, temporary machines.
  - **Secrets** are stored credentials (like API keys) that workflows can use without exposing them.
  - **Artifacts** are files a workflow saves, like screenshots and logs.

**Analogy.** GitHub Actions is a building's automation system. When a door opens, a timer fires or a button is pressed, a pre-written routine runs on a machine in the basement.

**How the factory uses it.** GitHub Actions is the factory's always-on runtime: it listens for triggers, provides the compute where agents run, and stores artifacts. The user runs no servers of their own.

**Limits to design around:**

- Artifacts expire: at most 90 days in public repos, up to 400 days in private ones. Workflow run records are cleaned up on the same schedule → the factory copies the media humans review to long-lived storage (its own git ref, kept 12 months by default), and a run file never depends on a workflow run still existing.
- Minutes are billed per job and rounded up to a whole minute, and private repos only get a small monthly allowance → the factory runs on events, never on a polling timer, so an idle factory costs close to nothing.
- In public repos, scheduled workflows are disabled after 60 days with no repo activity → the dashboard flags it if gardening stops running.

## 5. Branch protection, required checks and CODEOWNERS

**What it is.**

- **Branch protection** is a set of rules on main: for example, no pushing changes directly, everything goes through a PR, and approval is required.
- **Required checks** are CI checks that must pass before a PR can merge.
- **CODEOWNERS** is a file naming who must approve changes to particular files or folders.

**Analogy.** Branch protection is the lock on the official document: only accepted drafts get in. Required checks are mandatory inspections. CODEOWNERS says certain chapters need sign-off from a specific editor.

**How the factory uses it.**

- **Nothing reaches main without passing the gates.** The factory's gates are required checks and direct pushes are blocked. Human PRs get the deterministic gates (static rules, tests, coverage) and keep the team's normal review and merge flow; agent verification runs on them only if someone asks. Every PR must be up to date with main before it merges, so two changes that each pass alone can't break main together.
- **A PR can't rewrite its own checks.** GitHub runs a PR's own copy of the workflow files, so the factory's policy check uses a trigger (`pull_request_target`) that always runs main's copy instead, and it blocks any PR touching workflow files until a trusted human approves. The factory only adds its checks; it never removes the repo's existing protection rules.
- The factory doesn't rely on CODEOWNERS. A path-policy gate, always loaded from main, decides what each pipeline may change; changes to the factory definition need a trusted human's approval, and weakening a guardrail (removing or loosening a rule, raising a baseline) needs a human too. That keeps all three pipelines auto-mergeable. Branch protection and rulesets on private repos need a paid GitHub plan (Pro or above); on free private repos the factory is still the only thing that merges through its gates, and a post-push audit flags anyone who pushed straight to main.

## 6. Static analysis

**What it is.** Static analysis checks code **without running it**, by reading it. Each base kind reads the code at a different depth:

| Kind | What it reads | Tiny example |
| --- | --- | --- |
| Text and regex | Raw text | Flag anything shaped like an AWS key (`AKIA` + 16 characters) |
| Structured-data schema | Config files | Every dependency must be on the approved list |
| Syntax tree (AST) | The parsed structure of the code | A `fetch(...)` call outside `/lib/api` is caught however it's formatted |
| Canonical form | Code vs. its formatted version | Fail if the formatter would change anything |
| Types | What every value is | `user.id` is a number, so passing it where text is expected is an error |
| Dependency graph | Which module imports which | `features/billing` must never import from inside `features/auth`; no import cycles |
| Call graph | Which function calls which | A function nothing calls is dead code |
| Control flow | Possible paths through a function | Code after a `return` can never run; complexity is measured here |
| Data flow and taint | Where values travel | Text a user typed reaches a database query unsanitized |
| Clone detection | Repeated code | Two near-identical 40-line blocks |
| Cross-artifact consistency | Two things that must agree | The API spec lists an endpoint no handler implements |

**Analogy.** Static analysis is proofreading. A spellchecker is text matching, a grammar checker is the syntax tree, and checking that every cross-reference points to a chapter that exists is the dependency graph.

**How the factory uses it.** Static analysis is Gate 1 of the factory-clear loop. These rules are fast and deterministic, and they are how the factory *categorically eliminates* problems. Higher-level rules like "one folder per feature" are built by combining base kinds (file paths + dependency graph).

## 7. Ratchets and baselines

**What it is.**

- A new rule added to an existing codebase usually finds violations that already exist.
- If the rule simply failed on any violation, every PR would fail from then on, including the ones fixing violations.
- A **baseline** records the count of existing violations for each rule.
- A **ratchet** checks *direction*: no PR may raise any rule's count in any file, and a cleanup PR must also lower its rule's count. The count can only go down.
- When a rule's count reaches zero, the ratchet goes away and the rule becomes plain pass/fail.

**Analogy.** A ratchet wrench turns one way only. Each cleanup PR clicks the count down a notch, and nothing can turn it back up.

**How the factory uses it.** During setup, guardrails go in *before* the cleanup, with each rule's existing violations recorded as its baseline. Cleanup PRs then chip away at the counts while the gate blocks any new violations, from normal work or from the cleanup agents themselves. Many linters already keep such a baseline themselves (ESLint's bulk suppressions, for example), and the factory uses theirs wherever it exists. Baselines are kept **per rule and per file**, so fixing 10 violations of one rule can't hide 5 new violations of another, and fixing one in one file can't pay for a new one elsewhere. A rule whose violations a mechanical autofix clears at setup (the formatter, a linter's `--fix`) needs no baseline.

## 8. Testing: unit, integration and end-to-end

**What it is.** Tests are code that checks other code by running it. They differ in how much of the system they run at once:

| Type | What it runs | Example | Speed | Catches |
| --- | --- | --- | --- | --- |
| Unit | One function, everything around it faked (mocked) | `calculateTax(100)` returns `8` | Milliseconds | Logic bugs in one piece |
| Integration | A few real pieces together | Saving a user writes the right database row, and reading it back returns the same user | Seconds | Wiring bugs: wrong queries, bad formats, schema mismatches |
| End-to-end (E2E) | The whole app, used like a real user | Sign up → log in → add to cart → check out | Slowest | Whether the product actually works |

The usual balance is the **test pyramid**: many unit tests, fewer integration tests, a handful of E2E tests. E2E tests are the most likely to be **flaky** (failing randomly).

**Analogy.** Unit tests check each car part on a bench. Integration tests check that the engine and gearbox work together. E2E tests drive the whole car around the block.

**How the factory uses it.** Tests are half of Gate 2. Agents run them in their inner loop while coding, and the factory re-runs them in the sandbox as the official check. Tests can be rewritten or deleted in any pipeline, because code changes legitimately reshape them. What's protected is the safety net as a whole: an existing test may change only if the spec said it would, new or changed behavior must come with tests (a diff-coverage check, the main one), total coverage can't fall more than a point below its highest, and a skipped test counts as a suppression (reason required, counted, capped). From v0.2, mutation testing on changed lines checks that new tests actually catch bugs. The verifier and scorers judge whether rewritten tests still check something meaningful.

## 9. Agent runtime verification

**What it is.** An agent starts the real app in a sandbox and uses it the way a developer would, with real dev tools:

- **Browser automation** → the agent drives a real browser through Playwright (via Playwright MCP, which gives agents browser control): it clicks, types, navigates and reads the page, and Playwright records screenshots, video and traces.
- **Dev tools** → it reads console errors and network requests, checks the database, and calls the API directly.
- It **records evidence**: screenshots, short videos, before/after comparisons.

Unlike a test, nothing is scripted in advance. The agent explores the specific change it's checking, so it can catch problems no one thought to write a test for.

**Analogy.** A test is a checklist inspection. Runtime verification is a skilled mechanic test-driving the car and filming anything odd.

**How the factory uses it.** It's the other half of Gate 2, and it produces the **verification artifacts** a human reviews instead of reading code:

- Product work → the new behavior working.
- Gardening → the app behaving the same before and after.
- Hardening → the app unchanged after existing violations were fixed.

It needs the app to run reproducibly in a sandbox (section 11) and a **runbook** telling agents how to start and use it.

## 10. Formal verification

**What it is.** Formal verification *proves* that a property holds for every possible input or execution, instead of checking a few examples.

- You write a precise description (a **specification**) of what must always be true, such as "two users can never both book the last seat."
- A tool then checks every possible state, or builds a mathematical proof, that the code or design satisfies it.
- Examples of tools: **TLA+** (model-checking system designs, popular for distributed systems), **Lean** and **Dafny** (proofs about code).
- It is far stronger than testing and far more expensive, so it's used only for critical logic: money, permissions, concurrency, consensus.

**Analogy.** Testing is checking that a bridge holds the 20 trucks you drove across it. Formal verification is the engineering calculation proving it holds *any* load under its limit.

**How the factory uses it.** It's optional and targeted. During setup, a past correction about critical logic (a race condition, a permissions bug) can become a formal check instead of a test. In the factory-clear loop it runs as part of Gate 2 for the parts of the code it covers.

## 11. Sandboxes and reproducible environments

**What it is.**

- A **sandbox** is an isolated environment where code runs without being able to touch anything outside it.
- A **container** (for example Docker) packages an app with everything it needs (language version, libraries, tools) so it runs the same on any machine.
- A **devcontainer** is a standard config file describing a container for development.
- **Reproducible** means anyone, or any agent, gets the exact same working environment from the same files, every time.

**Analogy.** A sandbox is a lab clean room: experiments happen inside, and nothing leaks out. A container is a shipping container: whatever's inside arrives the same, whichever ship carries it.

**How the factory uses it.** It's setup phase 2, *make it runnable*. Agents do all their work inside the sandbox: building the app, running tests and runtime verification. Two benefits:

- **Reliability** → "works on my machine" can't happen; every run starts identical.
- **Security** → a compromised or misbehaving agent can't reach anyone's laptop or secrets (the core problem with local agents). Agents in the sandbox hold no write token and can only reach the model API and package registries; their changes leave the sandbox only as checked "safe outputs" (section 12).

The skill reuses whatever the repo already has (Dockerfile, devcontainer, setup scripts) before writing anything new.

## 12. Agents, agent CLIs, harnesses, skills, MCPs and hooks

**What it is.**

| Term | Plain meaning |
| --- | --- |
| **Model** | The AI itself (Claude, GPT, an open-weight model). It reads text and writes text. |
| **Agent** | A model in a loop with tools: it reads files, runs commands, edits code, checks the result, and repeats until the task is done. |
| **Harness / agent CLI** | The program that runs that loop and gives the model its tools, e.g. Claude Code or Cursor CLI, run from a terminal. |
| **Skill** | A folder of instructions (a `SKILL.md` plus scripts) an agent loads to do one kind of job well. |
| **MCP** | Model Context Protocol: a standard way to plug outside tools and data (GitHub, a tracker, a database) into any agent. |
| **Hook** | A script the harness runs automatically at a set moment, such as when a session ends or before a tool runs. |
| **Context** | Everything the agent is given to read before it works: instructions, the feature map, conventions. |

**Analogy.** The model is a talented new hire. The harness is their desk and computer. Skills are training manuals, MCPs are the company's internal systems they can log into, hooks are office routines that happen automatically, and context is the onboarding packet.

**How the factory uses it.**

- **The setup tool is itself a skill** → the user runs it in their own agent CLI.
- **Agents run inside GitHub Actions** on Claude Code (the one harness whose spending the factory can cap), through GitHub Agentic Workflows (gh-aw), GitHub's open-source framework for this. Each agent job is read-only; anything it wants to change (code, comments, labels) is handed over as a "safe output" that gh-aw checks for prompt injection and leaked secrets before applying it.
- **Seven fixed roles** (triage, spec, builder, verifier, gardener, hardener, scorer) all read the same **shared context**: the feature map, runbook, fundamentals and history.
- **Builder and verifier are separate** so no agent grades its own work.
- **Hooks capture local work** → a hook committed to the repo saves each local agent session's transcript (with secrets redacted) to the factory's data. It asks each developer once, on their own machine, before capturing anything, and it only stores transcripts where the public can't read them: on a public repo, that means the private data repo.

## 13. LLM-as-a-judge, scorers and benchmarks

**What it is.**

- **LLM-as-a-judge** → using a model to grade work against a rubric ("Does this PR follow the spec? Is the change minimal?"). It handles judgments that code checks can't.
- **Scorers** (also called *online evals*) → judge agents that grade the factory's real work. They run in a scheduled review every few days, over everything done since the last one.
- **Benchmarks** → a fixed set of real past tasks, each paired with a known-good result, that can be re-run against any factory configuration. The tasks never change, so a difference in score must come from the configuration (a model, a prompt, the context).

**Analogy.** Scorers are a teacher grading this week's homework. A benchmark is the same standardized exam given to every class, so classes can be compared fairly.

**How the factory uses it.** This is the factory loop:

1. Instrumentation records every run continuously; every few days a scheduled review has the scorers grade all recent work and find failures.
2. Completed tasks become benchmark tasks, including ones a human had to fix, graded against the human's fix.
3. Failures are grouped and routed: a fix in the codebase, static rules or verification goes to hardening; a fix in the factory definition (context, a step's model) is tested on the benchmarks, several runs per side so noise can't pass for improvement, then opened as a PR for a human to approve. A context line that comes straight from a human correction skips the benchmark.

Benchmarks also answer "is the new model worth it?" with a cost vs. quality graph for each kind of task. Benchmarks come **after** setup, once the factory has done real work to build them from.

## 14. Static web apps and the dashboard

**What it is.**

- "Static" describes how an app is *served*, not how it *behaves*.
- A **static app** is a set of files (HTML, JavaScript, CSS) sent identically to everyone. The JavaScript then runs in the user's browser and handles all clicking, navigation, animation and live data fetching. It can be fully interactive and polished.
- A **server-rendered app** runs code on a server for every request, and that's the kind whose costs grow with users.
- **Client-side fetching** → the browser asks other services for data directly. Here: the browser calls the **GitHub API** using the user's own GitHub access.
- **Next.js** can be either kind: with `output: 'export'` it builds into a static app. Pages that depend on IDs only known at runtime use a fixed page that reads the ID from the URL (`/run?id=123`).
- Static hosting such as **Cloudflare Pages** serves static files free with unlimited bandwidth.
- The one server step is **sign-in**: GitHub's login needs a tiny token exchange, run as a Pages Function on the dashboard's own address (free), and skipped if users paste a fine-grained token instead.

**Analogy.** A static app is a printed instruction kit mailed to everyone; all the building happens at the recipient's kitchen table. A server app is a restaurant that cooks every order.

**How the factory uses it.** The dashboard is an open-source static app. It reads the user's `factory-data` ref (run files and the rollup summary) and the Actions API (runs in progress), polling every few seconds. Its write actions (auto-merge toggles, approving guardrail candidates) **commit to the factory's config files**, so the factory stays defined in code. The user's data never touches the maintainer's servers, and hosting costs stay near zero however many people use it. Everyone signs in with their own GitHub access; a public, sign-in-free view is left for later.

## 15. Putting it together: one issue, start to finish

A trusted collaborator files a GitHub issue: *"The export button downloads an empty file."* Here is everything that happens, with the concept at each step.

1. **Trigger** → the new issue is a *signal trigger*; a GitHub Actions workflow listening for new issues starts (sections 4, 12).
2. **Work item** → the issue becomes a standard work item and is routed to the *product work* pipeline.
3. **Sandbox** → the workflow starts a fresh runner and builds the app in a reproducible container (section 11).
4. **Triage** → the triage agent reads the shared context (feature map, runbook), reproduces the bug through browser automation, and confirms it's real (sections 9, 12).
5. **Spec** → the spec agent writes a short, precise plan for the fix.
6. **Build** → the builder agent commits a fix plus a regression test, running checks locally as it goes; it hands the commit over as a checked "safe output", which lands on a factory *branch* as a draft PR and starts the gates in a separate job (sections 1, 8, 12).
7. **Gate 1** → the factory runs the static rules: AST, types, dependency graph, and the ratchet against baselines (sections 6, 7). One rule fails (the fix called `fetch` directly); the agent switches to `apiClient` and retries.
8. **Gate 2** → the factory runs the unit, integration and E2E tests; a separate verifier agent clicks Export in a real browser and records a video of a non-empty file downloading (sections 8, 9).
9. **Draft PR cleared** → the draft PR opened in step 6 is marked cleared and filled in with the plan and the artifacts. Key screenshots are copied to long-lived storage; the full video stays a workflow artifact (sections 2, 4).
10. **Trace** → a run file (steps, timing, cost, gate results, links to artifacts) is written to `factory-data`; the rollup summary updates (section 14).
11. **Approval** → the human watches the 20-second video on the dashboard and approves. With auto-merge on for product work, this step is skipped.
12. **Conflict** → meanwhile, a gardening PR merged and changed the same file. The PR is marked conflicting; an agent rebases, combines both intents, and the PR goes back through Gates 1 and 2 (section 3).
13. **Merge queue** → the PR is updated from main and re-checked, then marked ready and merged. Branch protection guaranteed it couldn't skip the gates (sections 3, 5).
14. **Learning** → the run is traced, and at the next scheduled review a scorer grades it. The direct-`fetch` slip in step 7 was already caught by an existing rule, so nothing new is needed. If agents keep making it, the repeated failures trigger hardening, which can make `apiClient` the only way to reach the network (an API change), so the mistake becomes impossible rather than just caught (section 13).

Every concept in this walkthrough appeared at least once: that's the whole factory.
