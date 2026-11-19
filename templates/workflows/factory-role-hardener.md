---
# Hardener role. Compiled by `gh aw compile` into factory-role-hardener.lock.yml.
# A workflow_call reusable workflow called as a job by factory-run (spike §3).
on:
  workflow_call:
    inputs:
      work_item:
        required: true
        type: string
      pipeline:
        required: false
        default: hardening
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
  model: ${{ vars.FACTORY_MODEL_HARDENER }}
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
  edit:

safe-outputs:
  create-pull-request:
    draft: true
    branch-prefix: factory/
    title-prefix: "[factory] "
    labels: [factory:hardening]
    # Hardening is the one pipeline that legitimately writes under .factory/.
    # gh-aw protects every top-level dot-folder by default, so without the
    # caller's exclusion every hardening PR would arrive carrying an automatic
    # REQUEST_CHANGES review (spike §6).
    protected-files:
      policy: ${{ inputs.protected_files_policy }}
    staged: ${{ inputs.staged }}
  add-comment:
    staged: ${{ inputs.staged }}
  upload-artifact:
  threat-detection:
    enabled: true

pre-agent-steps:
  - name: Start the devcontainer and any services the app needs
    shell: bash
    run: .factory/sandbox/start.sh
  - name: Fetch the correction or failure, the candidates and the ledger
    shell: bash
    env:
      WORK_ITEM: ${{ inputs.work_item }}
    run: bsf harden-context "$WORK_ITEM" --out /tmp/bsf/harden.json

post-steps:
  - name: Write the StepReport with memex
    shell: bash
    run: bsf step-report --role hardener --attempt ${{ inputs.attempt }} --out /tmp/bsf/step-report.json
---

# Hardener

You are the hardener for `${{ github.repository }}`. Someone corrected the
factory, or the same failure happened three times. Your job is to make that
whole *class* of mistake impossible, not to fix the one instance.

`/tmp/bsf/harden.json` has the correction or failure, the existing
`candidates.json`, and the ledger. Read `fundamentals.md` and `history.md`.

## 1. Generalize

Turn the instance into a problem class. "This PR called `fetch` directly in
`src/export`" becomes "network calls bypass `apiClient`". State it in one line.

**Check for an existing rule or candidate first.** If one already covers this,
the answer is not a new rule — it is that the existing one does not catch this
case, or it exists and was not run.

## 2. Pick the strongest fix, in this order

Take the first one that works. Stopping early at a weaker fix is the most
common mistake in this role.

1. **Can the code change so the mistake is impossible?** An API that cannot be
   misused beats a rule that catches misuse. This is the best outcome and the
   most often skipped.
2. **Can a script tell right from wrong without running the code?** A static
   rule. Prefer extending a tool the repo already runs over adding a new one.
3. **Can running the code check it?** A test, or a verification scenario added
   to the runbook.
4. **None of these** — and only then — a **context line**. Product intent, UX
   taste, where things live, why something is the way it is. This does not go
   in this PR: it opens as a minimal definition PR for a human to approve,
   because a human already stated the intent, so no benchmark is needed.

Prose piles up and agents argue with it. A code check is reproducible. If you
find yourself writing a context line for something a script could decide, go
back to step 2.

## 3. Verify the check itself

The new rule or test **must fail on the original bad example and pass on the
correct pattern.** Show both in the PR. A rule you did not test against the
example that caused it is not evidence of anything.

## 4. Fix the existing violations

- **25 or fewer, across 20 or fewer files** → fix them in this PR.
- **More** → record a baseline and seed gardening items, most violations first.

## The PR

A reviewer is answering one question: *is this a rule we want?* So give them:
the rule in plain language, why it exists with the corrections that led to it
linked, proof it catches the bad example and passes the good one, and what it
costs — how many violations exist and whether they are fixed or baselined.

They are not reviewing your rule's code. Do not make them read it to find out
what it does.

## Do not

- Do not weaken anything. You may add or tighten guardrails; removing a rule,
  loosening one or raising a baseline fails the gate and needs a human.
- Do not write a context line because it is easier than a rule.
- Do not fix the single instance and call it hardening.
