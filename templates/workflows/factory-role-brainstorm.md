---
# Brainstorm role. Compiled by `gh aw compile` into factory-role-brainstorm.lock.yml.
#
# The conversation held with the author before anything is built, as one job
# that stays alive. A turn used to be a whole workflow run — a comment woke
# intake, intake requeued the item, a role started from scratch and built a
# sandbox it never used in order to ask one question. Three to five minutes a
# turn, which is correspondence rather than conversation. Here the agent asks
# with `bsf brainstorm say` and blocks on `bsf brainstorm wait`, so a turn
# costs the model call and nothing else.
#
# It is a separate workflow from triage for two reasons, and the second is the
# one that settles it. Triage starts the sandbox because it reproduces bugs,
# and a conversation never needs a running app. And the sandbox needs
# FACTORY_SANDBOX_ENV, which is deliberately held in a pre-agent step and out
# of the agent's own environment; a role that does not start a sandbox should
# never be handed that secret at all, which is why it is not in this file.
# A workflow_call reusable workflow called as a job by factory-run (spike §3).
on:
  # Who may start this: decided upstream, not here. This workflow's only
  # trigger is workflow_call, so only this repo's own workflows can start it, and
  # the run that calls it starts only from someone with write access or from the
  # factory's App after intake has checked the request's author is trusted.
  # gh-aw's default role check would test the App itself — whose name differs in
  # every repo and cannot be a compile-time literal — and skip every run.
  roles: all
  workflow_call:
    inputs:
      model:
        description: This role's model, from factory.yaml, read by the caller with `bsf models`
        required: true
        type: string
      budget_key:
        description: Where this step's budget hold is kept; the caller settles it with the same key
        required: false
        default: ''
        type: string
      work_item:
        required: true
        type: string
      pipeline:
        required: false
        default: product_work
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
      ANTHROPIC_API_KEY:
        required: true
      FACTORY_APP_PRIVATE_KEY:
        required: true

github-app:
  client-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
  private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}

