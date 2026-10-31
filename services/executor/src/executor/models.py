from __future__ import annotations

import re
import unicodedata
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_FILES = 200
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
MAX_STDIN_BYTES = 1024 * 1024
MAX_PATH_LENGTH = 1024

_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_DRIVE_PREFIX = re.compile(r"^[a-zA-Z]:")


class Language(StrEnum):
    PYTHON = "PYTHON"
    CPP = "CPP"
    JAVA = "JAVA"
    JAVASCRIPT = "JAVASCRIPT"


class Status(StrEnum):
    """Matches the ExecutionStatus enum in the Prisma schema."""

    OK = "OK"
    COMPILE_ERROR = "COMPILE_ERROR"
    RUNTIME_ERROR = "RUNTIME_ERROR"
    TIME_LIMIT_EXCEEDED = "TIME_LIMIT_EXCEEDED"
    MEMORY_LIMIT_EXCEEDED = "MEMORY_LIMIT_EXCEEDED"
    OUTPUT_LIMIT_EXCEEDED = "OUTPUT_LIMIT_EXCEEDED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


def validate_path(raw: str) -> str:
    """Refuses anything that could leave the work directory.

    The API already validates paths. This is a second check at the point where they become
    entries in a tar archive, because a queue message should not have to be trusted.
    """
    path = unicodedata.normalize("NFC", raw)
    if not path or len(path) > MAX_PATH_LENGTH:
        raise ValueError("invalid path length")
    if _CONTROL_CHARACTERS.search(path) or "\\" in path:
        raise ValueError("invalid path characters")
    if path.startswith("/") or _DRIVE_PREFIX.match(path):
        raise ValueError("path must be relative")
    if any(segment in ("", ".", "..") for segment in path.split("/")):
        raise ValueError("invalid path segment")
    return path


class SourceFile(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: str
    content: str

    @field_validator("path")
    @classmethod
    def _valid_path(cls, value: str) -> str:
        return validate_path(value)


class RunRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    execution_id: UUID
    room_id: UUID
    user_id: UUID
    language: Language
    entry_path: str
    files: tuple[SourceFile, ...] = Field(min_length=1, max_length=MAX_FILES)
    stdin: str = Field(default="", max_length=MAX_STDIN_BYTES)

    @field_validator("entry_path")
    @classmethod
    def _valid_entry(cls, value: str) -> str:
        return validate_path(value)

    @model_validator(mode="after")
    def _entry_exists_and_size_fits(self) -> RunRequest:
        paths = {file.path for file in self.files}
        if self.entry_path not in paths:
            raise ValueError("entry_path is not one of the files")
        if len(paths) != len(self.files):
            raise ValueError("duplicate file paths")
        total = sum(len(file.content.encode()) for file in self.files)
        if total > MAX_PAYLOAD_BYTES:
            raise ValueError("files are too large")
        return self


class RunResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    execution_id: UUID
    status: Status
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    compile_output: str = ""
    time_ms: int | None = None
    memory_kb: int | None = None
    message: str | None = None
