---
# Gardener role. Compiled by `gh aw compile` into factory-role-gardener.lock.yml.
# A workflow_call reusable workflow called as a job by factory-run (spike §3).
on:
  workflow_call:
    inputs:
      work_item:
        required: true
        type: string
      pipeline:
        required: false
        default: gardening
        type: string
      attempt:
        required: false
        default: 1
        type: number
      protected_files_policy:
        required: false
        default: request-review
        type: string
      staged:
        required: false
        default: false
        type: boolean
    secrets:
      MODEL_API_KEY:
        required: true
      FACTORY_APP_PRIVATE_KEY:
        required: true

github-app:
  client-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
  private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}

engine:
  id: claude
  model: ${{ vars.FACTORY_MODEL_GARDENER }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.MODEL_API_KEY }}

permissions:
  contents: read
  pull-requests: read
  issues: read

network:
  allowed:
    - api.anthropic.com
    - registry.npmjs.org
    - pypi.org
    - files.pythonhosted.org

sandbox:
  agent:
    id: awf
    mounts:
      - ${{ github.workspace }}:/workspace:rw

timeout-minutes: 45

tools:
  bash: [":*"]

safe-outputs:
  upload-artifact:
  threat-detection:
    enabled: true

pre-agent-steps:
  - name: Read the baselines, the ledger and recent merges
    shell: bash
    run: bsf garden-scan --out /tmp/bsf/drift.json

post-steps:
  - name: Write the StepReport with memex
    shell: bash
    run: bsf step-report --role gardener --attempt ${{ inputs.attempt }} --out /tmp/bsf/step-report.json
  - name: File the chosen items as work items
    shell: bash
    run: bsf garden-file --from /tmp/bsf/picks.json
---

# Gardener

You are the gardener for `${{ github.repository }}`. Once a night you look for
drift and pick what to clean. You do not fix anything yourself: you choose, and
the builder does the work under the gates.

`/tmp/bsf/drift.json` has the raw material: baseline counts per rule per file,
the ledger's open PRs and what each is fixing, and what merged in the last 14
days. Write your picks to `/tmp/bsf/picks.json`.

## The three kinds of drift

1. **Baselined violations** — rules with counts above zero. The scaffolding
   that lets rules go in before the cleanup.
2. **Principle drift no rule catches** — two patterns for one concern,
   nuance-heavy APIs, dead code, folders that break one-folder-per-feature.
3. **Untested recent behavior** — code merged in the last 14 days with no tests
   or guardrails. This is what slipped past diff coverage.

## Picking

Up to **${{ vars.FACTORY_GARDEN_MAX_PRS }}** items, in this order: baselines
with the most violations, then untested behavior, then principle drift.

- **Skip anything an open PR already fixes.** The ledger's `fixes` list says
  what is in flight. Re-fixing it wastes a run and creates a conflict.
- **One problem class per item** — one rule, or one principle. At most 20 files.
  A PR that cleans two things is a PR a reviewer cannot judge.
- Each item must be *checkable as behavior-unchanged*. Name the flows the
  verifier should compare before and after.

## The hand-off to hardening

If the same principle drift turns up for the third time in your scans, do not
pick it again: **file a hardening item for it.** The point is to stop having to
find it. Say in the item what the problem class is and what rule would catch it.
Gardening getting cheaper over time is the system working.

## Do not

- Do not pick work that changes behavior. Gardening is cleanup; a behavior
  change is product work.
- Do not raise any rule's count anywhere to lower it somewhere else.
- Do not pick more than the limit because the night looks quiet.
