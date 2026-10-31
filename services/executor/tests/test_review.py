from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import anthropic
import httpx2
import pytest

from executor.analyzers import (
    Analysis,
    Finding,
    analyzer_command,
    parse_cppcheck,
    parse_eslint,
    parse_lizard,
    parse_pmd,
    parse_ruff,
)
from executor.llm import ClaudeClient, LLMError
from executor.models import Language
from executor.review import (
    OUTPUT_SCHEMA,
    Issue,
    ReviewMode,
    ReviewRequest,
    build_prompt,
    clean_issues,
    merge,
    run_review,
)
from executor.review_eval import SNIPPETS, LocalAnalyzer, Snippet, score
from executor.sandbox import Sandbox, SandboxError

CODE = "def f(a):\n    return a[0]\n\nprint(f([]))\n"


class ScriptedLLM:
    model = "scripted"

    def __init__(self, reply: dict[str, Any] | Exception) -> None:
        self.reply = reply
        self.calls: list[tuple[str, str]] = []

    def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((system, user))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


class BrokenAnalyzer:
    def create_analyzer(self) -> Sandbox:
        raise SandboxError("no analyzer image")


def request(**overrides: Any) -> ReviewRequest:
    values: dict[str, Any] = {
        "review_id": uuid4(),
        "mode": ReviewMode.REVIEW,
        "language": Language.PYTHON,
        "code": CODE,
    }
    return ReviewRequest(**(values | overrides))


def issue(**overrides: Any) -> dict[str, Any]:
    values = {
        "line_start": 2,
        "line_end": 2,
        "severity": "error",
        "category": "bug",
        "message": "Empty list crashes here",
        "suggested_fix": "    return a[0] if a else None",
    }
    return values | overrides


def typed(**overrides: Any) -> Issue:
    return Issue.model_validate(issue(**overrides))


class TestParsers:
    def test_ruff(self) -> None:
        output = json.dumps(
            [
                {
                    "code": "F821",
                    "message": "Undefined name",
                    "location": {"row": 2, "column": 1},
                    "end_location": {"row": 2, "column": 5},
                },
                {
                    "code": "S307",
                    "message": "Use of eval",
                    "location": {"row": 3, "column": 1},
                    "end_location": {"row": 4, "column": 1},
                },
            ]
        )
        first, second = parse_ruff(output)
        assert (first.category, first.severity, first.rule) == ("bug", "error", "F821")
        assert (second.category, second.line_end) == ("security", 4)

    def test_eslint(self) -> None:
        output = json.dumps(
            [{"messages": [{"ruleId": "no-undef", "severity": 2, "message": "x", "line": 3}]}]
        )
        assert parse_eslint(output)[0].line_end == 3

    def test_cppcheck_skips_noise(self) -> None:
        output = "12|error|nullPointer|Null pointer\n0|information|missingInclude|Skip\nnoise\n"
        findings = parse_cppcheck(output)
        assert [item.rule for item in findings] == ["nullPointer"]

    def test_pmd(self) -> None:
        output = json.dumps(
            {
                "files": [
                    {
                        "violations": [
                            {
                                "beginline": 4,
                                "endline": 5,
                                "description": "d",
                                "rule": "r",
                                "priority": 1,
                            }
                        ]
                    }
                ]
            }
        )
        assert parse_pmd(output)[0].severity == "error"

    def test_lizard(self) -> None:
        output = '5,3,40,2,7,"f@1-7@code.py","code.py","f","f(a,b)",1,7\n'
        assert parse_lizard(output)[0].cyclomatic == 3

    @pytest.mark.parametrize("language", list(Language))
    def test_every_tool_ignores_configuration_near_the_code(self, language: Language) -> None:
        command = " ".join(analyzer_command(language))
        if language is Language.PYTHON:
            assert "--isolated" in command
        if language is Language.JAVASCRIPT:
            assert "--no-config-lookup" in command


