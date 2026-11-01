# Viva guide

For each prompt: how to run it, how to test it, and three design trade-offs to defend. Commands run
from the repository root after the setup in the [README](../README.md).

Each trade-off states the choice, what it costs, and why the cost was accepted. If an examiner
pushes on one, name the cost first. It shows you weighed the decision.

## 3.1 Real-time collaboration

- **Run:** `pnpm --filter @codesync/collab dev`
- **Test:** `pnpm --filter @codesync/collab test`

1. **CRDT (Yjs) over operational transformation.** Costs metadata in the document and memory on the
   server. In return, edits merge with no central ordering, so offline editing and several server
   instances work without a transform server.
2. **Check updates after applying them, then repair.** A hostile write exists briefly on the server.
   Accepted because most Yjs items name a neighbour, not a parent, so an update cannot be judged
   reliably before it is applied. Repairs are ordinary edits that every replica converges on.
3. **Redis log plus PostgreSQL compaction.** Two stores to keep consistent, so load order matters:
   the log is read before the document. A write to PostgreSQL on every keystroke would be far too
   slow, and Redis alone could lose data on a crash.

## 3.2 Presence and live cursors

- **Run:** start collab and web, then open a room in two browsers.
- **Test:** `pnpm --filter @codesync/web test:e2e -- e2e/presence.spec.ts`

1. **Relative positions for cursors.** Each one must be resolved on every render. Absolute offsets
   are cheaper but point at the wrong character as soon as someone types above them.
2. **Awareness instead of the document.** Presence is lost on disconnect, and that is the goal: it
   never enters history, and stale users vanish on their own.
3. **Own cursor rendering instead of y-monaco's.** More code to maintain. y-monaco cannot tell which
   file a peer is in, and cannot show labels or fade them.

## 3.3 Rooms, projects and files API

- **Run:** `pnpm --filter @codesync/api dev`
- **Test:** `pnpm --filter @codesync/api exec vitest run test/rooms.test.ts test/files.test.ts`

1. **File content lives only in the Yjs document.** Reads go through the bridge, and SQL cannot
   search code. In return there is one source of truth and no sync bug between two copies.
2. **Tree lock shared by API and collab.** Creating a file briefly serialises tree changes. Without
   it, two instances could create competing Y.Text objects and silently lose edits to one.
3. **404 for outsiders, 403 for members.** Harder to debug. It stops anyone probing which rooms exist.

## 3.4 Authentication

- **Run:** start the API, then sign up. The mail appears in Mailpit.
- **Test:** `pnpm --filter @codesync/api exec vitest run test/auth.test.ts test/sessions.test.ts test/oauth.test.ts`

1. **Short JWT plus rotating refresh token.** More moving parts than a session cookie, and revocation
   waits up to 15 minutes for access tokens. Most requests need no database lookup.
2. **Refresh reuse detection with no grace window.** Two tabs refreshing at once look like theft. The
   client uses a Web Lock so that tabs take turns, which keeps detection strict.
3. **Password required on the verification page.** One extra step for users. A mail scanner opening
   the link cannot verify an account, and neither can someone who registered another person's address.

## 3.5 Sandboxed execution

- **Run:** see the [executor README](../services/executor/README.md). Needs Docker.
- **Test:** `cd services/executor && .venv/bin/pytest -m "not docker and not redis"`. The attack suite
  is `pytest -m docker -s`, and **it has not been run yet**. Say so if asked.

1. **gVisor over plain Docker.** Slower system calls and some compatibility gaps. A kernel bug in the
   host is far harder to reach through a user-space kernel.
2. **One-use containers with a warm pool.** Idle containers cost memory. Reuse would risk one
   student's run reading another's leftovers, and a cold start on every run would feel slow.
3. **Python, where the prompt preferred Go.** Slower under load, but the Docker SDK and BullMQ client
   are mature, the work is mostly waiting on containers, and the static analyzers are Python too.

## 3.6 Queue and workers

- **Run:** API, Redis and a worker. Needs Redis.
- **Test:** `pnpm --filter @codesync/api exec vitest run test/executions.test.ts`

1. **Reserved slots for interactive runs.** Judging can never use the whole machine, so batch
   throughput drops. A student waiting on Run should not sit behind a contest's submissions.
2. **Retry a crashed job at most twice.** A failed run may need the user to press Run again. Unlimited
   retries would let one poison job crash workers forever.
3. **Worker reports through the API.** One extra hop. The database credentials stay off the executor
   host, which is the machine most likely to be compromised.

## 3.7 Online judge

- **Run:** the Practice pages, with a worker running.
- **Test:** `pnpm --filter @codesync/api exec vitest run test/problems.test.ts`

1. **Expected outputs never enter the sandbox.** Comparison needs a separate step. Otherwise a program
   could simply read the answer.
