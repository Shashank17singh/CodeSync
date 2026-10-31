from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any, Protocol

import redis.asyncio as redis_async
import structlog
from pydantic import ValidationError

from .judge import JudgePackage, JudgeResult
from .metrics import Metrics
from .models import RunRequest, RunResult
from .slots import PrioritySlots, QueueName

log = structlog.get_logger()

HEARTBEAT_INTERVAL_S = 5.0
HEARTBEAT_TTL_S = 15
HEARTBEAT_PREFIX = "executor:worker:"
REPORT_ATTEMPTS = 4
REPORT_BACKOFF_S = 0.5
REPORT_TIMEOUT_S = 10.0

# A body of None makes it a GET.
Poster = Callable[[str, dict[str, Any] | None], tuple[int, dict[str, Any]]]
Runner = Callable[[RunRequest], RunResult]
JudgeRunner = Callable[[JudgePackage], JudgeResult]


class ReportError(Exception):
    """The API could not be told about a run."""


class Reporter(Protocol):
    async def started(self, execution_id: str, worker_id: str) -> bool: ...

    async def result(self, result: RunResult) -> None: ...

    async def judge_package(self, submission_id: str) -> JudgePackage | None: ...

    async def judge_result(self, result: JudgeResult) -> None: ...


def http_poster(base_url: str, token: str) -> Poster:
    if not base_url.startswith(("http://", "https://")):
        raise ValueError("API_URL must be http or https")

    def post(path: str, body: dict[str, Any] | None) -> tuple[int, dict[str, Any]]:
        request = urllib.request.Request(  # noqa: S310
            f"{base_url}{path}",
            data=None if body is None else json.dumps(body).encode(),
            headers={"content-type": "application/json", "x-service-token": token},
            method="GET" if body is None else "POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=REPORT_TIMEOUT_S) as response:  # noqa: S310
                payload: dict[str, Any] = json.load(response)
                return int(response.status), payload
        except urllib.error.HTTPError as error:
            return error.code, {}

    return post


class ApiReporter:
    def __init__(
        self,
        post: Poster,
        backoff_s: float = REPORT_BACKOFF_S,
    ) -> None:
        self._post = post
        self._backoff_s = backoff_s

    async def _send(self, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        problem = "no attempt made"
        for attempt in range(REPORT_ATTEMPTS):
            if attempt > 0:
                await asyncio.sleep(self._backoff_s * 2 ** (attempt - 1))
            try:
                status, payload = await asyncio.to_thread(self._post, path, body)
            except OSError as error:
                problem = str(error)
                continue
            if status < 300:
                return payload
            problem = f"status {status}"
            # A 4xx will fail the same way every time, so retrying only delays the failure.
            if status < 500:
                break
        raise ReportError(f"{path}: {problem}")

    async def started(self, execution_id: str, worker_id: str) -> bool:
        payload = await self._send(
            f"/api/v1/internal/executions/{execution_id}/started", {"worker_id": worker_id}
        )
        return bool(payload.get("proceed"))

    async def result(self, result: RunResult) -> None:
        await self._send(
            f"/api/v1/internal/executions/{result.execution_id}/result",
            result.model_dump(mode="json", exclude={"execution_id"}),
        )


    async def judge_package(self, submission_id: str) -> JudgePackage | None:
        payload = await self._send(f"/api/v1/internal/submissions/{submission_id}/package", None)
        if not payload.get("proceed"):
            return None
        return JudgePackage.model_validate(payload["package"])

    async def judge_result(self, result: JudgeResult) -> None:
        await self._send(
            f"/api/v1/internal/submissions/{result.submission_id}/result",
            result.model_dump(mode="json", exclude={"submission_id"}),
        )


class JobService:
    """What a worker does with one job, separate from how the job arrived."""

    def __init__(
        self,
        slots: PrioritySlots,
        runner: Runner,
        reporter: Reporter,
        metrics: Metrics,
        worker_id: str,
        clock: Callable[[], float] = time.time,
        judge_runner: JudgeRunner | None = None,
    ) -> None:
        self._judge_runner = judge_runner
        self._slots = slots
        self._runner = runner
        self._reporter = reporter
        self._metrics = metrics
        self._worker_id = worker_id
        self._clock = clock
        metrics.slots_total.set(slots.total)

    async def handle(self, queue: QueueName, data: Mapping[str, Any], enqueued_at_ms: int) -> str:
        try:
            request = RunRequest.model_validate(data)
        except ValidationError:
            # Retrying cannot fix a bad job. The error is not logged in full, as it holds the data.
            self._metrics.failures.labels(queue=queue.value, reason="invalid_job").inc()
            log.error("invalid_job", queue=queue.value)
            raise

        async with self._slots.slot(queue):
            self._metrics.slots_busy.set(self._slots.busy)
            try:
                return await self._run(queue, request, enqueued_at_ms)
            finally:
                self._metrics.slots_busy.set(self._slots.busy - 1)

    async def handle_judge(self, submission_id: str, enqueued_at_ms: int) -> str:
        if self._judge_runner is None:
            raise RuntimeError("this worker has no judge")
        queue = QueueName.JUDGE
        async with self._slots.slot(queue):
            self._metrics.slots_busy.set(self._slots.busy)
            try:
                waited_s = max(0.0, self._clock() - enqueued_at_ms / 1000)
                self._metrics.wait_seconds.labels(queue=queue.value).observe(waited_s)
                package = await self._reporter.judge_package(submission_id)
                if package is None:
                    return "declined"
                started = time.monotonic()
                result = await asyncio.to_thread(self._judge_runner, package)
                self._metrics.run_seconds.labels(
                    queue=queue.value, language=package.language.value
                ).observe(time.monotonic() - started)
                await self._reporter.judge_result(result)
                return result.verdict.value
            except ReportError:
                self._metrics.failures.labels(queue=queue.value, reason="report_failed").inc()
                raise
            finally:
                self._metrics.slots_busy.set(self._slots.busy - 1)

    async def _run(self, queue: QueueName, request: RunRequest, enqueued_at_ms: int) -> str:
        waited_s = max(0.0, self._clock() - enqueued_at_ms / 1000)
        self._metrics.wait_seconds.labels(queue=queue.value).observe(waited_s)
        execution_id = str(request.execution_id)

        try:
            proceed = await self._reporter.started(execution_id, self._worker_id)
            if not proceed:
                # A retry of a finished run, or one that has used up its attempts.
                log.info("job_declined", execution=execution_id)
                return "declined"

            started = time.monotonic()
            # On a thread, because the sandbox call blocks. BullMQ renews job locks on this event
            # loop, so blocking it would make a healthy job look like a crashed worker.
            result = await asyncio.to_thread(self._runner, request)
            self._metrics.run_seconds.labels(
                queue=queue.value, language=request.language.value
            ).observe(time.monotonic() - started)
            self._metrics.executions.labels(status=result.status.value).inc()

            await self._reporter.result(result)
        except ReportError:
            self._metrics.failures.labels(queue=queue.value, reason="report_failed").inc()
            raise
        return result.status.value


class Heartbeat:
    """Publishes which workers are alive, for dashboards and scaling decisions.

    BullMQ's own job locks are what detect a crash. This only reports. Each key expires by itself,
    so a dead worker disappears without anyone having to clean it up.
    """

    def __init__(
        self,
        client: redis_async.Redis,
        worker_id: str,
        slots: PrioritySlots,
        metrics: Metrics,
    ) -> None:
        self._client = client
        self._worker_id = worker_id
        self._slots = slots
        self._metrics = metrics

    async def beat(self) -> None:
        payload = {"slots": self._slots.total, "busy": self._slots.busy}
        await self._client.set(
            f"{HEARTBEAT_PREFIX}{self._worker_id}", json.dumps(payload), ex=HEARTBEAT_TTL_S
        )
        active = [key async for key in self._client.scan_iter(match=f"{HEARTBEAT_PREFIX}*")]
        self._metrics.workers_active.set(len(active))

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.beat()
            except redis_async.RedisError as error:
                log.warning("heartbeat_failed", error=str(error))
            try:
                await asyncio.wait_for(stop.wait(), HEARTBEAT_INTERVAL_S)
            except TimeoutError:
                continue
        await self._client.delete(f"{HEARTBEAT_PREFIX}{self._worker_id}")
