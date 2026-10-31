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
|---|---|---|---|
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

## Presence note for 3.2

y-protocols ignores a client's untouched initial awareness state because its clock is 0. A client
is invisible to others until it first sets a field, so the client must set its presence state
immediately after connecting.
