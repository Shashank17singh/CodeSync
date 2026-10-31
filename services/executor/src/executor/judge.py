from __future__ import annotations

import base64
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .languages import PROFILES, STDIN_FILE, WORK_DIR, LanguageProfile
from .models import Language
from .output import OutputCollector
from .runner import SandboxSource, StepResult, run_step
from .sandbox import MemoryStats, Sandbox, SandboxError
from .settings import MIB, SandboxLimits

ENTRY_FILES = {
    Language.PYTHON: "main.py",
    Language.CPP: "main.cpp",
    Language.JAVA: "Main.java",
    Language.JAVASCRIPT: "main.js",
}
CHECKER_INPUT = "input.txt"
CHECKER_EXPECTED = "expected.txt"
CHECKER_OUTPUT = "output.txt"
CHECKER_TIMEOUT_S = 5.0
# A checker accepts with 0 and rejects with this. It cannot be 1, because any crashing program
# exits with 1, and a bug in a checker must never tell a student that their answer is wrong.
CHECKER_REJECT_EXIT = 42
# Larger than the interactive cap: expected outputs can be long, and nobody is watching this live.
JUDGE_OUTPUT_BYTES = 8 * MIB
SIGKILL_EXIT = 137


class Verdict(StrEnum):
    """Matches the Verdict enum in the Prisma schema."""

    ACCEPTED = "ACCEPTED"
    WRONG_ANSWER = "WRONG_ANSWER"
    TIME_LIMIT_EXCEEDED = "TIME_LIMIT_EXCEEDED"
    MEMORY_LIMIT_EXCEEDED = "MEMORY_LIMIT_EXCEEDED"
    RUNTIME_ERROR = "RUNTIME_ERROR"
    COMPILE_ERROR = "COMPILE_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class CheckerKind(StrEnum):
    EXACT = "EXACT"
    WHITESPACE = "WHITESPACE"
    CUSTOM = "CUSTOM"


class JudgeTest(BaseModel):
    model_config = ConfigDict(frozen=True)

    ordinal: int
    input: str  # base64, as test data may be any bytes
    output: str  # base64


