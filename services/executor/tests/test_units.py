from __future__ import annotations

import io
import json
import re
import tarfile
import threading
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
import redis
from pydantic import ValidationError

from executor.docker_engine import DockerEngine, DockerSandbox, _tar, parse_memory_stats
from executor.events import BUS_SENDER_ID_BYTES, RedisEvents, events_channel
from executor.languages import BUILD_DIR, PROFILES
from executor.models import (
    MAX_FILES,
    Language,
    RunRequest,
    RunResult,
    SourceFile,
    Status,
    validate_path,
)
from executor.output import MAX_EVENT_CHARS, OutputChannel, OutputCollector
from executor.pool import SandboxPool
from executor.sandbox import MemoryStats, Sandbox, SandboxError
from executor.settings import SandboxLimits, Settings
from security.attacks import ATTACKS, Attack

IMAGES = Path(__file__).parent.parent / "images"


def request(**overrides: Any) -> RunRequest:
    values: dict[str, Any] = {
        "execution_id": uuid4(),
        "room_id": uuid4(),
        "user_id": uuid4(),
        "language": Language.PYTHON,
        "entry_path": "main.py",
        "files": [{"path": "main.py", "content": "x"}],
    }
    return RunRequest.model_validate(values | overrides)


class TestPaths:
    @pytest.mark.parametrize(
        "path",
        [
            "../evil",
            "a/../../evil",
            "/etc/passwd",
            "..\\evil",
            "C:/evil",
            "a//b",
            "./a",
            "a/.",
            "a\x00b",
            "a\nb",
            "",
        ],
    )
    def test_rejects(self, path: str) -> None:
        with pytest.raises(ValueError, match=r"."):
            validate_path(path)

    @pytest.mark.parametrize("path", ["main.py", "src/a.cpp", "dir with space/a.py", "नमस्ते.py"])
    def test_accepts(self, path: str) -> None:
        assert validate_path(path) == path


class TestRequests:
    def test_rejects_a_traversal_path_arriving_from_the_queue(self) -> None:
        with pytest.raises(ValidationError):
            request(entry_path="../main.py")
        with pytest.raises(ValidationError):
            request(files=[{"path": "../../etc/cron.d/x", "content": "x"}])

    def test_rejects_an_entry_that_is_not_a_file(self) -> None:
        with pytest.raises(ValidationError):
            request(entry_path="missing.py")

    def test_rejects_duplicates(self) -> None:
        duplicate = {"path": "main.py", "content": "x"}
        with pytest.raises(ValidationError):
            request(files=[duplicate, duplicate])

    def test_rejects_too_many_files(self) -> None:
        files = [{"path": f"f{i}.py", "content": ""} for i in range(MAX_FILES + 1)]
        with pytest.raises(ValidationError):
            request(files=files, entry_path="f0.py")

    def test_rejects_oversized_content(self) -> None:
        with pytest.raises(ValidationError):
            request(files=[{"path": "main.py", "content": "x" * (9 * 1024 * 1024)}])

    def test_rejects_unknown_fields(self) -> None:
        with pytest.raises(ValidationError):
            request(privileged=True)

    def test_rejects_unknown_languages(self) -> None:
        with pytest.raises(ValidationError):
            request(language="COBOL")


class TestLanguages:
    def test_compile_commands_use_argv_so_filenames_are_inert(self) -> None:
        compile_cpp = PROFILES[Language.CPP].compile
        assert compile_cpp is not None
        argv = compile_cpp(["a.cpp", "; rm -rf .cpp", "notes.txt"])
        assert "; rm -rf .cpp" in argv
        assert "notes.txt" not in argv

    def test_cpp_uses_o2(self) -> None:
        compile_cpp = PROFILES[Language.CPP].compile
        assert compile_cpp is not None
        assert "-O2" in compile_cpp(["a.cpp"])

    def test_java_runs_the_entry_class_and_caps_the_heap(self) -> None:
        argv = PROFILES[Language.JAVA].run("com/acme/App.java")
        assert argv[-1] == "com.acme.App"
        assert "-Xmx200m" in argv
        assert BUILD_DIR in argv

    def test_every_language_has_a_profile(self) -> None:
        assert set(PROFILES) == set(Language)


