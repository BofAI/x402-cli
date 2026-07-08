"""Output formatting for x402-cli."""

import json
import sys
from typing import Any, Literal, TypedDict

OutputMode = Literal["human", "json"]


class ErrorEnvelope(TypedDict):
    """Error envelope structure."""

    ok: bool
    command: str
    error: dict[str, str]
    network: str | None
    scheme: str | None


class SuccessEnvelope(TypedDict):
    """Success envelope structure."""

    ok: bool
    command: str
    result: Any
    network: str | None
    scheme: str | None


def emit_json(
    command: str,
    result: Any = None,
    error: dict[str, str] | None = None,
    network: str | None = None,
    scheme: str | None = None,
) -> None:
    """Emit JSON envelope."""
    envelope: dict[str, Any] = {
        "ok": error is None,
        "command": command,
    }
    if network:
        envelope["network"] = network
    if scheme:
        envelope["scheme"] = scheme

    if error:
        envelope["error"] = error
    else:
        envelope["result"] = result

    print(json.dumps(envelope, indent=2))


def emit_human(
    command: str,
    result: Any = None,
    error: dict[str, str] | None = None,
    network: str | None = None,
    scheme: str | None = None,
) -> None:
    """Emit human-readable output."""
    if error:
        sys.stderr.write(f"✗ {command} failed: {error.get('code', 'unknown')}\n")
        sys.stderr.write(f"  {error.get('message', 'unknown error')}\n")
        if "hint" in error:
            sys.stderr.write(f"  hint: {error['hint']}\n")
    else:
        header = f"✓ {command}"
        if network:
            header += f" ({network})"
        if scheme:
            header += f" — {scheme}"
        print(header)

        if result and isinstance(result, dict):
            for key, value in result.items():
                if key == "response" and isinstance(value, (dict, list)):
                    print("  response:")
                    print(json.dumps(value, ensure_ascii=False, indent=2))
                else:
                    print(f"  {key}: {value}")


def emit(
    command: str,
    result: Any = None,
    error: dict[str, str] | None = None,
    mode: OutputMode = "human",
    network: str | None = None,
    scheme: str | None = None,
) -> None:
    """Emit output in the specified mode."""
    if mode == "json":
        emit_json(command, result=result, error=error, network=network, scheme=scheme)
    else:
        emit_human(command, result=result, error=error, network=network, scheme=scheme)
