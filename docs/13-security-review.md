# Build Software Factory — Security Review

Nov 20, 2026 · Claude

The release checklist's security review, item by item. Each claim below was
checked against the code rather than recalled, and each says what was looked
at, so the check can be repeated.

This reviews the design and the code as written. It is not a penetration test,
and nothing here has been attacked by anyone but its author.

## The threat this is built around

A coding agent running in CI holds, or is one mistake away from holding,
credentials that can write to the repository. The two ways that goes wrong:

1. **Untrusted input steers the agent.** An issue, a comment or a PR body from
   someone outside the team reaches a prompt and tells the agent what to do.
2. **Untrusted code runs with credentials.** A pull request changes the
   workflow that is about to run it, or runs in a job that holds a secret.

Everything below is one of those two, or the blast radius if one happens.

## 1. Trust at intake

**Checked:** `runner/src/commands/intake.ts`, `intake.test.ts`.

Only events from owners, members and collaborators with write access start
agent work. Anything else becomes a work item in `waiting_trust` and starts
nothing until a trusted person adds `factory:accept`.

Trust belongs to people, not integrations. An issue filed by Linear's or
Sentry's bot account waits for the same one-click accept, however its
association reads — tested, because an integration's bot often *does* read as
a member, and a factory that trusted it would let anyone who can file a Linear
ticket start an agent.

A fork event starts nothing at all.

## 2. Untrusted text never reaches a prompt

**Checked:** `stripUntrustedText` in `intake.ts`, its three call sites, and
`role-io.ts`.

The stripping happens **in the step that writes the prompt's input**, not at
intake and not in the role workflow. That placement is the point: an item
could be accepted between being read and being prompted, and a strip done
earlier would be stale in the wrong direction.

`fetchWorkItem` passes a body only when the item is not `waiting_trust`, and
labels what it does pass as `source: "user-supplied, untrusted"` so the model
sees what it is reading. The verifier's `--spec-only` mode never receives the
request at all; triage notes expose which files changed and never the
transcript.

## 3. The policy check cannot be rewritten by the pull request it checks

**Checked:** `templates/workflows/factory-policy.yml`.

On `pull_request`, GitHub runs the workflow files **from the pull request**, so
a PR — a fork's above all — could rewrite `factory-gates.yml` to pass
unconditionally. The policy check closes this:

- it runs on `pull_request_target`, which always uses main's copy;
- it checks out `github.event.repository.default_branch`, never the PR's head;
- with `persist-credentials: false`, so the checkout's token is not left in
  the runner's git config for a later step to use;
- it loads `policy.yaml` from main, not from the PR;
- it fails any PR touching workflow or definition files until a trusted human
  approves.

It never checks out, builds or runs a line of the pull request's code.

## 4. No secret is in a job that can see pull-request code

**Checked:** every workflow in `templates/workflows/`, by listing its triggers
and the secrets its text references.

| Workflow | Triggers | Secrets |
| --- | --- | --- |
| `factory-gates.yml` | `pull_request`, `merge_group` | `FACTORY_SANDBOX_ENV` only (test-mode values for the sandbox; never given to a fork) |
| `factory-policy.yml` | `pull_request_target`, `pull_request_review` | App key |
| `factory-merge.yml` | `pull_request_target` | App key |

The gates see the PR's code and hold nothing. The two that hold the App key
run from main's copy and check out the default branch. That is the whole
invariant, and it is visible in three lines of a table rather than buried in a
convention.

## 5. The App cannot edit the gates

**Checked:** `skill/scripts/create-app.mjs`'s manifest.

The App does not request the `workflows` permission. It therefore cannot
change `.github/workflows/`, which means the gate definitions can only change
through a human's own push — and that push is itself subject to the policy
check. An agent that could edit its own gates is not gated.

The optional recompiler App exists precisely because gh-aw's compiled lock
files *do* need a workflow write, and it is a separate App a user may decline.

## 6. Per-job tokens, and no token in the sandbox

**Checked:** the `permissions` blocks across the templates, and the harness
jobs.

Every workflow sets `permissions` at the top, and the widest is
`contents: read` with `checks: write` where a check has to be reported. Tokens
are minted per job through `actions/create-github-app-token`.

The agent itself writes nothing directly: gh-aw runs it in a sandbox with no
repository token, and everything it produces leaves through gh-aw's safe
outputs after threat detection. The network inside the sandbox is on an
allowlist of the harness's own provider domains.

## 7. Redaction

**Checked:** `redact` in `mine.ts`, and its tests.

