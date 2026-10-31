from __future__ import annotations

import io
import socket
import tarfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from typing import Any

import docker
import docker.errors
import structlog

from .container_spec import SANDBOX_LABEL, SANDBOX_USER, WORKER_LABEL, container_spec
from .languages import BUILD_DIR, PROFILES, WORK_DIR
from .models import Language
from .sandbox import MemoryStats, Sandbox, SandboxError, SandboxProcess, StreamName
from .settings import Settings

log = structlog.get_logger()

SOCKET_TIMEOUT_S = 15.0
STATS_SCRIPT = (
    "cat /sys/fs/cgroup/memory.peak 2>/dev/null; "
    "grep '^oom_kill ' /sys/fs/cgroup/memory.events 2>/dev/null"
)


def _tar(files: Mapping[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for path, content in files.items():
            info = tarfile.TarInfo(path)
            info.size = len(content)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def parse_memory_stats(text: str) -> MemoryStats | None:
    """Reads cgroup v2 output. Files missing, as under gVisor, give no stats at all."""
    peak_kb: int | None = None
    oom_kills: int | None = None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 1 and parts[0].isdigit():
            peak_kb = int(parts[0]) // 1024
        elif len(parts) == 2 and parts[0] == "oom_kill" and parts[1].isdigit():
            oom_kills = int(parts[1])
    if peak_kb is None and oom_kills is None:
        return None
    return MemoryStats(peak_kb=peak_kb, oom_kills=oom_kills or 0)


class DockerProcess:
    def __init__(self, api: Any, exec_id: str) -> None:
        self._api = api
        self._exec_id = exec_id

    def output(self) -> Iterator[tuple[StreamName, bytes]]:
        stream = self._api.exec_start(self._exec_id, stream=True, demux=True)
        try:
            for stdout, stderr in stream:
                if stdout:
                    yield "stdout", stdout
                if stderr:
                    yield "stderr", stderr
        except docker.errors.APIError as error:
            raise SandboxError("exec stream failed") from error

    def exit_code(self) -> int | None:
        # exec_start never reports an exit status. Only exec_inspect does.
        try:
            code = self._api.exec_inspect(self._exec_id)["ExitCode"]
        except docker.errors.APIError:
            return None
        return int(code) if code is not None else None


class DockerSandbox:
    def __init__(self, api: Any, container_id: str) -> None:
        self._api = api
        self._id = container_id
        self._kill_lock = threading.Lock()
        self._killed = False

    def write_files(self, files: Mapping[str, bytes]) -> None:
        # `docker cp` cannot write to a tmpfs, and the root filesystem is read-only, so the
        # archive goes in through tar's stdin. BUILD_DIR is created here for compilers to use.
        script = f"mkdir -p {WORK_DIR} {BUILD_DIR} && exec tar -xof - -C {WORK_DIR}"
        created = self._api.exec_create(
            self._id,
            ["/bin/sh", "-c", script],
            stdin=True,
            stdout=True,
            stderr=True,
            user=SANDBOX_USER,
        )
        attached = self._api.exec_start(created["Id"], socket=True)
        raw: socket.socket = getattr(attached, "_sock", attached)
        raw.settimeout(SOCKET_TIMEOUT_S)
        try:
            raw.sendall(_tar(files))
            raw.shutdown(socket.SHUT_WR)
            while raw.recv(4096):
                pass
        except OSError as error:
            raise SandboxError("could not write files") from error
        finally:
            attached.close()
        if self._api.exec_inspect(created["Id"])["ExitCode"] != 0:
            raise SandboxError("tar failed inside the sandbox")

    def start(self, argv: Sequence[str], stdin_file: str | None = None) -> SandboxProcess:
        command = list(argv)
        if stdin_file is not None:
            # Arguments are passed positionally, so nothing in them is parsed by the shell.
            command = ["/bin/sh", "-c", 'exec "$@" < "$0"', stdin_file, *argv]
        try:
            created = self._api.exec_create(
                self._id,
                command,
                stdout=True,
                stderr=True,
                user=SANDBOX_USER,
                workdir=WORK_DIR,
            )
        except docker.errors.APIError as error:
            raise SandboxError("could not start process") from error
        return DockerProcess(self._api, created["Id"])

    def memory_stats(self) -> MemoryStats | None:
        try:
            created = self._api.exec_create(
                self._id, ["/bin/sh", "-c", STATS_SCRIPT], user=SANDBOX_USER
            )
            output = self._api.exec_start(created["Id"])
            stats = parse_memory_stats(output.decode("utf-8", "replace"))
            if stats is not None:
                return stats
        except docker.errors.APIError:
            log.info("sandbox_stats_unavailable", container=self._id[:12])
        return self._stats_from_inspect()

    def _stats_from_inspect(self) -> MemoryStats | None:
        # Reached when the out-of-memory kill took the whole container with it.
        try:
            state = self._api.inspect_container(self._id)["State"]
        except docker.errors.APIError:
            return None
        return MemoryStats(peak_kb=None, oom_kills=1) if state.get("OOMKilled") else None

    def kill(self) -> None:
        # Kills the container, not one process: a program may have forked away from the exec.
        with self._kill_lock:
            if self._killed:
                return
            self._killed = True
        try:
            self._api.kill(self._id)
        except docker.errors.APIError:
            log.info("sandbox_already_stopped", container=self._id[:12])

    def destroy(self) -> None:
        try:
            self._api.remove_container(self._id, force=True, v=True)
        except docker.errors.NotFound:
            return
        except docker.errors.APIError as error:
            log.error("sandbox_remove_failed", container=self._id[:12], error=str(error))


class DockerEngine:
    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self._settings = settings
        self._client = client or docker.from_env()
        self._api = self._client.api
        runtimes = self._client.info().get("Runtimes", {})
        self.gvisor = settings.runtime in runtimes
        if settings.require_gvisor and not self.gvisor:
            raise SandboxError(f"runtime {settings.runtime} is required but not installed")
        if not self.gvisor:
            log.warning("sandbox_without_gvisor", runtimes=sorted(runtimes))

    def _image(self, language: Language) -> str:
        name = PROFILES[language].image
        return f"{self._settings.image_prefix}-{name}:{self._settings.image_tag}"

    def create(self, language: Language) -> Sandbox:
        spec = container_spec(
            language=language,
            image=self._image(language),
            settings=self._settings,
            gvisor=self.gvisor,
        )
        container: dict[str, Any] | None = None
        try:
            host_config = self._api.create_host_config(**spec.host)
            container = self._api.create_container(host_config=host_config, **spec.create)
            self._api.start(container["Id"])
        except docker.errors.DockerException as error:
            if container is not None:
                self._api.remove_container(container["Id"], force=True)
            raise SandboxError(f"could not create {language} sandbox") from error
        return DockerSandbox(self._api, container["Id"])

    def reap_orphans(self) -> int:
        """Removes sandboxes this worker left behind when it last crashed."""
        filters = {"label": [SANDBOX_LABEL, f"{WORKER_LABEL}={self._settings.worker_id}"]}
        orphans = self._api.containers(all=True, filters=filters)
        for orphan in orphans:
            self._api.remove_container(orphan["Id"], force=True, v=True)
        return len(orphans)
