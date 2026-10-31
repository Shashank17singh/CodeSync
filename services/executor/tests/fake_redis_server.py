"""A Redis-protocol server for machines with no Redis: python tests/fake_redis_server.py 6390

This is the fakeredis emulator, not Redis. It speaks the real protocol and runs real Lua, so client
libraries and BullMQ's scripts exercise their actual code paths. Timing, eviction and durability
differ from Redis, so a pass here is useful evidence and does not replace testing on Redis 7.
"""

from __future__ import annotations

import sys
from typing import Any

from fakeredis import TcpFakeServer
from fakeredis._commands import command
from fakeredis._socket._fakesocket import FakeSocket

REDIS_VERSION = "7.4.0"


@command(name="info", fixed=(), repeat=(bytes,))
def _info(self: Any, *_sections: bytes) -> bytes:
    # Clients read this for a readiness and version check. fakeredis does not provide it.
    return f"# Server\r\nredis_version:{REDIS_VERSION}\r\nloading:0\r\n".encode()


FakeSocket._info = _info  # type: ignore[attr-defined]


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 6390
    server = TcpFakeServer(("127.0.0.1", port), server_type="redis", server_version=(7, 4))
    print(f"fake redis listening on {port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
