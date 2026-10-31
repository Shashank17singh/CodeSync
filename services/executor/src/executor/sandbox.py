from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from .models import Language

StreamName = Literal["stdout", "stderr"]


class SandboxError(Exception):
    """The sandbox itself failed, as opposed to the user's program."""


@dataclass(frozen=True)
class MemoryStats:
    peak_kb: int | None
    oom_kills: int


class SandboxProcess(Protocol):
    def output(self) -> Iterator[tuple[StreamName, bytes]]:
        """Yields output until the process ends or the sandbox is killed."""
        ...

    def exit_code(self) -> int | None: ...


class Sandbox(Protocol):
    def write_files(self, files: Mapping[str, bytes]) -> None: ...

    def start(self, argv: Sequence[str], stdin_file: str | None = None) -> SandboxProcess: ...

    def memory_stats(self) -> MemoryStats | None: ...

    def kill(self) -> None:
        """Stops everything inside at once. Safe to call from another thread."""
        ...

    def destroy(self) -> None: ...


class SandboxEngine(Protocol):
    def create(self, language: Language) -> Sandbox: ...
