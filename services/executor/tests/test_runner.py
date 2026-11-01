"""Tests the runner against real local processes, using harmless programs only."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from uuid import uuid4

import pytest

from executor.languages import PROFILES
from executor.models import Language, RunRequest, RunResult, SourceFile, Status
from executor.output import OutputChannel
from executor.runner import StepResult, classify, execute
from executor.sandbox import MemoryStats, Sandbox, SandboxError, StreamName
from executor.settings import SandboxLimits
from local_engine import LocalSandbox, LocalSource

LIMITS = SandboxLimits(run_timeout_s=1.5, output_bytes=2048)


@dataclass
class RecordingEvents:
    log: list[str] = field(default_factory=list)
    output_chunks: list[tuple[OutputChannel, str]] = field(default_factory=list)
    finished_result: RunResult | None = None

    def started(self, request: RunRequest) -> None:
        self.log.append("started")

    def output(self, request: RunRequest, channel: OutputChannel, data: str) -> None:
        self.log.append("output")
        self.output_chunks.append((channel, data))

    def finished(self, request: RunRequest, result: RunResult) -> None:
        self.log.append("finished")
        self.finished_result = result


def python_request(source: str, stdin: str = "") -> RunRequest:
    return RunRequest(
        execution_id=uuid4(),
        room_id=uuid4(),
        user_id=uuid4(),
        language=Language.PYTHON,
        entry_path="main.py",
        files=(SourceFile(path="main.py", content=source),),
        stdin=stdin,
    )


def run(source_code: str, stdin: str = "", source: LocalSource | None = None) -> RunResult:
    return execute(
        python_request(source_code, stdin),
        source or LocalSource(),
        RecordingEvents(),
        LIMITS,
    )


def test_reports_ok_with_output_and_time() -> None:
    result = run('print("hello")')
    assert result.status is Status.OK
    assert result.stdout.strip() == "hello"
    assert result.exit_code == 0
    assert result.time_ms is not None
    assert result.time_ms >= 0


def test_passes_stdin_to_the_program() -> None:
    result = run("print(input().upper())", stdin="from stdin\n")
    assert result.stdout.strip() == "FROM STDIN"


def test_separates_stdout_and_stderr() -> None:
    result = run('import sys\nprint("out")\nprint("err", file=sys.stderr)')
    assert result.stdout.strip() == "out"
    assert result.stderr.strip() == "err"


def test_reports_a_runtime_error_with_the_exit_code() -> None:
    result = run("import sys\nsys.exit(3)")
    assert result.status is Status.RUNTIME_ERROR
    assert result.exit_code == 3


def test_reports_an_uncaught_exception_as_a_runtime_error() -> None:
    result = run('raise ValueError("boom")')
    assert result.status is Status.RUNTIME_ERROR
    assert "boom" in result.stderr


def test_stops_a_busy_loop_at_the_time_limit() -> None:
    started = time.monotonic()
    result = run("while True: pass")
    assert result.status is Status.TIME_LIMIT_EXCEEDED
    assert time.monotonic() - started < LIMITS.run_timeout_s + 2


def test_stops_a_sleeping_program_with_no_output() -> None:
    result = run("import time\ntime.sleep(60)")
    assert result.status is Status.TIME_LIMIT_EXCEEDED


def test_keeps_output_written_before_a_timeout() -> None:
    result = run('import time\nprint("before", flush=True)\ntime.sleep(60)')
    assert result.status is Status.TIME_LIMIT_EXCEEDED
    assert "before" in result.stdout


def test_stops_an_output_flood_at_the_cap() -> None:
    source = LocalSource()
    result = run('while True: print("x" * 100, flush=True)', source=source)
    assert result.status is Status.OUTPUT_LIMIT_EXCEEDED
    assert len(result.stdout) <= LIMITS.output_bytes
    assert source.sandboxes[0].killed
    # Stopped by the cap itself. Waiting for the time limit would let a flood run for seconds.
    assert result.time_ms is not None
    assert result.time_ms < LIMITS.run_timeout_s * 1000 * 0.75


def test_counts_stdout_and_stderr_against_one_cap() -> None:
    result = run(
        "import sys\n"
        "while True:\n"
        '    print("o" * 100, flush=True)\n'
        '    print("e" * 100, file=sys.stderr, flush=True)'
    )
    assert result.status is Status.OUTPUT_LIMIT_EXCEEDED
    assert len(result.stdout) + len(result.stderr) <= LIMITS.output_bytes


def test_survives_invalid_utf8_output() -> None:
    result = run(r'import sys; sys.stdout.buffer.write(b"ok \xff\xfe end\n")')
    assert result.status is Status.OK
    assert "ok" in result.stdout
    assert "end" in result.stdout


def test_passes_multibyte_text_split_across_chunks() -> None:
    result = run(
        "import sys,time\n"
        'data = "नमस्ते".encode()\n'
        "for i in range(len(data)):\n"
        "    sys.stdout.buffer.write(data[i:i+1]); sys.stdout.flush(); time.sleep(0.005)"
    )
    assert result.stdout == "नमस्ते"


def test_reports_peak_memory() -> None:
    source = LocalSource(MemoryStats(peak_kb=5120, oom_kills=0))
    assert run('print("x")', source=source).memory_kb == 5120


def test_reports_an_out_of_memory_kill() -> None:
    source = LocalSource(MemoryStats(peak_kb=262144, oom_kills=1))
    assert run("import sys\nsys.exit(137)", source=source).status is (
        Status.MEMORY_LIMIT_EXCEEDED
    )


def test_destroys_the_sandbox_after_every_kind_of_run() -> None:
    for program in ('print("x")', "raise SystemExit(1)", "while True: pass"):
        source = LocalSource()
        run(program, source=source)
        assert source.sandboxes[0].destroyed


def test_streams_output_before_the_program_ends() -> None:
    events = RecordingEvents()
    source = LocalSource()
    seen_early: list[bool] = []

    original = events.output

    def watch(request: RunRequest, channel: OutputChannel, data: str) -> None:
        seen_early.append(events.finished_result is None)
        original(request, channel, data)

    events.output = watch  # type: ignore[method-assign]
    execute(
        python_request('import time\nprint("early", flush=True)\ntime.sleep(0.5)\nprint("late")'),
        source,
        events,
        LIMITS,
    )
    assert any("early" in data for _channel, data in events.output_chunks)
    assert all(seen_early)
    assert events.log[0] == "started"
    assert events.log[-1] == "finished"


def test_flushes_a_quiet_line_without_waiting_for_more_output() -> None:
    arrived: list[float] = []
    events = RecordingEvents()
    original = events.output

    def stamp(request: RunRequest, channel: OutputChannel, data: str) -> None:
        arrived.append(time.monotonic())
        original(request, channel, data)

    events.output = stamp  # type: ignore[method-assign]
    started = time.monotonic()
    execute(
        python_request('import time\nprint("line", flush=True)\ntime.sleep(1)'),
        LocalSource(),
        events,
        LIMITS,
    )
    assert arrived
    assert arrived[0] - started < 0.9


def test_batches_a_byte_at_a_time_program() -> None:
    events = RecordingEvents()
    execute(
        python_request(
            "import sys\nfor _ in range(1500):\n    sys.stdout.write('x'); sys.stdout.flush()"
        ),
        LocalSource(),
        events,
        LIMITS,
    )
    assert len(events.output_chunks) < 200


class BrokenSource:
    def acquire(self, language: Language) -> Sandbox:
        raise SandboxError("docker daemon at /var/run/secret-path is down")


class FailsOnWrite(LocalSource):
    def acquire(self, language: Language) -> Sandbox:
        sandbox = LocalSandbox()

        def fail(files: object) -> None:
            raise SandboxError("write failed at /var/lib/docker/secret")

        sandbox.write_files = fail  # type: ignore[method-assign]
        self.sandboxes.append(sandbox)
        return sandbox


def test_reports_internal_error_without_leaking_host_details() -> None:
    events = RecordingEvents()
    result = execute(python_request("pass"), BrokenSource(), events, LIMITS)
    assert result.status is Status.INTERNAL_ERROR
    assert "secret" not in (result.message or "")
    assert events.finished_result == result


def test_destroys_the_sandbox_when_setup_fails() -> None:
    source = FailsOnWrite()
    result = execute(python_request("pass"), source, RecordingEvents(), LIMITS)
    assert result.status is Status.INTERNAL_ERROR
    assert source.sandboxes[0].destroyed


def step(
    exit_code: int | None = 0, timed_out: bool = False, output_exceeded: bool = False
) -> StepResult:
    return StepResult(
        exit_code=exit_code, elapsed_ms=1, timed_out=timed_out, output_exceeded=output_exceeded
    )


JAVA = PROFILES[Language.JAVA]
PYTHON = PROFILES[Language.PYTHON]


@pytest.mark.parametrize(
    ("result", "stats", "stderr", "expected"),
    [
        (step(0), MemoryStats(10, 0), "", Status.OK),
        (step(1), MemoryStats(10, 0), "", Status.RUNTIME_ERROR),
        (step(137), MemoryStats(10, 1), "", Status.MEMORY_LIMIT_EXCEEDED),
        # A program that kills itself is not out of memory when cgroup data says so.
        (step(137), MemoryStats(10, 0), "", Status.RUNTIME_ERROR),
        # With no cgroup data, as under gVisor, SIGKILL is best explained by the OOM killer.
        (step(137), None, "", Status.MEMORY_LIMIT_EXCEEDED),
        (
            step(1),
            None,
            "java.lang.OutOfMemoryError: Java heap space",
            Status.MEMORY_LIMIT_EXCEEDED,
        ),
        # Being killed for time or output takes priority over the exit code it causes.
        (step(137, timed_out=True), None, "", Status.TIME_LIMIT_EXCEEDED),
        (step(137, output_exceeded=True), None, "", Status.OUTPUT_LIMIT_EXCEEDED),
        (step(0, output_exceeded=True), None, "", Status.OUTPUT_LIMIT_EXCEEDED),
    ],
)
def test_classifies_results(
    result: StepResult, stats: MemoryStats | None, stderr: str, expected: Status
) -> None:
    assert classify(JAVA, result, stats, stderr) is expected


def test_a_clean_exit_is_ok_even_if_it_prints_a_memory_marker() -> None:
    assert classify(PYTHON, step(0), None, "Traceback\nMemoryError") is Status.OK


def test_recognises_a_real_python_memory_error() -> None:
    result = run("raise MemoryError")
    assert result.status is Status.MEMORY_LIMIT_EXCEEDED


def test_a_memory_marker_only_counts_for_its_own_language() -> None:
    stderr = "java.lang.OutOfMemoryError"
    assert classify(PYTHON, step(1), MemoryStats(1, 0), stderr) is Status.RUNTIME_ERROR


class BlockingKillSandbox:
    """Docker's kill can wait for the output pipe to drain, so kill waits for the reader here."""

    def __init__(self) -> None:
        self.drained = threading.Event()
        self.killed = threading.Event()

    def write_files(self, files: Mapping[str, bytes]) -> None:
        pass

    def start(self, argv: Sequence[str], stdin_file: str | None = None) -> BlockingKillSandbox:
        return self

    def output(self) -> Iterator[tuple[StreamName, bytes]]:
        for _ in range(64):
            yield "stdout", b"x" * 1024
        self.drained.set()

    def exit_code(self) -> int | None:
        return 137

    def memory_stats(self) -> MemoryStats | None:
        return None

    def kill(self) -> None:
        # As in DockerSandbox, only the first call does the work.
        if not self.killed.is_set():
            self.killed.set()
            self.drained.wait(30)

    def destroy(self) -> None:
        pass

    def acquire(self, language: Language) -> BlockingKillSandbox:
        return self


def test_output_flood_is_reported_when_killing_needs_the_pipe_drained() -> None:
    sandbox = BlockingKillSandbox()
    result = execute(python_request("flood"), sandbox, RecordingEvents(), LIMITS)
    assert result.status is Status.OUTPUT_LIMIT_EXCEEDED
