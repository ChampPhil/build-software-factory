# Dashboard redesign, Phase 1 sketch

Open `index.html` for the three directions, the recommendation and the argument for it. Each direction is a static page that runs from this folder with no build and no network:

```bash
npx serve design/sketch    # then open the address it prints
```

| Path | What it is |
| --- | --- |
| `a-briefing/` | Direction A, recommended, built out as the whole dashboard: every page, state and action, light and dark, phone. |
| `b-workbench/` | Direction B. Core screens: pull request, live conversation, run in flight. |
| `c-reel/` | Direction C. Core screens: up for review, conversation sheet. |
| `COVERAGE.md` | Every action and every piece of data the dashboard has, where it lives in the Briefing, and which client method it calls. |
| `shared/data.js` | One synthetic factory, shaped field for field on `schema/*.json`: a work item in each of the ten statuses, runs in all eight outcomes, guardrails, review, sandbox, settings, workflows. |
| `shared/proof.js` | The proof media: a playable recording of the user's app, the exported CSV, the API response, the diagram. |
| `shared/util.js` | Formatting helpers and the sketch's screen switcher, which is not part of any design. |
| `fonts/` | Schibsted Grotesk, Newsreader, Atkinson Hyperlegible Next, Archivo, JetBrains Mono, from `@fontsource-variable`, with their OFL licences. |
| `screens/` | Screenshots of every screen the sketch was judged from. |
| `bundle/` | The tools around the sketch, below. |

## Checking it

```bash
node design/sketch/bundle/check-actions.mjs
```

Drives the Briefing in a real browser: performs every action in `COVERAGE.md` from a fresh page and confirms the dashboard says what it did, then finds every kind of data on the screen that shows it. Uses the `playwright` package; set `PLAYWRIGHT_PATH` and `CHROME` if they aren't on the default paths.

## The viewable artifact

```bash
python design/sketch/bundle/build.py sketch-artifact.html
python design/sketch/bundle/verify.py sketch-artifact.html
```

`build.py` reads every file of the sketch from a commit (HEAD by default) and embeds it unchanged in one self-contained page, `bundle/shell.html`, which assembles each direction in the browser. `verify.py` pulls each embedded file back out and compares it byte for byte with the commit. The published claude.ai artifact is this page.

## Moving around

Every page accepts `?screen=<route>` and `?theme=light|dark`; add `&bare` to hide the switcher for screenshots. In the Briefing, routes are `home`, `quiet`, `empty`, `requests`, `r-<issue>` with an optional tab (`-talk`, `-pr`, `-runs`, `-activity`), the conversation states `r-214-first`, `-live`, `-cold` and `-understood`, `runs`, `run-<id>`, `guardrails`, `spend`, `factory` with an optional section, and `signin`. On the live conversation the switcher has a "Let it go cold" button that turns the conversation cold in place, to show the change doesn't move the layout.

Nothing here reads or depends on `dashboard/`. Phase 2 starts only after the direction is approved.
