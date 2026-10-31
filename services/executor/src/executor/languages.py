from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath

from .models import Language

WORK_DIR = "/tmp/work"  # noqa: S108
BUILD_DIR = "/tmp/build"  # noqa: S108
STDIN_FILE = ".stdin"

Argv = list[str]


def _files_ending(paths: Sequence[str], suffix: str) -> Argv:
    return [path for path in paths if path.endswith(suffix)]


@dataclass(frozen=True)
class LanguageProfile:
    image: str
    # Text in stderr that means the runtime hit its heap limit, for runtimes that report it
    # themselves and exit normally, so the cgroup never records an out-of-memory kill.
    memory_error_markers: tuple[str, ...]
    compile: Callable[[Sequence[str]], Argv] | None
    run: Callable[[str], Argv]


def _java_class(entry: str) -> str:
    return ".".join(PurePosixPath(entry).with_suffix("").parts)


# Commands are argv lists and never pass through a shell, so a file named `; rm -rf /` is only a
# strange file name.
PROFILES: dict[Language, LanguageProfile] = {
    Language.PYTHON: LanguageProfile(
        image="python",
        # The newline stops this matching inside java.lang.OutOfMemoryError.
        memory_error_markers=("\nMemoryError",),
        compile=None,
        run=lambda entry: ["python3", "-B", entry],
    ),
    Language.CPP: LanguageProfile(
        image="cpp",
        memory_error_markers=("std::bad_alloc",),
        compile=lambda paths: [
            "g++",
            "-std=c++20",
            "-O2",
            "-o",
            f"{BUILD_DIR}/program",
            *_files_ending(paths, ".cpp"),
        ],
        run=lambda _entry: [f"{BUILD_DIR}/program"],
    ),
    Language.JAVA: LanguageProfile(
        image="java",
        memory_error_markers=("java.lang.OutOfMemoryError",),
        compile=lambda paths: ["javac", "-d", BUILD_DIR, *_files_ending(paths, ".java")],
        run=lambda entry: [
            "java",
            # The heap stays below the container limit, so a large program gets a clean
            # OutOfMemoryError instead of a kill. PerfData would write to /tmp for no benefit.
            "-Xmx200m",
            "-XX:+UseSerialGC",
            "-XX:-UsePerfData",
            "-cp",
            BUILD_DIR,
            _java_class(entry),
        ],
    ),
    Language.JAVASCRIPT: LanguageProfile(
        image="node",
        memory_error_markers=("JavaScript heap out of memory",),
        compile=None,
        run=lambda entry: ["node", "--max-old-space-size=200", entry],
    ),
}
