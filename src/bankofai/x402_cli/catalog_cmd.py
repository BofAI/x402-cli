"""Public x402 catalog commands."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import click
import httpx

from bankofai.x402_cli.gateway_search import default_catalog, search_gateway_catalog


def cache_dir() -> Path:
    return Path.home() / ".cache" / "x402-cli" / "catalog"


def cached_catalog_path() -> Path:
    return cache_dir() / "catalog.json"


def _read_json(source: str) -> dict[str, Any]:
    if source.startswith(("http://", "https://")):
        response = httpx.get(source, timeout=15.0)
        response.raise_for_status()
        payload = response.json()
    else:
        payload = json.loads(Path(source).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected JSON object from {source}")
    return payload


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _provider_filename(fqn: str) -> str:
    return f"{fqn.replace('/', '__')}.json"


def _catalog_source(catalog: str | None) -> str:
    if catalog:
        return catalog
    cached = cached_catalog_path()
    if cached.exists():
        return str(cached)
    return default_catalog()


def _remote_base_from_catalog_payload(payload: dict[str, Any]) -> str | None:
    base_url = payload.get("base_url") or payload.get("baseUrl")
    if isinstance(base_url, str) and base_url.startswith(("http://", "https://")):
        return base_url.rstrip("/") + "/"
    return None


def _remote_base_from_source(catalog_source: str, payload: dict[str, Any] | None = None) -> str | None:
    if payload is not None:
        base_url = _remote_base_from_catalog_payload(payload)
        if base_url:
            return base_url
    if catalog_source.startswith(("http://", "https://")):
        return catalog_source.rsplit("/", 1)[0].rstrip("/") + "/"
    try:
        local_payload = _read_json(catalog_source)
    except (OSError, ValueError, json.JSONDecodeError, httpx.HTTPError):
        return None
    return _remote_base_from_catalog_payload(local_payload)


def _detail_source(catalog_source: str, fqn: str) -> str:
    filename = _provider_filename(fqn)
    if catalog_source.startswith(("http://", "https://")):
        base = catalog_source.rsplit("/", 1)[0].rstrip("/") + "/"
        return urljoin(base, f"providers/{filename}")
    path = Path(catalog_source).parent / "providers" / filename
    if path.exists():
        return str(path)
    remote_base = _remote_base_from_source(catalog_source)
    if remote_base:
        return urljoin(remote_base, f"providers/{filename}")
    return str(path)


def _pay_source(catalog_source: str, fqn: str) -> str:
    filename = _provider_filename(fqn)
    if catalog_source.startswith(("http://", "https://")):
        base = catalog_source.rsplit("/", 1)[0].rstrip("/") + "/"
        return urljoin(base, f"pay/{filename}")
    path = Path(catalog_source).parent / "pay" / filename
    if path.exists():
        return str(path)
    remote_base = _remote_base_from_source(catalog_source)
    if remote_base:
        return urljoin(remote_base, f"pay/{filename}")
    return str(path)


def _cache_provider_assets(source: str, catalog_payload: dict[str, Any]) -> tuple[int, int]:
    base = _remote_base_from_source(source, catalog_payload)
    if not base:
        return (0, 0)

    provider_count = 0
    pay_count = 0
    for provider in catalog_payload.get("providers", []):
        if not isinstance(provider, dict):
            continue
        fqn = provider.get("fqn")
        if not isinstance(fqn, str) or not fqn:
            continue
        filename = _provider_filename(fqn)
        try:
            detail = _read_json(urljoin(base, f"providers/{filename}"))
            _write_json(cache_dir() / "providers" / filename, detail)
            provider_count += 1
        except (ValueError, httpx.HTTPError):
            pass
        try:
            pay_json = _read_json(urljoin(base, f"pay/{filename}"))
            _write_json(cache_dir() / "pay" / filename, pay_json)
            pay_count += 1
        except (ValueError, httpx.HTTPError):
            pass
    return (provider_count, pay_count)


def _zh_copy(title: str, subtitle: str, description: str, use_case: str) -> dict[str, str]:
    return {
        "title": title,
        "subtitle": subtitle,
        "description": description,
        "useCase": use_case,
    }


def _submission_catalog(detail: dict[str, Any]) -> dict[str, Any]:
    title = str(detail.get("title") or detail["fqn"])
    subtitle = str(detail.get("subtitle") or detail.get("use_case") or title)
    description = str(detail.get("description") or subtitle)
    use_case = str(detail.get("use_case") or description)
    return {
        "version": 1,
        "fqn": detail["fqn"],
        "title": title,
        "subtitle": subtitle,
        "description": description,
        "useCase": use_case,
        "i18n": detail.get("i18n") or {"zh-CN": _zh_copy(title, subtitle, description, use_case)},
        "logo": detail.get("logo") or "https://tm-x402-catelog.bankofai.io/assets/providers/default.png",
        "category": detail.get("category") or "other",
        "chains": detail.get("chains") or [],
        "isFirstParty": bool(detail.get("is_first_party")),
        "isFeatured": bool(detail.get("is_featured")),
        "featuredTags": detail.get("featured_tags") or [],
        "serviceUrl": detail.get("service_url"),
        "endpoints": [
            {
                "method": endpoint["method"],
                "path": endpoint["path"],
                "url": endpoint["url"],
                "title": endpoint.get("title") or endpoint["path"],
                "subtitle": endpoint.get("subtitle") or endpoint["path"],
                "description": endpoint.get("description") or description,
                "useCase": endpoint.get("use_case") or use_case,
                "i18n": endpoint.get("i18n")
                or {
                    "zh-CN": _zh_copy(
                        endpoint.get("title") or endpoint["path"],
                        endpoint.get("subtitle") or endpoint["path"],
                        endpoint.get("description") or description,
                        endpoint.get("use_case") or use_case,
                    )
                },
                "metered": bool(endpoint.get("metered")),
                "minPriceUsd": endpoint.get("min_price_usd", 0),
                "maxPriceUsd": endpoint.get("max_price_usd", 0),
            }
            for endpoint in detail.get("endpoints", [])
        ],
        "status": detail.get("status")
        or {
            "catalog": "draft",
            "gateway": "unknown",
            "payment": "unknown",
            "upstream": "unknown",
        },
    }


def _pay_markdown_from_detail(detail: dict[str, Any]) -> str:
    lines = [
        f"# {detail.get('title') or detail['fqn']}",
        "",
        "## Service",
        "",
        f"- FQN: `{detail['fqn']}`",
        f"- Service URL: `{detail.get('service_url')}`",
        f"- Category: `{detail.get('category')}`",
        f"- Chains: `{', '.join(detail.get('chains') or [])}`",
        "",
        "## Endpoints",
        "",
    ]
    for endpoint in detail.get("endpoints", []):
        metered = bool(endpoint.get("metered"))
        price = endpoint.get("min_price_usd")
        lines.extend(
            [
                f"### {endpoint.get('method')} {endpoint.get('path')}",
                "",
                endpoint.get("description") or "",
                "",
                f"- URL: `{endpoint.get('url')}`",
                f"- Metered: `{str(metered).lower()}`",
                f"- Price: `${price}`",
                "",
            ]
        )
        if metered:
            lines.extend(
                [
                    "```bash",
                    f"x402-cli pay '{endpoint.get('url')}'",
                    "```",
                    "",
                ]
            )
        else:
            lines.extend(["No payment required.", ""])
    lines.extend(
        [
            "## Notes",
            "",
            "This file is public. Do not include upstream API keys, bearer tokens, provider.yml, `.env`, passwords, or private infrastructure URLs.",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


@click.group()
def catalog() -> None:
    """Search and inspect public x402 provider catalog."""


@catalog.command("update")
@click.option("--catalog", "catalog_url", default=None, help="Catalog URL or local catalog.json.")
@click.option("--json", "output_json", is_flag=True, help="Print machine-readable JSON.")
def update(catalog_url: str | None, output_json: bool) -> None:
    """Cache the latest catalog index locally."""
    source = catalog_url or default_catalog()
    payload = _read_json(source)
    _write_json(cached_catalog_path(), payload)
    detail_count, pay_count = _cache_provider_assets(source, payload)
    result = {
        "source": source,
        "path": str(cached_catalog_path()),
        "providerCount": payload.get("provider_count", len(payload.get("providers", []))),
        "detailCount": detail_count,
        "payCount": pay_count,
    }
    if output_json:
        click.echo(json.dumps(result, indent=2, sort_keys=True))
        return
    click.echo(f"cached {result['providerCount']} provider(s) from {source}")
    if detail_count or pay_count:
        click.echo(f"cached {detail_count} provider detail file(s), {pay_count} pay file(s)")
    click.echo(str(cached_catalog_path()))


@catalog.command("search")
@click.argument("query")
@click.option("--catalog", default=None, help="Catalog URL or local catalog.json.")
@click.option("--limit", "-n", type=int, default=10, help="Maximum result count.")
@click.option("--json", "output_json", is_flag=True, help="Print machine-readable JSON.")
def search(query: str, catalog: str | None, limit: int, output_json: bool) -> None:
    """Search providers by use case, category, endpoint, chain, or tag."""
    source = _catalog_source(catalog)
    hits = search_gateway_catalog(query, catalog=source, limit=limit)
    if output_json:
        click.echo(
            json.dumps(
                {
                    "query": query,
                    "catalog": source,
                    "count": len(hits),
                    "results": [hit.to_dict() for hit in hits],
                },
                indent=2,
                sort_keys=True,
            )
        )
        return
    if not hits:
        click.echo("no matches")
        raise click.exceptions.Exit(code=1)
    for hit in hits:
        tags = ",".join(hit.tags) if hit.tags else "-"
        click.echo(f"{hit.fqn:32s}  score={hit.score:<3d}  category={hit.category:12s}  tags={tags}")
        click.echo(f"  {hit.title}")
        if hit.description:
            click.echo(f"  {hit.description}")
        if hit.service_url:
            click.echo(f"  service: {hit.service_url}")


@catalog.command("show")
@click.argument("fqn")
@click.option("--catalog", default=None, help="Catalog URL or local catalog.json.")
@click.option("--json", "output_json", is_flag=True, help="Print machine-readable JSON.")
def show(fqn: str, catalog: str | None, output_json: bool) -> None:
    """Show provider details."""
    source = _catalog_source(catalog)
    payload = _read_json(_detail_source(source, fqn))
    if output_json:
        click.echo(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return
    click.echo(f"{payload['fqn']} - {payload['title']}")
    click.echo(payload.get("subtitle") or "")
    click.echo(payload.get("description") or "")
    click.echo(f"service: {payload.get('service_url')}")
    click.echo(f"category: {payload.get('category')}  chains: {', '.join(payload.get('chains') or [])}")


@catalog.command("endpoints")
@click.argument("fqn")
@click.option("--catalog", default=None, help="Catalog URL or local catalog.json.")
@click.option("--json", "output_json", is_flag=True, help="Print machine-readable JSON.")
def endpoints(fqn: str, catalog: str | None, output_json: bool) -> None:
    """List callable endpoints for a provider."""
    source = _catalog_source(catalog)
    payload = _read_json(_detail_source(source, fqn))
    items = payload.get("endpoints", [])
    if output_json:
        click.echo(json.dumps({"fqn": fqn, "endpoints": items}, ensure_ascii=False, indent=2, sort_keys=True))
        return
    for endpoint in items:
        price = endpoint.get("min_price_usd")
        click.echo(f"{endpoint.get('method', ''):6s} {endpoint.get('path', '')}  ${price}")
        click.echo(f"  {endpoint.get('url')}")
        if endpoint.get("description"):
            click.echo(f"  {endpoint['description']}")


@catalog.command("pay-json")
@click.argument("fqn")
@click.option("--catalog", default=None, help="Catalog URL or local catalog.json.")
def pay_json(fqn: str, catalog: str | None) -> None:
    """Print provider pay.json for Agent or automation usage."""
    source = _catalog_source(catalog)
    click.echo(json.dumps(_read_json(_pay_source(source, fqn)), ensure_ascii=False, indent=2, sort_keys=True))


@catalog.command("export-gateway")
@click.argument("gateway_url")
@click.option("--provider", "provider_fqn", required=True, help="Provider FQN loaded in gateway.")
@click.option(
    "--output-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help="Output directory. Defaults to providers/<fqn> under current directory.",
)
@click.option("--json", "output_json", is_flag=True, help="Print machine-readable JSON.")
def export_gateway(
    gateway_url: str,
    provider_fqn: str,
    output_dir: Path | None,
    output_json: bool,
) -> None:
    """Export public catalog files from a running self-hosted gateway."""
    base = gateway_url.rstrip("/")
    detail = _read_json(f"{base}/__402/catalog/providers/{provider_fqn}.json")
    target = output_dir or Path("providers") / provider_fqn
    target.mkdir(parents=True, exist_ok=True)
    catalog_path = target / "catalog.json"
    pay_md_path = target / "pay.md"
    _write_json(catalog_path, _submission_catalog(detail))
    pay_md_path.write_text(_pay_markdown_from_detail(detail), encoding="utf-8")
    result = {
        "provider": provider_fqn,
        "catalog": str(catalog_path),
        "payMd": str(pay_md_path),
    }
    if output_json:
        click.echo(json.dumps(result, indent=2, sort_keys=True))
        return
    click.echo(f"wrote {catalog_path}")
    click.echo(f"wrote {pay_md_path}")
