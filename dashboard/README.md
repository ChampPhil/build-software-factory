# Dashboard

The one place to see what the factory is doing. A static site: the browser
talks to GitHub directly with the user's own token, so no data passes through
any server the maintainer runs.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export into out/
npm test
```

## Hosting it

`out/` is plain static files, published once from this repository to Cloudflare
Pages on one shared domain. Build command `npm ci && npm -w @bsf/dashboard run
build` from the repository root, output directory `dashboard/out`; the full
settings are in `docs/08-dashboard.md`. `public/_headers` carries the security
headers, including the policy that lets the page talk only to itself and
`api.github.com`.

```bash
npm run e2e      # needs Playwright and Chromium; builds first with `npm run build`
```

## Signing in

The main way in is one button, "Sign in with GitHub": the person approves the
Software Factory app at GitHub and lands back signed in. It needs the
sign-in function (`../worker`, a Pages Function) and a GitHub App, set up once
by whoever runs the site (`docs/08-dashboard.md`); where that is not set up the
button does not appear. "Use a token instead" opens GitHub's token form with
the name, lifetime and every permission already chosen. Either way the session
is checked against the repository before it is stored, and a missing read
permission is named at sign-in. It is kept for the tab only unless "Remember on
this device" is ticked. A GitHub sign-in lasts 8 hours and is renewed in the
background. `?repo=owner/name` pre-fills the repository, and `?demo` (or the
demo button) opens a made-up factory that touches nothing.

`npx tsx scripts/app-link.ts https://your-address` prints the link that
registers the GitHub App with everything filled in.

## What it reads

| Data | Where | How often |
| --- | --- | --- |
| Metrics, guardrail summary, recent runs | `index.json` on `refs/factory/data` | 60s |
| Open work and the merge queue | `ledger.json` | 15s on Live and Waiting on you |
| Runs in flight | the `refs/factory/live/*` refs | 5s on Live |
| One run's full record | `runs/<id>.json` | on open |
| Pull requests, issues, reviews | the pulls and issues APIs | 30s on Waiting on you |

Polling stops while the tab is in the background, so a dashboard left open on
a second monitor does not spend the day's rate limit.

## Design

The subject is a control room for a mechanism, so the surface reads as painted
steel rather than as near-black, and status comes from a set of signal colours
the way it does on a real status board rather than from one accent hue.

Two devices carry the point of view:

- **The gauge.** Every limit in this product moves one way only — a coverage
  floor rises, a violation count falls — and a bare percentage hides that. The
  gauge shows the line as well as the value.
- **Attempt pips.** "Gate 1, attempt 2 of 3" appears throughout the factory.
  Three slots read faster than the sentence and carry the sense of a counter
  running out.

Every figure distinguishes zero from nothing-to-measure. A new factory has
merged nothing, and an autonomy tile reading 0% would be a claim about the
agents rather than about the data, so it says why instead.