engine:
  id: claude
  model: ${{ inputs.model }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    # How `bsf brainstorm` reaches GitHub from inside the agent's container.
    # The engine's env rather than $GITHUB_ENV, so the token is scoped to the
    # agent step instead of being readable by every later step in the job.
    GH_TOKEN: ${{ steps.talk-token.outputs.token }}
    # Bounds on any one request, which is what the budget's margin is built
    # on: the 200k window instead of 1M, and Claude Code's default output cap
    # made explicit. Change one and the budget's ceilings are wrong.
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1"
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000"

permissions:
  contents: read
  pull-requests: read
  issues: read

network:
  # The same list as every other role. A conversation installs nothing, so a
  # shorter list is tempting — but the harness itself fetches from these, and a
  # role that cannot start is worse than a role with egress it does not use.
  allowed:
    - api.anthropic.com
    - defaults
    - node
    - python
    - go
    - rust
    - ruby
    - java
    - dotnet
    - playwright


# A ceiling on one conversation. The default is 360, and a job blocked on
# `wait` would hold a runner for six hours at a person's whim; `wait` gives up
# long before this, so reaching it means something is wrong.
sandbox:
  # The agent's own container, not the app's. `bsf sandbox start` — the Docker
  # services and the install — is what a conversation does not need, and that
  # pre-agent step is gone. This block is the isolation the agent itself runs
  # in, and every role has it.
  agent:
    id: awf
    mounts:
      - ${{ github.workspace }}:/workspace:rw

# Ten minutes, the most a held conversation may keep a runner open. `wait` gives
# up after five quiet minutes by itself; this is the hard stop behind it, and
# the conversation resumes from its saved log on the person's next comment.
timeout-minutes: 10
# A ceiling per run, in gh-aw AI credits (1 credit = $0.01). A normal run is
# well under it; it stops a runaway before it costs a week's budget.
# A conversation is cheap: a question and a reply, several times over. Well
# under a build, and it stops a loop that will not end from costing real money.
# Raised from 15 for the frame. Naming what a request is — the terms, the
# neighbouring fields, where each analogy fails — is the one part of this role
# that is real thinking rather than a question and a reply, and it happens
# once per conversation. A frame that runs out of credits half-written is
# worse than no frame, because the person is then taught half a vocabulary.
max-ai-credits: 25

tools:
  bash: [":*"]

safe-outputs:
  # A conversation comments and nothing else. It does not label an item, close
  # one or upload anything: a question is not a verdict, and the verdicts
  # belong to triage.
  add-comment:
    target: "*"
    staged: ${{ inputs.staged }}
  threat-detection:
    enabled: true
    # The scan for injected or malicious output reads one diff and one
    # transcript: a small model does it, not the role's own.
    engine:
      id: claude
      model: claude-haiku-5-5
      max-turns: 3
      env:
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1"
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000"
        # Overrides the role engine's GH_TOKEN, which gh-aw copies into this
        # job as well. `steps.talk-token` exists only in the agent job, so
        # inherited here the expression dangles and the compiler warns about
        # it in every repo that compiles this file. Empty is also the right
        # value: detection reads one diff and one transcript off disk and has
        # no business reaching GitHub.
        GH_TOKEN: ""
    max-ai-credits: 50

pre-agent-steps:
  # The runner that judges a change must not come from the change. A pull
  # request, a merge-group commit or an agent's workspace can all modify
  # .factory/bin, so it is taken from the default branch and parked outside the
  # workspace, which is the only directory the agent sandbox can write to.
  - name: Fetch the factory runner from the default branch
    uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
    with:
      ref: ${{ github.event.repository.default_branch }}
      path: .factory-trusted
      sparse-checkout: |
        .factory/bin
        .factory/definition
        .factory/sandbox
      sparse-checkout-cone-mode: false
      persist-credentials: false
  - name: Put the trusted runner on PATH
    shell: bash
    run: |
      mkdir -p "$RUNNER_TEMP/bsf"
      cp -R .factory-trusted/.factory/bin/. "$RUNNER_TEMP/bsf/"
      # The definition and the sandbox decide how a change is judged, so
      # bsf reads them from this copy, never from the checkout.
      mkdir -p "$RUNNER_TEMP/bsf-trusted/.factory"
      for d in definition sandbox; do
        if [ -d ".factory-trusted/.factory/$d" ]; then cp -R ".factory-trusted/.factory/$d" "$RUNNER_TEMP/bsf-trusted/.factory/"; fi
      done
      echo "BSF_TRUSTED_ROOT=$RUNNER_TEMP/bsf-trusted" >> "$GITHUB_ENV"
      rm -rf .factory-trusted
      echo "$RUNNER_TEMP/bsf" >> "$GITHUB_PATH"
      chmod +x "$RUNNER_TEMP/bsf/"*
      "$RUNNER_TEMP/bsf/bsf" --version
  # The conventions this repository writes down for agents: AGENTS.md,
  # CLAUDE.md, .claude/skills/ and anything policy.yaml declares. Resolved on
  # every run rather than recorded at setup, so a file the owners added today
  # is read today. Listed, not inlined — the role reads the ones it needs, so
  # a long file costs that role rather than every role.
  - name: Resolve the conventions this repository writes down
    shell: bash
    run: bsf repo-prose --out /tmp/gh-aw/agent/bsf/repo-prose.md
  # The budget: this step starts only if what is spent this month, what
  # running steps hold, and the most this step can cost (its credit cap plus
  # one request past it, for the agent and for threat detection) all fit.
  # A refusal fails here, before the agent spends anything.
  - name: Mint a token for the budget record
    id: budget-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-contents: write
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - name: Hold this step's budget
    shell: bash
    env:
      GH_TOKEN: ${{ steps.budget-token.outputs.token }}
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-brainstorm-{2}', github.run_id, github.run_attempt, inputs.attempt) }}
      PIPELINE: ${{ inputs.pipeline }}
      MODEL: ${{ inputs.model }}
    run: bsf budget reserve --key "$BUDGET_KEY" --pipeline "$PIPELINE" --role brainstorm --model "$MODEL" --cap 25 --detection-model claude-haiku-5-5 --detection-cap 50
  # Read-only, for the steps that fetch this item's data before the agent
  # starts. Minted here rather than handed to the agent: step outputs never
  # reach the agent's sandbox.
  - name: Mint a read-only token for the factory's data
    id: read-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-contents: read
      permission-actions: read
      # Scoped to this repository: an App token otherwise reaches every repo
      # the installation covers.
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  # A conversation is the one thing that cannot be batched into a conclusion
  # job. Every other role proposes its writes as safe outputs and a trusted job
  # performs them after the agent exits; a question posted after the run has
  # ended is not a question. So this role gets a token during the run — and
  # only this one, scoped to exactly what a conversation needs.
  #
  # contents:write is for the conversation log on the factory's data ref, not
  # for the repository's own files: every ref the runner writes is under
  # refs/factory/, and the gates refuse a change to tracked files from this
  # pipeline.
  #
  # The agent never posts a comment itself. It calls `bsf brainstorm say`,
  # which is trusted code from the default branch, and that redacts the text
  # and strips the factory's own markers before anything is sent. Same shape as
  # a safe output: the agent proposes words, trusted code performs the write.
  - name: Mint a token for the conversation
    id: talk-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-issues: write
      permission-contents: write
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - name: Fetch the work item
    shell: bash
    env:
      GH_TOKEN: ${{ steps.read-token.outputs.token }}
      WORK_ITEM: ${{ inputs.work_item }}
    run: bsf fetch-work-item "$WORK_ITEM" --out /tmp/gh-aw/agent/bsf/work-item.json
  - name: Fetch the conversation so far
    shell: bash
    env:
      GH_TOKEN: ${{ steps.read-token.outputs.token }}
      WORK_ITEM: ${{ inputs.work_item }}
    run: bsf brainstorm "$WORK_ITEM" --out /tmp/gh-aw/agent/bsf/brainstorm.txt

post-steps:
  # What this step spent, for the caller's settle job: the agent's cost as
  # the session recorded it (or priced from its tokens at list price, if
  # higher), and the name of the threat-detection artifact, whose usage the
  # settle job prices. Runs even when the agent failed: a failed step spent
  # too, and a missing measure is charged at the ceiling.
  - name: Measure this step's cost for the budget
    if: always()
    shell: bash
    env:
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-brainstorm-{2}', github.run_id, github.run_attempt, inputs.attempt) }}
      MODEL: ${{ inputs.model }}
      DETECTION_ARTIFACT: ${{ needs.activation.outputs.artifact_prefix }}detection
      PIPELINE: ${{ inputs.pipeline }}
    run: bsf budget measure --key "$BUDGET_KEY" --pipeline "$PIPELINE" --model "$MODEL" --detection-artifact "$DETECTION_ARTIFACT" --out /tmp/gh-aw/bsf-budget/measure.json
  - name: Upload the budget measure
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: budget-${{ inputs.budget_key || format('{0}-{1}-x', github.run_id, github.run_attempt) }}
      path: /tmp/gh-aw/bsf-budget/measure.json
      if-no-files-found: ignore
  # Write access, only after the agent has exited, for the steps that store
  # what it produced on the factory's data ref.
  - name: Mint a token to store this step's results
    id: write-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-contents: write
      permission-actions: read
      # Scoped to this repository: an App token otherwise reaches every repo
      # the installation covers.
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - name: Write the StepReport with memex
    shell: bash
    env:
      GH_TOKEN: ${{ steps.write-token.outputs.token }}
      ROLE: brainstorm
      ATTEMPT: ${{ inputs.attempt }}
      MODEL: ${{ inputs.model }}
    run: bsf step-report --role "$ROLE" --attempt "$ATTEMPT" --model "$MODEL" --out /tmp/gh-aw/agent/bsf/step-report.json
  # The run record is made from these: model, tokens and cost for each role.
  - name: Upload the StepReport
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: step-report-brainstorm
      path: /tmp/gh-aw/agent/bsf/step-report.json
      if-no-files-found: ignore
---

# The conversation

You are talking to the author of a request for `${{ github.repository }}`,
before anything is built. Your job is to understand what they actually want
well enough that the spec stage has something real to work from.

This is a conversation, not a form. **You stay in this session for the whole
of it** — you ask, you wait, they answer, you ask again. Nothing resets
between turns, so a fourth question should obviously follow from the first
three answers.

## The factory's own rules

Read these before anything else, and keep to them:

- `/tmp/gh-aw/agent/bsf/repo-prose.md` — the conventions **this repository** writes
  down for agents, and where they are. Read the files it lists first: they are the
  owners' own statement of how work here is done, they are kept current, and
  everything below supplements them rather than replacing them.
- `.factory/definition/context/fundamentals.md` — what this product is for
- `.factory/definition/context/feature-map.md` — what exists and where
- `.factory/definition/context/practices.md` — practices the owners stated to
  the factory, for what has no home in the codebase

And read the request and the conversation so far:

- `/tmp/gh-aw/agent/bsf/work-item.json` — the request
- `/tmp/gh-aw/agent/bsf/brainstorm.txt` — what has already been said, if anything

## How to talk

One question at a time. Always one. Two questions in a comment get one answer
and you will not know which.

Open before narrow. "What would you be able to do that you cannot now?" earns
a real answer; "should the button be blue or green?" earns a shrug and tells
you nothing you could not have guessed. Narrow questions are for the end,
when only a detail is left.

Ask about the problem, not your solution. If you find yourself asking whether
they want it done the way you were about to do it, you have stopped listening.

Build on the last answer. Quote the part you are following up on, so they can
see you read it.

Short. A sentence or two. They are answering on their phone.

Never ask what you can read. The codebase, the context files and the
conversation are all in front of you. A question whose answer is in
`feature-map.md` wastes their time and tells them you did not look.

## Name the thing, and teach them the name

Most requests arrive in vague words, and a request filed in vague words gets
built in vague words. The fix is not to ask more questions — it is to work out
what this **is**, in the terms the field already uses, and then **tell them**.

Telling them is the part that matters. If they do not have the word for the
thing, every question you ask about it lands on somebody with no way to answer
it precisely, and you get a guess back that you then build on. Give them the
word and the next three answers are worth three times as much.

Work it out from their files, their code and what they actually wrote — not
from a summary of it, and not from the issue title alone.

**If the request could name more than one problem, that is your first
question.** Not an open one. Name the two or three problems it could be, give
the one term for each, and give the sign that tells them apart. "Is the thing
you cannot do right now X or Y? If it's X you'd be seeing <sign>." That is a
question only they can answer and the answer redirects everything after it.
An open question here just gets you a longer version of the issue text.

Then, early — once an answer or two has settled which problem this is — teach
the frame. One turn, with `bsf brainstorm frame`. You supply:

- `named` — what this is, one plain sentence, with the one term that names it.
- `terms` — 8 to 12, **ranked by how much each would change what gets built**.
  Not alphabetical, not by how clever they sound. Each needs what it means in
  one plain sentence, the part of **what they actually said** that it names,
  what having it lets them ask for, and a real project, paper or system that
  uses it that way if you know of one. A term that names nothing they said is
  a term you went looking for. A term that unlocks nothing is vocabulary.

  Those two fields are printed behind a label, so write each to read after
  one. `names` follows "From what you wrote:" — so `the part where it dies
  halfway` or `you said it must not post twice`, not a bare fragment that
  needs a different lead-in. `unlocks` follows "Lets you ask for:" — so
  `a resume from the last good step`, a thing they could ask for, rather than
  a description of the benefit.
- `neighbors` — 2 or 3 fields that solved this shape of problem under other
  names. What carries over, **where the analogy breaks**, and which terms come
  back. Where it breaks is required: an analogy with no stated limit is the one
  that gets over-applied later.
- `unmentioned` — what they did not mention and should care about.
- `readings` and `reading_taken` if it was ambiguous.

They see the top few terms and neighbours; the rest goes to the spec stage,
which reads all of it. So write the full list even though the comment is
shorter — the ranking is how you decide what they see.

**You have no web access.** Do not invent a link and do not cite a paper you
are unsure of; name prior art only where you are confident what it is, and
leave it out otherwise. The whole frame is passed on marked unverified, and
the spec stage — which does have research egress — confirms each term against
a real source and cuts what it cannot confirm. Your job is to name things
accurately, not to prove them.

The frame is **not a gate**. It ends with your next question, and they are
free to ignore every word of it and just answer. Do not ask them to approve
it, do not wait for them to acknowledge it, and do not post a second frame to
correct a term unless an answer actually showed it was the wrong term.

Then carry on. The things in `unmentioned` that genuinely change the build are
your next questions, one at a time, in rank order.

## How it ends

The conversation is over when you can write down what they are asking for
**with nothing left to fill in** — no "presumably", no "some kind of", no
placeholder. That is the test. Not a number of turns.

Play it back before you finish. Say what you now believe they want, **in the
words you taught them** rather than the words the request arrived in, and mark
anything you are assuming. If the frame named this a X, the playback says X;
a playback that slides back into the vague original words is a sign the frame
never actually took. They correct it or they agree;
either is useful. This is their last cheap chance to stop you building the
wrong thing, and it costs them one read.

**Do not write a spec.** Nobody filing a request wants to review a document
about it. The spec stage reads this conversation and does its own research;
your job is to understand, not to design.

**If several questions have not got you there**, the request probably needs a
person more than it needs another question. Say so plainly, say what you do
and do not understand, and stop.

## The commands

Three, and they are the only way you talk to them:

```bash
# Ask. One comment on the issue, one turn in the log, both or neither.
bsf brainstorm say "$WORK_ITEM" --issue <N> --text "your question"

# Teach the frame and ask the next question, in one turn. Write the JSON to a
# file first; it is nested, and a shell will mangle a term's meaning quoted
# into an argument. It is refused if a term has no means/names/unlocks, or a
# neighbour no breaks_down, because those are what make it worth their read.
bsf brainstorm frame "$WORK_ITEM" --issue <N> --file /tmp/frame.json \
  --question "your next question"

# Wait for the answer. Blocks. Prints what they said, or prints "quiet" on the
# first line if they have gone away.
bsf brainstorm wait "$WORK_ITEM" --issue <N> --author <their login>

# End it, with what you understood.
bsf brainstorm close "$WORK_ITEM" --understood "what they are asking for"
```

The issue number and the author's login are in the work item.

`wait` blocks for up to five minutes. **If it prints `quiet`, stop.** Do not
ask another question into the silence and do not call `wait` again: they have
gone, the log is saved, and their next comment starts a fresh conversation
exactly where this one left off. Ending there costs nothing; holding a runner
open for somebody who has closed their laptop costs real money.

Do not post comments any other way. `say` is what redacts the text and keeps
the log and the issue in step; a comment you write by hand is a turn the next
conversation cannot see.

## What to do

1. Read everything above, and work out what this is before you type anything.
2. If the conversation is empty: if the request could be two or three
   different problems, ask which with `say`, naming each and the sign that
   tells them apart. Otherwise ask your first open question with `say`. If the
   conversation is not empty, read it and carry on from where it stopped.
3. `wait` for the answer.
4. If no frame has been taught yet and you now know which problem this is,
   teach it with `frame`, ending on your next question. Then `wait`.
5. Otherwise: is there anything left you genuinely cannot write down without
   guessing? If yes, ask the next question with `say` and `wait` again. If no,
   play back your understanding with `say`, `wait` once for a correction, and
   then `close`.
6. If you got `quiet` at any point: stop. Say nothing more.
