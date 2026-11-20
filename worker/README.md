# The sign-in Worker

Optional. It exchanges a GitHub OAuth `code` for an access token, which a
static site cannot do itself because the exchange needs the OAuth app's client
secret. Without it the dashboard asks for a fine-grained token instead, and
everything else works the same (doc 08).

It stores nothing: no tokens, no user ids, no database, no request bodies in
its logs. Three endpoints, and the token only ever travels in the response to
the browser that asked for it.

| Endpoint | Does |
| --- | --- |
| `GET /start?redirect_uri=&state=` | Returns the GitHub authorize URL, after checking the redirect is one of this deployment's own origins |
| `POST /exchange` | Exchanges `{code, redirect_uri}` for a token |
| `GET /health` | `{ok: true}`, and nothing about the configuration |

## Deploying

```sh
cd worker
npx wrangler secret put GITHUB_CLIENT_SECRET
# then set GITHUB_CLIENT_ID and ALLOWED_ORIGINS in wrangler.toml
npx wrangler deploy
```

Point the dashboard at it with `NEXT_PUBLIC_SIGNIN_WORKER`. Leave that unset
and the dashboard never calls it.

## Why it is this careful

A public endpoint that mints GitHub tokens is, by default, an open redirect
for credentials: anyone's page could call it, and anyone's URL could be the
callback. So:

- **`ALLOWED_ORIGINS` is an exact-match allowlist.** Not a wildcard, not a
  suffix test — `https://dash.example.com.evil.test` must not pass. An empty
  allowlist refuses everything rather than allowing everything, so a
  half-finished deployment mints no tokens.
- **`redirect_uri` is checked on both endpoints,** so the Worker will not send
  a user to GitHub with a third party's callback attached, nor exchange a code
  for one.
- **`state` must be at least 16 characters,** and the dashboard checks it
  matches on the way back, so a `?code=` someone plants in a link is ignored.
- **No credentials in CORS.** The Worker holds no session, so there is nothing
  for a cookie to carry.
- **GitHub's error descriptions are not relayed,** because they can echo the
  code; its error *names* are. Likewise a non-200 from GitHub becomes a plain
  502 rather than a pass-through of its body.
- **`Cache-Control: no-store`** on every response, because one of them carries
  a token.

The test suite (`runner/test/worker.test.ts`) asserts each of these, including
that no response can contain the client secret or the client id.
