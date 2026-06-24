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
    fqn = "sunpump-token-launch"
    service_url = "https://sunpump.meme"
    gateway_url = (
        "https://x402-gateway.bankofai.io/providers/"
        "sunpump-token-launch-tron/pump-api/ai/agentTokenLaunch"
    )
    endpoint = {
        "method": "POST",
        "path": "/pump-api/ai/agentTokenLaunch",
        "url": gateway_url,
        "description": (
            "Submit token metadata to SunPump after x402 payment settlement. "
            "`imageBase64` can carry a base64-encoded token image; when it is empty "
            "or omitted, SunPump generates an image automatically."
        ),
        "metered": True,
        "min_price_usd": 0.001,
        "max_price_usd": 0.001,
        "x402_routes": [
            {
                "network": "tron:mainnet",
                "provider": "sunpump-token-launch-tron",
                "scheme": "exact_permit",
                "url": gateway_url,
            },
            {
                "network": "eip155:56",
                "provider": "sunpump-token-launch-bsc",
                "scheme": "exact_permit",
                "url": (
                    "https://x402-gateway.bankofai.io/providers/"
                    "sunpump-token-launch-bsc/pump-api/ai/agentTokenLaunch"
                ),
            },
        ],
    }
    (dist / "catalog.json").write_text(
        json.dumps(
            {
                "version": 1,
                "base_url": "https://catalog.example.com/api",
                "provider_count": 1,
                "providers": [
                    {
                        "fqn": fqn,
                        "title": "SunPump Agent Token Launch API",
                        "subtitle": "Paid agent token creation through SunPump",
                        "description": "Launch a SunPump token from structured metadata.",
                        "use_case": "Create a token after a successful x402 payment.",
                        "category": "finance",
                        "service_url": service_url,
                        "featured_tags": ["sunpump", "token-launch", "tron", "bsc"],
                    }
                ],
            }
        )
    )
    (dist / "providers" / f"{fqn}.json").write_text(
        json.dumps(
            {
                "fqn": fqn,
                "title": "SunPump Agent Token Launch API",
                "subtitle": "Paid agent token creation through SunPump",
                "description": "Launch a SunPump token from structured metadata.",
                "use_case": "Create a token after a successful x402 payment.",
                "category": "finance",
                "service_url": service_url,
                "featured_tags": ["sunpump", "token-launch", "tron", "bsc"],
                "chains": ["tron:mainnet", "eip155:56"],
                "chain_kinds": ["tron", "bnb"],
                "endpoints": [endpoint],
            }
        )
    )
    (dist / "pay" / f"{fqn}.json").write_text(
        json.dumps(
            {
                "version": 1,
                "fqn": fqn,
                "service_url": service_url,
                "endpoints": [endpoint],
            }
        )
    )
    return dist / "catalog.json"


def test_catalog_search_show_endpoints_and_pay_json(tmp_path: Path) -> None:
    catalog = _write_public_catalog(tmp_path)
    runner = CliRunner()

    search = runner.invoke(
        cli,
        ["catalog", "search", "token launch", "--catalog", str(catalog), "--json"],
    )
    assert search.exit_code == 0
    assert json.loads(search.output)["results"][0]["fqn"] == "sunpump-token-launch"

    show = runner.invoke(
        cli,
        ["catalog", "show", "sunpump-token-launch", "--catalog", str(catalog), "--json"],
    )
    assert show.exit_code == 0
    assert json.loads(show.output)["service_url"] == "https://sunpump.meme"

    endpoints = runner.invoke(
        cli,
        ["catalog", "endpoints", "sunpump-token-launch", "--catalog", str(catalog), "--json"],
    )
    assert endpoints.exit_code == 0
    assert json.loads(endpoints.output)["endpoints"][0]["path"] == "/pump-api/ai/agentTokenLaunch"

    pay_json = runner.invoke(
        cli,
        ["catalog", "pay-json", "sunpump-token-launch", "--catalog", str(catalog)],
    )
    assert pay_json.exit_code == 0
    assert json.loads(pay_json.output)["fqn"] == "sunpump-token-launch"


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
    detail_payload = json.loads((tmp_path / "dist" / "providers" / "sunpump-token-launch.json").read_text())
    pay_payload = json.loads((tmp_path / "dist" / "pay" / "sunpump-token-launch.json").read_text())

    def fake_read_json(source: str):
        if source == "https://catalog.example.com/api/catalog.json":
            return catalog_payload
        if source == "https://catalog.example.com/api/providers/sunpump-token-launch.json":
            return detail_payload
        if source == "https://catalog.example.com/api/pay/sunpump-token-launch.json":
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
    assert (cache_root / "providers" / "sunpump-token-launch.json").exists()
    assert (cache_root / "pay" / "sunpump-token-launch.json").exists()


def test_catalog_detail_falls_back_to_base_url_when_local_detail_missing(tmp_path: Path) -> None:
    catalog = _write_public_catalog(tmp_path)
    (tmp_path / "dist" / "providers" / "sunpump-token-launch.json").unlink()
    (tmp_path / "dist" / "pay" / "sunpump-token-launch.json").unlink()
    assert (
        catalog_cmd._detail_source(str(catalog), "sunpump-token-launch")
        == "https://catalog.example.com/api/providers/sunpump-token-launch.json"
    )
    assert (
        catalog_cmd._pay_source(str(catalog), "sunpump-token-launch")
        == "https://catalog.example.com/api/pay/sunpump-token-launch.json"
    )


def test_catalog_export_gateway_writes_pr_files(tmp_path: Path, monkeypatch) -> None:
    detail = {
        "fqn": "sunpump-token-launch-tron",
        "title": "SunPump Agent Token Launch API",
        "subtitle": "Paid agent token creation through SunPump",
        "description": "Launch a SunPump token from structured metadata.",
        "use_case": "Create a token after a successful x402 payment.",
        "category": "finance",
        "service_url": "https://gw.example.com/providers/sunpump-token-launch-tron",
        "chains": ["tron:mainnet"],
        "endpoints": [
            {
                "method": "POST",
                "path": "/pump-api/ai/agentTokenLaunch",
                "url": (
                    "https://gw.example.com/providers/sunpump-token-launch-tron/"
                    "pump-api/ai/agentTokenLaunch"
                ),
                "description": "Launch a SunPump token from metadata.",
                "metered": True,
                "min_price_usd": 0.001,
                "max_price_usd": 0.001,
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
            "sunpump-token-launch-tron",
            "--output-dir",
            str(out),
            "--json",
        ],
    )

    assert result.exit_code == 0
    assert (out / "catalog.json").exists()
    assert (out / "pay.md").exists()
    payload = json.loads((out / "catalog.json").read_text())
    assert payload["fqn"] == "sunpump-token-launch-tron"
    assert payload["endpoints"][0]["path"] == "/pump-api/ai/agentTokenLaunch"
    pay_md = (out / "pay.md").read_text()
    assert (
        "x402-cli pay 'https://gw.example.com/providers/sunpump-token-launch-tron/"
        "pump-api/ai/agentTokenLaunch'" in pay_md
    )
    assert "provider.yml" in pay_md
