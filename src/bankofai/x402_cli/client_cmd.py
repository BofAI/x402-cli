"""Client command implementation."""

import json
import logging
import os
from typing import Any

import httpx

from bankofai.x402.clients import X402Client
from bankofai.x402.config import NetworkConfig
from bankofai.x402.encoding import decode_payment_payload, encode_payment_payload
from bankofai.x402.types import PaymentRequired
from bankofai.x402.utils.gasfree import GasFreeAPIClient

try:
    from bankofai.x402 import TokenRegistry
except ImportError:
    from bankofai.x402 import AssetRegistry as TokenRegistry  # noqa: F401

from bankofai.x402_cli.errors import classify
from bankofai.x402_cli.output import OutputMode, emit
from bankofai.x402_cli.wallet import resolve_evm_signer, resolve_tron_signer

logger = logging.getLogger(__name__)

PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE"
PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED"
PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE"


def _response_payload(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "json" in content_type.lower():
        try:
            return response.json()
        except ValueError:
            return response.text
    return response.text


async def cmd_client(
    url: str,
    max_raw_amount: str | None,
    max_amount: str | None,
    network: str | None,
    token: str | None,
    scheme: str | None,
    method: str,
    headers: tuple[str, ...],
    body: str | None,
    dry_run: bool,
    output_mode: OutputMode,
) -> None:
    """Pay an x402-protected URL."""

    try:
        if not url:
            raise ValueError("URL is required")

        if max_raw_amount and max_amount:
            raise ValueError("--max-rawAmount and --max-amount are mutually exclusive")

        # Parse custom headers into a dict
        custom_headers = {}
        for header in headers:
            if ":" not in header:
                raise ValueError(f"Invalid header format: {header} (expected Key: Value)")
            key, value = header.split(":", 1)
            custom_headers[key.strip()] = value.strip()

        async with httpx.AsyncClient(timeout=60.0) as client:
            # First request: probe for 402
            response = await client.request(
                method=method,
                url=url,
                headers=custom_headers,
                content=body,
            )

            if response.status_code != 402:
                result = {
                    "url": url,
                    "status": response.status_code,
                    "message": "Not a payment-required endpoint",
                    "response": _response_payload(response),
                }
                emit(
                    command="client",
                    result=result,
                    mode=output_mode,
                )
                return

            # Parse 402 response
            payment_required_header = response.headers.get(PAYMENT_REQUIRED_HEADER)
            if not payment_required_header:
                raise ValueError("402 response missing PAYMENT-REQUIRED header")

            try:
                payment_required = decode_payment_payload(
                    payment_required_header, PaymentRequired
                )
            except Exception as err:
                raise ValueError(f"Failed to parse payment requirements: {err}")

            if not payment_required.accepts:
                raise ValueError("No payment options available")

            # Determine the appropriate signer based on available networks
            # We need to create the right signer type before creating mechanisms
            networks_in_options = set(opt.network for opt in payment_required.accepts)
            primary_network = next(iter(networks_in_options))
            if primary_network.startswith("tron:"):
                signer = await resolve_tron_signer()
            elif primary_network.startswith("eip155:"):
                signer = await resolve_evm_signer()
            else:
                raise ValueError(f"Unknown network: {primary_network}")

            # Now create client and register mechanisms with signer
            client_obj = X402Client()
            _register_client_mechanisms(client_obj, payment_required.accepts, signer)

            # SDK's select_payment_requirements only knows scheme+network, so
            # --token (symbol) is filtered here before delegating.
            candidates = list(payment_required.accepts)
            if token:
                wanted = token.upper()
                filtered = []
                for req in candidates:
                    info = TokenRegistry.find_by_address(req.network, req.asset)
                    if info and info.symbol.upper() == wanted:
                        filtered.append(req)
                if not filtered:
                    raise ValueError(
                        f"No payment options match --token {token} "
                        f"among {len(candidates)} offered"
                    )
                candidates = filtered

            # Select payment requirements based on filters
            selected = await client_obj.select_payment_requirements(
                candidates,
                filters={
                    "network": network,
                    "scheme": scheme,
                } if any([network, scheme]) else None,
            )

            # Validate amount constraints
            # selected.amount is in smallest unit (raw integer string).
            actual_raw = int(selected.amount or "0")
            if max_raw_amount:
                if actual_raw > int(max_raw_amount):
                    raise ValueError(
                        f"Payment rawAmount {actual_raw} exceeds --max-rawAmount {max_raw_amount}"
                    )
            if max_amount:
                from decimal import Decimal

                token_info = TokenRegistry.find_by_address(selected.network, selected.asset)
                decimals = token_info.decimals if token_info else 6
                actual_human = Decimal(actual_raw) / (10 ** decimals)
                if actual_human > Decimal(max_amount):
                    raise ValueError(
                        f"Payment amount {actual_human} exceeds --max-amount {max_amount}"
                    )

            # Extract extensions (e.g. paymentPermitContext) from 402 response
            extensions_dict = None
            if payment_required.extensions:
                extensions_dict = payment_required.extensions.model_dump(by_alias=True)

            # Create payment payload
            payload = await client_obj.create_payment_payload(
                selected,
                resource=url,
                extensions=extensions_dict,
            )

            if dry_run:
                result = {
                    "url": url,
                    "network": selected.network,
                    "scheme": selected.scheme,
                    "asset": selected.asset,
                    "amount": selected.amount,
                    "pay_to": selected.pay_to,
                    "message": "Dry run - no payment submitted",
                }
                emit(
                    command="client",
                    result=result,
                    mode=output_mode,
                    network=selected.network,
                    scheme=selected.scheme,
                )
                return

            # Second request: submit payment signature
            payment_header = encode_payment_payload(payload.model_dump(by_alias=True))
            retry_headers = custom_headers.copy()
            retry_headers[PAYMENT_SIGNATURE_HEADER] = payment_header

            retry_response = await client.request(
                method=method,
                url=url,
                headers=retry_headers,
                content=body,
            )

            if retry_response.status_code != 200:
                # Server returned a non-200 on the retry — surface it as a
                # structured error with hint, not as a "successful" envelope.
                body = retry_response.text[:500]
                pseudo = RuntimeError(
                    f"HTTP {retry_response.status_code} from {url}: {body}"
                )
                emit(
                    command="client",
                    error=classify(pseudo).to_dict(),
                    mode=output_mode,
                )
                return

            # Success
            result = {
                "url": url,
                "status": retry_response.status_code,
                "network": selected.network,
                "scheme": selected.scheme,
                "asset": selected.asset,
                "amount": selected.amount,
                "paid": True,
                "response": _response_payload(retry_response),
            }

            # Parse response header if available
            response_header = retry_response.headers.get(PAYMENT_RESPONSE_HEADER)
            if response_header:
                try:
                    import base64
                    decoded_bytes = base64.b64decode(response_header)
                    response_data = json.loads(decoded_bytes.decode('utf-8'))
                    if isinstance(response_data, dict):
                        result["transaction"] = response_data.get("transaction")
                except Exception:
                    pass

            emit(
                command="client",
                result=result,
                mode=output_mode,
                network=selected.network,
                scheme=selected.scheme,
            )

    except Exception as err:
        logger.error(f"Client error: {err}", exc_info=True)
        emit(
            command="client",
            error=classify(err).to_dict(),
            mode=output_mode,
        )


def _get_gasfree_api_base_url(network: str) -> str:
    """Get GasFree API base URL from env var, falling back to NetworkConfig."""
    env_suffix = network.split(":")[-1].upper()
    return os.getenv(f"GASFREE_API_BASE_URL_{env_suffix}") or NetworkConfig.get_gasfree_api_base_url(network)


def _register_client_mechanisms(
    client: X402Client,
    requires: list[Any],
    signer: Any,
) -> None:
    """Register payment mechanisms based on required payment options."""
    networks_schemes: dict[str, set[str]] = {}
    for req in requires:
        network = req.network
        scheme = req.scheme
        if network not in networks_schemes:
            networks_schemes[network] = set()
        networks_schemes[network].add(scheme)

    # Pre-build GasFree API clients for any TRON networks that need them
    gasfree_clients = {}
    for network in networks_schemes:
        if network.startswith("tron:") and "exact_gasfree" in networks_schemes[network]:
            if network not in gasfree_clients:
                gasfree_clients[network] = GasFreeAPIClient(_get_gasfree_api_base_url(network))

    for network, schemes in networks_schemes.items():
        for scheme in schemes:
            try:
                if scheme == "exact":
                    if network.startswith("eip155:"):
                        from bankofai.x402.mechanisms.evm.exact import ExactEvmClientMechanism
                        client.register(network, ExactEvmClientMechanism(signer))
                elif scheme == "exact_permit":
                    if network.startswith("eip155:"):
                        from bankofai.x402.mechanisms.evm.exact_permit import ExactPermitEvmClientMechanism
                        client.register(network, ExactPermitEvmClientMechanism(signer))
                    elif network.startswith("tron:"):
                        from bankofai.x402.mechanisms.tron.exact_permit import ExactPermitTronClientMechanism
                        client.register(network, ExactPermitTronClientMechanism(signer))
                elif scheme == "exact_gasfree":
                    if network.startswith("tron:"):
                        from bankofai.x402.mechanisms.tron.exact_gasfree.client import ExactGasFreeClientMechanism
                        mechanism = ExactGasFreeClientMechanism(signer, clients=gasfree_clients)
                        client.register(network, mechanism)
            except Exception as err:
                logger.warning(f"Failed to register {scheme} mechanism for {network}: {err}")
