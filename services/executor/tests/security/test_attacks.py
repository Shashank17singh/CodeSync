"""Runs every attack in the real sandbox. Needs Docker and the sandbox images.

    sh build-images.sh
    pytest -m docker -s

Results go to sandbox-report.md, or to the file named by SANDBOX_REPORT. If Docker is missing
these tests are skipped, which proves nothing. Skipped does not mean contained.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import docker
import docker.errors
import pytest

from executor.docker_engine import DockerEngine
from executor.events import NullEvents
from executor.languages import PROFILES
from executor.models import Language, RunRequest, RunResult, SourceFile, Status
from executor.pool import SandboxPool
from executor.runner import execute
from executor.settings import Settings
from security.attacks import ATTACKS, Attack

pytestmark = pytest.mark.docker

SETTINGS = Settings(worker_id=f"security-suite-{uuid4().hex[:8]}")

# The worker holds these in production. Setting them here means a leak into sandboxes would fail
# the /proc attack, which looks for these names in the sandbox's environment.
for secret in ("INTERNAL_SERVICE_TOKEN", "REDIS_URL", "ANTHROPIC_API_KEY"):
    os.environ.setdefault(secret, "attack-suite-sentinel")
ENTRY_NAMES = {Language.PYTHON: "main.py", Language.CPP: "main.cpp"}
_results: list[tuple[Attack, RunResult, str | None]] = []


@pytest.fixture(scope="module")
def client() -> docker.DockerClient:
    try:
        connected = docker.from_env()
        connected.ping()
    except docker.errors.DockerException:
        pytest.skip("no Docker daemon: these attacks have NOT been verified")
    return connected


@pytest.fixture(scope="module")
def pool(client: docker.DockerClient) -> Iterator[SandboxPool]:
    engine = DockerEngine(SETTINGS, client)
    sandbox_pool = SandboxPool(engine, size=0, max_idle_s=600)
    yield sandbox_pool
    sandbox_pool.shutdown()
    engine.reap_orphans()
    write_report(engine.gvisor)


def write_report(gvisor: bool) -> None:
    runtime = "gVisor (runsc)" if gvisor else "runc"
    lines = [
        "# Sandbox security results",
        "",
        f"Runtime: {runtime}",
        "",
        "| Attack | Goal | Status | Time (ms) | Contained |",
        "| --- | --- | --- | --- | --- |",
    ]
    for attack, result, problem in _results:
        contained = "Yes" if problem is None else f"**NO**: {problem}"
        lines.append(
            f"| {attack.name} | {attack.goal} | {result.status.value} "
            f"| {result.time_ms} | {contained} |"
        )
    target = Path(os.environ.get("SANDBOX_REPORT", "sandbox-report.md"))
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def attack_request(attack: Attack) -> RunRequest:
    entry = ENTRY_NAMES[attack.language]
    return RunRequest(
        execution_id=uuid4(),
        room_id=uuid4(),
        user_id=uuid4(),
        language=attack.language,
        entry_path=entry,
        files=(SourceFile(path=entry, content=attack.source),),
    )


@pytest.mark.parametrize("attack", ATTACKS, ids=lambda attack: attack.name)
def test_attack_is_contained(
    attack: Attack, pool: SandboxPool, client: docker.DockerClient
) -> None:
    result = execute(attack_request(attack), pool, NullEvents(), SETTINGS.limits)
    problem = attack.check(result, SETTINGS.limits)
    _results.append((attack, result, problem))
    print(f"\n{attack.name}: {result.status} in {result.time_ms} ms")
    print(result.stdout[:800])
    assert problem is None, result.stdout[:2000]

    # Destroying the sandbox is part of containment.
    leftovers = client.api.containers(
        all=True, filters={"label": f"codesync.worker={SETTINGS.worker_id}"}
    )
    assert leftovers == []


@pytest.mark.parametrize(
    ("language", "entry", "source", "expected"),
    [
        (Language.PYTHON, "main.py", 'print("hello")', "hello"),
        (
            Language.CPP,
            "main.cpp",
            '#include <iostream>\nint main(){std::cout<<"hello";}',
            "hello",
        ),
        (
            Language.JAVA,
            "Main.java",
            'public class Main{public static void main(String[] a){System.out.print("hello");}}',
            "hello",
        ),
        (Language.JAVASCRIPT, "main.js", 'console.log("hello")', "hello"),
    ],
)
def test_ordinary_programs_still_work(
    language: Language, entry: str, source: str, expected: str, pool: SandboxPool
) -> None:
    """A sandbox too tight to run real programs would pass every attack above."""
    request = RunRequest(
        execution_id=uuid4(),
        room_id=uuid4(),
        user_id=uuid4(),
        language=language,
        entry_path=entry,
        files=(SourceFile(path=entry, content=source),),
    )
    result = execute(request, pool, NullEvents(), SETTINGS.limits)
    assert result.status is Status.OK, result.model_dump_json()
    assert expected in result.stdout
    assert PROFILES[language] is not None


def test_a_compile_error_is_reported_with_its_output(pool: SandboxPool) -> None:
    request = RunRequest(
        execution_id=uuid4(),
        room_id=uuid4(),
        user_id=uuid4(),
        language=Language.CPP,
        entry_path="main.cpp",
        files=(SourceFile(path="main.cpp", content="int main( {"),),
    )
    result = execute(request, pool, NullEvents(), SETTINGS.limits)
    assert result.status is Status.COMPILE_ERROR
    assert "error" in result.compile_output
