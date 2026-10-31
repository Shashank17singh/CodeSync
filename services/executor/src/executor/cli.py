"""Runs one request from a JSON file: python -m executor.cli request.json"""

from __future__ import annotations

import sys
from pathlib import Path

from .docker_engine import DockerEngine
from .events import NullEvents
from .models import RunRequest
from .pool import SandboxPool
from .runner import execute
from .settings import Settings


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python -m executor.cli request.json\n")
        return 2
    request = RunRequest.model_validate_json(Path(sys.argv[1]).read_text(encoding="utf-8"))
    settings = Settings.from_env()
    pool = SandboxPool(DockerEngine(settings), size=0, max_idle_s=settings.pool_max_idle_s)
    try:
        result = execute(request, pool, NullEvents(), settings.limits)
    finally:
        pool.shutdown()
    sys.stdout.write(result.model_dump_json(indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
