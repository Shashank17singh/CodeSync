from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import structlog

from .models import Language
from .sandbox import Sandbox, SandboxEngine, SandboxError

log = structlog.get_logger()


@dataclass(frozen=True)
class _Idle:
    sandbox: Sandbox
    created_at: float


class SandboxPool:
    """Keeps started containers ready, because starting one takes far longer than running code.

    A sandbox is used once and then destroyed. Reusing one would let a program leave something
    behind for the next user's code to find.
    """

    def __init__(
        self,
        engine: SandboxEngine,
        size: int,
        max_idle_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._engine = engine
        self._size = size
        self._max_idle_s = max_idle_s
        self._clock = clock
        self._idle: dict[Language, queue.Queue[_Idle]] = {
            language: queue.Queue() for language in Language
        }
        self._filling: dict[Language, int] = dict.fromkeys(Language, 0)
        self._lock = threading.Lock()
        self._closed = False
        self._workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sandbox-pool")

    def warm(self) -> None:
        for language in Language:
            self._top_up(language)

    def acquire(self, language: Language) -> Sandbox:
        idle = self._idle[language]
        while True:
            try:
                entry = idle.get_nowait()
            except queue.Empty:
                break
            if self._clock() - entry.created_at > self._max_idle_s:
                entry.sandbox.destroy()
                continue
            self._top_up(language)
            return entry.sandbox
        self._top_up(language)
        return self._engine.create(language)

    def _top_up(self, language: Language) -> None:
        with self._lock:
            if self._closed:
                return
            missing = self._size - self._idle[language].qsize() - self._filling[language]
            if missing <= 0:
                return
            self._filling[language] += missing
        for _ in range(missing):
            self._workers.submit(self._create_one, language)

    def _create_one(self, language: Language) -> None:
        sandbox: Sandbox | None = None
        try:
            sandbox = self._engine.create(language)
        except SandboxError as error:
            # A run still works without a warm container, so this is not fatal.
            log.warning("sandbox_pool_fill_failed", language=language, error=str(error))
        with self._lock:
            self._filling[language] -= 1
            closed = self._closed
            if sandbox is not None and not closed:
                self._idle[language].put(_Idle(sandbox, self._clock()))
        if sandbox is not None and closed:
            sandbox.destroy()

    def idle_count(self, language: Language) -> int:
        return self._idle[language].qsize()

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
        self._workers.shutdown(wait=True)
        for idle in self._idle.values():
            while True:
                try:
                    idle.get_nowait().sandbox.destroy()
                except queue.Empty:
                    break
