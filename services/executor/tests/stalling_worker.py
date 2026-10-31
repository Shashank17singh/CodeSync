"""Takes a job and hangs, so a test can kill it. Short timings make recovery quick to observe."""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from bullmq import Worker

from executor.worker import MAX_STALLED_COUNT


async def main(redis_url: str, queue: str) -> None:
    async def process(_job: Any, _token: str) -> None:
        print("picked", flush=True)
        await asyncio.sleep(3600)

    Worker(
        queue,
        process,
        {
            "connection": redis_url,
            "lockDuration": 1000,
            "stalledInterval": 500,
            "maxStalledCount": MAX_STALLED_COUNT,
        },
    )
    await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
