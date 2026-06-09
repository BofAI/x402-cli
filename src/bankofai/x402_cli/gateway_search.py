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
    title_zh: str | None = None
    main_title: str | None = None
    sub_title: str | None = None
    category_meta: dict[str, Any] | None = None
    chains: list[str] = field(default_factory=list)
    chain_kinds: list[str] = field(default_factory=list)
    chains_meta: list[dict[str, Any]] = field(default_factory=list)
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
            "title_zh": self.title_zh,
            "main_title": self.main_title,
            "sub_title": self.sub_title,
            "category_meta": self.category_meta,
            "chains": self.chains,
            "chain_kinds": self.chain_kinds,
            "chains_meta": self.chains_meta,
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
        payload = response.json()
    else:
        payload = json.loads(Path(source).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected JSON object from {source}")
    return payload


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
    "chain_kinds": 8,
    "chains": 8,
    "category": 6,
    "category_meta": 6,
    "endpoints": 6,
    "i18n": 5,
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


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if item is not None]


def _dict_values(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return []
    values: list[str] = []
    for child in value.values():
        if isinstance(child, dict):
            values.extend(_dict_values(child))
        elif isinstance(child, list):
            values.extend(str(item) for item in child if item is not None)
        elif child is not None:
            values.append(str(child))
    return values


def _chain_meta_values(chains_meta: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    for chain in chains_meta:
        values.extend(_dict_values(chain))
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
        category_meta = detail.get("category_meta") or provider.get("category_meta")
        if not isinstance(category_meta, dict):
            category_meta = None
        chains = _string_list(detail.get("chains") or provider.get("chains"))
        chain_kinds = _string_list(detail.get("chain_kinds") or provider.get("chain_kinds"))
        chains_meta_raw = detail.get("chains_meta") or provider.get("chains_meta") or []
        chains_meta = [
            item for item in chains_meta_raw
            if isinstance(item, dict)
        ] if isinstance(chains_meta_raw, list) else []
        title_zh = str(detail.get("title_zh") or provider.get("title_zh") or "")
        main_title = str(detail.get("main_title") or provider.get("main_title") or "")
        sub_title = str(detail.get("sub_title") or provider.get("sub_title") or "")
        fields = {
            "fqn": [fqn],
            "title": [
                str(detail.get("title") or provider.get("title") or ""),
                main_title,
            ],
            "i18n": [
                title_zh,
                sub_title,
                *_dict_values(detail.get("i18n") or provider.get("i18n")),
            ],
            "category": [str(detail.get("category") or provider.get("category") or "")],
            "category_meta": _dict_values(category_meta),
            "chains": [*chains, *_chain_meta_values(chains_meta)],
            "chain_kinds": chain_kinds,
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
                title_zh=title_zh or None,
                main_title=main_title or None,
                sub_title=sub_title or None,
                category_meta=category_meta,
                chains=chains,
                chain_kinds=chain_kinds,
                chains_meta=chains_meta,
                tags=tags,
                endpoints=endpoints,
                score=score,
                matched_fields=matched,
            )
        )

    hits.sort(key=lambda hit: (-hit.score, hit.fqn))
    return hits[:limit]