Transcripts are redacted before analysis, by token shape and by the name a
value is assigned to — the second matters because a project's own token format
is not one anybody's pattern list knows.

gh-aw redacts its own output independently, so a secret would have to defeat
both.

## 8. Fork pull requests

**Checked:** `policy.ts`, `policy.test.ts`.

A fork PR runs only the gates that need no secrets. Agent work never starts
from a fork. A fork PR that edits a guardrail path fails on both the protected
path and on being a fork, and an approval from an untrusted author does not
clear it.

## 9. What a contribution from a teammate exposes

**Checked:** `contribute.ts`.

`bsf contribute-corrections` carries quotes from someone's private agent
sessions into a shared repository. It is deliberately two commands: the first
mines and writes a file on their disk, printing exactly what would be shared;
the second submits. Consent to read a session is not consent to publish from
it, and the gap between the two commands is where that distinction lives.

## 10. The dashboard

**Checked:** `dashboard/lib/session.ts`, `runner/src/commands/serve.ts`.

The dashboard is a static page that talks to GitHub from the viewer's browser
with their own token. No server sees it. `bsf dashboard` serves it on the
loopback interface only — a page holding a repository-writing token, served on
a network, hands anyone on that network the ability to act as its owner.

**The hosted dashboard's policy.** The page is served with a
Content-Security-Policy that lets it connect only to itself and `api.github.com`
(so a bug cannot send the token anywhere else), forbids framing, forms,
`<base>` and plugins, and allows scripts only by hash: every inline script in
the built pages is hashed at build time (`dashboard/scripts/csp-hashes.mjs`),
and a page that gained an injected `<script>` or an `onclick=` would not run it.
Styles are the exception, see below.

## Accepted risks

Each of these was weighed and left, on purpose. They are written down so that a
later reader does not have to rediscover them or mistake them for oversights.

- **Inline styles are allowed (`style-src 'unsafe-inline'`).** React writes
  style attributes, which cannot be hashed, and the dashboard sets many. A style
  is not a way to run code, and with `connect-src` limited to GitHub's API an
  injected style could not send a token out either. The cost is that an
  attacker who could inject markup could restyle the page, for example to dress
  up a button. Scripts, which are the dangerous half, are hash-only.
- **`/api/auth/exchange` and `/refresh` trust the `Origin` header.** They refuse
  a request whose `Origin` is not the site itself. A non-browser caller (a
  script, `curl`) can send any `Origin`, so the check does not stop one. It does
  not need to: it exists to stop another website's script in a victim's browser
  from calling the function, and browsers do not let a page choose its own
  `Origin`. A direct caller still has to present a valid GitHub authorization
  code or refresh token, which only someone already signed in to GitHub as that
  person holds, and the function stores nothing and returns no GitHub error
  text. Forging the header therefore gets an attacker nothing they could not
  get from GitHub directly.

## Known gaps

Said plainly, because a review that lists only what it found is not a review.

- **Nothing here has been attacked.** No third party has reviewed this, and
  no penetration test has been run.
- **The policy check's own correctness is tested against fixtures and against
  three real pull requests**, not against an adversary trying to get past it.
- **`bsf consistency` and the rule packs are not a security boundary.** The
  data-flow rules catch a shape of mistake; they are not a guarantee that no
  tainted value reaches a sink.
- **The free-plan path cannot prevent a direct push to main.** `factory-audit`
  detects it afterwards and can open a revert PR; that is detection, not
  prevention, and the README says so rather than implying otherwise.
- **An App installation's blast radius is the repositories it is installed
  on.** Read from `skill/manifests/factory-app.json`, the factory App asks
  for:

  | Permission | Why |
  | --- | --- |
  | `contents: write` | Push factory branches and the data refs |
  | `pull_requests: write` | Open, review and merge factory PRs |
  | `issues: write` | Comment on a work item, add `factory:accept` |
  | `checks: write` | Report the gates as check runs |
  | `statuses: write` | The older commit-status API, where a repo uses it |
  | `actions: write` | Dispatch a workflow, cancel a run |
  | `administration: write` | `factory-sync` applying branch protection from config |
  | `metadata: read` | Required by GitHub alongside the rest |

  No `workflows`, and `create-app.mjs` refuses to proceed if the manifest
  ever grows it — that permission is what would let the App rewrite its own
  gates. The recompiler App does hold it, which is the whole reason it is a
  separate App a user may decline.

  `administration: write` is the widest of these and the one worth thinking
  about before installing: it can change a repository's settings, not only
  its branch protection. Installing the App only on the repositories that
  need it is the mitigation, and the only one.
