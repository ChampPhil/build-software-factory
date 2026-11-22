# The sign-in function

The server half of "Sign in with GitHub". It runs as a Cloudflare Pages Function
on the dashboard's own address: `functions/api/auth/[[route]].ts` hands every
request under `/api/auth` to `src/index.ts`, which holds the logic so the tests
can reach it (`runner/test/worker.test.ts`).

A static page cannot finish GitHub's login alone. The code-for-token exchange
needs the GitHub App's client secret, and GitHub does not answer cross-origin
requests to it. This does that one step and stores nothing: no tokens, no user
ids, no database, no request bodies in logs.

| Endpoint | Does |
| --- | --- |
| `GET /api/auth/config` | `{enabled, install_url}`, so the page knows whether to show the button |
| `GET /api/auth/start?state=&code_challenge=` | Returns GitHub's authorize address, with the site's own callback and PKCE |
| `POST /api/auth/exchange` | `{code, code_verifier}` for `{access_token, expires_in, refresh_token, ...}` |
| `POST /api/auth/refresh` | `{refresh_token}` for a new pair (GitHub rotates the refresh token) |
| `GET /api/auth/health` | `{ok: true}`, and nothing about the configuration |

## Setting it up

Three values in the Pages project (Settings, Variables and secrets), then
redeploy. The registration link for the GitHub App is printed by
`cd dashboard && npx tsx scripts/app-link.ts https://your-address`; the full
steps are in `docs/08-dashboard.md`.

| Name | Kind |
| --- | --- |
| `GITHUB_APP_CLIENT_ID` | plain value |
| `GITHUB_APP_SLUG` | plain value |
| `GITHUB_APP_CLIENT_SECRET` | secret, never in code |

Until all three are set `/config` says `enabled: false`, the dashboard does not
show the button, and the other endpoints refuse. The dashboard keeps working
with a pasted token.

## Why it is this careful

An endpoint that mints GitHub tokens must not be usable from anywhere else:

- **Same origin.** The dashboard calls it from its own address, so there is no
  CORS to configure and no list of allowed origins to get wrong. No response
  carries a cross-origin permission.
- **The callback is the site's own.** It is computed from the request, never
  taken from the caller, so the function cannot send a person to GitHub with
  someone else's callback attached.
- **`/exchange` and `/refresh` only answer the site itself.** A request whose
  `Origin` is not the site's, or has none, is refused before GitHub is called.
- **`state` and PKCE.** The dashboard checks `state` on the way back, so a
  `?code=` planted in a link is ignored; the verifier is held in the browser,
  so a leaked code cannot be redeemed by anyone else.
- **No scopes.** A GitHub App token is limited to what the app was given and
  what the person can do, on the repositories the app is installed on.
- **GitHub's error descriptions are not relayed,** because they can echo the
  code; its error *names* are. A failing GitHub becomes a plain 502.
- **`Cache-Control: no-store`** on every response, because one of them carries
  a token.

The tests assert each of these, including that no response can contain the
client secret.
