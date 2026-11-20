# Phase 2 — Make it runnable

Produce a sandbox where agents can build the app, run its tests, and see it
running — for this repo, whatever its language, framework or services — and
prove it. Nothing here runs on the user's machine.

**Done when the setup PR is open with a frozen sandbox manifest.** Its `tier`
says how far verification can go, measured rather than claimed.

## How it works

1. **Bootstrap.** `node scripts/install-factory.mjs --into <checkout>` on a
   branch: the packed runner (`.factory/bin`), the definition templates, the
   guardrail files, and every workflow, precompiled. Write the user's product
   answers into `practices.md` and `fundamentals.md`'s product intent. Open
   the bootstrap PR. It changes protected paths, so the user's merge is the
   approval.
2. **Dispatch `factory-setup`.** It runs unattended:
   - **Design.** The setup agent reads the repo and writes a complete
     candidate: the four context files, `manifest.json`, any stub servers, and
     the documentation hosts of the repo's stack.
   - **Trial.** `bsf sandbox trial`, on the runner where Docker is, brings up
     exactly what the candidate declares, runs install, build and test,
     starts the app, waits for `app_url`, and screenshots it. It records the
     tier actually reached and the last lines of every step's output.
   - **Again, if it fell short.** The next design round reads the failing
     step's output and changes the smallest thing that explains it. Three
     rounds at most.
   - **Freeze.** `bsf sandbox freeze` takes the best measured round and
     writes its manifest at the tier the trial reached, with every round on
     the record. The job opens the setup PR.
3. **The user merges it.** The factory exists from that commit.

## Why it is built this way

The first version reused the repo's deployment logic — its Dockerfile, its
commands, the secrets the app needs — and then warned against inheriting real
credentials. Deployment logic exists to reach production; reusing it and
spotting the dangerous parts is a denylist, and it holds only until the
hazard takes a shape nobody listed: an `ENTRYPOINT` that runs a release
script, a config file that loads `.env.local` on import, a build that chains
a migration.

A rule-based generator was tried next and failed on the first real repo: it
pointed `SITE_URL` — the app's own origin — at a host that cannot resolve,
which broke sign-in and with it every page. No rule can tell the app's own
origin from a third party's URL by its name. Reading the code can.

So the agent chooses every value, by reading, and three properties make that
safe whatever it chooses:

- **The environment is closed.** The sandbox gives the app exactly the
  manifest's variables and nothing from the runner. A variable the agent
  missed is absent, so the app fails loudly instead of quietly reaching
  something real. A test sets a variable on the runner and asserts it never
  arrives.
- **No credential of the user's is in it.** A value is the app's own correct
  configuration, a throwaway service, a local stub, or a named test-mode
  secret from `FACTORY_SANDBOX_ENV`. Never a production key.
- **The claim is measured.** The trial, not the agent, decides the tier.

## Variable kinds

| Kind | For | Value |
| --- | --- | --- |
| `self` | The app's own configuration | Its correct value: `http://localhost:3000`, the real domain allowlist |
| `service` | Something the sandbox can run | Points at a throwaway service on `127.0.0.1` |
| `stub` | A third party it cannot run | A local server answering in the real API's shapes, with provenance |
| `test_mode` | A provider's real test mode | The name of a secret in `FACTORY_SANDBOX_ENV`, never a value |
| `inert` | Last resort, so the app starts | Listed under `capabilities.not_exercised` |

## What the roles get

The roles bring the frozen sandbox up with `bsf sandbox start`, which reads
the manifest from the default branch — never from the change being judged —
starts its services, writes the closed environment to
`.factory/sandbox/.runtime.env` (excluded from every commit), and runs its
install. The builder and verifier source that file, start the app with the
manifest's `run` command, and use the browser at `app_url`.

## When the sandbox is not enough

A builder or verifier that cannot exercise what a change needs writes a
structured report: what it needed, which paths, why. That report dispatches
`factory-setup` with `amend` set; the next episode starts from the current
manifest, extends it, and opens an amendment PR. That is the only way the
sandbox changes after setup.

## Commands with side effects

`bsf consistency` reports, as `runbook_command_touches_state`, a command the
runbook runs whose chain applies migrations, deploys or publishes. Under the
sandbox it acts on a throwaway target; the finding exists so the runbook says
so.

## Sidecars and the agent's network

Services run on the runner, published on `127.0.0.1`. An agent inside AWF
reaching a published port needs `sandbox.agent.runtime:
docker-sudo-iptables`, a weaker isolation profile, so the default compiled
roles do not assume it. A repo whose sandbox has services is recompiled at
setup with that posture; tell the user it gets a measurably weaker isolation
level than a repo with none, and why.
