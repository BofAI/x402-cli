from __future__ import annotations

import json
from pathlib import Path

import pytest

from bankofai.x402_cli import mcp_server
from tests.test_catalog_cmd import _write_public_catalog


@pytest.mark.asyncio
async def test_mcp_lists_tools() -> None:
    response = await mcp_server.handle_message(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    )

    assert response is not None
    assert response["id"] == 1
    names = {tool["name"] for tool in response["result"]["tools"]}
    assert {"catalog_search", "catalog_show", "x402_pay", "wallet_status"} <= names


@pytest.mark.asyncio
async def test_mcp_catalog_tools_use_public_catalog(tmp_path: Path) -> None:
    catalog = _write_public_catalog(tmp_path)

    search = await mcp_server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "catalog_search",
                "arguments": {"query": "weather", "catalog": str(catalog)},
            },
        }
    )
    assert search is not None
    search_payload = json.loads(search["result"]["content"][0]["text"])
    assert search_payload["results"][0]["fqn"] == "acme-weather"

    endpoints = await mcp_server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "catalog_endpoints",
                "arguments": {"fqn": "acme-weather", "catalog": str(catalog)},
            },
        }
    )
    assert endpoints is not None
    endpoints_payload = json.loads(endpoints["result"]["content"][0]["text"])
    assert endpoints_payload["endpoints"][0]["path"] == "/v1/current"


@pytest.mark.asyncio
async def test_mcp_unknown_tool_returns_error() -> None:
    response = await mcp_server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "missing", "arguments": {}},
        }
    )

    assert response is not None
    assert "error" in response
    assert "unknown tool" in response["error"]["message"]


@pytest.mark.asyncio
async def test_mcp_x402_pay_returns_cli_json(monkeypatch) -> None:
    async def fake_cmd_client(**kwargs):
        print(json.dumps({"ok": True, "command": "client", "result": kwargs}))

    monkeypatch.setattr(mcp_server, "cmd_client", fake_cmd_client)

    response = await mcp_server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "x402_pay",
                "arguments": {
                    "url": "https://gw.example.com/providers/acme/v1/models",
                    "network": "eip155:97",
                    "token": "USDT",
                    "scheme": "exact_permit",
                    "json": {"hello": "world"},
                },
            },
        }
    )

    assert response is not None
    payload = json.loads(response["result"]["content"][0]["text"])
    assert payload["ok"] is True
    result = payload["result"]
    assert result["url"] == "https://gw.example.com/providers/acme/v1/models"
    assert result["headers"] == ["Content-Type: application/json"]
    assert json.loads(result["body"]) == {"hello": "world"}
