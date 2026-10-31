"""The worker process: python -m executor.worker"""

from __future__ import annotations

import asyncio
import signal
from typing import Any

import redis.asyncio as redis_async
import structlog
from bullmq import Queue, Worker
from prometheus_client import start_http_server

from .docker_engine import DockerEngine
from .events import RedisEvents
from .metrics import Metrics
from .pool import SandboxPool
from .runner import execute
from .service import ApiReporter, Heartbeat, JobService, http_poster
from .settings import Settings
from .slots import PrioritySlots, QueueName

log = structlog.get_logger()

QUEUE_SAMPLE_INTERVAL_S = 5.0
QUEUE_STATES = ("waiting", "active", "delayed", "failed")

# A worker that stops renewing its lock for 30 seconds counts as crashed. One stall is recovered
# and a second fails the job, which is the "retried once" rule. The API enforces it as well.
LOCK_DURATION_MS = 30_000
STALLED_INTERVAL_MS = 15_000
MAX_STALLED_COUNT = 1


def worker_options(redis_url: str, concurrency: int) -> dict[str, Any]:
    return {
        "connection": redis_url,
        "concurrency": concurrency,
        "lockDuration": LOCK_DURATION_MS,
        "stalledInterval": STALLED_INTERVAL_MS,
        "maxStalledCount": MAX_STALLED_COUNT,
    }


async def sample_queues(
    queues: dict[QueueName, Queue], metrics: Metrics, stop: asyncio.Event
) -> None:
    while not stop.is_set():
        for name, queue in queues.items():
            try:
                counts = await queue.getJobCounts(*QUEUE_STATES)
            except Exception as error:
                log.warning("queue_sample_failed", queue=name.value, error=str(error))
                continue
            for state in QUEUE_STATES:
                metrics.queue_jobs.labels(queue=name.value, state=state).set(counts.get(state, 0))
        try:
            await asyncio.wait_for(stop.wait(), QUEUE_SAMPLE_INTERVAL_S)
        except TimeoutError:
            continue


async def main() -> None:
    settings = Settings.from_env()
    if not settings.api_url or not settings.internal_service_token:
        raise SystemExit("API_URL and INTERNAL_SERVICE_TOKEN are required")

    engine = DockerEngine(settings)
    log.info("orphans_removed", count=engine.reap_orphans())
    pool = SandboxPool(engine, size=settings.pool_size, max_idle_s=settings.pool_max_idle_s)
    pool.warm()

    metrics = Metrics()
    start_http_server(settings.metrics_port, addr=settings.metrics_host, registry=metrics.registry)

    client: redis_async.Redis = redis_async.Redis.from_url(settings.redis_url)
    sync_events = RedisEvents(_sync_client(settings.redis_url))
    slots = PrioritySlots(settings.slots, settings.reserved_for_run)
    service = JobService(
        slots,
        lambda request: execute(request, pool, sync_events, settings.limits),
        ApiReporter(http_poster(settings.api_url, settings.internal_service_token)),
        metrics,
        settings.worker_id,
    )

    async def process_run(job: Any, _token: str) -> str:
        return await service.handle(QueueName.RUN, job.data, job.timestamp)

    # The judge queue gets its consumer with the judge in 3.7. Its slot rules already apply.
    run_worker = Worker(
        QueueName.RUN.value, process_run, worker_options(settings.redis_url, slots.total)
    )
    run_worker.on("error", lambda error, *_: log.error("worker_error", error=str(error)))

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, stop.set)

    queues = {
        QueueName.RUN: Queue(QueueName.RUN.value, {"connection": settings.redis_url}),
        QueueName.JUDGE: Queue(QueueName.JUDGE.value, {"connection": settings.redis_url}),
    }
    background = [
        asyncio.create_task(Heartbeat(client, settings.worker_id, slots, metrics).run(stop)),
        asyncio.create_task(sample_queues(queues, metrics, stop)),
    ]
    log.info("worker_started", worker=settings.worker_id, slots=slots.total)
    await stop.wait()

    # Finishes jobs already running. A stuck run is bounded by the sandbox time limits.
    await run_worker.close()
    await asyncio.gather(*background)
    for queue in queues.values():
        await queue.close()
    pool.shutdown()
    await client.aclose()


def _sync_client(url: str) -> Any:
    import redis

    return redis.Redis.from_url(url)


if __name__ == "__main__":
    asyncio.run(main())