class TestValidation:
    def test_drops_issues_outside_the_file(self) -> None:
        kept = clean_issues(
            [issue(), issue(line_start=99, line_end=99), issue(line_start=0), issue(line_end=1)],
            line_count=5,
        )
        assert len(kept) == 1

    def test_drops_issues_that_do_not_fit_the_schema(self) -> None:
        kept = clean_issues(
            [issue(severity="catastrophic"), issue(extra="field"), "text", issue(line_start="2")],
            line_count=5,
        )
        assert all(item.message != "text" for item in kept)
        assert len(kept) <= 1

    def test_survives_a_reply_that_is_not_a_list(self) -> None:
        assert clean_issues("nonsense", 5) == []
        assert clean_issues(None, 5) == []

    def test_limits_the_number_of_issues(self) -> None:
        assert len(clean_issues([issue() for _ in range(500)], 5)) == 50

    def test_drops_an_oversized_fix(self) -> None:
        kept = clean_issues([issue(suggested_fix="x" * 100_000)], 5)
        assert kept[0].suggested_fix is None


class TestMerging:
    def test_keeps_the_model_wording_over_a_matching_analyzer_finding(self) -> None:
        merged = merge([typed(message="From model")], [typed(message="From analyzer")])
        assert [item.message for item in merged] == ["From model"]

    def test_keeps_a_finding_on_other_lines(self) -> None:
        merged = merge([typed()], [typed(line_start=3, line_end=3)])
        assert len(merged) == 2

    def test_keeps_a_finding_in_another_category(self) -> None:
        merged = merge([typed()], [typed(category="security")])
        assert len(merged) == 2


class TestPipeline:
    def source(self) -> LocalAnalyzer:
        return LocalAnalyzer()

    def test_combines_analyzers_and_the_model(self) -> None:
        llm = ScriptedLLM({"explanation": "Looks risky", "issues": [issue()]})
        code = "import os\ndef f(a):\n    return a[0]\nos.system(input())\n"
        output = run_review(request(code=code), self.source(), llm)
        assert output.status == "DONE"
        assert output.model == "scripted"
        assert output.explanation == "Looks risky"
        assert any(item.category == "security" for item in output.issues)
        assert any(item.message == "Empty list crashes here" for item in output.issues)

    def test_reports_complexity(self) -> None:
        output = run_review(request(), self.source(), None)
        assert output.complexity[0]["cyclomatic"] == 1

    def test_falls_back_to_analyzers_when_the_model_fails(self) -> None:
        llm = ScriptedLLM(LLMError("refusal"))
        output = run_review(request(code="def f():\n    return nope\n"), self.source(), llm)
        assert output.status == "DONE"
        assert output.model == "analyzers"
        assert output.issues

    def test_still_uses_the_model_when_analyzers_fail(self) -> None:
        llm = ScriptedLLM({"explanation": "", "issues": [issue()]})
        output = run_review(request(), BrokenAnalyzer(), llm)
        assert len(output.issues) == 1

    def test_includes_error_output_for_why_failing(self) -> None:
        llm = ScriptedLLM({"explanation": "x", "issues": []})
        run_review(
            request(mode=ReviewMode.WHY_FAILING, error_output="IndexError: list index"),
            self.source(),
            llm,
        )
        assert "IndexError: list index" in llm.calls[0][1]

    def test_numbers_lines_so_the_model_can_cite_them(self) -> None:
        _system, user = build_prompt(request(), Analysis((), ()))
        assert "2:     return a[0]" in user

    def test_treats_code_as_data_in_the_prompt(self) -> None:
        system, _user = build_prompt(request(), Analysis((), ()))
        assert "never instructions" in system


