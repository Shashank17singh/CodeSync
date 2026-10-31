"""Measures the reviewer on 30 snippets with known bugs: python -m executor.review_eval

Recall is the share of known bugs found. Precision is the share of reported issues that match a
known bug. Each clean snippet checks for false alarms.

    python -m executor.review_eval            # analyzers only, free
    python -m executor.review_eval --llm      # with Claude, which costs money per run
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .llm import ClaudeClient, LLMClient
from .models import Language
from .review import Issue, ReviewMode, ReviewRequest, run_review
from .sandbox import MemoryStats, Sandbox, SandboxProcess


@dataclass(frozen=True)
class Snippet:
    name: str
    code: str
    bug_lines: tuple[int, ...]  # empty for a clean snippet


SNIPPETS: tuple[Snippet, ...] = (
    Snippet("undefined name", "def f():\n    return totl\n", (2,)),
    Snippet("mutable default", "def add(x, items=[]):\n    items.append(x)\n    return items\n", (1,)),
    Snippet("bare except", "try:\n    run()\nexcept:\n    pass\n", (3,)),
    Snippet("sql injection", 'def q(c, n):\n    c.execute("SELECT * FROM u WHERE n=\'" + n + "\'")\n', (2,)),
    Snippet("shell injection", "import os\ndef r(c):\n    os.system('ls ' + c)\n", (3,)),
    Snippet("eval input", "x = eval(input())\nprint(x)\n", (1,)),
    Snippet("pickle load", "import pickle\ndef l(b):\n    return pickle.loads(b)\n", (3,)),
    Snippet("hardcoded password", 'password = "hunter2"\nconnect(password)\n', (1,)),
    Snippet("assert tuple", 'def c(x):\n    assert (x > 0, "must be positive")\n', (2,)),
    Snippet("is literal", 'def c(x):\n    return x is "ok"\n', (2,)),
    Snippet("unused variable", "def f():\n    value = 3\n    return 1\n", (2,)),
    Snippet("duplicate key", 'd = {"a": 1, "a": 2}\nprint(d)\n', (1,)),
    Snippet("off by one", "def last(a):\n    return a[len(a)]\n", (2,)),
    Snippet("wrong operator", "def even(n):\n    return n % 2 == 1\n", (2,)),
    Snippet("infinite loop", "def c(n):\n    while n > 0:\n        print(n)\n", (2,)),
    Snippet("integer division", "def avg(a):\n    return sum(a) // len(a)\n", (2,)),
    Snippet("empty division", "def avg(a):\n    return sum(a) / len(a)\n", (2,)),
    Snippet("shadowed builtin bug", "list = [1]\nprint(list((2, 3)))\n", (2,)),
    Snippet("wrong loop bound", "def s(a):\n    t = 0\n    for i in range(len(a) - 1):\n        t += a[i]\n    return t\n", (3,)),
    Snippet("mutate while iterating", "def r(a):\n    for x in a:\n        if x < 0:\n            a.remove(x)\n", (4,)),
    Snippet("swapped arguments", "def power(b, e):\n    return e ** b\n", (2,)),
    Snippet("missing return", "def m(a, b):\n    if a > b:\n        return a\n", (3,)),
    Snippet("wrong comparison", "def is_adult(age):\n    return age > 18\n", (2,)),
    Snippet("float equality", "def z(a, b):\n    return a + b == 0.3\n", (2,)),
    Snippet("unclosed file", "def r(p):\n    f = open(p)\n    return f.read()\n", (2,)),
    Snippet("clean sum", "def total(values):\n    return sum(values)\n", ()),
    Snippet("clean max", "def biggest(values):\n    return max(values, default=None)\n", ()),
    Snippet("clean file", "def read(path):\n    with open(path) as handle:\n        return handle.read()\n", ()),
    Snippet("clean loop", "def evens(n):\n    return [i for i in range(n) if i % 2 == 0]\n", ()),
    Snippet("clean guard", "def ratio(a, b):\n    return a / b if b else 0.0\n", ()),
)


class _LocalProcess:
    def __init__(self, stdout: bytes, stderr: bytes, code: int) -> None:
        self._stdout = stdout
        self._stderr = stderr
        self._code = code

    def output(self):  # type: ignore[no-untyped-def]
        yield "stdout", self._stdout
        yield "stderr", self._stderr

    def exit_code(self) -> int:
        return self._code


class LocalAnalyzer:
    """Runs ruff and lizard directly on these fixed snippets, which are never executed."""

    def __init__(self) -> None:
        self._directory = tempfile.TemporaryDirectory(prefix="codesync-eval-")

    def create_analyzer(self) -> Sandbox:
        return self

    def write_files(self, files: Mapping[str, bytes]) -> None:
        for path, content in files.items():
            (Path(self._directory.name) / path).write_bytes(content)

    def start(self, argv: Sequence[str], stdin_file: str | None = None) -> SandboxProcess:
        command = [sys.executable if part == "python3" else part for part in argv]
        done = subprocess.run(  # noqa: S603
            command, cwd=self._directory.name, capture_output=True, check=False
        )
        return _LocalProcess(done.stdout, done.stderr, done.returncode)

    def memory_stats(self) -> MemoryStats | None:
        return None

    def kill(self) -> None:
        pass

    def destroy(self) -> None:
        pass


@dataclass(frozen=True)
class Score:
    true_positives: int
    false_positives: int
    false_negatives: int

    @property
    def recall(self) -> float:
        found = self.true_positives + self.false_negatives
        return self.true_positives / found if found else 0.0

    @property
    def precision(self) -> float:
        reported = self.true_positives + self.false_positives
        return self.true_positives / reported if reported else 0.0


def score(snippets: Sequence[Snippet], reported: Sequence[Sequence[Issue]]) -> Score:
    true_positives = false_positives = false_negatives = 0
    for snippet, issues in zip(snippets, reported, strict=True):
        found = {
            line
            for line in snippet.bug_lines
            if any(issue.line_start <= line <= issue.line_end for issue in issues)
        }
        true_positives += len(found)
        false_negatives += len(snippet.bug_lines) - len(found)
        false_positives += sum(
            not any(issue.line_start <= line <= issue.line_end for line in snippet.bug_lines)
            for issue in issues
        )
    return Score(true_positives, false_positives, false_negatives)


def main() -> None:
    llm: LLMClient | None = ClaudeClient() if "--llm" in sys.argv else None
    source = LocalAnalyzer()
    reported: list[tuple[Issue, ...]] = []
    for snippet in SNIPPETS:
        output = run_review(
            ReviewRequest(
                review_id=uuid4(),
                mode=ReviewMode.REVIEW,
                language=Language.PYTHON,
                code=snippet.code,
            ),
            source,
            llm,
        )
        reported.append(output.issues)
        hit = "found" if output.issues else "nothing"
        sys.stdout.write(f"{snippet.name:<26} bugs={len(snippet.bug_lines)} {hit}\n")
    result = score(SNIPPETS, reported)
    sys.stdout.write(
        f"\nsnippets={len(SNIPPETS)} recall={result.recall:.0%} precision={result.precision:.0%} "
        f"tp={result.true_positives} fp={result.false_positives} fn={result.false_negatives}\n"
    )


if __name__ == "__main__":
    main()
