"""Five sample problems judged through real local processes, using harmless programs only."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from uuid import uuid4

import pytest

from executor.judge import (
    CheckerKind,
    JudgePackage,
    JudgeResult,
    JudgeTest,
    Verdict,
    judge,
    matches,
    memory_exceeded,
)
from executor.models import Language
from executor.sandbox import MemoryStats
from executor.settings import SandboxLimits
from local_engine import LocalSource

LIMITS = SandboxLimits()


def encode(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


@dataclass(frozen=True)
class Problem:
    name: str
    tests: tuple[tuple[str, str], ...]
    checker_kind: CheckerKind = CheckerKind.EXACT
    checker_source: str | None = None
    time_limit_ms: int = 2000


SUM = Problem("sum of two", (("1 2\n", "3\n"), ("10 20\n", "30\n"), ("-5 5\n", "0\n")))

REVERSE = Problem("reverse a line", (("hello\n", "olleh\n"), ("ab\n", "ba\n")))

FIZZBUZZ = Problem(
    "fizzbuzz",
    (("5\n", "1\n2\nFizz\n4\nBuzz\n"), ("3\n", "1 2 Fizz\n")),
    checker_kind=CheckerKind.WHITESPACE,
)

MAX_VALUE = Problem("largest number", (("3\n1 5 2\n", "5\n"), ("1\n7\n", "7\n")))

ANY_PAIR_CHECKER = """
import sys
numbers = open(sys.argv[1]).read().split()
target = int(numbers[1])
values = list(map(int, numbers[2:]))
try:
    i, j = map(int, open(sys.argv[3]).read().split())
except ValueError:
    sys.exit(42)
