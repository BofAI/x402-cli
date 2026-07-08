from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from click.testing import CliRunner

import bankofai.x402_cli.cli as cli_module
from bankofai.x402_cli.cli import cli
from bankofai.x402_cli.gateway_search import search_gateway_catalog


def _write_catalog(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    providers = dist / "providers"
    providers.mkdir(parents=True)
    (dist / "skills.json").write_text(
        json.dumps(
            {
                "providers": [
                    {
                        "fqn": "acme/weather",
                        "title": "Acme Weather",
                        "category": "data",
                        "service_url": "https://gw.example.com/providers/weather",
                        "tags": ["weather"],
                        "block": False,
                    }
                ]
            }
        )
    )
    (providers / "acme__weather.json").write_text(
        json.dumps(
            {
                "fqn": "acme/weather",
                "title": "Acme Weather",
                "title_zh": "Acme 天气",
                "main_title": "Acme Weather",
                "sub_title": "城市天气",
                "category": "data",
                "category_meta": {
                    "id": "data",
                    "label": "Data",
                    "label_zh": "数据",
                },
                "chains": ["eip155:97"],
                "chain_kinds": ["bnb"],
                "chains_meta": [
                    {
                        "id": "eip155:97",
                        "kind": "bnb",
                        "label": "BNB Smart Chain Testnet",
                        "label_zh": "BNB 测试网",
                    }
                ],
                "description": "Current weather data",
                "use_case": "Look up current weather for a city",
                "i18n": {
                    "zh-CN": {
                        "title": "Acme 天气",
                        "subtitle": "城市天气",
                        "description": "查询城市天气数据",
                        "useCase": "适合查询城市实时天气",
                    }
                },
                "service_url": "https://gw.example.com/providers/weather",
                "tags": ["weather", "forecast"],
                "endpoints": [
                    {
                        "method": "GET",
                        "path": "/v1/current",
                        "metered": True,
                        "probe_status": "ok",
                        "paid": {
                            "network": "tron:mainnet",
                            "currency": "USDT",
                            "amount_raw": "2000",
                        },
                    }
                ],
                "verdict": {
                    "block": False,
                    "ok_count": 1,
                    "non_compat_count": 0,
                    "error_count": 0,
                },
            }
        )
    )
    return dist / "skills.json"


def test_search_gateway_catalog_reads_dist_details(tmp_path: Path) -> None:
    catalog = _write_catalog(tmp_path)

    hits = search_gateway_catalog("current weather", catalog=str(catalog))

    assert len(hits) == 1
    assert hits[0].fqn == "acme/weather"
    assert hits[0].endpoints[0]["path"] == "/v1/current"
    assert "description" in hits[0].matched_fields
    assert hits[0].chain_kinds == ["bnb"]
    assert hits[0].category_meta == {"id": "data", "label": "Data", "label_zh": "数据"}


def test_search_gateway_catalog_matches_frontend_metadata(tmp_path: Path) -> None:
    catalog = _write_catalog(tmp_path)

    chain_hits = search_gateway_catalog("bnb", catalog=str(catalog))
    zh_hits = search_gateway_catalog("天气", catalog=str(catalog))
    category_hits = search_gateway_catalog("数据", catalog=str(catalog))

    assert [hit.fqn for hit in chain_hits] == ["acme/weather"]
    assert [hit.fqn for hit in zh_hits] == ["acme/weather"]
    assert [hit.fqn for hit in category_hits] == ["acme/weather"]
    assert "chain_kinds" in chain_hits[0].matched_fields


def test_gateway_search_cli_json(tmp_path: Path) -> None:
    catalog = _write_catalog(tmp_path)
    runner = CliRunner()

    result = runner.invoke(cli, ["gateway", "search", "weather", "--catalog", str(catalog), "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["count"] == 1
    assert payload["results"][0]["fqn"] == "acme/weather"


def test_gateway_search_cli_no_match(tmp_path: Path) -> None:
    catalog = _write_catalog(tmp_path)
    runner = CliRunner()

    result = runner.invoke(cli, ["gateway", "search", "translation", "--catalog", str(catalog)])

    assert result.exit_code == 1
    assert "no matches" in result.output


def test_gateway_commands_forward_to_gateway_module(monkeypatch) -> None:
    calls: list[list[str]] = []

    def fake_run(args, check=False):
        calls.append(list(args))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(cli_module.subprocess, "run", fake_run)
    runner = CliRunner()

    start = runner.invoke(cli, ["gateway", "start", "--providers-dir", "providers"])
    catalog = runner.invoke(
        cli,
        ["gateway", "catalog", "build", "providers", "--dist-dir", "dist"],
    )

    assert start.exit_code == 0
    assert catalog.exit_code == 0
    assert calls == [
        [
            cli_module.sys.executable,
            "-m",
            "bankofai.x402_gateway",
            "server",
            "start",
            "--providers-dir",
            "providers",
        ],
        [
            cli_module.sys.executable,
            "-m",
            "bankofai.x402_gateway",
            "catalog",
            "build",
            "providers",
            "--dist-dir",
            "dist",
        ],
    ]
