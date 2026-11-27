# Roles

Seven roles do the factory's agent work. They share one context, and the builder never grades itself: the verifier is a separate job, on a separate runner, and it never sees the builder's transcript.

| Term | Meaning |
| --- | --- |
| Model | The AI itself. It reads text and writes text. |
| Agent | A model in a loop with tools: it reads files, runs commands, edits code, checks the result, and repeats. |
| Harness | The program that runs that loop, such as Claude Code. |
| Skill | A folder of instructions an agent loads to do one job. Setup is a skill. The factory's own agents run as GitHub Actions workflows. |
| Hook | A script the harness runs at a set moment, such as the end of a session. |
| Context | What the agent is given to read before it works. |

The factory's own agents run on Claude Code, through GitHub Agentic Workflows. Each agent job is read-only. Anything it changes leaves as a checked safe output. Which harnesses can run, and why the others cannot, is in [Architecture](Architecture.md).

## The seven roles

| Role | Does | Used by |
| --- | --- | --- |
| **Triage** | Understands the work item, reproduces bugs in the sandbox, checks it's in scope, rejects or escalates unclear items | Product work |
| **Spec** | Writes a short, precise plan: what changes, where, acceptance checks, tests to add, and which existing tests will change | Product work, hardening |
| **Builder** | Implements the plan with the smallest correct change, plus tests for new behavior | All pipelines, conflict resolution |
| **Verifier** | Runs the app and checks the result independently; produces the verification artifacts | All pipelines |
| **Gardener** | Finds drift and picks the night's cleanup items | Gardening |
| **Hardener** | Generalizes a correction or failure into a problem class and chooses how the codebase changes: a static rule, a stronger verification requirement, or a refactor that removes the problem class | Hardening |
| **Scorer** | Grades recent work against rubrics in the scheduled review | Self-improvement |

- Every role reads the same four context files: feature map, runbook, fundamentals, history.
- **The verifier never sees the builder's transcript,** only the spec and the result, so no agent grades its own work.
- Each role's model comes from `factory.yaml`; prompts come from `roles/<role>.yaml`.
- **No role sees untrusted text.** Issue bodies and comments from untrusted authors are stripped before a prompt is built; an accepted outside issue is passed in clearly marked as user-supplied.
- **Each role is a gh-aw `workflow_call` workflow.** Every role runs in its own GitHub Agentic Workflows (gh-aw) job: a read-only AWF sandbox behind gh-aw's network firewall, with the app reached in the repo's devcontainer started by `pre-agent-steps`. No role holds a write token; its only way to change anything (push code, open a PR, comment, label) is gh-aw safe outputs, checked by gh-aw's threat detection before a separate job applies them with the factory App's token. `factory-run` (deterministic) calls the role workflows as jobs in order, sequenced with `needs:`, and passes each the `protected-files` policy for the calling pipeline.
- **Because each role is its own job, the verifier cannot reach the builder's transcript** — separate jobs run on separate runners with separate filesystems. Role results travel as job outputs, which are capped at 1 MB per run, so a role writes its report to `factory-data` and returns only ids.
