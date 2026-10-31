from __future__ import annotations

import json
import os
from typing import Any, Protocol

import redis
import structlog

from .models import RunRequest, RunResult
from .output import OutputChannel

log = structlog.get_logger()

# Must match BUS_SENDER_ID_BYTES in packages/shared/src/collab.ts.
BUS_SENDER_ID_BYTES = 16


def events_channel(room_id: str) -> str:
    return f"room:{room_id}:events"


class EventSink(Protocol):
    def started(self, request: RunRequest) -> None: ...

    def output(self, request: RunRequest, channel: OutputChannel, data: str) -> None: ...

    def finished(self, request: RunRequest, result: RunResult) -> None: ...


class NullEvents:
    def started(self, request: RunRequest) -> None:
        pass

    def output(self, request: RunRequest, channel: OutputChannel, data: str) -> None:
        pass

    def finished(self, request: RunRequest, result: RunResult) -> None:
        pass


class RedisEvents:
    """Publishes run progress for collab to forward to everyone in the room.

    Losing an event only affects what people see live. The stored result comes from RunResult,
    so a publish failure never fails the run.
    """

    def __init__(self, client: redis.Redis) -> None:
        self._client = client
        self._sender = os.urandom(BUS_SENDER_ID_BYTES)
        self._sequence = 0

    def _publish(self, room_id: str, event: dict[str, Any]) -> None:
        payload = self._sender + json.dumps(event, separators=(",", ":")).encode()
        try:
            self._client.publish(events_channel(room_id), payload)
        except redis.RedisError as error:
            log.warning("run_event_dropped", type=event["type"], error=str(error))

    def started(self, request: RunRequest) -> None:
        self._sequence = 0
        self._publish(
            str(request.room_id),
            {
                "type": "exec.started",
                "executionId": str(request.execution_id),
                "userId": str(request.user_id),
                "language": request.language.value,
            },
        )

    def output(self, request: RunRequest, channel: OutputChannel, data: str) -> None:
        self._sequence += 1
        self._publish(
            str(request.room_id),
            {
                "type": "exec.output",
                "executionId": str(request.execution_id),
                "stream": channel,
                "seq": self._sequence,
                "data": data,
            },
        )

    def finished(self, request: RunRequest, result: RunResult) -> None:
        self._publish(
            str(request.room_id),
            {
                "type": "exec.finished",
                "executionId": str(request.execution_id),
                "status": result.status.value,
                "exitCode": result.exit_code,
                "timeMs": result.time_ms,
                "memoryKb": result.memory_kb,
            },
        )
