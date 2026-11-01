# REST API

All routes use the `/api/v1` prefix. Errors have the shape
`{ "error": { "code", "message" } }`.

**Access levels:** `Public` needs no login. `User` needs a valid access token. `Viewer+`, `Editor+`
and `Owner` are effective room roles, and a locked room blocks content writes for everyone.
`Faculty` means a `FACULTY` or `ADMIN` global role. `Service` is an internal service token that
Nginx must block from outside.

A private room answers `404` to outsiders, so they cannot tell it exists.

The **Status** column shows what exists today. Planned routes follow the 3.0 baseline and may
change when they are built.

## Rooms, members and invites

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| GET, POST | `/rooms` | List my rooms, create from template | User | Built |
| GET | `/rooms/:id` | Room details | Viewer+, or User if public | Built |
| POST | `/rooms/:id/join` | Join a public room as viewer | User | Built |
| PATCH, DELETE | `/rooms/:id` | Update settings, delete room | Owner | Built |
| POST | `/rooms/:id/lock`, `/rooms/:id/unlock` | Lock or unlock | Owner | Built |
| POST | `/rooms/:id/transfer` | Transfer ownership to a member | Owner | Built |
| GET | `/rooms/:id/members` | List members | Viewer+ | Built |
| PATCH | `/rooms/:id/members/:userId` | Change role | Owner | Built |
| DELETE | `/rooms/:id/members/:userId` | Remove member, or leave | Owner, or self | Built |
| GET, POST | `/rooms/:id/invites` | List or create link and email invites | Owner | Built |
| DELETE | `/rooms/:id/invites/:inviteId` | Revoke invite | Owner | Built |
| POST | `/invites/accept` | Join with `{ token }` | User | Built |
| POST | `/rooms/:id/collab-token` | Issue a 5-minute token for `{ projectId }` | Viewer+ | Built |

Invite links carry the token in a URL fragment, and the web page posts it. The baseline had the token in the path. It moved to the body because a signed token exceeds
Fastify's parameter length limit, and because URLs end up in proxy logs.

## Projects and files

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| POST | `/rooms/:id/projects` | Create project | Editor+ | Built |
| GET | `/projects/:id` | Project metadata | Viewer+ | Built |
| DELETE | `/projects/:id` | Delete project | Owner | Built |
| GET | `/projects/:id/files` | File tree metadata | Viewer+ | Built |
| POST | `/projects/:id/files` | Create file or folder | Editor+ | Built |
| PATCH | `/projects/:id/files/:fileId` | Rename or move | Editor+ | Built |
| DELETE | `/projects/:id/files/:fileId` | Delete, with contents for a folder | Editor+ | Built |
| POST | `/projects/:id/import` | Upload zip as `application/zip` | Editor+ | Built |
| GET | `/projects/:id/export` | Download project zip | Viewer+ | Built |

## Auth and profile

Details are in [auth.md](auth.md).

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| POST | `/auth/signup` | Register with Argon2id password hashing | Public | Built |
| POST | `/auth/verify-email` | Verify with `{ token, password }` | Public | Built |
| POST | `/auth/verify-email/resend` | Send a new verification link | Public | Built |
| POST | `/auth/login` | Issue access token and refresh cookie | Public | Built |
| POST | `/auth/refresh` | Rotate refresh token, revoke family on reuse | Cookie + CSRF | Built |
| POST | `/auth/logout` | Revoke current session family | Cookie + CSRF | Built |
| POST | `/auth/password/forgot` | Send reset email | Public | Built |
| POST | `/auth/password/reset` | Set new password, revoke sessions | Public | Built |
| GET | `/auth/oauth/:provider` | Start GitHub or Google OAuth | Public | Built |
| GET | `/auth/oauth/:provider/callback` | Complete OAuth | Public | Built |
| GET, PATCH | `/me` | Read or update profile and editor settings | User | Built |
| GET | `/me/notifications` | Recent notifications | User | Built |
| POST | `/me/notifications/:id/read` | Mark as read | User | Built |
| GET | `/me/submissions` | Own submission history | User | Built |

## Execution

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| POST | `/rooms/:id/executions` | Queue a run, `429` at the limit, `503` when full | Editor+ | Built |
| GET | `/rooms/:id/executions` | Run history | Viewer+ | Built |
| GET | `/executions/:id` | Run result | Viewer+ | Built |

