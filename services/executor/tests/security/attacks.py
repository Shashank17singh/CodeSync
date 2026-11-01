"""Hostile programs for the sandbox security suite.

These must only ever run inside the real sandbox. Each one prints what it managed to do, and a
check decides whether that counts as contained.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from executor.models import Language, RunResult, Status
from executor.settings import SandboxLimits

Check = Callable[[RunResult, SandboxLimits], str | None]


@dataclass(frozen=True)
class Attack:
    name: str
    goal: str
    language: Language
    source: str
    check: Check


def expects(*statuses: Status) -> Check:
    def check(result: RunResult, _limits: SandboxLimits) -> str | None:
        return None if result.status in statuses else f"status was {result.status}"

    return check


def all_of(*checks: Check) -> Check:
    def check(result: RunResult, limits: SandboxLimits) -> str | None:
        for item in checks:
            if (problem := item(result, limits)) is not None:
                return problem
        return None

    return check


def never_prints(*markers: str) -> Check:
    def check(result: RunResult, _limits: SandboxLimits) -> str | None:
        for marker in markers:
            if marker in result.stdout:
                return f"output contains {marker!r}"
        return None

    return check


def stopped_near_limit(result: RunResult, limits: SandboxLimits) -> str | None:
    allowed_ms = (limits.run_timeout_s + 2) * 1000
    if result.time_ms is None or result.time_ms > allowed_ms:
        return f"took {result.time_ms} ms"
    return None


def fewer_forks_than_the_limit(result: RunResult, limits: SandboxLimits) -> str | None:
    for line in result.stdout.splitlines():
        if line.startswith("FORKS "):
            forks = int(line.split()[1])
            return None if forks < limits.pids else f"made {forks} processes"
    # Killed before reporting, which is also contained, provided the status says why.
    return None


def wrote_at_most_tmpfs(result: RunResult, limits: SandboxLimits) -> str | None:
    for line in result.stdout.splitlines():
        if line.startswith("WROTE "):
            written = int(line.split()[1])
            return None if written <= limits.tmpfs_bytes else f"wrote {written} bytes"
    return None


FORK_BOMB = """
import os, time
count = 0
try:
    while True:
        if os.fork() == 0:
            time.sleep(30)
            os._exit(0)
        count += 1
except OSError as error:
    print("FORKS", count, flush=True)
    print("BLOCKED", error, flush=True)
"""

SHELL_FORK_BOMB = """
import subprocess
result = subprocess.run(["/bin/sh", "-c", ":(){ :|:& };:; sleep 30"], capture_output=True)
print("EXIT", result.returncode)
"""

INFINITE_LOOP = "while True:\n    pass\n"

MEMORY_BOMB = """
blocks = []
while True:
    blocks.append(bytearray(10 * 1024 * 1024))
    for offset in range(0, len(blocks[-1]), 4096):
        blocks[-1][offset] = 1
"""

CPP_MEMORY_BOMB = """
#include <cstring>
#include <cstdlib>
int main() {
    while (true) {
        char* block = static_cast<char*>(malloc(10 * 1024 * 1024));
        if (block) memset(block, 1, 10 * 1024 * 1024);
    }
}
"""

LARGE_FILE = """
written = 0
try:
    with open("/tmp/fill", "wb", buffering=0) as handle:
        while True:
            written += handle.write(b"x" * (1024 * 1024))
except OSError as error:
    print("WROTE", written, flush=True)
    print("BLOCKED", error, flush=True)
"""

ROOT_FILESYSTEM_WRITE = """
for path in ("/etc/evil", "/usr/bin/python3", "/bin/sh", "/root/x"):
    try:
        open(path, "ab").close()
        print("WROTE_ROOTFS", path)
    except OSError as error:
        print("BLOCKED", path, error)
"""

NETWORK = """
import socket, threading
targets = (("1.1.1.1", 53), ("8.8.8.8", 443), ("169.254.169.254", 80), ("172.17.0.1", 2375))
for host, port in targets:
    try:
        with socket.create_connection((host, port), timeout=1):
            print("CONNECTED", host, port, flush=True)
    except OSError as error:
        print("BLOCKED", host, error, flush=True)

# A lookup with no network can retry for longer than the run limit, and it cannot be timed out
# directly. Either way, a lookup that succeeds at any point in this window is reported.
def lookup():
    try:
        print("RESOLVED", socket.gethostbyname("example.com"), flush=True)
    except OSError as error:
        print("BLOCKED dns", error, flush=True)

thread = threading.Thread(target=lookup, daemon=True)
thread.start()
thread.join(2)
if thread.is_alive():
    print("BLOCKED dns still unanswered", flush=True)
"""

READ_SHADOW = """
try:
    print("SHADOW", open("/etc/shadow").read())
except OSError as error:
    print("BLOCKED", error)
"""

PROC_ESCAPE = """
import ctypes, os
def attempt(name, action):
    try:
        print("ESCAPED", name, action())
    except OSError as error:
        print("BLOCKED", name, error)

attempt("host root through /proc/1/root", lambda: os.listdir("/proc/1/root/root"))

