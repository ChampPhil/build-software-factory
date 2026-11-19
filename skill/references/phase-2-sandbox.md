# Phase 2 — Make it runnable

Produce a sandbox where an agent can build the app, run its tests, and verify
it at runtime with real tools. This phase is the one most likely to fail, and
the one it is most important not to fake.

**Done when the app starts in the sandbox and a screenshot shows it working.**
If you cannot get there, stop and show the user the failing step. Do not
continue. A factory that cannot verify anything still produces confident PRs,
which is worse than no factory.

## Steps

1. **Reuse first.** An existing devcontainer, Dockerfile or setup script
   becomes the base. Describe the result as a standard `devcontainer.json` so
   any devcontainer tool can open it.
2. **Otherwise generate one** from the assessment: language runtimes, package
   install, the services the app needs as sidecars, and a headless browser for
   runtime verification.
3. **Write the runbook** (`context/runbook.md`): build, run, test, verify and
   seed-data commands. Test every one of them.
4. **Prove it works.** Build the sandbox with Docker, run the tests, start the
   app, and have a verifier agent open it in a browser through Playwright, with
   Playwright taking the screenshot.
5. **List the secrets the app needs to run**, store them as repo secrets, and
   have the sandbox read them from the environment.

## The thing that will bite you

**Never let the sandbox inherit real credentials.**

A repo's documented build command is not safe to run just because it is
documented. `npm run build` that chains a database migration will migrate
whatever `DATABASE_URL` points at, and on a developer's machine that is their
real database. Config files load `.env` files without being asked:
`drizzle.config.ts` calling `config({ path: ".env.local" })` is normal, and it
means a build inherits whatever that file holds.

So:

- Build the sandbox's environment from **an explicit list of throwaway
  values**. A positive list, not a denylist — `.env.local` is only today's
  example.
- **Classify the repo's commands rather than copying them.** Record which
  touch persistent state, and keep those out of the build path. The runbook
  records `build` and `migrate` as separate commands, with `migrate` marked.
- **Test for it.** Run the build and test commands with no credentials present
  and watch for one that wanted something real. The user will not know this
  about their own repo; most people do not.

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
