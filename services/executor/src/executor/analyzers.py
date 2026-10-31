from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .languages import WORK_DIR
from .models import Language
from .output import OutputCollector
from .runner import run_step
from .sandbox import Sandbox, SandboxError

ANALYZER_TIMEOUT_S = 20.0
ANALYZER_OUTPUT_BYTES = 2 * 1024 * 1024

Severity = Literal["error", "warning", "info"]
Category = Literal["bug", "security", "performance", "style", "readability"]

SOURCE_NAMES = {
    Language.PYTHON: "code.py",
    Language.CPP: "code.cpp",
    Language.JAVA: "Code.java",
    Language.JAVASCRIPT: "code.js",
}


@dataclass(frozen=True)
class Finding:
    line_start: int
    line_end: int
    severity: Severity
    category: Category
    message: str
    rule: str


@dataclass(frozen=True)
class FunctionComplexity:
    name: str
    line: int
    cyclomatic: int


class AnalyzerSource(Protocol):
    def create_analyzer(self) -> Sandbox: ...


def _python_category(rule: str) -> Category:
    if rule.startswith("S"):
        return "security"
    if rule.startswith(("F", "B", "E9", "PLE")):
        return "bug"
    if rule.startswith("PERF"):
        return "performance"
    return "style"


def _python_severity(rule: str) -> Severity:
    return "error" if rule.startswith(("F", "E9", "PLE")) else "warning"


def parse_ruff(output: str) -> list[Finding]:
    return [
        Finding(
            line_start=item["location"]["row"],
            line_end=item["end_location"]["row"],
            severity=_python_severity(item.get("code") or ""),
            category=_python_category(item.get("code") or ""),
            message=item["message"],
            rule=item.get("code") or "syntax",
        )
        for item in json.loads(output or "[]")
    ]


def parse_eslint(output: str) -> list[Finding]:
    findings: list[Finding] = []
    for result in json.loads(output or "[]"):
        for message in result.get("messages", []):
            line = message.get("line") or 1
            findings.append(
                Finding(
                    line_start=line,
                    line_end=message.get("endLine") or line,
                    severity="error" if message.get("severity") == 2 else "warning",
                    category="bug" if message.get("severity") == 2 else "style",
                    message=message.get("message", ""),
                    rule=message.get("ruleId") or "syntax",
                )
            )
    return findings


_CPPCHECK_SEVERITY: Mapping[str, Severity] = {
    "error": "error",
    "warning": "warning",
    "performance": "warning",
    "portability": "warning",
    "style": "info",
    "information": "info",
}


def parse_cppcheck(output: str) -> list[Finding]:
    """Reads lines written with the template in `analyzer_command`."""
    findings: list[Finding] = []
    for line in output.splitlines():
        parts = line.split("|", 3)
        if len(parts) != 4 or not parts[0].isdigit() or parts[1] == "information":
            continue
        number, severity, rule, message = parts
        category: Category = "performance" if severity == "performance" else (
            "bug" if severity in ("error", "warning") else "style"
        )
        findings.append(
            Finding(
                line_start=int(number),
                line_end=int(number),
                severity=_CPPCHECK_SEVERITY.get(severity, "info"),
                category=category,
                message=message,
                rule=rule,
            )
        )
    return findings


def parse_pmd(output: str) -> list[Finding]:
    findings: list[Finding] = []
    for file in json.loads(output or "{}").get("files", []):
        for violation in file.get("violations", []):
            priority = violation.get("priority", 3)
            findings.append(
                Finding(
                    line_start=violation.get("beginline", 1),
                    line_end=violation.get("endline", violation.get("beginline", 1)),
                    severity="error" if priority <= 2 else "warning",
                    category="bug" if priority <= 2 else "style",
                    message=violation.get("description", ""),
                    rule=violation.get("rule", "pmd"),
                )
            )
    return findings


def parse_lizard(output: str) -> list[FunctionComplexity]:
    functions: list[FunctionComplexity] = []
    for row in csv.reader(io.StringIO(output)):
        if len(row) >= 10 and row[1].isdigit():
            functions.append(
                FunctionComplexity(name=row[7], line=int(row[9]), cyclomatic=int(row[1]))
            )
    return functions