## History

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| GET | `/projects/:id/snapshots` | Snapshot timeline | Viewer+ | Built |
| POST | `/projects/:id/snapshots` | Named checkpoint | Editor+ | Built |
| GET | `/snapshots/:id` | Snapshot details and file list | Viewer+ | Built |
| GET | `/snapshots/:id/files/:fileId` | Read a file at a snapshot | Viewer+ | Built |
| GET | `/snapshots/:id/files/:fileId/blame` | Blame at a snapshot | Viewer+ | Built |
| GET | `/files/:id/blame` | Blame of the live file | Viewer+ | Built |
| POST | `/snapshots/:id/restore` | Restore project or `{ fileId }` as a new edit | Editor+ | Built |
| GET | `/snapshots/:id/export` | Download snapshot zip | Viewer+ | Built |
| POST | `/snapshots/:id/github` | Push to GitHub (stretch goal) | Editor+ | Not built |
| GET | `/projects/:id/files/:fileId/blame` | Line attribution | Viewer+ | Built |

## Chat and comments

Chat messages are sent over WebSocket. REST covers history and moderation.

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| GET | `/rooms/:id/messages?cursor=` | Paginated chat history | Viewer+ | Built |
| DELETE | `/rooms/:id/messages/:messageId` | Delete message | Owner | Built |
| POST | `/rooms/:id/read` | Update unread marker | Viewer+ | Built |
| GET | `/rooms/:id/unread` | Unread count | Viewer+ | Built |
| GET, POST | `/files/:id/comments` | List threads, create anchored thread | Viewer+ | Built |
| POST | `/comments/:id/replies` | Reply to thread | Viewer+ | Built |
| PATCH | `/comments/:id` | Edit, resolve or reopen | Author, Owner | Built |
| DELETE | `/comments/:id` | Delete comment | Author, Owner | Built |

## AI review

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| POST | `/reviews` | Review, explain or diagnose | Viewer+, or User in practice | Built |
| GET | `/reviews/:id` | Read result | Requesting user | Built |
| GET | `/reviews/quota` | Remaining daily quota | User | Built |

## Practice and contests

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| GET | `/problems` | List with filters | User | Built |
| GET | `/problems/:slug` | Problem with sample tests only | User | Built |
| POST | `/problems` | Create problem | Faculty | Built |
| PATCH | `/problems/:id` | Edit problem | Faculty | Built |
| POST | `/problems/:id/tests` | Upload `.in` and `.out` zip | Faculty | Built |
| POST | `/problems/:id/validate` | Validate with reference solution | Faculty | Built |
| POST | `/problems/:slug/submissions` | Submit to the judge | User | Built |
| GET | `/submissions/:id` | Verdict and per-test results | Submitter, Faculty | Built |
| POST | `/problem-sets` | Create problem set | Faculty | Built |
| GET | `/problem-sets/:id/leaderboard` | Problem set leaderboard | User | Built |
| POST | `/rooms/:id/contests` | Create contest | Owner | Built |
| GET | `/contests/:id` | Contest details and countdown | Viewer+ | Built |
| GET | `/contests/:id/leaderboard` | Frozen for the final 15 minutes | Viewer+ | Built |
| POST | `/problems/:id/plagiarism` | Start similarity analysis | Faculty | Built |
| GET | `/problems/:id/plagiarism` | Similarity report | Faculty | Built |

## Internal and operations

| Method | Path | Purpose | Access | Status |
| --- | --- | --- | --- | --- |
| GET | `/healthz` (no prefix) | Liveness | Public | Built |
| POST | `/internal/executions/:id/started` | Worker claims a run, answers whether to proceed | Service | Built |
| POST | `/internal/executions/:id/result` | Worker reports final result | Service | Built |
| POST | `/internal/submissions/:id/result` | Worker reports judge result | Service | Built |
| GET | `/internal/submissions/:id/package` | Worker claims a submission and fetches its tests | Service | Built |
| POST | `/internal/reviews/:id/result` | Worker reports a review | Service | Built |
| GET | `/metrics` on each executor worker | Prometheus metrics | Internal network | Built |