# PID 1 here is the sandbox's own process, so reading it is allowed. Holding a worker secret is not.
def worker_secrets():
    environment = open("/proc/1/environ", "rb").read()
    names = (b"INTERNAL_SERVICE_TOKEN", b"REDIS_URL", b"ANTHROPIC_API_KEY")
    found = [name for name in names if name in environment]
    if not found:
        raise OSError("no worker secrets in the init environment")
    return found

attempt("init environment", worker_secrets)
attempt("kernel sysrq", lambda: open("/proc/sysrq-trigger", "w").write("h"))
attempt("kernel core pattern", lambda: open("/proc/sys/kernel/core_pattern", "w").write("|/x"))
attempt("kernel hostname", lambda: open("/proc/sys/kernel/hostname", "w").write("evil"))
attempt("kernel memory", lambda: open("/proc/kcore", "rb").read(16))
attempt("cgroup release agent", lambda: open("/sys/fs/cgroup/release_agent", "w").write("/x"))
attempt("docker socket", lambda: os.stat("/var/run/docker.sock"))

libc = ctypes.CDLL(None, use_errno=True)
CLONE_NEWUSER = 0x10000000
for name, call in (
    ("mount", lambda: libc.mount(b"none", b"/tmp", b"tmpfs", 0, None)),
    ("unshare user namespace", lambda: libc.unshare(CLONE_NEWUSER)),
    ("setuid root", lambda: libc.setuid(0)),
):
    result = call()
    print("ESCAPED" if result == 0 else "BLOCKED", name, ctypes.get_errno())

status = open("/proc/self/status").read()
print("UID", os.getuid())
print(next(line for line in status.splitlines() if line.startswith("CapEff")))
"""

LONG_SLEEP = "import time\ntime.sleep(60)\nprint('WOKE')\n"

OUTPUT_FLOOD = "while True:\n    print('x' * 1024, flush=True)\n"


def zero_capabilities(result: RunResult, _limits: SandboxLimits) -> str | None:
    for line in result.stdout.splitlines():
        if line.startswith("CapEff"):
            value = int(line.split()[1], 16)
            return None if value == 0 else f"effective capabilities {value:x}"
    return "did not report capabilities"


def not_root(result: RunResult, _limits: SandboxLimits) -> str | None:
    return "ran as root" if "UID 0" in result.stdout else None


ATTACKS: tuple[Attack, ...] = (
    Attack(
        "fork bomb",
        "Create processes until the host runs out",
        Language.PYTHON,
        FORK_BOMB,
        all_of(
            expects(Status.OK, Status.TIME_LIMIT_EXCEEDED, Status.RUNTIME_ERROR),
            fewer_forks_than_the_limit,
        ),
    ),
    Attack(
        "shell fork bomb",
        "Classic :(){ :|:& };: bomb",
        Language.PYTHON,
        SHELL_FORK_BOMB,
        expects(Status.OK, Status.TIME_LIMIT_EXCEEDED, Status.RUNTIME_ERROR),
    ),
    Attack(
        "infinite loop",
        "Hold a CPU forever",
        Language.PYTHON,
        INFINITE_LOOP,
        all_of(expects(Status.TIME_LIMIT_EXCEEDED), stopped_near_limit),
    ),
    Attack(
        "memory bomb",
        "Allocate until the host runs out",
        Language.PYTHON,
        MEMORY_BOMB,
        expects(Status.MEMORY_LIMIT_EXCEEDED),
    ),
    Attack(
        "memory bomb in C++",
        "Allocate from native code",
        Language.CPP,
        CPP_MEMORY_BOMB,
        expects(Status.MEMORY_LIMIT_EXCEEDED),
    ),
    Attack(
        "large file",
        "Fill the disk",
        Language.PYTHON,
        LARGE_FILE,
        all_of(
            expects(Status.OK, Status.RUNTIME_ERROR, Status.MEMORY_LIMIT_EXCEEDED),
            wrote_at_most_tmpfs,
        ),
    ),
    Attack(
        "root filesystem write",
        "Change files outside /tmp",
        Language.PYTHON,
        ROOT_FILESYSTEM_WRITE,
        all_of(expects(Status.OK), never_prints("WROTE_ROOTFS")),
    ),
    Attack(
        "network access",
        "Reach the internet, cloud metadata or the Docker bridge",
        Language.PYTHON,
        NETWORK,
        all_of(expects(Status.OK), never_prints("CONNECTED", "RESOLVED")),
    ),
    Attack(
        "read /etc/shadow",
        "Read password hashes",
        Language.PYTHON,
        READ_SHADOW,
        all_of(expects(Status.OK), never_prints("SHADOW")),
    ),
    Attack(
        "/proc escape",
        "Reach the host through /proc, /sys, mount, namespaces or setuid",
        Language.PYTHON,
        PROC_ESCAPE,
        all_of(expects(Status.OK), never_prints("ESCAPED"), zero_capabilities, not_root),
    ),
    Attack(
        "long sleep",
        "Hold a sandbox past the time limit",
        Language.PYTHON,
        LONG_SLEEP,
        all_of(
            expects(Status.TIME_LIMIT_EXCEEDED),
            stopped_near_limit,
            never_prints("WOKE"),
        ),
    ),
    Attack(
        "output flood",
        "Exhaust worker memory with output",
        Language.PYTHON,
        OUTPUT_FLOOD,
        expects(Status.OUTPUT_LIMIT_EXCEEDED),
    ),
)
