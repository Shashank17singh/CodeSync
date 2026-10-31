"""Runs programs as plain local processes, with no isolation at all.

Lets the runner be tested against real processes, real timing and real pipes on a machine with no
Docker. Only harmless test programs may go through this. The attack programs must never run here.
"""

from __future__ import annotations

import queue
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import IO

from executor.languages import WORK_DIR
from executor.models import Language
from executor.sandbox import MemoryStats, Sandbox, SandboxProcess, StreamName


class LocalProcess:
    def __init__(self, process: subprocess.Popen[bytes], stdin: IO[bytes] | None) -> None:
        self._process = process
        self._stdin = stdin

    def output(self) -> Iterator[tuple[StreamName, bytes]]:
        items: queue.Queue[tuple[StreamName, bytes] | None] = queue.Queue()

        def read(name: StreamName, pipe: IO[bytes]) -> None:
            while chunk := pipe.read1(4096):  # type: ignore[attr-defined]
                items.put((name, chunk))
            items.put(None)

        assert self._process.stdout is not None
        assert self._process.stderr is not None
        threading.Thread(target=read, args=("stdout", self._process.stdout), daemon=True).start()
        threading.Thread(target=read, args=("stderr", self._process.stderr), daemon=True).start()
        finished = 0
        while finished < 2:
            item = items.get()
            if item is None:
                finished += 1
            else:
                yield item
        self._process.wait()

    def exit_code(self) -> int | None:
        return self._process.poll()


class LocalSandbox:
    def __init__(self, stats: MemoryStats | None = None) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="codesync-local-"))
        self.stats = stats
        self.destroyed = False
        self.killed = False
        self._processes: list[subprocess.Popen[bytes]] = []

    def write_files(self, files: Mapping[str, bytes]) -> None:
        for path, content in files.items():
            target = self.directory / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

    def start(self, argv: Sequence[str], stdin_file: str | None = None) -> SandboxProcess:
        command = [sys.executable if part == "python3" else part for part in argv]
        stdin: IO[bytes] | None = None
        if stdin_file is not None:
            stdin = (self.directory / stdin_file.removeprefix(f"{WORK_DIR}/")).open("rb")
        process = subprocess.Popen(
            command,
            cwd=self.directory,
            stdin=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._processes.append(process)
        return LocalProcess(process, stdin)

    def memory_stats(self) -> MemoryStats | None:
        return self.stats

    def kill(self) -> None:
        self.killed = True
        for process in self._processes:
            process.kill()

    def destroy(self) -> None:
        self.destroyed = True
        self.kill()
        shutil.rmtree(self.directory, ignore_errors=True)


class LocalSource:
    def __init__(self, stats: MemoryStats | None = None) -> None:
        self.stats = stats
        self.sandboxes: list[LocalSandbox] = []

    def acquire(self, language: Language) -> Sandbox:
        sandbox = LocalSandbox(self.stats)
        self.sandboxes.append(sandbox)
        return sandbox