# Each tool is told to ignore any configuration near the code. A config file can run code in some
# tools, and only the file being reviewed is written, but this keeps that true by design.
def analyzer_command(language: Language) -> list[str]:
    path = SOURCE_NAMES[language]
    if language is Language.PYTHON:
        return [
            "python3", "-m", "ruff", "check", "--isolated", "--output-format", "json",
            "--select", "E9,F,B,S,PLE,PERF", "--exit-zero", path,
        ]
    if language is Language.CPP:
        return [
            "cppcheck", "--enable=warning,performance,portability", "--inline-suppr",
            "--template={line}|{severity}|{id}|{message}", path,
        ]
    if language is Language.JAVASCRIPT:
        return [
            "eslint", "--no-config-lookup", "--config", "/opt/analysis/eslint.config.mjs",
            "--format", "json", path,
        ]
    return [
        "pmd", "check", "--no-progress", "--no-cache", "--format", "json",
        "--rulesets", "rulesets/java/quickstart.xml", "--dir", path,
    ]


PARSERS: Mapping[Language, Callable[[str], list[Finding]]] = {
    Language.PYTHON: parse_ruff,
    Language.CPP: parse_cppcheck,
    Language.JAVASCRIPT: parse_eslint,
    Language.JAVA: parse_pmd,
}


@dataclass(frozen=True)
class Analysis:
    findings: tuple[Finding, ...]
    complexity: tuple[FunctionComplexity, ...]


def _run_tool(sandbox: Sandbox, argv: list[str]) -> str:
    collector = OutputCollector(ANALYZER_OUTPUT_BYTES, lambda _c, _d: None)
    step = run_step(sandbox, argv, ANALYZER_TIMEOUT_S, collector)
    collector.finish()
    if step.timed_out or step.output_exceeded:
        raise SandboxError(f"analyzer stopped early: {argv[0]}")
    # cppcheck reports on stderr. The others use stdout.
    return collector.text("stdout") + collector.text("stderr")


def analyze(code: str, language: Language, source: AnalyzerSource) -> Analysis:
    """Runs static analysis on hostile code, in a sandbox.

    Analyzers are real programs parsing attacker-controlled input, so they get the same isolation
    as a user's program. A tool failing is not fatal: the review continues on what it has.
    """
    sandbox = source.create_analyzer()
    try:
        path = SOURCE_NAMES[language]
        sandbox.write_files({path: code.encode()})
        report = _run_tool(sandbox, analyzer_command(language))
        findings = PARSERS[language](_extract(language, report))
        lizard = _run_tool(sandbox, ["python3", "-m", "lizard", "--csv", path])
        return Analysis(tuple(findings), tuple(parse_lizard(lizard)))
    finally:
        sandbox.destroy()


_JSON_START = re.compile(r"[\[{]")


def _extract(language: Language, text: str) -> str:
    # Tools can print a warning before their JSON. cppcheck's format is line based already.
    if language is Language.CPP:
        return text
    match = _JSON_START.search(text)
    return text[match.start() :] if match else ""


__all__ = [
    "WORK_DIR",
    "Analysis",
    "AnalyzerSource",
    "Category",
    "Finding",
    "FunctionComplexity",
    "Severity",
    "analyze",
    "analyzer_command",
    "parse_cppcheck",
    "parse_eslint",
    "parse_lizard",
    "parse_pmd",
    "parse_ruff",
]


def as_prompt_data(analysis: Analysis) -> dict[str, Any]:
    return {
        "findings": [
            {
                "line_start": item.line_start,
                "line_end": item.line_end,
                "severity": item.severity,
                "category": item.category,
                "rule": item.rule,
                "message": item.message,
            }
            for item in analysis.findings
        ],
        "complexity": [
            {"function": item.name, "line": item.line, "cyclomatic": item.cyclomatic}
            for item in analysis.complexity
        ],
    }
