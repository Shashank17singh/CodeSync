"""Queue behaviour with a fake executor: priority, retry, metrics and heartbeats."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Coroutine
from typing import Any
from uuid import uuid4

import fakeredis
import pytest
from prometheus_client import generate_latest
from pydantic import ValidationError

from executor.metrics import Metrics
from executor.models import RunRequest, RunResult, Status
from executor.service import (
    ApiReporter,
    Heartbeat,
    JobService,
    ReportError,
)
from executor.slots import PrioritySlots, QueueName
from executor.worker import MAX_STALLED_COUNT, worker_options


def job_data(execution_id: str | None = None) -> dict[str, Any]:
    return {
        "execution_id": execution_id or str(uuid4()),
        "room_id": str(uuid4()),
        "user_id": str(uuid4()),
        "language": "PYTHON",
        "entry_path": "main.py",
        "files": [{"path": "main.py", "content": "print(1)"}],
        "stdin": "",
    }


class FakeReporter:
    """Applies the same claim rule as the API, which real tests cover against PostgreSQL."""

    def __init__(self, max_attempts: int = 2) -> None:
        self.max_attempts = max_attempts
        self.attempts: dict[str, int] = {}
        self.results: dict[str, RunResult] = {}
        self.fail_result = False

    async def started(self, execution_id: str, worker_id: str) -> bool:
        if execution_id in self.results:
            return False
        count = self.attempts.get(execution_id, 0)
        if count >= self.max_attempts:
            return False
        self.attempts[execution_id] = count + 1
        return True

    async def result(self, result: RunResult) -> None:
        if self.fail_result:
            raise ReportError("api down")
        self.results[str(result.execution_id)] = result


def ok_runner(request: RunRequest) -> RunResult:
    return RunResult(execution_id=request.execution_id, status=Status.OK, exit_code=0, time_ms=1)


def service(
    runner: Any = ok_runner,
    reporter: FakeReporter | None = None,
    slots: PrioritySlots | None = None,
    metrics: Metrics | None = None,
) -> JobService:
    return JobService(
        slots or PrioritySlots(2, 1),
        runner,
        reporter or FakeReporter(),
        metrics or Metrics(),
        "worker-1",
    )


def run(coroutine: Coroutine[Any, Any, Any]) -> Any:
    return asyncio.run(coroutine)


class TestPrioritySlots:
    def test_refuses_a_configuration_that_could_never_judge(self) -> None:
        with pytest.raises(ValueError, match="reserved"):
            PrioritySlots(2, 2)
        with pytest.raises(ValueError, match="at least one"):
            PrioritySlots(0, 0)

    def test_a_run_goes_ahead_of_judge_jobs_that_arrived_first(self) -> None:
        async def scenario() -> list[str]:
            slots = PrioritySlots(1, 0)
            order: list[str] = []
            release = asyncio.Event()

            async def job(queue: QueueName, name: str) -> None:
                async with slots.slot(queue):
                    order.append(name)
                    await release.wait()

            first = asyncio.create_task(job(QueueName.JUDGE, "judge-1"))
            await asyncio.sleep(0)
            waiting = [
                asyncio.create_task(job(QueueName.JUDGE, "judge-2")),
                asyncio.create_task(job(QueueName.JUDGE, "judge-3")),
                asyncio.create_task(job(QueueName.RUN, "run-1")),
            ]
            await asyncio.sleep(0.01)
            release.set()
            await asyncio.gather(first, *waiting)
            return order

        assert run(scenario()) == ["judge-1", "run-1", "judge-2", "judge-3"]

    def test_judge_jobs_never_take_the_reserved_slot(self) -> None:
        async def scenario() -> tuple[int, int]:
            slots = PrioritySlots(3, 1)
            release = asyncio.Event()
            peak = 0

            async def judge() -> None:
                nonlocal peak
                async with slots.slot(QueueName.JUDGE):
                    peak = max(peak, slots.busy)
                    await release.wait()

            tasks = [asyncio.create_task(judge()) for _ in range(6)]
            await asyncio.sleep(0.01)
            busy_with_only_judges = slots.busy

            async def person() -> None:
                async with slots.slot(QueueName.RUN):
                    release.set()

            await asyncio.wait_for(person(), 1)
            await asyncio.gather(*tasks)
            return busy_with_only_judges, peak

        assert run(scenario()) == (2, 2)

    def test_runs_can_use_every_slot(self) -> None:
        async def scenario() -> int:
            slots = PrioritySlots(3, 1)
            release = asyncio.Event()

            async def job() -> None:
                async with slots.slot(QueueName.RUN):
                    await release.wait()

            tasks = [asyncio.create_task(job()) for _ in range(3)]
            await asyncio.sleep(0.01)
            busy = slots.busy
            release.set()
            await asyncio.gather(*tasks)
            return busy

        assert run(scenario()) == 3

    def test_an_overdue_judge_job_goes_first_so_runs_cannot_starve_it(self) -> None:
        async def scenario() -> list[str]:
            now = [0.0]
            slots = PrioritySlots(1, 0, judge_max_wait_s=30, clock=lambda: now[0])
            order: list[str] = []
            release = asyncio.Event()

            async def job(queue: QueueName, name: str) -> None:
                async with slots.slot(queue):
                    order.append(name)
                    await release.wait()

            holder = asyncio.create_task(job(QueueName.RUN, "holder"))
            await asyncio.sleep(0)
            judge = asyncio.create_task(job(QueueName.JUDGE, "old-judge"))
            await asyncio.sleep(0)
            now[0] = 31
            person = asyncio.create_task(job(QueueName.RUN, "new-run"))
            await asyncio.sleep(0)
            release.set()
            await asyncio.gather(holder, judge, person)
            return order

        assert run(scenario()) == ["holder", "old-judge", "new-run"]

    def test_never_exceeds_the_total_under_load(self) -> None:
        async def scenario() -> int:
            slots = PrioritySlots(4, 1)
            peak = 0

            async def job(queue: QueueName) -> None:
                nonlocal peak
                async with slots.slot(queue):
                    peak = max(peak, slots.busy)
                    await asyncio.sleep(0.001)

            await asyncio.gather(
                *(
                    job(QueueName.RUN if index % 3 else QueueName.JUDGE)
                    for index in range(200)
                )
            )
            assert slots.busy == 0
            return peak

        assert run(scenario()) == 4

    def test_a_cancelled_waiter_gives_up_its_place(self) -> None:
        async def scenario() -> int:
            slots = PrioritySlots(1, 0)
            release = asyncio.Event()

            async def job() -> None:
                async with slots.slot(QueueName.RUN):
                    await release.wait()

            holder = asyncio.create_task(job())
            await asyncio.sleep(0)
            waiter = asyncio.create_task(job())
            await asyncio.sleep(0)
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
            release.set()
            await holder
            return slots.busy

        assert run(scenario()) == 0

    def test_a_failing_job_frees_its_slot(self) -> None:
        async def scenario() -> int:
            slots = PrioritySlots(1, 0)
            with pytest.raises(RuntimeError):
                async with slots.slot(QueueName.RUN):
                    raise RuntimeError("boom")
            return slots.busy

        assert run(scenario()) == 0


class TestRetryAfterACrash:
    """Simulates BullMQ delivering a job again after its worker died."""

    def test_a_job_interrupted_mid_run_runs_again_on_the_next_delivery(self) -> None:
        async def scenario() -> tuple[int, int]:
            reporter = FakeReporter()
            data = job_data()
            calls = 0

            def crash_then_succeed(request: RunRequest) -> RunResult:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise ConnectionError("worker died")
                return ok_runner(request)

            worker = service(crash_then_succeed, reporter)
            with pytest.raises(ConnectionError):
                await worker.handle(QueueName.RUN, data, 0)
            result = await worker.handle(QueueName.RUN, data, 0)
            assert result == "OK"
            return calls, reporter.attempts[data["execution_id"]]

        assert run(scenario()) == (2, 2)

    def test_gives_up_after_one_retry(self) -> None:
        async def scenario() -> tuple[str, int]:
            reporter = FakeReporter()
            data = job_data()
            calls = 0

            def always_crash(request: RunRequest) -> RunResult:
                nonlocal calls
                calls += 1
                raise ConnectionError("worker died")

            worker = service(always_crash, reporter)
            for _ in range(2):
                with pytest.raises(ConnectionError):
                    await worker.handle(QueueName.RUN, data, 0)
            third = await worker.handle(QueueName.RUN, data, 0)
            return third, calls

        assert run(scenario()) == ("declined", 2)

    def test_a_finished_run_is_not_repeated_when_delivered_again(self) -> None:
        async def scenario() -> tuple[str, int]:
            reporter = FakeReporter()
            data = job_data()
            calls = 0

            def counted(request: RunRequest) -> RunResult:
                nonlocal calls
                calls += 1
                return ok_runner(request)

            worker = service(counted, reporter)
            await worker.handle(QueueName.RUN, data, 0)
            return await worker.handle(QueueName.RUN, data, 0), calls

        assert run(scenario()) == ("declined", 1)

    def test_workers_ask_bullmq_for_exactly_one_recovery(self) -> None:
        options = worker_options("redis://x", 4)
        assert MAX_STALLED_COUNT == 1
        assert options["maxStalledCount"] == 1
        assert options["concurrency"] == 4


class TestJobService:
    def test_rejects_a_malformed_job_without_running_it(self) -> None:
        metrics = Metrics()
        calls: list[RunRequest] = []

        def runner(request: RunRequest) -> RunResult:
            calls.append(request)
            return ok_runner(request)

        worker = service(runner, metrics=metrics)
        bad = job_data() | {"entry_path": "../../etc/passwd"}
        with pytest.raises(ValidationError):
            run(worker.handle(QueueName.RUN, bad, 0))
        assert calls == []
        assert b'reason="invalid_job"' in generate_latest(metrics.registry)

    def test_counts_a_result_that_could_not_be_reported(self) -> None:
        metrics = Metrics()
        reporter = FakeReporter()
        reporter.fail_result = True
        with pytest.raises(ReportError):
            run(service(reporter=reporter, metrics=metrics).handle(QueueName.RUN, job_data(), 0))
        assert b'reason="report_failed"' in generate_latest(metrics.registry)

    def test_does_not_block_the_event_loop_during_a_run(self) -> None:
        """BullMQ renews locks on this loop, so a blocked loop looks like a crash."""

        async def scenario() -> int:
            ticks = 0

            def slow(request: RunRequest) -> RunResult:
                time.sleep(0.2)
                return ok_runner(request)

            async def ticker() -> None:
                nonlocal ticks
                while True:
                    ticks += 1
                    await asyncio.sleep(0.01)

            task = asyncio.create_task(ticker())
            await service(slow).handle(QueueName.RUN, job_data(), 0)
            task.cancel()
            return ticks

        assert run(scenario()) > 5

    def test_runs_jobs_at_the_same_time_up_to_the_slot_count(self) -> None:
        async def scenario() -> int:
            active = 0
            peak = 0
            lock = threading.Lock()

            def runner(request: RunRequest) -> RunResult:
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                time.sleep(0.05)
                with lock:
                    active -= 1
                return ok_runner(request)

            worker = service(runner, slots=PrioritySlots(3, 0))
            await asyncio.gather(
                *(worker.handle(QueueName.RUN, job_data(), 0) for _ in range(9))
            )
            return peak

        assert run(scenario()) == 3


class TestMetrics:
    def test_exposes_what_the_spec_asks_for_in_prometheus_format(self) -> None:
        metrics = Metrics()
        worker = JobService(
            PrioritySlots(2, 1),
            ok_runner,
            FakeReporter(),
            metrics,
            "worker-1",
            clock=lambda: 12.5,
        )
        run(worker.handle(QueueName.RUN, job_data(), enqueued_at_ms=10_000))
        metrics.queue_jobs.labels(queue="run", state="waiting").set(7)
        text = generate_latest(metrics.registry).decode()

        assert 'codesync_queue_jobs{queue="run",state="waiting"} 7.0' in text
        assert 'codesync_job_wait_seconds_sum{queue="run"} 2.5' in text
        assert 'codesync_job_run_seconds_count{language="PYTHON",queue="run"} 1.0' in text
        assert 'codesync_executions_total{status="OK"} 1.0' in text
        assert "codesync_worker_slots_total 2.0" in text

    def test_never_reports_a_negative_wait_from_clock_skew(self) -> None:
        metrics = Metrics()
        worker = JobService(
            PrioritySlots(1, 0), ok_runner, FakeReporter(), metrics, "w", clock=lambda: 1.0
        )
        run(worker.handle(QueueName.RUN, job_data(), enqueued_at_ms=99_000))
        text = generate_latest(metrics.registry).decode()
        assert 'codesync_job_wait_seconds_sum{queue="run"} 0.0' in text


class TestApiReporter:
    def recorder(self, responses: list[Any]) -> tuple[list[tuple[str, dict[str, Any]]], Any]:
        calls: list[tuple[str, dict[str, Any]]] = []

        def post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
            calls.append((path, body))
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            status: int
            payload: dict[str, Any]
            status, payload = response
            return status, payload

        return calls, post

    def test_uses_the_routes_and_fields_the_api_expects(self) -> None:
        calls, post = self.recorder([(200, {"proceed": True}), (200, {"recorded": True})])
        reporter = ApiReporter(post, backoff_s=0)
        execution = uuid4()
        assert run(reporter.started(str(execution), "worker-1")) is True
        run(
            reporter.result(
                RunResult(execution_id=execution, status=Status.OK, exit_code=0, stdout="hi")
            )
        )
        assert calls[0] == (
            f"/api/v1/internal/executions/{execution}/started",
            {"worker_id": "worker-1"},
        )
        path, body = calls[1]
        assert path == f"/api/v1/internal/executions/{execution}/result"
        assert body == {
            "status": "OK",
            "exit_code": 0,
            "stdout": "hi",
            "stderr": "",
            "compile_output": "",
            "time_ms": None,
            "memory_kb": None,
            "message": None,
        }

    def test_retries_a_brief_outage(self) -> None:
        calls, post = self.recorder(
            [OSError("refused"), (503, {}), (200, {"proceed": False})]
        )
        assert run(ApiReporter(post, backoff_s=0).started("id", "w")) is False
        assert len(calls) == 3

    def test_does_not_retry_a_refusal(self) -> None:
        calls, post = self.recorder([(403, {}), (200, {})])
        with pytest.raises(ReportError):
            run(ApiReporter(post, backoff_s=0).started("id", "w"))
        assert len(calls) == 1

    def test_gives_up_after_a_long_outage(self) -> None:
        calls, post = self.recorder([OSError("down") for _ in range(10)])
        with pytest.raises(ReportError):
            run(ApiReporter(post, backoff_s=0).started("id", "w"))
        assert len(calls) == 4


class TestHeartbeat:
    def test_registers_a_key_that_expires_and_counts_live_workers(self) -> None:
        async def scenario() -> tuple[Any, int, str]:
            client = fakeredis.FakeAsyncRedis()
            metrics = Metrics()
            slots = PrioritySlots(4, 1)
            await Heartbeat(client, "a", slots, metrics).beat()
            await Heartbeat(client, "b", slots, metrics).beat()
            return (
                await client.get("executor:worker:a"),
                await client.ttl("executor:worker:a"),
                generate_latest(metrics.registry).decode(),
            )

        value, ttl, text = run(scenario())
        assert value == b'{"slots": 4, "busy": 0}'
        assert 0 < ttl <= 15
        assert "codesync_workers_active 2.0" in text

    def test_removes_its_key_on_a_clean_stop(self) -> None:
        async def scenario() -> Any:
            client = fakeredis.FakeAsyncRedis()
            stop = asyncio.Event()
            beat = Heartbeat(client, "a", PrioritySlots(1, 0), Metrics())
            task = asyncio.create_task(beat.run(stop))
            await asyncio.sleep(0.01)
            stop.set()
            await task
            return await client.get("executor:worker:a")

        assert run(scenario()) is None
