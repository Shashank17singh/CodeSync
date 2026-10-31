from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field

MIB = 1024 * 1024
KIB = 1024


@dataclass(frozen=True)
class SandboxLimits:
    memory_bytes: int = 256 * MIB
    nano_cpus: int = 1_000_000_000
    pids: int = 64
    tmpfs_bytes: int = 64 * MIB
    output_bytes: int = 64 * KIB
    compile_timeout_s: float = 10.0
    run_timeout_s: float = 5.0
    open_files: int = 256


@dataclass(frozen=True)
class Settings:
    redis_url: str = "redis://localhost:6379"
    image_prefix: str = "codesync/sandbox"
    image_tag: str = "1"
    api_url: str = ""
    internal_service_token: str = ""
    # Sandboxes this machine runs at once, and how many only interactive runs may use.
    slots: int = 2
    reserved_for_run: int = 1
    metrics_host: str = "127.0.0.1"
    metrics_port: int = 9100
    pool_size: int = 3
    pool_max_idle_s: float = 600.0
    runtime: str = "runsc"
    # On in production, so a host without gVisor refuses to start rather than running user code
    # on a weaker boundary without anyone noticing.
    require_gvisor: bool = False
    worker_id: str = field(default_factory=socket.gethostname)
    limits: SandboxLimits = field(default_factory=SandboxLimits)

    @classmethod
    def from_env(cls) -> Settings:
        defaults = cls()
        return cls(
            redis_url=os.environ.get("REDIS_URL", defaults.redis_url),
            api_url=os.environ.get("API_URL", defaults.api_url),
            internal_service_token=os.environ.get("INTERNAL_SERVICE_TOKEN", ""),
            slots=int(os.environ.get("EXECUTOR_SLOTS", defaults.slots)),
            reserved_for_run=int(
                os.environ.get("EXECUTOR_RESERVED_FOR_RUN", defaults.reserved_for_run)
            ),
            metrics_host=os.environ.get("METRICS_HOST", defaults.metrics_host),
            metrics_port=int(os.environ.get("METRICS_PORT", defaults.metrics_port)),
            image_prefix=os.environ.get("SANDBOX_IMAGE_PREFIX", defaults.image_prefix),
            image_tag=os.environ.get("SANDBOX_IMAGE_TAG", defaults.image_tag),
            pool_size=int(os.environ.get("SANDBOX_POOL_SIZE", defaults.pool_size)),
            runtime=os.environ.get("SANDBOX_RUNTIME", defaults.runtime),
            require_gvisor=os.environ.get("SANDBOX_REQUIRE_GVISOR", "false") == "true",
            worker_id=os.environ.get("WORKER_ID", defaults.worker_id),
        )