class TestImages:
    @pytest.mark.parametrize("name", ["python", "cpp", "java", "node"])
    def test_pinned_by_digest_and_not_root(self, name: str) -> None:
        text = (IMAGES / name / "Dockerfile").read_text(encoding="utf-8")
        assert re.search(r"^FROM \S+@sha256:[0-9a-f]{64}$", text, re.M)
        assert re.search(r"^USER 10001:10001$", text, re.M)
        assert "chmod a-s" in text

    def test_requested_versions(self) -> None:
        def read(name: str) -> str:
            return (IMAGES / name / "Dockerfile").read_text(encoding="utf-8")

        assert "python:3.12" in read("python")
        assert "g++=13." in read("cpp")
        assert "temurin:21" in read("java")
        assert "node:20" in read("node")


class TestMemoryStats:
    def test_parses_cgroup_v2(self) -> None:
        assert parse_memory_stats("10485760\noom_kill 2\n") == MemoryStats(10240, 2)

    def test_handles_no_kills(self) -> None:
        assert parse_memory_stats("2048\noom_kill 0\n") == MemoryStats(2, 0)

    def test_gives_nothing_when_the_files_are_missing(self) -> None:
        assert parse_memory_stats("") is None


class TestDockerSandbox:
    def test_tar_has_exact_regular_files(self) -> None:
        data = _tar({"src/a.py": b"x", ".stdin": b"in"})
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            members = {member.name: member for member in archive.getmembers()}
        assert set(members) == {"src/a.py", ".stdin"}
        assert all(member.isreg() for member in members.values())

    def test_passes_stdin_path_and_arguments_without_shell_parsing(self) -> None:
        recorded: dict[str, Any] = {}

        class Api:
            def exec_create(self, _id: str, command: list[str], **kwargs: Any) -> dict[str, str]:
                recorded.update(command=command, **kwargs)
                return {"Id": "exec"}

        sandbox = DockerSandbox(Api(), "container")
        sandbox.start(["prog", "$(evil)"], stdin_file="/tmp/work/.stdin")
        assert recorded["command"] == [
            "/bin/sh",
            "-c",
            'exec "$@" < "$0"',
            "/tmp/work/.stdin",
            "prog",
            "$(evil)",
        ]
        assert recorded["user"] == "10001:10001"

    def test_kills_the_whole_container_only_once(self) -> None:
        kills: list[str] = []

        class Api:
            def kill(self, container: str) -> None:
                kills.append(container)

        sandbox = DockerSandbox(Api(), "container")
        sandbox.kill()
        sandbox.kill()
        assert kills == ["container"]


class TestEngine:
    class Client:
        def __init__(self, runtimes: dict[str, Any]) -> None:
            self.runtimes = runtimes
            self.api = object()

        def info(self) -> dict[str, Any]:
            return {"Runtimes": self.runtimes}

    def test_uses_gvisor_when_installed(self) -> None:
        engine = DockerEngine(Settings(), self.Client({"runc": {}, "runsc": {}}))
        assert engine.gvisor is True

    def test_falls_back_when_gvisor_is_optional(self) -> None:
        assert DockerEngine(Settings(), self.Client({"runc": {}})).gvisor is False

    def test_refuses_to_start_when_gvisor_is_required_but_missing(self) -> None:
        with pytest.raises(SandboxError):
            DockerEngine(Settings(require_gvisor=True), self.Client({"runc": {}}))


class FakeSandbox:
    def __init__(self) -> None:
        self.destroyed = False

    def destroy(self) -> None:
        self.destroyed = True


class FakeEngine:
    def __init__(self) -> None:
        self.created: list[FakeSandbox] = []
        self.fail = False
        self.lock = threading.Lock()

    def create(self, language: Language) -> Sandbox:
        if self.fail:
            raise SandboxError("no image")
        sandbox = FakeSandbox()
        with self.lock:
            self.created.append(sandbox)
        return sandbox  # type: ignore[return-value]


def wait_for(condition: Any) -> None:
    deadline = time.monotonic() + 3
    while not condition():
        assert time.monotonic() < deadline
        time.sleep(0.005)


