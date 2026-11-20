# Phase 2 — Make it runnable

Produce a sandbox where an agent can build the app, run its tests, and verify
it at runtime with real tools. This phase is the one most likely to fail, and
the one it is most important not to fake.

**Done when the app starts in the sandbox, a screenshot shows it working, and
the containment checks pass.** If you cannot get there, stop and show the user
the failing step. Do not continue. A factory that cannot verify anything still
produces confident PRs, which is worse than no factory.

## Steps

1. **Derive, do not inherit.** Run `bsf sandbox-plan --root .`. It reads the
   repo for what the app *needs installed* and synthesizes everything the app
   *reads*, so the sandbox is the same whichever agent builds it and the user
   can read what it will contain before it runs.

   An existing devcontainer or Dockerfile is an input to this, not the base.
   `bsf sandbox-plan` takes its runtimes and system packages and deliberately
   drops its `ENTRYPOINT`, `CMD`, `HEALTHCHECK`, `EXPOSE` and `VOLUME`,
   reporting each drop. Those describe what the *production* image does, and
   inheriting them is how a sandbox ends up running the deployment path it was
   built to avoid.
2. **Add the sidecars the plan asks for** — Postgres, Redis, MinIO — plus a
   headless browser for runtime verification. The plan's `usable` variables
   already point at them.
3. **Write the runbook** (`context/runbook.md`) from the plan's output: build,
   run, test, verify and seed-data commands, the synthesized environment, the
   egress allowlist, and the plan's "cannot establish" list. Test every command.
4. **Prove it works, and prove it is contained.** Build the sandbox with
   Docker, run the tests, start the app, and have a verifier agent open it in a
   browser through Playwright, with Playwright taking the screenshot. Then run
   the containment checks below. A sandbox that only passes the happy path has
   not been shown to be a sandbox.
5. **Give the sandbox no secret of the user's.** Not one. The environment is
   exactly what `bsf sandbox-plan` synthesized and nothing else.

## Why this phase is built the way it is

The first version of this phase said to reuse the repo's devcontainer or
Dockerfile as the base, record the repo's own commands, and give the sandbox
the secrets the app needs to run — and then warned, thirty lines later, never
to let the sandbox inherit real credentials. Both were prose addressed to an
agent, and they contradicted each other, so whichever an agent read more
literally won.

The deeper mistake was the premise. **Deployment logic exists in order to reach
production.** Reusing it and then trying to spot the dangerous parts is a
denylist, and it holds only until the hazard takes a shape nobody enumerated:

- a Dockerfile `ENTRYPOINT` that runs a release script;
- a compose service pointed at a real host;
- a config file that loads `.env.local` on import — `drizzle.config.ts` calling
  `config({ path: ".env.local" })` is normal, and it means a build inherits
  whatever that file holds;
- a `postinstall` hook, a Makefile target, a framework instrumentation file
  that opens a connection on boot;
- a variable read through a helper, so no scan of `process.env.NAME` finds it.

Enumerating those is useful and never finishes. So the safety here does not
come from which commands the sandbox avoids running. It comes from **what the
sandbox cannot reach**:

- Every variable the app reads is **synthesized**. No credential of the user's
  is present, so there is nothing for a command to misuse.
- Anything the app would dial points at `blocked.sandbox.invalid`. `.invalid`
  is reserved by RFC 2606 and cannot resolve, so a request aimed at production
  fails at DNS rather than at whatever happens to answer.
- Egress is refused except for package registries. Not the app's own provider
  domains: an app that cannot build without reaching its production API has a
  build coupled to production, and the response is to say so, not to open the
  hole.
- The environment is **closed, not additive**. The sandbox receives exactly the
  synthesized variables. This is the load-bearing part, because no static scan
  can prove it found every variable an app reads — so a variable the scan
  missed must be *absent*, making the app fail loudly on boot, rather than
  *inherited*, making it work against whatever the host held.

Under this, `npm run build` chaining `drizzle-kit migrate` stops being a hazard
to detect and becomes a command that migrates a throwaway database, because the
only connection string in the sandbox points at one.

The command-level check (`runbook_command_touches_state`, below) stays, demoted
to what it should always have been: a diagnostic that explains a failure and
records which verification steps have side effects — not the thing standing
between an agent and production.

So:

- Build the sandbox's environment from **`bsf sandbox-plan`'s output and
  nothing else**. A positive list, not a denylist — `.env.local` is only
  today's example.
