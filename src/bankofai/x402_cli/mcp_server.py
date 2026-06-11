"""Minimal MCP stdio server for x402-cli.

The server intentionally reuses the existing catalog and pay implementation so
agent integrations behave like the command line users already test.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import subprocess
import sys
from typing import Any, Callable

from bankofai.x402_cli import __version__, _tron_patch
from bankofai.x402_cli.catalog_cmd import (
    _catalog_source,
    _detail_source,
    _pay_source,
    _read_json,
)
from bankofai.x402_cli.client_cmd import cmd_client
from bankofai.x402_cli.gateway_search import search_gateway_catalog

_tron_patch.install()

JsonObject = dict[str, Any]


def _json_text(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)


def _tool_result(payload: Any) -> JsonObject:
    return {"content": [{"type": "text", "text": _json_text(payload)}]}


def _text_result(text: str) -> JsonObject:
    return {"content": [{"type": "text", "text": text}]}


def _require_str(args: JsonObject, key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _optional_str(args: JsonObject, key: str) -> str | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value


def _optional_int(args: JsonObject, key: str, default: int) -> int:
    value = args.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    return value


def _catalog_search(args: JsonObject) -> JsonObject:
    query = _require_str(args, "query")
    catalog = _optional_str(args, "catalog")
    limit = _optional_int(args, "limit", 10)
    hits = search_gateway_catalog(query, catalog=_catalog_source(catalog), limit=limit)
    return _tool_result(
        {
            "query": query,
            "count": len(hits),
            "results": [hit.to_dict() for hit in hits],
        }
    )


def _catalog_show(args: JsonObject) -> JsonObject:
    fqn = _require_str(args, "fqn")
    catalog = _catalog_source(_optional_str(args, "catalog"))
    return _tool_result(_read_json(_detail_source(catalog, fqn)))


def _catalog_endpoints(args: JsonObject) -> JsonObject:
    fqn = _require_str(args, "fqn")
    catalog = _catalog_source(_optional_str(args, "catalog"))
    detail = _read_json(_detail_source(catalog, fqn))
    return _tool_result({"fqn": fqn, "endpoints": detail.get("endpoints", [])})


def _catalog_pay_json(args: JsonObject) -> JsonObject:
    fqn = _require_str(args, "fqn")
    catalog = _catalog_source(_optional_str(args, "catalog"))
    return _tool_result(_read_json(_pay_source(catalog, fqn)))


async def _x402_pay(args: JsonObject) -> JsonObject:
    url = _require_str(args, "url")
    method = str(args.get("method") or "GET").upper()
    network = _optional_str(args, "network")
    token = _optional_str(args, "token") or "USDT"
    scheme = _optional_str(args, "scheme")
    max_amount = _optional_str(args, "max_amount")
    max_raw_amount = _optional_str(args, "max_raw_amount")
    body = args.get("json")
    raw_body = args.get("body")
    headers_arg = args.get("headers") or {}
    dry_run = bool(args.get("dry_run", False))

    if body is not None and raw_body is not None:
        raise ValueError("json and body are mutually exclusive")
    if body is not None:
        raw_body = json.dumps(body, ensure_ascii=False)

    headers: list[str] = []
    if headers_arg:
        if not isinstance(headers_arg, dict):
            raise ValueError("headers must be an object")
        headers = [f"{key}: {value}" for key, value in headers_arg.items()]
    if body is not None and not any(header.lower().startswith("content-type:") for header in headers):
        headers.append("Content-Type: application/json")

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        await cmd_client(
            url=url,
            max_raw_amount=max_raw_amount,
            max_amount=max_amount,
            network=network,
            token=token,
            scheme=scheme,
            method=method,
            headers=tuple(headers),
            body=raw_body if isinstance(raw_body, str) else None,
            dry_run=dry_run,
            output_mode="json",
        )
    text = output.getvalue().strip()
    try:
        return _tool_result(json.loads(text))
    except json.JSONDecodeError:
        return _text_result(text)


def _wallet_status(args: JsonObject) -> JsonObject:
    timeout = _optional_int(args, "timeout_seconds", 10)
    commands = [
        ["agent-wallet", "list"],
        ["agent-wallet", "resolve-address"],
    ]
    result: dict[str, Any] = {}
    for command in commands:
        key = command[1].replace("-", "_")
        try:
            proc = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            result[key] = {
                "ok": proc.returncode == 0,
                "exit_code": proc.returncode,
                "stdout": proc.stdout.strip(),
                "stderr": proc.stderr.strip(),
            }
        except FileNotFoundError:
            result[key] = {
                "ok": False,
                "exit_code": None,
                "stdout": "",
                "stderr": "agent-wallet command not found",
            }
            break
    return _tool_result(result)


TOOLS: dict[str, Callable[[JsonObject], JsonObject] | Callable[[JsonObject], Any]] = {
    "catalog_search": _catalog_search,
    "catalog_show": _catalog_show,
    "catalog_endpoints": _catalog_endpoints,
    "catalog_pay_json": _catalog_pay_json,
    "x402_pay": _x402_pay,
    "wallet_status": _wallet_status,
}


TOOL_DEFINITIONS: list[JsonObject] = [
    {
        "name": "catalog_search",
        "description": "Search the Bank of AI x402 catalog by use case, category, endpoint, chain, or tag.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "catalog": {"type": "string"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "catalog_show",
        "description": "Show detailed metadata for a catalog provider.",
        "inputSchema": {
            "type": "object",
            "properties": {"fqn": {"type": "string"}, "catalog": {"type": "string"}},
            "required": ["fqn"],
        },
    },
    {
        "name": "catalog_endpoints",
        "description": "List callable endpoints, prices, and x402 routes for a provider.",
        "inputSchema": {
            "type": "object",
            "properties": {"fqn": {"type": "string"}, "catalog": {"type": "string"}},
            "required": ["fqn"],
        },
    },
    {
        "name": "catalog_pay_json",
        "description": "Return the machine-readable pay.json for a provider.",
        "inputSchema": {
            "type": "object",
            "properties": {"fqn": {"type": "string"}, "catalog": {"type": "string"}},
            "required": ["fqn"],
        },
    },
    {
        "name": "x402_pay",
        "description": "Pay an x402-protected URL using x402-cli and the configured agent-wallet.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "method": {"type": "string", "default": "GET"},
                "network": {"type": "string"},
                "token": {"type": "string", "default": "USDT"},
                "scheme": {"type": "string"},
                "max_amount": {"type": "string"},
                "max_raw_amount": {"type": "string"},
                "headers": {"type": "object"},
                "json": {},
                "body": {"type": "string"},
                "dry_run": {"type": "boolean", "default": False},
            },
            "required": ["url"],
        },
    },
    {
        "name": "wallet_status",
        "description": "Check whether agent-wallet is installed and can resolve active wallet addresses.",
        "inputSchema": {
            "type": "object",
            "properties": {"timeout_seconds": {"type": "integer", "default": 10}},
        },
    },
]


async def handle_message(message: JsonObject) -> JsonObject | None:
    method = message.get("method")
    request_id = message.get("id")
    if request_id is None:
        return None

    try:
        result: JsonObject
        if method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "x402-mcp", "version": __version__},
            }
        elif method == "tools/list":
            result = {"tools": TOOL_DEFINITIONS}
        elif method == "tools/call":
            params = message.get("params") or {}
            if not isinstance(params, dict):
                raise ValueError("params must be an object")
            name = _require_str(params, "name")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                raise ValueError("arguments must be an object")
            tool = TOOLS.get(name)
            if tool is None:
                raise ValueError(f"unknown tool: {name}")
            maybe_result = tool(arguments)
            result = await maybe_result if asyncio.iscoroutine(maybe_result) else maybe_result
        else:
            raise ValueError(f"unsupported method: {method}")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except Exception as exc:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32000, "message": str(exc)},
        }


def _read_frame(stdin: Any) -> JsonObject | None:
    headers: dict[str, str] = {}
    while True:
        line = stdin.buffer.readline()
        if not line:
            return None
        if line in {b"\r\n", b"\n"}:
            break
        key, _, value = line.decode("ascii").partition(":")
        headers[key.lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    body = stdin.buffer.read(length)
    payload = json.loads(body.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("MCP frame body must be a JSON object")
    return payload


def _write_frame(stdout: Any, payload: JsonObject) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    stdout.buffer.write(body)
    stdout.buffer.flush()


async def run_stdio() -> None:
    while True:
        message = _read_frame(sys.stdin)
        if message is None:
            return
        response = await handle_message(message)
        if response is not None:
            _write_frame(sys.stdout, response)


def main() -> None:
    asyncio.run(run_stdio())


if __name__ == "__main__":
    main()