valid = 0 <= i < len(values) and 0 <= j < len(values) and i != j
sys.exit(0 if valid and values[i] + values[j] == target else 42)
"""

# Several pairs are correct, which an exact comparison could not accept.
ANY_PAIR = Problem(
    "any pair with the target sum",
    (("4 6\n1 5 2 4\n", "0 1\n"),),
    checker_kind=CheckerKind.CUSTOM,
    checker_source=ANY_PAIR_CHECKER,
)


def package(
    problem: Problem,
    source: str,
    *,
    stop_on_first_failure: bool = True,
    memory_limit_mb: int = 256,
) -> JudgePackage:
    return JudgePackage(
        submission_id=uuid4(),
        language=Language.PYTHON,
        source=source,
        time_limit_ms=problem.time_limit_ms,
        memory_limit_mb=memory_limit_mb,
        checker_kind=problem.checker_kind,
        checker_source=problem.checker_source,
        checker_language=Language.PYTHON if problem.checker_source else None,
        stop_on_first_failure=stop_on_first_failure,
        tests=tuple(
            JudgeTest(ordinal=index + 1, input=encode(given), output=encode(expected))
            for index, (given, expected) in enumerate(problem.tests)
        ),
    )


def run(problem: Problem, source: str, **options: bool) -> JudgeResult:
    return judge(package(problem, source, **options), LocalSource(), LIMITS)


SOLUTIONS = [
    (SUM, "a, b = map(int, input().split())\nprint(a + b)"),
    (REVERSE, "print(input()[::-1])"),
    (
        FIZZBUZZ,
        "n = int(input())\n"
        "for i in range(1, n + 1):\n"
        "    print('Fizz' if i % 3 == 0 else 'Buzz' if i % 5 == 0 else i)",
    ),
    (MAX_VALUE, "input()\nprint(max(map(int, input().split())))"),
    (
        ANY_PAIR,
        "n, target = map(int, input().split())\n"
        "values = list(map(int, input().split()))\n"
        "for i in range(n):\n"
        "    for j in range(i + 1, n):\n"
        "        if values[i] + values[j] == target:\n"
        "            print(i, j)\n"
        "            raise SystemExit",
    ),
]


@pytest.mark.parametrize(
    ("problem", "source"), SOLUTIONS, ids=lambda item: getattr(item, "name", "")
)
def test_accepts_correct_solutions(problem: Problem, source: str) -> None:
    result = run(problem, source)
    assert result.verdict is Verdict.ACCEPTED, result
    assert len(result.results) == len(problem.tests)
    assert result.failed_ordinal is None


def test_reports_wrong_answer_on_the_failing_test() -> None:
    result = run(SUM, "a, b = map(int, input().split())\nprint(a + b if a > 0 else 99)")
    assert result.verdict is Verdict.WRONG_ANSWER
    assert result.failed_ordinal == 3


def test_stops_at_the_first_failure_by_default() -> None:
    result = run(SUM, "print(0)")
    assert result.failed_ordinal == 1
    assert len(result.results) == 1


def test_can_run_every_test_after_a_failure() -> None:
    result = run(SUM, "print(0)", stop_on_first_failure=False)
    assert [item.ordinal for item in result.results] == [1, 2, 3]
    assert result.failed_ordinal == 1
    assert result.results[2].verdict is Verdict.ACCEPTED


def test_reports_time_limit_with_the_test_number() -> None:
    result = judge(
        package(
            Problem("slow", (("1\n", "1\n"), ("2\n", "2\n")), time_limit_ms=300),
            "while True: pass",
        ),
        LocalSource(),
        LIMITS,
    )
    assert result.verdict is Verdict.TIME_LIMIT_EXCEEDED
    assert result.failed_ordinal == 1


def test_continues_after_a_kill_when_running_every_test() -> None:
    problem = Problem("mixed", (("slow\n", "slow\n"), ("fast\n", "fast\n")), time_limit_ms=400)
    source = "text = input()\nwhile text == 'slow': pass\nprint(text)"
    result = judge(package(problem, source, stop_on_first_failure=False), LocalSource(), LIMITS)
    assert [item.verdict for item in result.results] == [
        Verdict.TIME_LIMIT_EXCEEDED,
        Verdict.ACCEPTED,
    ]


def test_reports_runtime_error() -> None:
    result = run(SUM, "raise ValueError('boom')")
    assert result.verdict is Verdict.RUNTIME_ERROR
    assert result.failed_ordinal == 1


def test_reports_a_memory_error_from_the_runtime() -> None:
    assert run(SUM, "raise MemoryError").verdict is Verdict.MEMORY_LIMIT_EXCEEDED


def test_rejects_a_wrong_answer_through_the_custom_checker() -> None:
    result = run(ANY_PAIR, "print(0, 0)")
    assert result.verdict is Verdict.WRONG_ANSWER


def test_accepts_a_different_valid_answer_through_the_custom_checker() -> None:
    assert run(ANY_PAIR, "print(0, 1)").verdict is Verdict.ACCEPTED
    assert run(ANY_PAIR, "print(2, 3)").verdict is Verdict.ACCEPTED


def test_a_broken_checker_is_an_internal_error_never_a_verdict_for_the_student() -> None:
    broken = Problem(
        "broken",
        (("1\n", "1\n"),),
        checker_kind=CheckerKind.CUSTOM,
        checker_source="raise RuntimeError('checker bug')",
    )
    assert run(broken, "print(1)").verdict is Verdict.INTERNAL_ERROR


def test_the_expected_output_never_enters_the_program_sandbox() -> None:
    source = LocalSource()
    written: list[str] = []

    class Spy(LocalSource):
        def acquire(self, language: Language):  # type: ignore[no-untyped-def]
            sandbox = source.acquire(language)
            original = sandbox.write_files

            def record(files):  # type: ignore[no-untyped-def]
                written.extend(content.decode("utf-8", "replace") for content in files.values())
                original(files)

            sandbox.write_files = record  # type: ignore[method-assign]
            return sandbox

    problem = Problem("secret", (("in\n", "THE-SECRET-ANSWER\n"),))
    judge(package(problem, "print('x')"), Spy(), LIMITS)
    assert not any("THE-SECRET-ANSWER" in item for item in written)


def test_destroys_every_sandbox() -> None:
    source = LocalSource()
    judge(package(ANY_PAIR, "print(0, 1)"), source, LIMITS)
    assert len(source.sandboxes) == 2
    assert all(sandbox.destroyed for sandbox in source.sandboxes)


class TestCheckers:
    def test_exact_compares_every_character(self) -> None:
        assert matches(CheckerKind.EXACT, "1 2\n", "1 2\n")
        assert not matches(CheckerKind.EXACT, "1 2", "1 2\n")
        assert not matches(CheckerKind.EXACT, "1  2\n", "1 2\n")

    def test_exact_ignores_windows_line_endings(self) -> None:
        assert matches(CheckerKind.EXACT, "1\n2\n", "1\r\n2\r\n")

    def test_whitespace_compares_tokens(self) -> None:
        assert matches(CheckerKind.WHITESPACE, "1\n2  3\n\n", "1 2 3")
        assert not matches(CheckerKind.WHITESPACE, "1 2", "1 2 3")
        assert not matches(CheckerKind.WHITESPACE, "12", "1 2")


class TestMemoryLimit:
    LIMIT_KB = 64 * 1024

    def test_blames_the_test_that_raised_the_peak(self) -> None:
        assert memory_exceeded(MemoryStats(self.LIMIT_KB + 1, 0), 0, 64)

    def test_does_not_blame_a_later_test_for_an_earlier_peak(self) -> None:
        peak = self.LIMIT_KB + 1000
        assert not memory_exceeded(MemoryStats(peak, 0), peak, 64)

    def test_allows_memory_within_the_limit(self) -> None:
        assert not memory_exceeded(MemoryStats(self.LIMIT_KB - 1, 0), 0, 64)

    def test_gives_no_verdict_without_measurements(self) -> None:
        assert not memory_exceeded(None, 0, 64)
        assert not memory_exceeded(MemoryStats(None, 0), 0, 64)
