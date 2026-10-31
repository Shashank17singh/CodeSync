from __future__ import annotations

import json
from typing import Any, Protocol

import anthropic

DEFAULT_MODEL = "claude-opus-5-5"
MAX_OUTPUT_TOKENS = 16_000


class LLMError(Exception):
    """The model gave no usable answer. Callers fall back to analyzer results."""


class LLMClient(Protocol):
    """The one thing reviews need from a model, so providers can be swapped."""

    model: str

    def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]: ...


class ClaudeClient:
    def __init__(
        self, client: anthropic.Anthropic | None = None, model: str = DEFAULT_MODEL
    ) -> None:
        self._client = client or anthropic.Anthropic()
        self.model = model

    def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.beta.messages.create(
                model=self.model,
                max_tokens=MAX_OUTPUT_TOKENS,
                # Re-runs a safety decline on another model inside this call. A student's code
                # about, say, sockets should still get a review.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                # Stable first and cached, so each review pays full price only for its own code.
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user}],
                output_config={
                    "effort": "high",
                    "format": {"type": "json_schema", "schema": schema},
                },
            )
        except anthropic.APIError as error:
            raise LLMError(type(error).__name__) from error

        if response.stop_reason != "end_turn":
            raise LLMError(f"stopped with {response.stop_reason}")
        text = next((block.text for block in response.content if block.type == "text"), None)
        if text is None:
            raise LLMError("no text in the response")
        try:
            parsed: dict[str, Any] = json.loads(text)
        except json.JSONDecodeError as error:
            raise LLMError("response was not JSON") from error
        return parsed