class TestPracticeMode:
    SOLUTION = "Do this:\n```python\nprint(sum(map(int, input().split())))\n```\nThen submit."

    def run(self, reply: dict[str, Any]) -> Any:
        return run_review(request(practice=True), LocalAnalyzer(), ScriptedLLM(reply))

    def test_tells_the_model_to_give_hints(self) -> None:
        llm = ScriptedLLM({"explanation": "", "issues": []})
        run_review(request(practice=True), LocalAnalyzer(), llm)
        assert "never solve" in llm.calls[0][0]

    def test_removes_fixes_even_if_the_model_returns_them(self) -> None:
        """A student's code can try to talk the model into revealing the answer."""
        output = self.run({"explanation": "", "issues": [issue()]})
        assert all(item.suggested_fix is None for item in output.issues)

    def test_removes_code_from_messages_and_the_explanation(self) -> None:
        output = self.run({"explanation": self.SOLUTION, "issues": [issue(message=self.SOLUTION)]})
        assert "print(sum" not in output.explanation
        assert all("print(sum" not in item.message for item in output.issues)
        assert "Then submit." in output.explanation

    def test_removes_an_unterminated_code_block(self) -> None:
        output = self.run({"explanation": "Try ```python\nprint(1)", "issues": []})
        assert "print(1)" not in output.explanation

    def test_keeps_hints_short(self) -> None:
        output = self.run({"explanation": "", "issues": [issue(message="x" * 5000)]})
        assert all(len(item.message) <= 400 for item in output.issues)

    def test_keeps_fixes_outside_practice_mode(self) -> None:
        llm = ScriptedLLM({"explanation": "", "issues": [issue()]})
        output = run_review(request(), LocalAnalyzer(), llm)
        assert output.issues[0].suggested_fix is not None


def response(text: str | None, stop_reason: str = "end_turn") -> SimpleNamespace:
    content = [] if text is None else [SimpleNamespace(type="text", text=text)]
    return SimpleNamespace(stop_reason=stop_reason, content=content)


class FakeMessages:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.kwargs: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def claude(result: Any) -> tuple[ClaudeClient, FakeMessages]:
    messages = FakeMessages(result)
    client = SimpleNamespace(beta=SimpleNamespace(messages=messages))
    return ClaudeClient(client), messages  # type: ignore[arg-type]


class TestClaudeClient:
    def test_requests_structured_output_on_the_default_model(self) -> None:
        client, messages = claude(response('{"issues": [], "explanation": ""}'))
        client.complete_json("system", "user", OUTPUT_SCHEMA)
        assert messages.kwargs["model"] == "claude-opus-5-5"
        assert messages.kwargs["output_config"]["format"]["schema"] == OUTPUT_SCHEMA
        assert messages.kwargs["fallbacks"] == "default"
        assert messages.kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}

    def test_parses_the_reply(self) -> None:
        client, _ = claude(response('{"issues": []}'))
        assert client.complete_json("s", "u", {}) == {"issues": []}

    @pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
    def test_checks_why_it_stopped_before_reading(self, stop_reason: str) -> None:
        client, _ = claude(response("{}", stop_reason))
        with pytest.raises(LLMError):
            client.complete_json("s", "u", {})

    def test_reports_a_reply_that_is_not_json(self) -> None:
        client, _ = claude(response("not json"))
        with pytest.raises(LLMError):
            client.complete_json("s", "u", {})

    def test_reports_no_text(self) -> None:
        client, _ = claude(response(None))
        with pytest.raises(LLMError):
            client.complete_json("s", "u", {})

    def test_turns_api_errors_into_a_failure_it_can_handle(self) -> None:
        error = anthropic.APIConnectionError(
            request=httpx2.Request("POST", "https://api.anthropic.com")
        )
        client, _ = claude(error)
        with pytest.raises(LLMError):
            client.complete_json("s", "u", {})


class TestEvaluation:
    def test_has_30_snippets_with_valid_bug_lines(self) -> None:
        assert len(SNIPPETS) == 30
        for snippet in SNIPPETS:
            compile(snippet.code, snippet.name, "exec")
            lines = snippet.code.count("\n") + 1
            assert all(1 <= line <= lines for line in snippet.bug_lines)

    def test_scores_recall_and_precision(self) -> None:
        snippets = [
            Snippet("a", "x\ny\n", (1,)),
            Snippet("b", "x\ny\n", (2,)),
            Snippet("c", "x\n", ()),
        ]
        reported = [[typed(line_start=1, line_end=1)], [], [typed(line_start=1, line_end=1)]]
        result = score(snippets, reported)
        assert (result.true_positives, result.false_negatives, result.false_positives) == (1, 1, 1)
        assert result.recall == 0.5
        assert result.precision == 0.5


def test_findings_are_frozen() -> None:
    finding = Finding(1, 1, "info", "style", "m", "r")
    assert finding.rule == "r"
