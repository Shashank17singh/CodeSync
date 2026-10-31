"""Real BullMQ across Node and Python. Needs real Redis: TEST_REDIS_URL=redis://... pytest -m redis

The Node and Python clients are separate projects sharing Lua scripts, so the only proof that they
agree is a job crossing between them. Crash recovery is checked with a real SIGKILL.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from bullmq import Queue, Worker

from executor.models import RunRequest

pytestmark = pytest.mark.redis

REDIS_URL = os.environ.get("TEST_REDIS_URL", "")
REPO = Path(__file__).parents[3]
STALLING_WORKER = Path(__file__).parent / "stalling_worker.py"


@pytest.fixture(autouse=True)
def needs_redis() -> None:
    if not REDIS_URL:
        pytest.skip("TEST_REDIS_URL is not set: BullMQ has NOT been verified")


def enqueue_from_node(queue: str, execution_id: str) -> None:
    subprocess.run(
        [
            "pnpm",
            "--filter",
            "@codesync/api",
            "exec",
            "tsx",
            "test/enqueueContractJob.ts",
            REDIS_URL,
            queue,
            execution_id,
        ],
        cwd=REPO,
        check=True,
        timeout=60,
    )


def test_a_job_added_by_node_reaches_a_python_worker_intact() -> None:
    queue_name = f"contract-{uuid4().hex}"
    execution_id = str(uuid4())
    enqueue_from_node(queue_name, execution_id)

    async def scenario() -> tuple[dict[str, Any], int]:
        received: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

        async def process(job: Any, _token: str) -> str:
            if not received.done():
                received.set_result(job)
            return "done"

        worker = Worker(queue_name, process, {"connection": REDIS_URL})
        job = await asyncio.wait_for(received, 20)
        await worker.close()
        return job.data, job.timestamp

    data, timestamp = asyncio.run(scenario())
    assert str(RunRequest.model_validate(data).execution_id) == execution_id
    assert timestamp > 0


def test_a_job_is_recovered_once_after_a_worker_is_killed() -> None:
    queue_name = f"contract-{uuid4().hex}"
    marker = f"stall-{uuid4().hex}"

    async def add() -> None:
        queue = Queue(queue_name, {"connection": REDIS_URL})
        await queue.add("run", {"marker": marker}, {"jobId": marker, "attempts": 1})
        await queue.close()

    asyncio.run(add())

    def start_worker() -> subprocess.Popen[bytes]:
        return subprocess.Popen(
            [sys.executable, str(STALLING_WORKER), REDIS_URL, queue_name],
            stdout=subprocess.PIPE,
        )

    def wait_for_pickup(process: subprocess.Popen[bytes]) -> None:
        assert process.stdout is not None
        assert b"picked" in process.stdout.readline()

    first = start_worker()
    wait_for_pickup(first)
    first.kill()
    first.wait()

    second = start_worker()
    wait_for_pickup(second)
    second.kill()
    second.wait()

    third = start_worker()

    async def final_state() -> str:
        queue = Queue(queue_name, {"connection": REDIS_URL})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            counts = await queue.getJobCounts("failed", "completed")
            if counts.get("failed"):
                await queue.close()
                return "failed"
            await asyncio.sleep(0.25)
        await queue.close()
        return "stuck"

    state = asyncio.run(final_state())
    third.kill()
    third.wait()
    # One recovery was allowed. The second crash ends the job instead of looping forever.
    assert state == "failed"
