# Version history

## What a snapshot holds

A `Snapshot` row stores the full encoded Yjs state, the file list from PostgreSQL, the authors and
who took it. It is a full state and not a `Y.snapshot` because a `Y.snapshot` needs a document with
garbage collection off, which keeps every deleted character forever. A full state costs more per
snapshot and costs nothing in the live document. Pruning keeps the total bounded.

The file list is stored separately because the tree inside the document exists only once a room
has opened. A snapshot taken by the API for a project nobody has opened would otherwise look empty,
and restoring it would delete every file.

## When one is taken

| Trigger | Kind | Taken by |
| --- | --- | --- |
| Every 5 minutes while people edit | `AUTO` | Collab room timer |
| Room closes after unsaved activity | `AUTO` | Collab room teardown |
| Successful run | `RUN` | API, when the worker reports `OK` |
| "Before restore" safety copy | `AUTO` with a label | API |
| Named checkpoint | `MANUAL` | API |

`captureSnapshot` in `packages/db` is the one implementation. An automatic snapshot that would
repeat the latest one returns its id and stores nothing.

With several collab instances, each tries to take a Redis lock named `snapshot:{projectId}` that
expires after 90% of the interval and is never released. Whoever wins takes the snapshot.

## Restore

A restore is applied on top of the live document, as an edit:

1. Take the tree lock, so collab cannot reconcile the tree halfway through.
2. Save the current state as a "Before restore" snapshot, and return its id as `undoSnapshotId`.
3. Put the file rows back. A whole-project restore also removes files added since the snapshot.
4. Replace only the changed span of each file (`lib0/diff`), so comment anchors and cursors outside
   that span survive, then publish the update.
5. Tell collab to reconcile the tree, and tell the room.

Undo is a restore of `undoSnapshotId`. A restore does not enter anyone's Ctrl+Z stack, because
`Y.UndoManager` tracks a user's own local edits, and a restore is applied by the server. A shared
snapshot lets anyone in the room undo it, including people who did not start it.

## Blame

Every Yjs item keeps the id of the client that created it, and `YjsClient` maps client ids to users
as updates arrive. A line goes to the user who wrote most of its characters.

Limits to state in the viva:

- Deletions are not attributed, because a deletion advances no clock. The same applies to the
  author list of a snapshot.
- Client ids are not signed. A hostile editor could craft an item under another user's client id,
  so blame shows who probably wrote a line. It is not evidence.
- Imported or template text has no user, because the API wrote it without a person behind it.

## Retention

`pruneSnapshots` keeps the newest automatic snapshot per UTC day once a snapshot is 30 days old. The
API runs it every 6 hours. It is one idempotent statement, so running it on several instances at
once is safe. Named checkpoints are kept, capped at 200 per project.

## Not built

Pushing a snapshot to GitHub, the prompt's stretch goal. It needs a per-user GitHub token with
repository scope, and the sign-in flow only asks for identity scopes. Zip export is built.
