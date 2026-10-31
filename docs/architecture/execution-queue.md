# Execution queue and scaling

Code: `apps/api/src/queue`, `apps/api/src/modules/executions.ts`,
`services/executor/src/executor/{slots,service,worker,metrics}.py`.

## Flow

1. `POST /rooms/:id/executions` checks permission and rate limits, reads the code as it is now,
   creates an `Execution` row, and adds a job to the `run` queue.
2. A worker takes the job, waits for a slot, and asks the API for permission to start.
3. The worker runs the sandbox and streams output to the room through Redis.
4. The worker reports the result to the API, which stores it.

Workers have no database access. Everything they know comes from the job, and everything they
report goes through `/internal` routes protected by `INTERNAL_SERVICE_TOKEN`. Nginx must block those
routes from outside.

## Queues and priority

`run` is for a person waiting at a screen, and `judge` is for submissions. BullMQ priorities only
work inside one queue, so `PrioritySlots` applies the rule on each machine:

- A run always goes ahead of waiting judge jobs.
- Judge jobs leave `EXECUTOR_RESERVED_FOR_RUN` slots free for the next person.
- A judge job waiting over 30 seconds goes first once, so constant runs cannot starve submissions.

## Limits

| Limit | Value | Response |
| --- | --- | --- |
| Runs per user | 10 per minute | `429` with a message and `Retry-After` |
| Runs per room | 30 per minute | `429` with a message and `Retry-After` |
| Waiting runs | 500 | `503 queue_full` |
| Project size | 2 MB | `413 project_too_large` |

A growing queue only gives everyone a longer wait, so past 500 new runs are refused.

## Crashes

A worker renews its job lock every 15 seconds. If it stops for 30, BullMQ treats the job as stalled
and hands it to another worker.

The API enforces the same rule itself, in `/started`: a run is claimed at most twice. This also
stops a redelivered job repeating a run that finished just before its worker died. A job that
fails with no worker left to report is caught by a `QueueEvents` listener in the API, so a run never
stays `QUEUED` forever.

Sandbox calls run on a thread. Locks renew on the event loop, so blocking it would make a healthy
job look like a crash.

## Metrics

Each worker serves Prometheus metrics on `METRICS_PORT`, default 9100, bound to localhost unless
`METRICS_HOST` is set. There is no authentication, so keep it on the internal network.

| Metric | Meaning |
| --- | --- |
| `codesync_queue_jobs{queue,state}` | Queue length by state |
| `codesync_job_wait_seconds{queue}` | Time from enqueue to a free slot |
| `codesync_job_run_seconds{queue,language}` | Time running, including compilation |
| `codesync_executions_total{status}` | Finished runs by status |
| `codesync_job_failures_total{queue,reason}` | Worker failures, not program failures |
| `codesync_worker_slots_busy`, `codesync_worker_slots_total` | Capacity on this worker |
| `codesync_workers_active` | Workers with a live heartbeat |

## Adding machines

Workers pull jobs, so nothing routes work to them and nothing needs reconfiguring.

1. Provision a Linux host with Docker and gVisor. Never use the database host.
2. Run `sh build-images.sh`, or pull the images.
3. Start `python -m executor.worker` with `REDIS_URL`, `API_URL`, `INTERNAL_SERVICE_TOKEN`, a unique
   `WORKER_ID` and `SANDBOX_REQUIRE_GVISOR=true`.

The worker starts taking jobs as soon as it connects. Redis hands each job to one worker, whichever
is free first, so faster or emptier machines naturally take more.

**Sizing:** one slot needs 1 core and 256 MB, plus room for the pool. Set `EXECUTOR_SLOTS` to the
number of cores minus one.

**Autoscaling:** add a machine when `codesync_job_wait_seconds` p95 stays above 2 seconds for 5
minutes, or when `waiting` jobs exceed total slots. Remove one when busy slots stay under 30% of
total for 15 minutes. Queue length is the better signal, as CPU stays low while jobs are waiting
for a slot.

**Scaling down:** send `SIGTERM`. The worker stops taking jobs and finishes what it holds.

## What limits scale

Redis is a single point of failure for the queue, and each queued run keeps its project in Redis
memory. At 500 waiting runs of 2 MB, that is up to 1 GB. A larger deployment should move payloads
out of the job and let workers fetch them from the API.
