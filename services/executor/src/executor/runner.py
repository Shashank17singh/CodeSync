from __future__ import annotations

import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

import structlog

from .events import EventSink
from .languages import PROFILES, STDIN_FILE, WORK_DIR, LanguageProfile
from .models import Language, RunRequest, RunResult, Status
from .output import OutputCollector, channel_for
from .sandbox import MemoryStats, Sandbox, SandboxError
from .settings import SandboxLimits

log = structlog.get_logger()

POLL_INTERVAL_S = 0.05
KILL_GRACE_S = 5.0
SIGKILL_EXIT = 137


class SandboxSource(Protocol):
    def acquire(self, language: Language) -> Sandbox: ...


@dataclass(frozen=True)
class StepResult:
    exit_code: int | None
    elapsed_ms: int
    timed_out: bool
    output_exceeded: bool


def run_step(
    sandbox: Sandbox,
    argv: Sequence[str],
    timeout_s: float,
    collector: OutputCollector,
    compiling: bool = False,
    stdin_file: str | None = None,
) -> StepResult:
    process = sandbox.start(argv, stdin_file)
    failure: list[BaseException] = []

    def pump() -> None:
        try:
            for stream, data in process.output():
                if not collector.add(channel_for(stream, compiling), data):
                    sandbox.kill()
                    return
        except Exception as error:
            failure.append(error)

    # Reading happens on its own thread so that a silent program can still be timed out.
    reader = threading.Thread(target=pump, name="sandbox-output", daemon=True)
    started = time.monotonic()
    deadline = started + timeout_s
    reader.start()
    timed_out = False
    while reader.is_alive():
        reader.join(POLL_INTERVAL_S)
        collector.tick()
        if reader.is_alive() and time.monotonic() >= deadline:
            timed_out = True
            sandbox.kill()
            reader.join(KILL_GRACE_S)
            if reader.is_alive():
                raise SandboxError("sandbox did not stop after being killed")
            break
    elapsed_ms = round((time.monotonic() - started) * 1000)
    if failure and not (timed_out or collector.exceeded):
        raise SandboxError("output stream failed") from failure[0]
    return StepResult(
        exit_code=process.exit_code(),
        elapsed_ms=elapsed_ms,
        timed_out=timed_out,
        output_exceeded=collector.exceeded,
    )


def classify(
    profile: LanguageProfile,
    step: StepResult,
    stats: MemoryStats | None,
    stderr: str,
) -> Status:
    # Order matters: a killed program also has a nonzero exit code, so the reason for the kill
    # has to be checked first.
    if step.output_exceeded:
        return Status.OUTPUT_LIMIT_EXCEEDED
    if step.timed_out:
        return Status.TIME_LIMIT_EXCEEDED
    if stats is not None and stats.oom_kills > 0:
        return Status.MEMORY_LIMIT_EXCEEDED
    if step.exit_code == 0:
        return Status.OK
    if any(marker in stderr for marker in profile.memory_error_markers):
        return Status.MEMORY_LIMIT_EXCEEDED
    # Without cgroup stats, as under gVisor, an unexplained SIGKILL is most likely the OOM
    # killer: the worker did not send it and a time limit did not trigger.
    if stats is None and step.exit_code == SIGKILL_EXIT:
        return Status.MEMORY_LIMIT_EXCEEDED
    return Status.RUNTIME_ERROR


def _input_files(request: RunRequest) -> dict[str, bytes]:
    files = {file.path: file.content.encode() for file in request.files}
    files[STDIN_FILE] = request.stdin.encode()
    return files


def _run(
    request: RunRequest,
    sandbox: Sandbox,
    limits: SandboxLimits,
    collector: OutputCollector,
) -> RunResult:
    profile = PROFILES[request.language]
    sandbox.write_files(_input_files(request))

    if profile.compile is not None:
        paths = [file.path for file in request.files]
        built = run_step(
            sandbox,
            profile.compile(paths),
            limits.compile_timeout_s,
            collector,
            compiling=True,
        )
        if built.exit_code != 0 or built.timed_out or built.output_exceeded:
            collector.finish()
            reason = "Compilation timed out" if built.timed_out else None
            return RunResult(
                execution_id=request.execution_id,
                status=Status.COMPILE_ERROR,
                exit_code=built.exit_code,
                compile_output=collector.text("compile"),
                time_ms=built.elapsed_ms,
                message=reason,
            )

    step = run_step(
        sandbox,
        profile.run(request.entry_path),
        limits.run_timeout_s,
        collector,
        stdin_file=f"{WORK_DIR}/{STDIN_FILE}",
    )
    collector.finish()
    # A killed container has no statistics left to read.
    stats = None if step.timed_out or step.output_exceeded else sandbox.memory_stats()
    stderr = collector.text("stderr")
    return RunResult(
        execution_id=request.execution_id,
        status=classify(profile, step, stats, stderr),
        exit_code=step.exit_code,
        stdout=collector.text("stdout"),
        stderr=stderr,
        compile_output=collector.text("compile"),
        time_ms=step.elapsed_ms,
        memory_kb=stats.peak_kb if stats else None,
    )


def execute(
    request: RunRequest,
    source: SandboxSource,
    events: EventSink,
    limits: SandboxLimits,
) -> RunResult:
    """Runs one request. Always returns a result, and always destroys the sandbox."""
    events.started(request)
    collector = OutputCollector(
        limits.output_bytes,
        lambda channel, data: events.output(request, channel, data),
    )
    sandbox: Sandbox | None = None
    try:
        sandbox = source.acquire(request.language)
        result = _run(request, sandbox, limits, collector)
    except SandboxError as error:
        # Never shown to users: the detail can describe the host.
        log.error("sandbox_failed", execution=str(request.execution_id), error=str(error))
        result = RunResult(
            execution_id=request.execution_id,
            status=Status.INTERNAL_ERROR,
            message="The run could not be completed. Try again.",
        )
    finally:
        if sandbox is not None:
            sandbox.destroy()
    events.finished(request, result)
    return result