class TestPool:
    def test_warms_three_of_each_language(self) -> None:
        pool = SandboxPool(FakeEngine(), size=3, max_idle_s=60)
        pool.warm()
        for language in Language:
            wait_for(lambda lang=language: pool.idle_count(lang) == 3)
        pool.shutdown()

    def test_refills_after_each_use(self) -> None:
        engine = FakeEngine()
        pool = SandboxPool(engine, size=3, max_idle_s=60)
        pool.warm()
        wait_for(lambda: pool.idle_count(Language.CPP) == 3)
        first = pool.acquire(Language.CPP)
        wait_for(lambda: pool.idle_count(Language.CPP) == 3)
        assert pool.acquire(Language.CPP) is not first
        pool.shutdown()

    def test_never_hands_out_the_same_sandbox_twice(self) -> None:
        pool = SandboxPool(FakeEngine(), size=2, max_idle_s=60)
        pool.warm()
        wait_for(lambda: pool.idle_count(Language.PYTHON) == 2)
        taken = [pool.acquire(Language.PYTHON) for _ in range(20)]
        assert len({id(item) for item in taken}) == 20
        pool.shutdown()

    def test_creates_directly_when_the_pool_is_empty(self) -> None:
        pool = SandboxPool(FakeEngine(), size=0, max_idle_s=60)
        assert pool.acquire(Language.JAVA) is not None
        pool.shutdown()

    def test_discards_a_sandbox_that_sat_idle_too_long(self) -> None:
        now = [0.0]
        engine = FakeEngine()
        pool = SandboxPool(engine, size=1, max_idle_s=10, clock=lambda: now[0])
        pool.warm()
        wait_for(lambda: pool.idle_count(Language.JAVA) == 1)
        stale = pool._idle[Language.JAVA].queue[0].sandbox
        now[0] = 100
        assert pool.acquire(Language.JAVA) is not stale
        assert stale.destroyed
        pool.shutdown()

    def test_survives_a_failed_refill(self) -> None:
        engine = FakeEngine()
        engine.fail = True
        pool = SandboxPool(engine, size=2, max_idle_s=60)
        pool.warm()
        time.sleep(0.05)
        engine.fail = False
        assert pool.acquire(Language.PYTHON) is not None
        pool.shutdown()

    def test_destroys_idle_sandboxes_on_shutdown(self) -> None:
        engine = FakeEngine()
        pool = SandboxPool(engine, size=1, max_idle_s=60)
        pool.warm()
        for language in Language:
            wait_for(lambda lang=language: pool.idle_count(lang) == 1)
        pool.shutdown()
        assert engine.created
        assert all(sandbox.destroyed for sandbox in engine.created)


class TestOutputCollector:
    def emitted(self) -> tuple[OutputCollector, list[tuple[OutputChannel, str]]]:
        chunks: list[tuple[OutputChannel, str]] = []
        return OutputCollector(100, lambda c, d: chunks.append((c, d))), chunks

    def test_signals_when_the_cap_is_passed(self) -> None:
        collector, _ = self.emitted()
        assert collector.add("stdout", b"x" * 100) is True
        assert collector.add("stdout", b"x") is False
        assert collector.exceeded

    def test_keeps_exactly_the_cap(self) -> None:
        collector, _ = self.emitted()
        collector.add("stdout", b"x" * 500)
        collector.finish()
        assert len(collector.text("stdout")) == 100

    def test_does_not_split_a_character_across_chunks(self) -> None:
        collector, _ = self.emitted()
        data = "é".encode()
        collector.add("stdout", data[:1])
        collector.add("stdout", data[1:])
        collector.finish()
        assert collector.text("stdout") == "é"

    def test_limits_the_size_of_one_event(self) -> None:
        chunks: list[tuple[OutputChannel, str]] = []
        collector = OutputCollector(100_000, lambda c, d: chunks.append((c, d)))
        collector.add("stdout", b"x" * 30_000)
        collector.finish()
        assert all(len(data) <= MAX_EVENT_CHARS for _channel, data in chunks)
        assert sum(len(data) for _channel, data in chunks) == 30_000


class FakeRedis:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.messages: list[tuple[str, bytes]] = []

    def publish(self, channel: str, payload: bytes) -> int:
        if self.fail:
            raise redis.ConnectionError("down")
        self.messages.append((channel, payload))
        return 1


