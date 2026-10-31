# Collaboration engine

Code: `apps/collab`, `packages/collab-client`. Shared constants and message types:
`packages/shared/src/collab.ts`.

## Why a CRDT and not Operational Transformation

OT rewrites each operation against concurrent ones, which needs one server to define the order.
That server must process every keystroke in sequence, so scaling out means routing each document
to a single owner. Offline editing is awkward too, because a long offline session has to be
transformed against everything that happened meanwhile. Correct transform functions are also hard
to write: several published OT algorithms were later shown to be wrong.

A CRDT gives each character a unique identity and merges by rule, so replicas converge whatever
order updates arrive in. That gives CodeSync three things it needs:

- Several collab instances can accept writes for one document, with Redis only relaying updates.
- Offline edits merge on reconnect with no special handling.
- Comment anchors can use Yjs relative positions, which survive other users' edits.

The costs are metadata overhead, because deleted characters leave tombstones, and a server that
cannot reject an edit before applying it. The second cost shapes the security model below.

## Document layout

One `Y.Doc` per project:

| Root | Type | Written by | Content |
| --- | --- | --- | --- |
| `files` | `Y.Map<Y.Text>` | Server creates entries, editors edit text | File content keyed by `File.id` |
| `tree` | `Y.Map<{ path, kind }>` | Server only | Mirror of `File` rows |

## Update flow

1. The client's update reaches its collab instance.
2. The server checks the role, applies the update, and runs the transaction guard.
3. The update goes to local clients, then to the Redis log, then to other instances over pub/sub.

## Persistence rules

- **Load reads the log before the document.** A compaction between the two reads only duplicates
  updates, which Yjs ignores. The opposite order could lose trimmed updates.
- **Subscribe before loading**, so nothing published during load is missed.
- **Compaction merges the database, the shared log and local memory**, so it is correct even when
  this instance has not received another instance's updates.
- **Trim happens after the save.** A crash between them replays updates, which is harmless.
- **`ydocVersion` is an optimistic check**, so a slow compactor cannot overwrite a newer state.
- **Each tick replays the log into live rooms**, which heals a dropped pub/sub message.
- **A room stays in memory if its final compaction fails**, and the sweeper retries.

## Security model

- Viewers are blocked on `sync.step2` as well as `sync.update`, because both carry updates.
- Roles are re-read from the database on connect, and `room:{id}:control` updates live sockets.
- Writes are checked after applying and repaired with ordinary edits, which every replica
  converges on. A client that changes `tree`, the `files` map or any other root is disconnected.
- Awareness identity is overwritten from the verified token, and a connection can only update
  client ids it owns.

## Known limitations

- A client that sends more than 60 messages per second is disconnected permanently. Human typing,
  including key repeat, stays well below this, but scripted typing does not.
- A hostile tree write reaches other clients briefly before the repair. Clients must treat tree
  paths as display data and never as filesystem paths.
- Deleting a file through the `files` map recreates it empty. This gives an editor no more power
  than deleting the text normally, and version history (3.10) restores it.
- The 2 MB limit counts UTF-16 characters, not bytes.
- Yjs client ids are not authenticated, so an editor can write under an id another user owns.
  Blame keeps the first recorded owner, which makes it best-effort attribution.
- A Redis failure can lose up to about one second of updates on a crashed instance, matching
  `appendfsync everysec`.
- The `app` message channel answers every event with `unsupported_event` until chat (3.9) and
  execution streaming (3.5) are built.

## Presence

Code: `packages/shared/src/presence.ts`, `packages/collab-client/src/presence.ts`,
`apps/web/src/features/presence`.

Each user's awareness state holds `fileId`, `cursor`, and `status`, which the client sets, plus
`userId`, `name`, `initials`, and `color`, which the server stamps from the verified token. The
color is a hash of the user id into a fixed palette, so it is the same everywhere without being
stored. Two users can share a color, which is why cursors also carry a name.

Cursors are Yjs relative positions, so a cursor stays on the same character while others type
above it.

| Rule | Where | Why |
| --- | --- | --- |
| Set presence as soon as a session starts | Client | y-protocols ignores an untouched initial state, whose clock is 0 |
| Re-announce on every reconnect | Client | A resent clock would be ignored by a server that already saw it |
| A user can reclaim their own client id | Server | The old socket may not have been seen to die yet |
| At most 20 cursor updates per second, newest wins | Client | Each update fans out to the whole room |
| At most 25 presence updates per second, burst 40 | Server | Same fan-out, enforced against hostile clients; excess is dropped |

y-monaco's cursor rendering is turned off by passing `null` for awareness. It has no concept of a
peer's current file and cannot show name labels or fade them. `CollabEditor` draws selections as
decorations and cursors as content widgets. Display names reach the DOM only through
`textContent`, and colors reach CSS only through classes generated from the fixed palette.

Follow mode watches document transactions, not keystrokes. A local transaction is this user's own
edit and stops following, while the followed user's text arrives as a non-local one.

## How the API shares a project

File content has no copy in PostgreSQL, so zip import, zip export and templates all go through the
Y.Doc. `apps/api/src/collab/bridge.ts` follows the same rules as a collab instance.

Creating a file holds the `tree:{projectId}` Redis lock around these steps:

1. Write the content to the shared log as a Yjs update.
2. Commit the `File` row.

The lock prevents two ways of losing data. Two writers each creating a `Y.Text` for one file id
would compete, and edits to the loser would vanish. A reconcile reading the file list before the
commit would see text with no row and delete it, which is why `Room.reconcileTree` reads the list
inside the lock. `treeLock.test.ts` and the matching test in `persistence.test.ts` force both
orderings.

After the lock is released, the API publishes `tree.changed` on `room:{roomId}:control`. Database
changes are committed first, so a Redis failure does not fail the request. Collab re-reads roles
on connect and the file list on the next room load, but a live socket would miss the change until
it reconnects.

## Frontend tooling notes

- Monaco renders nothing until a model is set, so an empty editor host is normal.
- `monaco-editor` 0.57 removed `esm/vs/...` from its package exports. y-monaco still imports that
  path, so `apps/web/vite.config.ts` aliases it.
- Monaco is excluded from Vite's dependency pre-bundling, which ran out of memory on an 8 GB
  machine. Production bundling has not been tried and needs attention in 3.11.
