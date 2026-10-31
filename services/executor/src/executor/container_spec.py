from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import docker.types

from .models import Language
from .settings import SandboxLimits, Settings

SANDBOX_USER = "10001:10001"
SANDBOX_LABEL = "codesync.sandbox"
WORKER_LABEL = "codesync.worker"

# Keeps PATH free of /tmp, so nothing a program writes can replace a command the worker runs.
SANDBOX_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp",  # noqa: S108
    "LANG": "C.UTF-8",
}


def _tmpfs_options(limits: SandboxLimits) -> str:
    # `exec` is explicit because compiled programs run from here, and `nosuid,nodev` stop a file
    # written here from gaining privileges. Docker's defaults differ between versions.
    return f"rw,exec,nosuid,nodev,size={limits.tmpfs_bytes},mode=1777"


@dataclass(frozen=True)
class ContainerSpec:
    create: dict[str, Any]
    host: dict[str, Any]


def container_spec(
    *,
    language: Language,
    image: str,
    settings: Settings,
    gvisor: bool,
) -> ContainerSpec:
    """Every isolation decision for a sandbox, in one reviewable place.

    Kept as pure data so tests can check it without a Docker daemon. No mounts and no Docker
    socket are ever passed in, and nothing from the worker's environment is inherited.
    """
    limits = settings.limits
    host: dict[str, Any] = {
        "network_mode": "none",
        "read_only": True,
        "tmpfs": {"/tmp": _tmpfs_options(limits)},  # noqa: S108
        "cap_drop": ["ALL"],
        # Docker's default seccomp profile applies because seccomp is not overridden here.
        "security_opt": ["no-new-privileges:true"],
        "pids_limit": limits.pids,
        "mem_limit": limits.memory_bytes,
        # Equal to mem_limit, which allows no swap: swap would let a memory bomb stall the host.
        "memswap_limit": limits.memory_bytes,
        "mem_swappiness": 0,
        "nano_cpus": limits.nano_cpus,
        "ulimits": [
            docker.types.Ulimit(name="core", soft=0, hard=0),
            docker.types.Ulimit(name="nofile", soft=limits.open_files, hard=limits.open_files),
            docker.types.Ulimit(name="fsize", soft=limits.tmpfs_bytes, hard=limits.tmpfs_bytes),
        ],
        "ipc_mode": "none",
        # Reaps zombies from a killed fork bomb and gives `sleep` a real PID 1 to run under.
        "init": True,
        # Output goes to the worker. A daemon log file would let a program fill the host's disk.
        "log_config": docker.types.LogConfig(type="none"),
    }
    if gvisor:
        host["runtime"] = settings.runtime

    create: dict[str, Any] = {
        "image": image,
        "command": ["sleep", "infinity"],
        "user": SANDBOX_USER,
        "environment": SANDBOX_ENV,
        "working_dir": "/tmp",  # noqa: S108
        "hostname": "sandbox",
        "network_disabled": True,
        "labels": {
            SANDBOX_LABEL: language.value,
            WORKER_LABEL: settings.worker_id,
        },
    }
    return ContainerSpec(create=create, host=host)
