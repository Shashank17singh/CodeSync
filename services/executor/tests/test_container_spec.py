"""Checks the isolation settings through the real Docker SDK, with no daemon needed.

The SDK turns these keyword arguments into the JSON sent to Docker, so asserting on that JSON tests
what Docker would receive, including that every argument name is one the SDK accepts.
"""

from __future__ import annotations

from typing import Any

import docker
import pytest

from executor.container_spec import SANDBOX_ENV, SANDBOX_USER, container_spec
from executor.models import Language
from executor.settings import MIB, SandboxLimits, Settings

API_VERSION = "1.47"


@pytest.fixture
def api() -> docker.APIClient:
    # An explicit version means the client never contacts a daemon.
    return docker.APIClient(base_url="tcp://127.0.0.1:1", version=API_VERSION)


def host_json(api: docker.APIClient, gvisor: bool = False) -> dict[str, Any]:
    spec = container_spec(
        language=Language.PYTHON, image="image", settings=Settings(), gvisor=gvisor
    )
    config: dict[str, Any] = api.create_host_config(**spec.host)
    return config


def create_json(api: docker.APIClient) -> dict[str, Any]:
    spec = container_spec(
        language=Language.PYTHON, image="image", settings=Settings(), gvisor=False
    )
    config: dict[str, Any] = api.create_container_config(**spec.create)
    return config


def test_has_no_network(api: docker.APIClient) -> None:
    assert host_json(api)["NetworkMode"] == "none"
    assert create_json(api)["NetworkDisabled"] is True


def test_root_filesystem_is_read_only(api: docker.APIClient) -> None:
    assert host_json(api)["ReadonlyRootfs"] is True


def test_tmp_is_a_small_tmpfs_without_setuid_or_devices(api: docker.APIClient) -> None:
    options = host_json(api)["Tmpfs"]["/tmp"].split(",")
    assert f"size={64 * MIB}" in options
    assert "nosuid" in options
    assert "nodev" in options
    # Compiled programs run from /tmp, and Docker's default for --tmpfs is noexec.
    assert "exec" in options


def test_runs_as_a_non_root_user(api: docker.APIClient) -> None:
    assert create_json(api)["User"] == SANDBOX_USER
    assert not SANDBOX_USER.startswith("0")


def test_drops_every_capability_and_adds_none(api: docker.APIClient) -> None:
    host = host_json(api)
    assert host["CapDrop"] == ["ALL"]
    assert "CapAdd" not in host


def test_cannot_gain_privileges(api: docker.APIClient) -> None:
    assert "no-new-privileges:true" in host_json(api)["SecurityOpt"]


def test_keeps_the_default_seccomp_profile(api: docker.APIClient) -> None:
    assert not any("seccomp" in option for option in host_json(api)["SecurityOpt"])


def test_limits_processes_memory_and_cpu(api: docker.APIClient) -> None:
    host = host_json(api)
    assert host["PidsLimit"] == 64
    assert host["Memory"] == 256 * MIB
    assert host["NanoCpus"] == 1_000_000_000


def test_allows_no_swap(api: docker.APIClient) -> None:
    host = host_json(api)
    assert host["MemorySwap"] == host["Memory"]
    assert host["MemorySwappiness"] == 0


def test_is_not_privileged_and_mounts_nothing(api: docker.APIClient) -> None:
    host = host_json(api)
    assert not host.get("Privileged")
    assert not host.get("Binds")
    assert not host.get("Mounts")
    assert not host.get("Devices")
    assert "PortBindings" not in host


def test_shares_no_namespace_with_the_host(api: docker.APIClient) -> None:
    host = host_json(api)
    assert "PidMode" not in host
    assert "UTSMode" not in host
    assert "UsernsMode" not in host
    assert host["IpcMode"] == "none"


def test_stops_core_dumps_and_keeps_no_daemon_logs(api: docker.APIClient) -> None:
    host = host_json(api)
    limits = {item["Name"]: item for item in host["Ulimits"]}
    assert limits["core"]["Hard"] == 0
    assert limits["nofile"]["Hard"] == 256
    assert host["LogConfig"]["Type"] == "none"


def test_uses_gvisor_only_when_available(api: docker.APIClient) -> None:
    assert host_json(api, gvisor=True)["Runtime"] == "runsc"
    assert "Runtime" not in host_json(api, gvisor=False)


def test_passes_no_secrets_into_the_sandbox(api: docker.APIClient) -> None:
    assert set(SANDBOX_ENV) == {"PATH", "HOME", "LANG"}
    assert "/tmp" not in SANDBOX_ENV["PATH"]
    assert len(create_json(api)["Env"]) == len(SANDBOX_ENV)


def test_follows_configured_limits(api: docker.APIClient) -> None:
    settings = Settings(limits=SandboxLimits(memory_bytes=128 * MIB, pids=32))
    spec = container_spec(language=Language.CPP, image="i", settings=settings, gvisor=False)
    host: dict[str, Any] = api.create_host_config(**spec.host)
    assert host["Memory"] == 128 * MIB
    assert host["PidsLimit"] == 32
