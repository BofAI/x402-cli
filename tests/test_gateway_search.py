from __future__ import annotations

import json
from pathlib import Path

from click.testing import CliRunner

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
                "category": "data",
                "description": "Current weather data",
                "use_case": "Look up current weather for a city",
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