- **Classify the repo's commands rather than copying them.** Record which
  touch persistent state, and keep those out of the build path. The runbook
  records `build` and `migrate` as separate commands, with `migrate` marked.

  Do not do this by reading the manifest and judging. Run it:

  ```sh
  bsf consistency --root . --json
  ```

  `runbook_command_touches_state` findings are the ones that matter here. The
  check walks each script's chain, `pre`/`post` hooks included, and knows the
  difference between `drizzle-kit generate` (codegen, harmless) and
  `drizzle-kit migrate` (applies SQL). It fires only on scripts whose names
  promise they are safe to re-run — `build`, `test`, `verify`, `start` and
  their kin — because `npm run deploy` deploying is that script doing its job.

  When it fires, there are two fixes and the user picks:

  1. **Give the factory the inner command.** `next build` instead of
     `npm run build`. Right when the side effect is not part of verifying.
  2. **Point it at a throwaway target and record that in the runbook.** Right
     when the app genuinely cannot start without a migrated database.

  Writing the reason in the runbook clears the finding, which is the point:
  the check enforces that the decision was made, not which way it went.
- **Test for it.** Run the build and test commands with no credentials present
  and watch for one that wanted something real. The user will not know this
  about their own repo; most people do not — and a user who does know may have
  written the coupling down as expected, which it is for them, by hand, on
  their own machine. That note is about them running it. It says nothing about
  an agent running it on every pull request, which is the case you are here to
  make safe.

## Containment checks

Step 4 is not done until these pass. Each one tries to do the thing the sandbox
is supposed to prevent, because a sandbox that has only been shown to run the
happy path has not been shown to be a sandbox.

1. **DNS fails closed.** From inside the app container:

   ```sh
   getent hosts blocked.sandbox.invalid && echo FAIL || echo ok
   ```

   Must print `ok`. If this resolves, every inert URL in the plan is pointed at
   something that answers.

2. **Egress is refused.** Pick a host that is not on the allowlist and not the
   app's own, and confirm the connection fails rather than hanging or
   succeeding. A hang is a fail: the verifier will time out and someone will
   "fix" it by widening the allowlist.

3. **No host value reached the container.** Dump the container's environment and
   diff the variable *values* against the plan. Every value must be local, end
   in `.invalid`, carry the `sandbox-fake` sentinel, or be the generated key.
   Anything else came from the host, and the sentinel exists so this diff is
   mechanical rather than a judgement call.

4. **The side-effecting command hits the throwaway.** Run the recorded build
   with the synthesized environment, then confirm the migration landed in the
   sandbox's own Postgres. This is the positive half of check 1: it proves the
   command ran, rather than proving only that nothing broke.

5. **A missed variable fails loudly.** Remove one variable from the synthesized
   set and start the app. It must fail on boot. If it starts anyway, something
   is supplying a default from the host and the closed-environment guarantee
   does not hold for this repo.

Record each result in the runbook. When check 5 cannot be made to fail, say so
in the runbook and in what you tell the user: that repo's sandbox is weaker
than this phase claims, and the user should know which claim is reduced.

This matters beyond tidiness. The factory's safety rests on the worst case
being a draft PR nobody has to merge. A live credential in the sandbox changes
the ceiling on a prompt injection from "bad code in a reviewable diff" to
"dropped a table", and none of the gates sit where they would catch it.

## Sidecar services and the sandbox posture

An agent runs inside gh-aw's AWF sandbox. Reaching a published GitHub Actions
`services:` port from in there requires `sandbox.agent.runtime:
docker-sudo-iptables`, which runs AWF with host privileges — every other
profile refuses published service connectivity.

So:

- **Try the cheaper thing first.** Start the dependency inside the agent's own
  network from `pre-agent-steps`, with a `docker run`, rather than as an
  Actions service. If that works, the default profile is enough.
- **If it needs the weaker profile, say so.** Tell the user their repo gets a
  measurably weaker isolation level than one whose app needs no database, and
  why. Do not bury it.
- The posture is a **compile-time** literal: gh-aw takes no expression for it.
  Decide here; phase 6 writes it in before compiling. Changing it later needs a
  recompile.

## The devcontainer is the app's environment, not the agent's

The agent runs in AWF's own container. The devcontainer holds the app, and the
agent reaches it from the sandbox, with `sandbox.agent.mounts` exposing the
workspace. Do not try to make the devcontainer image the agent's image.
