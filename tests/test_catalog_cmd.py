from __future__ import annotations

import json
from pathlib import Path

from click.testing import CliRunner

from bankofai.x402_cli import catalog_cmd
from bankofai.x402_cli.cli import cli


def _write_public_catalog(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "providers").mkdir(parents=True)
    (dist / "pay").mkdir()
    (dist / "catalog.json").write_text(
        json.dumps(
            {
                "version": 1,
                "base_url": "https://catalog.example.com/api",
                "provider_count": 1,
                "providers": [
                    {
                        "fqn": "acme-weather",
                        "title": "Acme Weather API",
                        "subtitle": "City-level weather",
                        "description": "Current weather data",
                        "use_case": "Look up weather by city",
                        "category": "data",
                        "service_url": "https://gw.example.com/providers/acme-weather",
                        "featured_tags": ["weather"],
                    }
                ],
            }
        )
    )
    (dist / "providers" / "acme-weather.json").write_text(
        json.dumps(
            {
                "fqn": "acme-weather",
                "title": "Acme Weather API",
                "subtitle": "City-level weather",
                "description": "Current weather data",
                "use_case": "Look up weather by city",
                "category": "data",
                "service_url": "https://gw.example.com/providers/acme-weather",
                "featured_tags": ["weather"],
                "chains": ["tron:mainnet"],
                "endpoints": [
                    {
                        "method": "GET",
                        "path": "/v1/current",
                        "url": "https://gw.example.com/providers/acme-weather/v1/current",
                        "description": "Current weather for a city",
                        "metered": True,
                        "min_price_usd": 0.002,
                        "max_price_usd": 0.002,
                    }
                ],
            }
        )
    )
    (dist / "pay" / "acme-weather.json").write_text(
        json.dumps(
            {
                "version": 1,
                "fqn": "acme-weather",
                "service_url": "https://gw.example.com/providers/acme-weather",
                "endpoints": [
                    {
                        "method": "GET",
                        "path": "/v1/current",
                        "url": "https://gw.example.com/providers/acme-weather/v1/current",
                    }
                ],
            }
        )
    )
    return dist / "catalog.json"


def test_catalog_search_show_endpoints_and_pay_json(tmp_path: Path) -> None:
    catalog = _write_public_catalog(tmp_path)
    runner = CliRunner()

    search = runner.invoke(
        cli,
        ["catalog", "search", "weather", "--catalog", str(catalog), "--json"],
    )
    assert search.exit_code == 0
    assert json.loads(search.output)["results"][0]["fqn"] == "acme-weather"

    show = runner.invoke(
        cli,
        ["catalog", "show", "acme-weather", "--catalog", str(catalog), "--json"],
    )
    assert show.exit_code == 0
    assert json.loads(show.output)["service_url"].endswith("/providers/acme-weather")

    endpoints = runner.invoke(
        cli,
        ["catalog", "endpoints", "acme-weather", "--catalog", str(catalog), "--json"],
    )
    assert endpoints.exit_code == 0
    assert json.loads(endpoints.output)["endpoints"][0]["path"] == "/v1/current"

    pay_json = runner.invoke(
        cli,
        ["catalog", "pay-json", "acme-weather", "--catalog", str(catalog)],
    )
    assert pay_json.exit_code == 0
    assert json.loads(pay_json.output)["fqn"] == "acme-weather"


def test_catalog_update_caches_catalog(
    tmp_path: Path,
    monkeypatch,
) -> None:
    catalog = _write_public_catalog(tmp_path)
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(catalog_cmd, "cache_dir", lambda: cache_root)

    result = CliRunner().invoke(
        cli,
        ["catalog", "update", "--catalog", str(catalog), "--json"],
    )

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["providerCount"] == 1
    assert payload["detailCount"] == 0
    assert payload["payCount"] == 0
    assert (cache_root / "catalog.json").exists()


def test_catalog_update_caches_remote_detail_and_pay_files(tmp_path: Path, monkeypatch) -> None:
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(catalog_cmd, "cache_dir", lambda: cache_root)

    catalog_payload = json.loads(_write_public_catalog(tmp_path).read_text())
    detail_payload = json.loads((tmp_path / "dist" / "providers" / "acme-weather.json").read_text())
    pay_payload = json.loads((tmp_path / "dist" / "pay" / "acme-weather.json").read_text())

    def fake_read_json(source: str):
        if source == "https://catalog.example.com/api/catalog.json":
            return catalog_payload
        if source == "https://catalog.example.com/api/providers/acme-weather.json":
            return detail_payload
        if source == "https://catalog.example.com/api/pay/acme-weather.json":
            return pay_payload
        raise AssertionError(source)

    monkeypatch.setattr(catalog_cmd, "_read_json", fake_read_json)

    result = CliRunner().invoke(
        cli,
        [
            "catalog",
            "update",
            "--catalog",
            "https://catalog.example.com/api/catalog.json",
            "--json",
        ],
    )

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["detailCount"] == 1
    assert payload["payCount"] == 1
    assert (cache_root / "providers" / "acme-weather.json").exists()
    assert (cache_root / "pay" / "acme-weather.json").exists()


def test_catalog_detail_falls_back_to_base_url_when_local_detail_missing(tmp_path: Path) -> None:
    catalog = _write_public_catalog(tmp_path)
    (tmp_path / "dist" / "providers" / "acme-weather.json").unlink()
    (tmp_path / "dist" / "pay" / "acme-weather.json").unlink()
    assert (
        catalog_cmd._detail_source(str(catalog), "acme-weather")
        == "https://catalog.example.com/api/providers/acme-weather.json"
    )
    assert (
        catalog_cmd._pay_source(str(catalog), "acme-weather")
        == "https://catalog.example.com/api/pay/acme-weather.json"
    )


def test_catalog_export_gateway_writes_pr_files(tmp_path: Path, monkeypatch) -> None:
    detail = {
        "fqn": "acme-weather",
        "title": "Acme Weather API",
        "subtitle": "City-level weather",
        "description": "Current weather data",
        "use_case": "Look up weather by city",
        "category": "data",
        "service_url": "https://gw.example.com/providers/acme-weather",
        "chains": ["tron:mainnet"],
        "endpoints": [
            {
                "method": "GET",
                "path": "/v1/current",
                "url": "https://gw.example.com/providers/acme-weather/v1/current",
                "description": "Current weather for a city",
                "metered": True,
                "min_price_usd": 0.002,
                "max_price_usd": 0.002,
            }
        ],
    }
    monkeypatch.setattr(catalog_cmd, "_read_json", lambda source: detail)
    out = tmp_path / "entry"

    result = CliRunner().invoke(
        cli,
        [
            "catalog",
            "export-gateway",
            "https://gw.example.com",
            "--provider",
            "acme-weather",
            "--output-dir",
            str(out),
            "--json",
        ],
    )

    assert result.exit_code == 0
    assert (out / "catalog.json").exists()
    assert (out / "pay.md").exists()
    payload = json.loads((out / "catalog.json").read_text())
    assert payload["fqn"] == "acme-weather"
    assert payload["endpoints"][0]["path"] == "/v1/current"
    pay_md = (out / "pay.md").read_text()
    assert "x402-cli pay 'https://gw.example.com/providers/acme-weather/v1/current'" in pay_md
    assert "provider.yml" in pay_md
