# Authentication

Code: `apps/api/src/modules/auth`, `apps/api/src/modules/profile.ts`.

## Sessions

| Token | Lifetime | Stored by the client in | Stored by the server as |
| --- | --- | --- | --- |
| Access (JWT) | 15 minutes | Memory only | Nothing, it is verified by signature |
| Refresh (random) | 30 days | `httpOnly`, `Secure`, `SameSite=Lax` cookie | SHA-256 hash |

Each login starts a **family**. Every refresh issues a new token in that family and marks the old
one as replaced. Presenting a replaced token means two parties hold it, and the server cannot tell
which is the thief, so the whole family is revoked.

### Rule for the frontend (3.11)

Two tabs refreshing at once with the same cookie look exactly like theft, and both get logged out.
The client must allow one refresh at a time across tabs, using the Web Locks API, and re-read the
result after acquiring the lock. There is deliberately no grace window on the server, because one
would give a thief the same window.

### Access tokens after revocation

An access token cannot be revoked. After logout, a reset or a theft detection it keeps working
until it expires, up to 15 minutes. That is the cost of not touching the database on every
request, and it is why the lifetime is short.

## Passwords

Argon2id at OWASP's minimum: 19 MiB, 2 iterations, 1 thread. Passwords must be 10 to 128
characters. The upper limit stops a huge password being used to tie up Argon2.

Login takes about the same time for an unknown account, because it verifies against a decoy hash.
Signup, resend and forgot-password answer identically whether or not an address exists, and send
their email in the background so that timing does not reveal it either.

## Email links

Verification links last 24 hours and reset links last 1 hour. They work once, and only the hash is
stored. Tokens travel in the URL fragment (`#token=`), which browsers never send to a server, so
they stay out of access logs. The web page reads the fragment and posts the token.

## Account pre-hijacking

An attacker can sign up with someone else's address and choose the password, hoping the real owner
later verifies the account. Three rules close this:

- Verifying needs the emailed link **and** the account's password. The attacker lacks the inbox
  and the owner lacks the password, so neither can finish alone.
- A password reset proves control of the inbox, so it verifies the account and replaces the
  password.
- OAuth login on an unverified account with the same address clears the password and revokes its
  sessions.

## OAuth

GitHub and Google use the authorization code flow with PKCE (S256). A short-lived signed cookie
holds the state and verifier. The callback checks the state against that cookie, which ties it to
the browser that started the login and stops an attacker feeding a victim their own code.

An account is linked by email only when the provider says the address is verified. The access
token is never put in a redirect: the web app lands on `/auth/callback` and calls `/auth/refresh`.

A provider stays off until both of its environment variables are set. Register these callback URLs
with the provider:

- `{PUBLIC_API_URL}/api/v1/auth/oauth/github/callback`
- `{PUBLIC_API_URL}/api/v1/auth/oauth/google/callback`

## CSRF

Only `/auth/refresh` and `/auth/logout` rely on a cookie. Every other route needs a bearer token,
which a browser never attaches by itself.

Those two routes are protected three ways: `SameSite=Lax`, an exact `Origin` check, and a
double-submit token. The client copies the `codesync_csrf` cookie into the `x-csrf-token` header,
which another site can neither read nor set. Login and signup refuse a foreign `Origin` and accept
only JSON, which stops a cross-site form logging a victim into the attacker's account.

## Rate limits

Defined in `AUTH_LIMITS` in `rateLimit.ts`:

| Limit | Value |
| --- | --- |
| Login per account | 10 per 15 minutes, cleared by a success |
| Login per IP | 100 per 15 minutes |
| Signup per IP | 60 per hour |
| Emails per address (signup, resend, forgot) | 3 per hour |
| Emails per IP | 60 per hour |
| Link attempts per IP (verify, reset) | 60 per 15 minutes |

IP limits are generous because a whole college lab can share one public address. Per-account limits
are what stop password guessing. An attacker can use up a victim's login attempts, locking them out
for up to 15 minutes, which is the accepted cost of a per-account limit.

If Redis is down these routes answer `503` rather than dropping the limit.

Client IPs come from `X-Forwarded-For` only as far as `TRUST_PROXY_HOPS` allows. Set it to the real
number of proxies, or clients can forge their address.

## Profile

`GET /me` and `PATCH /me` cover display name, avatar, theme and editor settings. Settings live on
the user row, so they follow the account across devices. A partial settings change is merged inside
a transaction. Avatars must be `https` URLs because the value becomes an image source for everyone
in a room.
