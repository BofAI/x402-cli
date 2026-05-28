#!/usr/bin/env python3
"""x402-cli — serve or pay x402 endpoints."""

import asyncio
import json
import logging
import subprocess
import time

import click

from bankofai.x402_cli import __version__, _tron_patch
from bankofai.x402_cli.gateway_search import default_catalog, search_gateway_catalog
from bankofai.x402_cli.output import OutputMode
from bankofai.x402_cli.server_cmd import cmd_server
from bankofai.x402_cli.client_cmd import cmd_client

# Install the TRON raw_data_hex compat patch before any signing happens.
# See _tron_patch.py for the rationale.
_tron_patch.install()


def setup_logging() -> None:
    """Configure logging for CLI."""
    logging.basicConfig(
        level=logging.INFO,
        format="[%(name)s] %(levelname)s: %(message)s",
    )
    # The SDK emits a startup WARNING when TRON_GRID_API_KEY is unset,
    # but falling back to the BankofAI-hosted gateway is the intended
    # default for cli users — not a real warning. Silence it.
    logging.getLogger("bankofai.x402.utils.tron_client").setLevel(logging.ERROR)


@click.group(
    no_args_is_help=True,
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.version_option(__version__, prog_name="x402-cli")
def cli() -> None:
    """BankofAI x402 CLI — pay x402-protected URLs, run a paywall, or test the full flow.

    \b
    Common flows:
      x402-cli pay <url>          Pay an x402-protected URL.
      x402-cli serve --pay-to ... Run a 402 endpoint that charges to your address.
      x402-cli roundtrip ...      One-shot transfer: spin up serve → pay → tear down.

    \b
    First-time setup (one command):
      agent-wallet start raw_secret --wallet-id payer --private-key 0x...

    \b
    Example — GasFree USDT transfer on TRON mainnet:
      x402-cli roundtrip --pay-to T... --amount 1 --network tron:mainnet --token USDT

    See https://github.com/BofAI/x402-cli for the full guide.
    """
    setup_logging()


@cli.group()
def gateway() -> None:
    """Discover and use x402-gateway provider catalogs."""


@gateway.command("search")
@click.argument("query")
@click.option(
    "--catalog",
    type=str,
    default=None,
    help=(
        "Catalog source: local dist/skills.json or HTTPS URL. "
        "Defaults to $X402_GATEWAY_CATALOG or dist/skills.json."
    ),
)
@click.option("--limit", "-n", type=int, default=10, help="Maximum result count.")
@click.option(
    "--include-blocked",
    is_flag=True,
    help="Include providers whose catalog verdict is blocked.",
)
@click.option("--json", "output_json", is_flag=True, help="Print machine-readable JSON.")
def gateway_search(
    query: str,
    catalog: str | None,
    limit: int,
    include_blocked: bool,
    output_json: bool,
) -> None:
    """Search an x402-gateway catalog for capabilities.

    Example:
      x402-cli gateway search "weather"
    """
    catalog_source = catalog or default_catalog()
    try:
        hits = search_gateway_catalog(
            query,
            catalog=catalog_source,
            limit=limit,
            include_blocked=include_blocked,
        )
    except Exception as exc:
        raise click.ClickException(f"gateway search failed: {exc}") from exc

    if output_json:
        click.echo(
            json.dumps(
                {
                    "query": query,
                    "catalog": catalog_source,
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
        click.echo(
            f"{hit.fqn:32s}  score={hit.score:<3d}  "
            f"category={hit.category:12s}  tags={tags}"
        )
        click.echo(f"  {hit.title}")
        if hit.description:
            click.echo(f"  {hit.description}")
        if hit.service_url:
            click.echo(f"  service: {hit.service_url}")
        for endpoint in hit.endpoints[:3]:
            method = str(endpoint.get("method") or "")
            path = str(endpoint.get("path") or "")
            paid = endpoint.get("paid")
            suffix = ""
            if isinstance(paid, dict):
                suffix = (
                    f"  {paid.get('network', '')} "
                    f"{paid.get('currency', '')} "
                    f"{paid.get('amount_raw', '')}"
                ).rstrip()
            click.echo(f"  {method:6s} {path}{suffix}")
        click.echo("")


@cli.command()
@click.option(
    "--pay-to",
    required=True,
    help="Recipient wallet address",
)
@click.option(
    "--amount",
    type=str,
    help="Human-readable amount, e.g. 1.25 (mutually exclusive with --rawAmount)",
)
@click.option(
    "--rawAmount",
    type=str,
    help="Smallest-unit amount, e.g. 1250000 for 1.25 USDT (mutually exclusive with --amount)",
)
@click.option(
    "--network",
    required=True,
    help=(
        "Payment network (CAIP-2 ID). Supported: "
        "tron:mainnet, tron:nile, tron:shasta, "
        "eip155:56 (BSC), eip155:97 (BSC Testnet)."
    ),
)
@click.option(
    "--token",
    default="USDT",
    help=(
        "Token symbol from the registry. "
        "Supported: USDT, USDC, USDD, DHLU. Default: USDT."
    ),
)
@click.option(
    "--asset",
    type=str,
    help="Explicit token address (out of registry)",
)
@click.option(
    "--decimals",
    type=int,
    help="Token decimals when --asset is given",
)
@click.option(
    "--scheme",
    type=str,
    help=(
        "x402 settlement scheme. Supported: "
        "exact_gasfree (TRON only, gasless), "
        "exact_permit (EIP-2612/TIP-2612 permit, payer pays gas), "
        "exact (ERC-3009 transferWithAuthorization). "
        "Omit to let cli auto-pick from the (network, token) registry."
    ),
)
@click.option(
    "--host",
    default="127.0.0.1",
    help="Bind host (default: 127.0.0.1)",
)
@click.option(
    "--port",
    type=int,
    default=4020,
    help="Bind port (default: 4020)",
)
@click.option(
    "--resource-url",
    type=str,
    help="Resource URL advertised in x402 requirements",
)
@click.option(
    "--daemon",
    is_flag=True,
    help="Run server in background and print pid",
)
@click.option(
    "--json",
    "output_json",
    is_flag=True,
    help="Print server info as JSON",
)
def serve(
    pay_to: str,
    rawamount: str | None,
    amount: str | None,
    network: str,
    token: str,
    asset: str | None,
    decimals: int | None,
    scheme: str | None,
    host: str,
    port: int,
    resource_url: str | None,
    daemon: bool,
    output_json: bool,
) -> None:
    """Run a local x402 paywall endpoint.

    Advertises payment terms (network / token / amount / scheme) and only
    returns content after a valid signed payload is verified and settled.
    Foreground by default; `--daemon` runs in the background.
    """
    output_mode: OutputMode = "json" if output_json else "human"

    async def run() -> None:
        await cmd_server(
            pay_to=pay_to,
            raw_amount=rawamount,
            amount=amount,
            network=network,
            token=token,
            asset=asset,
            decimals=decimals,
            scheme=scheme,
            host=host,
            port=port,
            resource_url=resource_url,
            daemon=daemon,
            output_mode=output_mode,
        )

    asyncio.run(run())


@cli.command()
@click.argument("url")
@click.option(
    "--max-amount",
    type=str,
    help="Maximum human-readable amount allowed, e.g. 1.25",
)
@click.option(
    "--max-rawAmount",
    type=str,
    help="Maximum smallest-unit amount allowed, e.g. 1250000",
)
@click.option(
    "--network",
    type=str,
    help=(
        "Require a specific network (CAIP-2 ID). Supported: "
        "tron:mainnet, tron:nile, tron:shasta, "
        "eip155:56 (BSC), eip155:97 (BSC Testnet). "
        "Omit to accept any network the server advertises."
    ),
)
@click.option(
    "--token",
    type=str,
    help=(
        "Require a specific token symbol. "
        "Supported: USDT, USDC, USDD, DHLU. "
        "Omit to accept any token the server advertises."
    ),
)
@click.option(
    "--scheme",
    type=str,
    help=(
        "Require a specific x402 settlement scheme. Supported: "
        "exact_gasfree (TRON only, gasless), "
        "exact_permit (EIP-2612/TIP-2612 permit, payer pays gas), "
        "exact (ERC-3009 transferWithAuthorization). "
        "Omit to accept any scheme the server advertises."
    ),
)
@click.option(
    "--method",
    default="GET",
    help="HTTP method (default: GET)",
)
@click.option(
    "--header",
    multiple=True,
    help="HTTP header; can be repeated",
)
@click.option(
    "--body",
    type=str,
    help="Request body string or JSON",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Read payment requirements but do not sign or pay",
)
@click.option(
    "--json",
    "output_json",
    is_flag=True,
    help="Print machine-readable JSON",
)
def pay(
    url: str,
    max_rawamount: str | None,
    max_amount: str | None,
    network: str | None,
    token: str | None,
    scheme: str | None,
    method: str,
    header: tuple[str, ...],
    body: str | None,
    dry_run: bool,
    output_json: bool,
) -> None:
    """Pay an x402-protected URL.

    Hits URL; if the server returns 402 Payment Required, signs the
    advertised payload with the active wallet and retries. Returns the
    server's response on success, or a structured error with hint on
    failure.
    """
    output_mode: OutputMode = "json" if output_json else "human"

    async def run() -> None:
        await cmd_client(
            url=url,
            max_raw_amount=max_rawamount,
            max_amount=max_amount,
            network=network,
            token=token,
            scheme=scheme,
            method=method,
            headers=header,
            body=body,
            dry_run=dry_run,
            output_mode=output_mode,
        )

    asyncio.run(run())


@cli.command()
@click.option(
    "--pay-to",
    required=True,
    help="Recipient wallet address",
)
@click.option(
    "--amount",
    type=str,
    help="Human-readable amount, e.g. 1.25 (mutually exclusive with --rawAmount)",
)
@click.option(
    "--rawAmount",
    type=str,
    help="Smallest-unit amount, e.g. 1250000 for 1.25 USDT (mutually exclusive with --amount)",
)
@click.option(
    "--network",
    required=True,
    help=(
        "Payment network (CAIP-2 ID). Supported: "
        "tron:mainnet, tron:nile, tron:shasta, "
        "eip155:56 (BSC), eip155:97 (BSC Testnet)."
    ),
)
@click.option(
    "--token",
    default="USDT",
    help=(
        "Token symbol from the registry. "
        "Supported: USDT, USDC, USDD, DHLU. Default: USDT."
    ),
)
@click.option(
    "--asset",
    type=str,
    help="Explicit token address (out of registry)",
)
@click.option(
    "--decimals",
    type=int,
    help="Token decimals when --asset is given",
)
@click.option(
    "--scheme",
    type=str,
    help=(
        "x402 settlement scheme. Supported: "
        "exact_gasfree (TRON only, gasless), "
        "exact_permit (EIP-2612/TIP-2612 permit, payer pays gas), "
        "exact (ERC-3009 transferWithAuthorization). "
        "Omit to let cli auto-pick from the (network, token) registry."
    ),
)
@click.option(
    "--host",
    default="127.0.0.1",
    help="Bind host (default: 127.0.0.1)",
)
@click.option(
    "--port",
    type=int,
    default=4020,
    help="Bind port (default: 4020)",
)
@click.option(
    "--resource-url",
    type=str,
    help="Resource URL advertised in x402 requirements",
)
@click.option(
    "--json",
    "output_json",
    is_flag=True,
    help="Print result as JSON",
)
def roundtrip(
    pay_to: str,
    rawamount: str | None,
    amount: str | None,
    network: str,
    token: str,
    asset: str | None,
    decimals: int | None,
    scheme: str | None,
    host: str,
    port: int,
    resource_url: str | None,
    output_json: bool,
) -> None:
    """One-shot transfer: serve → pay → tear down.

    Spins up `serve` in a background subprocess, runs `pay` against it
    from the same process, then kills the subprocess. The fastest way to
    make a single payment from the command line.
    """
    output_mode: OutputMode = "json" if output_json else "human"

    async def run() -> None:
        import sys

        # Start daemon server
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "bankofai.x402_cli.cli",
                "serve",
                "--pay-to", pay_to,
                "--network", network,
                "--token", token,
                "--host", host,
                "--port", str(port),
            ] + (
                ["--rawAmount", rawamount] if rawamount else []
            ) + (
                ["--amount", amount] if amount else []
            ) + (
                ["--asset", asset] if asset else []
            ) + (
                ["--decimals", str(decimals)] if decimals else []
            ) + (
                ["--scheme", scheme] if scheme else []
            ) + (
                ["--resource-url", resource_url] if resource_url else []
            ),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Wait for server to start
        time.sleep(1)

        try:
            # Pay the server
            await cmd_client(
                url=f"http://{host}:{port}/pay",
                max_raw_amount=None,
                max_amount=None,
                network=network,
                token=token,
                scheme=scheme,
                method="GET",
                headers=(),
                body=None,
                dry_run=False,
                output_mode=output_mode,
            )
        finally:
            # Kill the server
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    asyncio.run(run())


def main() -> None:
    """CLI entry point."""
    cli()


if __name__ == "__main__":
    main()
