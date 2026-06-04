"""Search x402-gateway catalog artifacts from x402-cli."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx


@dataclass
class GatewaySearchHit:
    fqn: str
    title: str
    category: str
    service_url: str
    description: str | None = None
    use_case: str | None = None
    tags: list[str] = field(default_factory=list)
    endpoints: list[dict[str, Any]] = field(default_factory=list)
    score: int = 0
    matched_fields: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "fqn": self.fqn,
            "title": self.title,
            "category": self.category,
            "serviceUrl": self.service_url,
            "description": self.description,
            "useCase": self.use_case,
            "tags": self.tags,
            "score": self.score,
            "matchedFields": self.matched_fields,
            "endpoints": self.endpoints,
        }


def default_catalog() -> str:
    return os.environ.get(
        "X402_CATALOG",
        os.environ.get("X402_GATEWAY_CATALOG", "https://catalog.bankofai.io/api/catalog.json"),
    )


def _read_json(source: str) -> dict[str, Any]:
    if source.startswith(("http://", "https://")):
        response = httpx.get(source, timeout=10.0)
        response.raise_for_status()
        return response.json()
    return json.loads(Path(source).read_text())


def _provider_detail_source(catalog_source: str, fqn: str) -> str:
    filename = f"{fqn.replace('/', '__')}.json"
    if catalog_source.startswith(("http://", "https://")):
        base = catalog_source.rsplit("/", 1)[0].rstrip("/") + "/"
        return urljoin(base, f"providers/{filename}")
    catalog_path = Path(catalog_source)
    return str(catalog_path.parent / "providers" / filename)


def _read_provider_detail(catalog_source: str, fqn: str) -> dict[str, Any]:
    source = _provider_detail_source(catalog_source, fqn)
    try:
        return _read_json(source)
    except (FileNotFoundError, httpx.HTTPError, json.JSONDecodeError):
        return {}


FIELD_WEIGHTS = {
    "fqn": 12,
    "title": 10,
    "tags": 8,
    "category": 6,
    "endpoints": 6,
    "description": 4,
    "use_case": 4,
    "service_url": 2,
}


def _score(terms: list[str], fields: dict[str, list[str]]) -> tuple[int, list[str]]:
    score = 0
    matched: list[str] = []
    for field_name, values in fields.items():
        haystack = " ".join(str(value) for value in values if value is not None).lower()
        if not haystack:
            continue
        count = sum(1 for term in terms if term in haystack)
        if count:
            score += FIELD_WEIGHTS.get(field_name, 1) * count
            matched.append(field_name)
    return score, matched


def _endpoint_fields(endpoints: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for endpoint in endpoints:
        values.extend(
            [
                str(endpoint.get("method") or ""),
                str(endpoint.get("path") or ""),
                str(endpoint.get("probe_status") or ""),
            ]
        )
        paid = endpoint.get("paid")
        if isinstance(paid, dict):
            values.extend(
                [
                    str(paid.get("network") or ""),
                    str(paid.get("currency") or ""),
                    str(paid.get("amount_raw") or ""),
                ]
            )
        values.extend(
            [
                str(endpoint.get("title") or ""),
                str(endpoint.get("description") or ""),
                str(endpoint.get("use_case") or endpoint.get("useCase") or ""),
            ]
        )
    return values


def search_gateway_catalog(
    query: str,
    *,
    catalog: str | None = None,
    limit: int = 10,
    include_blocked: bool = False,
) -> list[GatewaySearchHit]:
    catalog_source = catalog or default_catalog()
    index = _read_json(catalog_source)
    terms = [term.lower() for term in query.split() if term.strip()]
    if not terms:
        return []

    hits: list[GatewaySearchHit] = []
    for provider in index.get("providers", []):
        if provider.get("block") and not include_blocked:
            continue
        fqn = str(provider.get("fqn") or "")
        if not fqn:
            continue

        detail = _read_provider_detail(catalog_source, fqn)
        tags = list(
            detail.get("featured_tags")
            or provider.get("featured_tags")
            or detail.get("tags")
            or provider.get("tags")
            or []
        )
        endpoints = list(detail.get("endpoints") or [])
        fields = {
            "fqn": [fqn],
            "title": [str(detail.get("title") or provider.get("title") or "")],
            "category": [str(detail.get("category") or provider.get("category") or "")],
            "service_url": [
                str(detail.get("service_url") or provider.get("service_url") or "")
            ],
            "description": [str(detail.get("description") or "")],
            "use_case": [str(detail.get("use_case") or detail.get("useCase") or "")],
            "tags": [str(tag) for tag in tags],
            "endpoints": _endpoint_fields(endpoints),
        }
        score, matched = _score(terms, fields)
        if score == 0:
            continue
        hits.append(
            GatewaySearchHit(
                fqn=fqn,
                title=fields["title"][0],
                category=fields["category"][0],
                service_url=fields["service_url"][0],
                description=fields["description"][0] or None,
                use_case=fields["use_case"][0] or None,
                tags=tags,
                endpoints=endpoints,
                score=score,
                matched_fields=matched,
            )
        )

    hits.sort(key=lambda hit: (-hit.score, hit.fqn))
    return hits[:limit]
