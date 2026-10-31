from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum


class QueueName(StrEnum):
    """Matches EXECUTION_QUEUES in packages/shared/src/execution.ts."""

    RUN = "run"
    JUDGE = "judge"


@dataclass
class _Waiter:
    future: asyncio.Future[None]
    arrived_at: float


class PrioritySlots:
    """Shares a machine's sandboxes between the two queues.

    BullMQ priorities only work inside one queue, and these are two queues. So the rule lives here:
    someone pressing Run waits ahead of any judge job, and judge jobs always leave some slots free
    for a person who arrives next. A judge job waiting too long goes first once, so that constant
    interactive use cannot starve submissions forever.
    """

    def __init__(
        self,
        total: int,
        reserved_for_run: int,
        judge_max_wait_s: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if total < 1:
            raise ValueError("a worker needs at least one slot")
        if not 0 <= reserved_for_run < total:
            raise ValueError("reserved slots must leave at least one for judging")
        self.total = total
        self.reserved_for_run = reserved_for_run
        self._judge_max_wait_s = judge_max_wait_s
        self._clock = clock
        self.busy = 0
        self._run: deque[_Waiter] = deque()
        self._judge: deque[_Waiter] = deque()

    @property
    def judge_capacity(self) -> int:
        return self.total - self.reserved_for_run

    def _waiters(self, queue: QueueName) -> deque[_Waiter]:
        return self._run if queue is QueueName.RUN else self._judge

    def _judge_is_overdue(self) -> bool:
        return (
            bool(self._judge)
            and self._clock() - self._judge[0].arrived_at >= self._judge_max_wait_s
        )

    def _next_waiter(self) -> _Waiter | None:
        if self.busy >= self.total:
            return None
        if self._judge_is_overdue():
            return self._judge.popleft()
        if self._run:
            return self._run.popleft()
        if self._judge and self.busy < self.judge_capacity:
            return self._judge.popleft()
        return None

    def _wake(self) -> None:
        while (waiter := self._next_waiter()) is not None:
            if waiter.future.done():
                continue
            self.busy += 1
            waiter.future.set_result(None)

    async def _acquire(self, queue: QueueName) -> None:
        waiter = _Waiter(asyncio.get_running_loop().create_future(), self._clock())
        self._waiters(queue).append(waiter)
        self._wake()
        try:
            await waiter.future
        except asyncio.CancelledError:
            if waiter.future.done() and not waiter.future.cancelled():
                self.release()
            else:
                self._waiters(queue).remove(waiter)
            raise

    def release(self) -> None:
        self.busy -= 1
        self._wake()

    @asynccontextmanager
    async def slot(self, queue: QueueName) -> AsyncIterator[None]:
        await self._acquire(queue)
        try:
            yield
        finally:
            self.release()