class JudgePackage(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    submission_id: UUID
    language: Language
    source: str
    time_limit_ms: int = Field(gt=0, le=30_000)
    memory_limit_mb: int = Field(gt=0, le=256)
    checker_kind: CheckerKind = CheckerKind.EXACT
    checker_source: str | None = None
    checker_language: Language | None = None
    stop_on_first_failure: bool = True
    tests: tuple[JudgeTest, ...]


class TestResult(BaseModel):
    __test__ = False
    model_config = ConfigDict(frozen=True)

    ordinal: int
    verdict: Verdict
    time_ms: int | None = None
    memory_kb: int | None = None


class JudgeResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    submission_id: UUID
    verdict: Verdict
    failed_ordinal: int | None = None
    time_ms: int | None = None
    memory_kb: int | None = None
    compile_output: str = ""
    results: tuple[TestResult, ...] = ()


def _unix_lines(text: str) -> str:
    return "\n".join(text.splitlines()) + ("\n" if text.endswith(("\n", "\r")) else "")


def matches(kind: CheckerKind, output: str, expected: str) -> bool:
    if kind is CheckerKind.WHITESPACE:
        return output.split() == expected.split()
    # Test files are often uploaded from Windows, and CRLF must not fail a correct answer.
    return _unix_lines(output) == _unix_lines(expected)


def _decode(value: str) -> bytes:
    return base64.b64decode(value)


def _text(value: bytes) -> str:
    return value.decode("utf-8", "replace")


def memory_exceeded(
    stats: MemoryStats | None,
    peak_before_kb: int,
    limit_mb: int,
) -> bool:
    """Whether this test passed the limit.

    Tests share a container, and memory.peak only ever rises, so one heavy test would otherwise
    fail every test after it. A test is only blamed if it raised the peak past the limit.
    """
    if stats is None or stats.peak_kb is None:
        return False
    return stats.peak_kb > limit_mb * 1024 and stats.peak_kb > peak_before_kb


def _failure_verdict(
    profile: LanguageProfile,
    step: StepResult,
    stats: MemoryStats | None,
    oom_before: int,
    stderr: str,
) -> Verdict | None:
    if step.timed_out:
        return Verdict.TIME_LIMIT_EXCEEDED
    # Output past the cap cannot be right, and the verdicts have no separate status for it.
    if step.output_exceeded:
        return Verdict.WRONG_ANSWER
    if stats is not None and stats.oom_kills > oom_before:
        return Verdict.MEMORY_LIMIT_EXCEEDED
    if step.exit_code == 0:
        return None
    if any(marker in stderr for marker in profile.memory_error_markers):
        return Verdict.MEMORY_LIMIT_EXCEEDED
    if stats is None and step.exit_code == SIGKILL_EXIT:
        return Verdict.MEMORY_LIMIT_EXCEEDED
    return Verdict.RUNTIME_ERROR


class _Checker:
    """Runs a problem's checker in its own sandbox.

    It reads contestant output, which is hostile, and it must never share a sandbox with the
    contestant's program, which could otherwise replace it.
    """

    def __init__(self, package: JudgePackage, source: SandboxSource, limits: SandboxLimits) -> None:
        if package.checker_source is None or package.checker_language is None:
            raise SandboxError("custom checker has no source")
        self._profile = PROFILES[package.checker_language]
        self._entry = ENTRY_FILES[package.checker_language]
        self._limits = limits
        self._code = package.checker_source
        self._sandbox: Sandbox = source.acquire(package.checker_language)

    def prepare(self) -> None:
        self._sandbox.write_files({self._entry: self._code.encode()})
        if self._profile.compile is None:
            return
        collector = OutputCollector(self._limits.output_bytes, lambda _c, _d: None)
        built = run_step(
            self._sandbox,
            self._profile.compile([self._entry]),
            self._limits.compile_timeout_s,
            collector,
            compiling=True,
        )
        if built.exit_code != 0:
            raise SandboxError("checker did not compile")

    def accepts(self, test_input: bytes, expected: bytes, output: str) -> bool:
        self._sandbox.write_files(
            {
                CHECKER_INPUT: test_input,
                CHECKER_EXPECTED: expected,
                CHECKER_OUTPUT: output.encode(),
            }
        )
        collector = OutputCollector(self._limits.output_bytes, lambda _c, _d: None)
        step = run_step(
            self._sandbox,
            [*self._profile.run(self._entry), CHECKER_INPUT, CHECKER_EXPECTED, CHECKER_OUTPUT],
            CHECKER_TIMEOUT_S,
            collector,
        )
        if step.timed_out or step.exit_code not in (0, CHECKER_REJECT_EXIT):
            raise SandboxError("checker failed")
        return step.exit_code == 0

    def destroy(self) -> None:
        self._sandbox.destroy()


class _Program:
    """The contestant's compiled program, rebuilt if a kill takes its sandbox away."""

    def __init__(self, package: JudgePackage, source: SandboxSource, limits: SandboxLimits) -> None:
        self._package = package
        self._source = source
        self._limits = limits
        self._profile = PROFILES[package.language]
        self._entry = ENTRY_FILES[package.language]
        self._sandbox: Sandbox | None = None
        self.compile_output = ""

    def prepare(self) -> bool:
        self.destroy()
        self._sandbox = self._source.acquire(self._package.language)
        self._sandbox.write_files({self._entry: self._package.source.encode()})
        if self._profile.compile is None:
            return True
        collector = OutputCollector(self._limits.output_bytes, lambda _c, _d: None)
        built = run_step(
            self._sandbox,
            self._profile.compile([self._entry]),
            self._limits.compile_timeout_s,
            collector,
            compiling=True,
        )
        collector.finish()
        self.compile_output = collector.text("compile")
        return built.exit_code == 0 and not built.timed_out and not built.output_exceeded

    def run(self, test: JudgeTest, timeout_s: float) -> tuple[StepResult, str, str]:
        if self._sandbox is None:
            raise SandboxError("program is not prepared")
        # Only this test's input enters the sandbox. The expected output never does.
        self._sandbox.write_files({STDIN_FILE: _decode(test.input)})
        collector = OutputCollector(JUDGE_OUTPUT_BYTES, lambda _c, _d: None)
        step = run_step(
            self._sandbox,
            self._profile.run(self._entry),
            timeout_s,
            collector,
            stdin_file=f"{WORK_DIR}/{STDIN_FILE}",
        )
        collector.finish()
        return step, collector.text("stdout"), collector.text("stderr")

    def memory_stats(self) -> MemoryStats | None:
        return self._sandbox.memory_stats() if self._sandbox else None

    def destroy(self) -> None:
        if self._sandbox is not None:
            self._sandbox.destroy()
            self._sandbox = None


def judge(package: JudgePackage, source: SandboxSource, limits: SandboxLimits) -> JudgeResult:
    """Runs every test in order. Always returns a result and destroys its sandboxes."""
    program = _Program(package, source, limits)
    checker: _Checker | None = None
    try:
        if not program.prepare():
            return JudgeResult(
                submission_id=package.submission_id,
                verdict=Verdict.COMPILE_ERROR,
                compile_output=program.compile_output,
            )
        if package.checker_kind is CheckerKind.CUSTOM:
            checker = _Checker(package, source, limits)
            checker.prepare()
        return _run_tests(package, program, checker)
    except SandboxError:
        return JudgeResult(submission_id=package.submission_id, verdict=Verdict.INTERNAL_ERROR)
    finally:
        program.destroy()
        if checker is not None:
            checker.destroy()


def _run_tests(
    package: JudgePackage,
    program: _Program,
    checker: _Checker | None,
) -> JudgeResult:
    profile = PROFILES[package.language]
    timeout_s = package.time_limit_ms / 1000
    results: list[TestResult] = []
    peak_kb = 0
    oom_kills = 0

    for test in package.tests:
        step, output, stderr = program.run(test, timeout_s)
        killed = step.timed_out or step.output_exceeded
        # A killed sandbox has no statistics, and no later test can use it.
        stats = None if killed else program.memory_stats()
        verdict = _failure_verdict(profile, step, stats, oom_kills, stderr)
        if verdict is None and memory_exceeded(stats, peak_kb, package.memory_limit_mb):
            verdict = Verdict.MEMORY_LIMIT_EXCEEDED
        if verdict is None:
            expected = _decode(test.output)
            passed = (
                checker.accepts(_decode(test.input), expected, output)
                if checker
                else matches(package.checker_kind, output, _text(expected))
            )
            verdict = Verdict.ACCEPTED if passed else Verdict.WRONG_ANSWER

        results.append(
            TestResult(
                ordinal=test.ordinal,
                verdict=verdict,
                time_ms=step.elapsed_ms,
                memory_kb=stats.peak_kb if stats else None,
            )
        )
        if stats is not None:
            peak_kb = max(peak_kb, stats.peak_kb or 0)
            oom_kills = stats.oom_kills
        if verdict is not Verdict.ACCEPTED and package.stop_on_first_failure:
            break
        if killed and test is not package.tests[-1] and not program.prepare():
            raise SandboxError("program stopped compiling")
        if killed:
            peak_kb = 0
            oom_kills = 0

    failed = next((item for item in results if item.verdict is not Verdict.ACCEPTED), None)
    times = [item.time_ms for item in results if item.time_ms is not None]
    memories = [item.memory_kb for item in results if item.memory_kb is not None]
    return JudgeResult(
        submission_id=package.submission_id,
        verdict=failed.verdict if failed else Verdict.ACCEPTED,
        failed_ordinal=failed.ordinal if failed else None,
        time_ms=max(times, default=None),
        memory_kb=max(memories, default=None),
        compile_output=program.compile_output,
        results=tuple(results),
    )
