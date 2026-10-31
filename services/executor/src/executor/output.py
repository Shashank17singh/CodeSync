from __future__ import annotations

import codecs
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from .sandbox import StreamName

OutputChannel = Literal["stdout", "stderr", "compile"]

FLUSH_BYTES = 4096
FLUSH_INTERVAL_S = 0.05
MAX_EVENT_CHARS = 8000


@dataclass
class _Stream:
    decoder: codecs.IncrementalDecoder = field(
        default_factory=lambda: codecs.getincrementaldecoder("utf-8")("replace")
    )
    text: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)


class OutputCollector:
    """Keeps output within the cap and sends it live in small batches.

    Batching matters because a program that prints one byte at a time would otherwise produce
    one message per byte for the whole room.
    """

    def __init__(
        self,
        cap_bytes: int,
        emit: Callable[[OutputChannel, str], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._remaining = cap_bytes
        self._emit = emit
        self._clock = clock
        self._lock = threading.Lock()
        self._streams: dict[OutputChannel, _Stream] = {}
        self._last_flush = clock()
        self.exceeded = False

    def add(self, channel: OutputChannel, data: bytes) -> bool:
        """Returns False once the cap is passed, which is the signal to kill the program."""
        with self._lock:
            kept = data[: self._remaining]
            self._remaining -= len(kept)
            if len(kept) < len(data):
                self.exceeded = True
            stream = self._streams.setdefault(channel, _Stream())
            text = stream.decoder.decode(kept)
            if text:
                stream.text.append(text)
                stream.pending.append(text)
            pending = sum(len(chunk) for s in self._streams.values() for chunk in s.pending)
            if pending >= FLUSH_BYTES or self.exceeded:
                self._flush()
            return not self.exceeded

    def tick(self) -> None:
        """Called on a timer, so a quiet program's last line is not held back."""
        with self._lock:
            if self._clock() - self._last_flush >= FLUSH_INTERVAL_S:
                self._flush()

    def finish(self) -> None:
        with self._lock:
            for stream in self._streams.values():
                text = stream.decoder.decode(b"", final=True)
                if text:
                    stream.text.append(text)
                    stream.pending.append(text)
            self._flush()

    def _flush(self) -> None:
        self._last_flush = self._clock()
        for channel, stream in self._streams.items():
            if not stream.pending:
                continue
            text = "".join(stream.pending)
            stream.pending.clear()
            for start in range(0, len(text), MAX_EVENT_CHARS):
                self._emit(channel, text[start : start + MAX_EVENT_CHARS])

    def text(self, channel: OutputChannel) -> str:
        with self._lock:
            stream = self._streams.get(channel)
            return "".join(stream.text) if stream else ""


def channel_for(stream: StreamName, compiling: bool) -> OutputChannel:
    return "compile" if compiling else stream
