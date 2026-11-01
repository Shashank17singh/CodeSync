# IEEE paper outline

Working title: *CodeSync: Design and Evaluation of a CRDT-Based Collaborative Code Editor with
Sandboxed Execution*

Numbers marked **[to measure]** do not exist yet. Do not fill them in until the run has happened.

## Abstract (150 to 200 words)

Problem, approach (Yjs CRDT, gVisor sandboxes, an online judge), and the main latency and security
results, written last.

## I. Introduction

- Remote pair programming and classroom coding need shared editing and safe execution together.
- Contributions: a server-validated CRDT design for untrusted clients, a layered sandbox for hostile
  code, and measurements of both.

## II. Related work

- Operational transformation and CRDTs: Google Docs-style OT, Yjs, Automerge.
- Collaborative IDEs: VS Code Live Share, Replit, CodeTogether.
- Judges and sandboxing: Judge0, DMOJ, gVisor, Firecracker.
- Gap: CRDT papers usually assume honest peers, while a classroom tool cannot.

## III. System design

- Architecture diagram: browser, collab server, API, Redis, PostgreSQL, executor host.
- Document model: one Y.Doc per project, with a file tree owned by the server.
- Persistence: Redis update log, PostgreSQL compaction, snapshots.
- Execution pipeline: BullMQ queues, warm pool, priority slots.
- Trade-offs: CRDT over OT, full-state snapshots over `Y.snapshot`, separate executor host.

## IV. Handling hostile clients

- A CRDT update cannot be inspected reliably before it is applied, so writes are checked after
  applying and repaired with ordinary edits that every replica converges on.
- Identity stamped from the token, per-connection rate limits, viewer enforcement.
- Comment anchors with relative positions.

## V. CRDT performance results

Method: typists insert stamped text, and receivers read the stamp from the raw frame.

Preliminary results from `loadtest/results/REPORT.md`, on one laptop with the load generator beside
the server and an in-memory stand-in for Redis and PostgreSQL. Each row is a single run.

| Users | Keys/s each | p50 ms | p95 ms | p99 ms | Delivered |
| --- | --- | --- | --- | --- | --- |
| 20 | 3 | 1 | 2 | 3 | 100% |
| 100 | 3 | 3 | 9 | 13 | 100% |
| 500 | 1 | 12 | 39 | 71 | 100% |
| 200 | 5 | 16 | 317 | 685 | 100% |

- These figures include generator overhead and exclude Redis and network time, so they are not
  publishable as system latency.
- Target: 10 rooms × 50 users at 5 keys/s with k6 from a separate machine, repeated at least three
  times with confidence intervals. **[to measure]**
- Baseline to compare: the same load on plain y-websocket. **[to measure]**
- Document growth and compaction cost over a long session. **[to measure]**

## VI. Sandbox security evaluation

- Threat model and layers: gVisor, seccomp, no network, cgroups, one-use containers.
- Attack suite: 12 attacks covering escape, resource exhaustion and data access, plus 5 checks that
  ordinary programs still work.
- Results: all 12 contained under runc and runsc, in `docs/security/sandbox-report-*.md`. Worth
  reporting: the first run found a kill deadlock (F5) and that gVisor ignores Docker's seccomp
  profile unless told otherwise (F6). These are one CI run each, so repeat them before publishing.
- Execution load: 200 concurrent runs, queue wait, run time, failure rate. **[to measure]**
- Overhead of gVisor compared with runc. **[to measure]**

## VII. AI review evaluation

- Static analyzers alone: recall 48%, precision 86% on the seeded set (12 true positives, 2 false
  positives, 13 false negatives).
- Analyzers with the LLM. **[to measure]**, which needs an API key and budget.

## VIII. Limitations

- Blame and snapshot authors do not credit deletions, and client ids are unsigned.
- The evaluation is a single-region deployment at classroom scale.
- Mention whether the attack suite covers kernel-level exploits, which it cannot prove absent.

## IX. Conclusion and future work

- Summary of results.
- Future work: per-file documents for large projects, signed updates, language servers.

## References

Shapiro et al. on CRDTs, Nicolaescu et al. on Yjs, Ellis and Gibbs on OT, the gVisor paper by Young
et al., and the OWASP Top 10. Check every citation against the source before submitting.
