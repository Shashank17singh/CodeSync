from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

# Run time is bounded by the sandbox limits. Wait time is what users feel under load.
RUN_BUCKETS = (0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 20)
WAIT_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120)


class Metrics:
    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        self.registry = registry or CollectorRegistry()
        self.queue_jobs = Gauge(
            "codesync_queue_jobs",
            "Jobs in each queue by state",
            ["queue", "state"],
            registry=self.registry,
        )
        self.wait_seconds = Histogram(
            "codesync_job_wait_seconds",
            "Time from enqueue until a sandbox slot was free",
            ["queue"],
            buckets=WAIT_BUCKETS,
            registry=self.registry,
        )
        self.run_seconds = Histogram(
            "codesync_job_run_seconds",
            "Time spent running a job, including compilation",
            ["queue", "language"],
            buckets=RUN_BUCKETS,
            registry=self.registry,
        )
        self.executions = Counter(
            "codesync_executions_total",
            "Finished runs by status",
            ["status"],
            registry=self.registry,
        )
        self.failures = Counter(
            "codesync_job_failures_total",
            "Jobs that failed in the worker, as opposed to a program failing",
            ["queue", "reason"],
            registry=self.registry,
        )
        self.slots_busy = Gauge(
            "codesync_worker_slots_busy",
            "Sandbox slots in use on this worker",
            registry=self.registry,
        )
        self.slots_total = Gauge(
            "codesync_worker_slots_total",
            "Sandbox slots on this worker",
            registry=self.registry,
        )
        self.workers_active = Gauge(
            "codesync_workers_active",
            "Workers with a live heartbeat",
            registry=self.registry,
        )
