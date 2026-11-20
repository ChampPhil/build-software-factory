# `cursor-cli.md` is gh-aw's own file

`adapters/cursor-cli.md` is `.github/workflows/shared/cursor.md` from
githubnext/gh-aw, copied verbatim. MIT; the commit is in
`VENDORED-FROM-GH-AW`, and gh-aw's licence is at `../runner/vendor/gh-aw/LICENSE`.

It is here instead of a definition of our own because it already is one, and a
better one than this project could write without the CLI in hand:

- It installs `cursor-agent` itself, from a **pinned** archive
  (`2026.10.14-941492e`, the build the official installer selects), verifies
  the binary, and removes the install directory afterwards. So there is no
  separate setup step and no floating "latest".
- Its `execution.args` are the real headless invocation:
  `-p --force --trust --approve-mcps --output-format stream-json`.
- It ships a **log parser** and a harness script, so per-step tokens and cost
  reach gh-aw's unified session artifact — which is where the factory's step
  report reads them from first.
- `auth` names `CURSOR_API_KEY`, which is the secret this factory already
  expects for this harness.
- gh-aw runs conformance and smoke workflows against it
  (`engine-conformance-cursor.md`, `smoke-cursor.md`), so it is maintained
  rather than a sample left to rot.

Do not edit it. To update: copy the file again from gh-aw and record the new
commit. If a local change ever becomes necessary, make it a separate overlay
file so the diff against gh-aw's version stays visible.

**One consequence worth knowing.** This definition selects the engine as
`engine: cursor`, not `cursor-cli`. The adapter registry records the id gh-aw
uses, because the id in the definition is what a role workflow must set.
