# Security report

Status as of 2026-11-01. "Tested" means an automated test in this repository covers it and passed
on that date. "Configured" means the setting exists but nothing has exercised it.

## Open before real use

1. **The sandbox attack suite has never run.** It needs Docker, which was not available on the
   development machine. Do not accept untrusted code until it has passed under gVisor.
2. **Redis has not been used for real.** Locks, pub/sub and BullMQ passed against stand-ins only.
   `.github/workflows/integration.yml` covers this, and it has not run because the repository has
   no remote yet.
3. **Nginx, Dockerfiles and the production compose files have not been executed.** The
   Content-Security-Policy itself has been tested: browser tests run the production bundle under
   the exact policy from the Nginx template.

## OWASP Top 10 (2021) applied to the API

| Category | Controls | Evidence | Status |
| --- | --- | --- | --- |
| A01 Broken access control | Routes are private unless marked public. Every room, project, file and snapshot route checks membership and role. Outsiders get 404. Locked rooms block writes. | `permissions`, `rooms`, `files`, `history`, `chat` tests | Tested |
| A02 Cryptographic failures | Argon2id passwords. Refresh and link tokens stored as hashes. Secrets of at least 32 characters. HTTPS and HSTS in Nginx. | `auth`, `sessions` tests. Nginx is configured only | Tested, TLS configured |
| A03 Injection | Prisma parameterises queries, and the one raw statement uses bound values. Paths are validated. Chat and statements render through react-markdown with no raw HTML. Terminal output goes only to xterm. | `files` tests, browser test "chat shows hostile Markdown as text" | Tested |
| A04 Insecure design | Rate limits on login, runs, submissions, reviews, chat and comments. Post-apply guard for CRDT updates. Sandboxes on a separate host. | `security`, `executions`, `chat` tests | Tested, host split configured |
| A05 Security misconfiguration | Errors return generic messages. `/api/v1/internal` is blocked at Nginx. Secure cookies and proxy hops are explicit settings. | `app` error tests. Nginx rules are configured only | Partly tested |
| A06 Vulnerable components | Exact dependency versions, frozen lockfile, `pnpm audit --prod` in CI. | Audit reports no known vulnerabilities after finding F1 | Tested |
| A07 Authentication failures | 15-minute JWT, rotating refresh tokens with reuse detection, PKCE, identical signup replies for taken addresses, a decoy hash on unknown accounts. | `auth`, `oauth`, `sessions` tests | Tested |
| A08 Integrity failures | Sandbox images pinned by digest. Refresh is single-flight across tabs. Hostile Yjs updates are repaired after applying. | `security` tests, `api.test.ts` | Tested |
| A09 Logging failures | Structured logs with pino and structlog. Automatic request logging is off in the API, and Nginx does not log `/collab/`, where the token is in the URL. Link tokens sit in URL fragments. | Reviewed by reading the code | Reviewed |
| A10 SSRF | The API fetches no user-supplied URL. OAuth endpoints are fixed. `avatarUrl` must be https and only the browser loads it. | Reviewed by reading the code | Reviewed |

### Findings and fixes

| ID | Finding | Severity | Fix |
| --- | --- | --- | --- |
| F1 | `pnpm audit` found five advisories in DOMPurify 3.4.15, pulled in by Monaco: one critical, one high, three low | Critical as reported. Monaco's actual use of the affected options was not assessed | Forced 3.4.17 with a pnpm override. Audit is now clean |
| F2 | Comments had no rate limit, though viewers can post them and each one fans out to the room | Medium | 30 a minute per user, with a test |
| F3 | Review findings reached Monaco hover text, which it treats as Markdown | Low | Markdown characters are escaped before display |
| F4 | Found by the first Linux CI run. The presence-entry limit treated a client relaying others' states as malformed, so joining a room of about five or more could permanently disconnect a legitimate user. Every client also re-sent each state it received, so a busy room could trip the rate limit on innocent users | High, availability | Frames may now carry a full room's entries, entries a client does not own are ignored, and clients send only their own presence. `crowdedRoom.test.ts` covers it with 12 users |

## Accessibility

An axe scan (WCAG 2 A and AA) passes on sign-in, rooms, practice, settings and the workspace, with
the workspace and settings scanned in both themes. It found and we fixed invalid ARIA on the open
files strip and low contrast on file badges. Monaco and xterm are excluded from the scan. Keyboard
tests cover the file menu, moving a file and the side panel tabs. No one has tested this with a
screen reader, and an automated scan catches only part of what a real audit would.

### Accepted risks

- **Collab token in the query string.** Browsers cannot set headers on a WebSocket. The token lasts
  5 minutes and is kept out of access logs.
- **`style-src 'unsafe-inline'`.** Monaco needs it.
- **Blame is not evidence.** Yjs client ids are unsigned, so an editor can forge authorship.
- **`/metrics` has no authentication.** Only the private network can reach it.

## Sandbox escape suite

Not run. `services/executor/tests/security/test_attacks.py` holds 17 attacks and writes
`sandbox-report.md` when run under Docker. There are no results to report, and the sandbox must be
treated as unproven until there are.

```sh
cd services/executor
.venv/bin/pytest -m docker -s
```

## WebSocket abuse tests

`apps/collab/test/security.test.ts`: 36 tests passed on 2026-11-01, against the real server over
real sockets.

| Abuse | Expected result | Test |
| --- | --- | --- |
| Oversized message | Closed with permanent code 4413 | `rejects an oversized frame with a permanent code` |
| Flood | Closed with code 4429 | `disconnects a client that floods messages` |
| Malformed frames | Sender closed, server stays up | `stays available after malformed frames` |
| Unauthorized join, no or forged token | Closed with code 4401 | `rejects a missing token`, `rejects a token signed with another key`, `rejects an unsigned token` |
| Token for another project | Closed with code 4401 | `rejects a token issued for another project` |
| Access removed after the token was issued | Closed with code 4403 | `rejects a user who has lost room access despite a valid token` |
| Cross-site socket | Refused before the upgrade | `rejects a cross-site origin before upgrading` |
| Viewer write | Update ignored, permission denied | `viewer enforcement` tests |
| Token claims a higher role | Database role wins | `treats a token claiming editor as a viewer when the database says viewer` |
| Editing the file tree through the CRDT | Reverted, writer disconnected | `reverts a client write to the file tree and disconnects the writer` |
| Spoofed presence identity | Overwritten from the token | `overwrites a spoofed identity with the token identity` |