2. **Custom checkers run in their own sandbox.** Extra cost per test. A checker is code too, and exit
   code 42 for "reject" keeps a crash from being read as a wrong answer.
3. **ICPC scoring with a contest freeze.** Fewer live updates near the end. It is a known format, and
   the owner still sees everything.

## 3.8 AI code review

- **Run:** the AI Review tab. Without `ANTHROPIC_API_KEY`, only static analyzers run.
- **Test:** `cd services/executor && .venv/bin/pytest tests/test_review.py`

1. **Static analyzers before the model.** More tools to maintain. Their findings are reliable, they
   work with no key, and they give the model grounded facts.
2. **Abstract `LLMClient`.** A layer of indirection. Tests run with no network or cost, and the
   provider can change.
3. **Enforcing the practice rule after the reply.** A reply can be thrown away. A prompt alone cannot
   guarantee the model will not give the full solution.

## 3.9 Chat and inline comments

- **Run:** the Chat and Comments tabs in a room.
- **Test:** `pnpm --filter @codesync/collab exec vitest run test/chat.test.ts` and
  `pnpm --filter @codesync/api exec vitest run test/chat.test.ts`

1. **Chat over the document's WebSocket.** Chat load shares a socket with editing. There is one
   connection to authenticate and no second reconnect path. Rate-limited messages are refused, and
   the socket stays open because it also carries the user's document.
2. **Comment anchors as Yjs relative positions.** Stored as opaque bytes, so SQL cannot query by line.
   Line numbers would be wrong after the first edit above them.
3. **A deliberately short profanity list with whole-word matching.** Determined users get through. A
   complete filter mostly catches innocent words, such as Scunthorpe.

## 3.10 Version history

- **Run:** the History tab.
- **Test:** `pnpm --filter @codesync/api exec vitest run test/history.test.ts`

1. **Full state instead of `Y.snapshot`.** Each snapshot costs more storage, which pruning bounds.
   `Y.snapshot` needs garbage collection off, which keeps every deleted character forever.
2. **Restore as a new edit with a saved copy.** Restore does not enter Ctrl+Z, because `Y.UndoManager`
   only tracks a user's own edits. In exchange, anyone in the room can undo it, not only the person
   who started it, and concurrent typing merges instead of being overwritten.
3. **Blame from Yjs client ids.** Deletions are not credited, and client ids are unsigned, so blame
   can be forged. It is free to compute from data the CRDT already keeps.

More detail is in [version-history.md](architecture/version-history.md).

## 3.11 Frontend

- **Run:** `pnpm --filter @codesync/web dev`
- **Test:** `pnpm --filter @codesync/web test`, `pnpm --filter @codesync/web test:e2e`, and
  `E2E_PRODUCTION=1 pnpm --filter @codesync/web test:e2e -- e2e/workspace.spec.ts` for the real bundle

1. **Access token in memory only.** Every reload needs a refresh call. A script injected into the
   page has no stored token to steal.
2. **Lazy-loading Monaco and xterm.** The editor appears a moment after the page. The first load stays
   about 200 KB, not several megabytes, and sign-in and dashboards stay fast.
3. **Phones get read-only code and chat.** Phone users cannot edit. Monaco on a phone keyboard is a
   poor editor, and a good read-only view beats a bad editor.

Debugging story worth telling: the Vim and Emacs libraries passed the type checker and the build but
failed at run time, one only in the production bundle. Testing that bundle in a browser caught it.

## 3.12 Testing and deployment

- **Run:** see Deployment in the [README](../README.md). Needs Docker.
- **Test:** `cd loadtest && pnpm local`, then `pnpm report`. Results are in
  [REPORT.md](../loadtest/results/REPORT.md).

1. **Executor on a separate host.** Costs a second machine and some network latency. A sandbox escape
   then reaches a disposable worker, not the database.
2. **Stamps read from raw frames, without decoding the CRDT.** The test does not check that clients
   converge, which other tests cover. The load generator stays cheap enough not to measure itself.
3. **Nginx in front of everything.** One more component. TLS, the block on internal routes and security
   headers sit in one place, and application ports stay private.

Be ready to say which results are real. The local load figures come from one laptop with simulated
Redis and PostgreSQL. k6, the sandbox suite, Docker and CI have not been run. See the
[security report](security/report.md).

## Assumptions made

| Assumption | Why |
| --- | --- |
| Node 22.12 or later, where the stack says Node 20 | The test runner needs it, and Node 20 is past end of life |
| Python executor | The prompt allows Go or Python |
| Self-hosted single region | Classroom scale |
| One-server deployments keep code execution off | Sandboxes must not share a machine with the database |
| One project is opened per room in the workspace | The API allows several, and the first is what the UI opens |
| GitHub push left out | Stretch goal, and it needs a repository-scoped token per user |
| Grafana latency is server handling time | True end-to-end latency needs client reporting, so the load test measures it |
| OWASP Top 10 2021 edition | The categories used in the checklist |