class TestRedisEvents:
    def decode(self, message: tuple[str, bytes]) -> dict[str, Any]:
        result: dict[str, Any] = json.loads(message[1][BUS_SENDER_ID_BYTES:])
        return result

    def test_publishes_to_the_room_with_the_shared_frame_format(self) -> None:
        client = FakeRedis()
        events = RedisEvents(client)  # type: ignore[arg-type]
        run = request()
        events.started(run)
        events.output(run, "stdout", "hi")
        events.output(run, "stderr", "oops")
        events.finished(
            run,
            RunResult(execution_id=run.execution_id, status=Status.OK, exit_code=0, time_ms=5),
        )
        assert {channel for channel, _ in client.messages} == {events_channel(str(run.room_id))}
        started, first, second, finished = [self.decode(item) for item in client.messages]
        assert started == {
            "type": "exec.started",
            "executionId": str(run.execution_id),
            "userId": str(run.user_id),
            "language": "PYTHON",
        }
        assert (first["seq"], second["seq"]) == (1, 2)
        assert first["data"] == "hi"
        assert second["stream"] == "stderr"
        assert finished == {
            "type": "exec.finished",
            "executionId": str(run.execution_id),
            "status": "OK",
            "exitCode": 0,
            "timeMs": 5,
            "memoryKb": None,
        }

    def test_a_redis_failure_does_not_fail_the_run(self) -> None:
        events = RedisEvents(FakeRedis(fail=True))  # type: ignore[arg-type]
        events.started(request())


def test_source_files_are_immutable() -> None:
    file = SourceFile(path="a.py", content="x")
    with pytest.raises(ValidationError):
        file.path = "../b"


class TestAttackSuiteCanFail:
    """The attack suite cannot run without Docker, so its own logic is checked here.

    Nothing is executed. This proves each program is valid and each check reports a breach, so the
    suite cannot pass simply because a check never fires.
    """

    @pytest.mark.parametrize("attack", ATTACKS, ids=lambda attack: attack.name)
    def test_python_programs_are_valid(self, attack: Attack) -> None:
        if attack.language is Language.PYTHON:
            compile(attack.source, attack.name, "exec")

    @pytest.mark.parametrize(
        ("name", "stdout", "status"),
        [
            ("read /etc/shadow", "SHADOW root:hash", Status.OK),
            ("network access", "CONNECTED 1.1.1.1 53\n", Status.OK),
            ("network access", "RESOLVED 93.184.216.34\n", Status.OK),
            ("root filesystem write", "WROTE_ROOTFS /etc/evil\n", Status.OK),
            ("/proc escape", "ESCAPED mount 0\nCapEff: 0\n", Status.OK),
            ("/proc escape", "CapEff: 00000000a80425fb\n", Status.OK),
            ("/proc escape", "UID 0\nCapEff: 0\n", Status.OK),
            ("/proc escape", "nothing reported\n", Status.OK),
            ("fork bomb", "FORKS 5000\n", Status.OK),
            ("large file", f"WROTE {1024 ** 3}\n", Status.OK),
            ("infinite loop", "", Status.OK),
            ("memory bomb", "", Status.OK),
            ("long sleep", "WOKE\n", Status.TIME_LIMIT_EXCEEDED),
            ("output flood", "", Status.OK),
        ],
    )
    def test_each_check_reports_a_breach(self, name: str, stdout: str, status: Status) -> None:
        attack = next(item for item in ATTACKS if item.name == name)
        breach = RunResult(execution_id=uuid4(), status=status, stdout=stdout, time_ms=100)
        assert attack.check(breach, SandboxLimits()) is not None

    def test_a_loop_that_outlives_the_limit_is_a_breach(self) -> None:
        attack = next(item for item in ATTACKS if item.name == "infinite loop")
        slow = RunResult(
            execution_id=uuid4(), status=Status.TIME_LIMIT_EXCEEDED, time_ms=60_000
        )
        assert attack.check(slow, SandboxLimits()) is not None

    @pytest.mark.parametrize(
        ("name", "stdout", "status"),
        [
            ("read /etc/shadow", "BLOCKED denied\n", Status.OK),
            ("/proc escape", "BLOCKED mount 1\nUID 10001\nCapEff: 0000000000000000\n", Status.OK),
            ("fork bomb", "FORKS 63\n", Status.OK),
            ("memory bomb", "", Status.MEMORY_LIMIT_EXCEEDED),
            ("output flood", "", Status.OUTPUT_LIMIT_EXCEEDED),
        ],
    )
    def test_each_check_accepts_containment(self, name: str, stdout: str, status: Status) -> None:
        attack = next(item for item in ATTACKS if item.name == name)
        contained = RunResult(execution_id=uuid4(), status=status, stdout=stdout, time_ms=100)
        assert attack.check(contained, SandboxLimits()) is None

    def test_covers_every_attack_the_spec_names(self) -> None:
        names = {attack.name for attack in ATTACKS}
        assert {
            "fork bomb",
            "infinite loop",
            "memory bomb",
            "large file",
            "network access",
            "read /etc/shadow",
            "/proc escape",
            "long sleep",
        } <= names
