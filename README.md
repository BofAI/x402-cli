# x402-cli

TypeScript command-line client for BankofAI x402 payments. This version uses
the npm TypeScript SDK packages only:

- `@bankofai/x402-core@1.0.1`
- `@bankofai/x402-evm@1.0.1`
- `@bankofai/x402-fetch@1.0.1`
- `@bankofai/x402-tron@1.0.1`

Stablecoin payments support `scheme=exact` and TRON `scheme=exact_gasfree`.
The GasFree flow lets the relayer pay network energy while deducting its fee
from the payment token, so the payer does not need TRX.

## Install

Install the CLI package:

```bash
npm install -g @bankofai/x402-cli@1.0.2
x402-cli --version
```

For repository development:

```bash
npm install
npm run build
```

Run from source during development:

```bash
npm run dev -- serve --pay-to <recipient> --amount 0.0001 --network tron:0xcd8690dc --token USDT
```

Run the compiled CLI:

```bash
node dist/cli.js <command> [options]
```

Common CLI options:

```bash
x402-cli --help
x402-cli --version
x402-cli pay --help
```

Output is human-readable by default. Add `--json` to commands such as `pay`,
`serve`, `gateway check`, and `catalog search` for a stable machine-readable
envelope with `ok`, `command`, `result`, or structured `error` fields.

## Commands

### Serve

Start a local x402 paywall endpoint:

```bash
x402-cli serve \
  --pay-to <recipient> \
  --amount 0.0001 \
  --network tron:0xcd8690dc \
  --token USDT \
  --port 4020
```

The server exposes:

- `GET /health`
- `GET /.well-known/x402`
- `/pay` returns `402 Payment Required` without a payment signature
- The signed retry uses the same HTTP method, then verifies and settles with the facilitator

### Pay

Pay an x402-protected URL:

```bash
TRON_PRIVATE_KEY=<hex> \
x402-cli pay http://127.0.0.1:4020/pay \
  --network tron:0xcd8690dc \
  --token USDT
```

For automated or unfamiliar endpoints, set `--max-amount` or
`--max-raw-amount` before allowing the CLI to sign a payment.
Registered token decimals are authoritative and cannot be overridden with
`--decimals`. For an explicit unregistered non-Base asset, pass both `--asset`
and `--decimals`.

Pay a TRON GasFree endpoint (the CLI normally selects this automatically from
the server challenge):

```bash
TRON_PRIVATE_KEY=<hex> \
x402-cli pay https://api.example.com/pay \
  --network tron:0xcd8690dc \
  --token USDT \
  --scheme exact_gasfree
```

Use `--gasfree-api-url <url>` or `X402_GASFREE_API_URL` to override the SDK's
default relayer endpoint.

GasFree fees are separate from the advertised payment amount. Set a fee limit
so the CLI estimates the relayer fee and rejects the payment before signing if
the estimate is too high:

```bash
x402-cli pay https://api.example.com/pay \
  --scheme exact_gasfree \
  --max-amount 0.01 \
  --max-gasfree-fee 0.5 \
  --json
```

Use `--max-gasfree-fee-raw` to express the fee limit in the token's smallest
unit. Successful and failed paid responses distinguish `settled` (payment
completed) from `delivered` (HTTP business response succeeded). A settled
upstream failure has `paid=true`, `settled=true`, and `delivered=false` and
includes its transaction information.

By default, `x402-cli pay` resolves the active wallet from
`@bankofai/agent-wallet` for the selected payment network and delegates signing
to the wallet. If configured wallets exist but none is active, the CLI stops
before signing instead of silently selecting the first available wallet. The
CLI does not read private keys from `wallets_config.json`.
Use `AGENT_WALLET_DIR` to select a non-default Agent Wallet directory, or
`AGENT_WALLET_ID` to explicitly select a configured wallet.

For development and CI only, `--private-key`, `EVM_PRIVATE_KEY`,
`TRON_PRIVATE_KEY`, or `PRIVATE_KEY` can explicitly override Agent Wallet.
Prefer environment variables over `--private-key` in shared environments,
because command-line arguments may be visible to other local processes.

Pay a Base Mainnet USDC endpoint:

```bash
x402-cli pay https://api.example.com/pay \
  --network base-mainnet \
  --token USDC \
  --max-amount 0.01 \
  --rpc-url <production-rpc-url>
```

Base uses the x402 `exact` EVM flow with USDC EIP-3009 authorization. The
built-in public RPC fallback is intended for development; production callers
should supply `--rpc-url`, `EVM_RPC_URL_8453`/`EVM_RPC_URL_84532`, or
`EVM_RPC_URL`.

The probe and signed retry do not automatically follow HTTP redirects. If an
endpoint redirects, inspect the destination and invoke the final trusted URL
explicitly so `PAYMENT-SIGNATURE` is never forwarded to another origin.

If the gateway settles a payment but the upstream request fails, JSON error
output includes `error.details.paymentResponse` for reconciliation. Do not retry
such a request blindly; inspect the transaction and provider behavior first.

### Roundtrip

Start a temporary local server and immediately pay it:

```bash
TRON_PRIVATE_KEY=<hex> \
x402-cli roundtrip \
  --pay-to <recipient> \
  --amount 0.0001 \
  --network tron:0xcd8690dc \
  --token USDT
```

With `--json`, roundtrip emits one JSON document containing separate `serve`
and `pay` results.

### Gateway and Catalog

Inspect and validate local Gateway providers:

```bash
x402-cli gateway check ./providers --json
x402-cli gateway catalog build ./providers --json
x402-cli gateway catalog search "token price" --catalog ./dist/catalog.json --json
```

Search and cache a hosted or local Catalog:

```bash
x402-cli catalog search "Base USDC" --json
x402-cli catalog update --catalog https://catalog.example/api/catalog.json --json
x402-cli catalog show defillama --json
x402-cli catalog endpoints defillama --json
x402-cli catalog pay-json defillama --json
```

Use `x402-cli gateway --help`, `x402-cli gateway catalog --help`, and
`x402-cli catalog <command> --help` for command-specific options.

## Networks

Supported built-in token registry:

- `tron:0x2b6653dc` USDT, USDD
- `tron:0xcd8690dc` USDT, USDD
- `tron:0x94a9059e` USDT
- `eip155:56` USDT
- `eip155:97` USDT, USDC
- `eip155:8453` USDC
- `eip155:84532` USDC

Non-CAIP TRON aliases are rejected. Use the canonical TRON IDs above.

EVM convenience aliases accepted:

- `bsc-mainnet` -> `eip155:56`
- `bsc-testnet` -> `eip155:97`
- `base-mainnet` -> `eip155:8453`
- `base-sepolia` -> `eip155:84532`

## Facilitator

Pass a facilitator URL when needed:

```bash
x402-cli serve --facilitator-url https://facilitator.bankofai.io ...
```

`serve --scheme exact_gasfree` advertises a TRON GasFree requirement. The
configured facilitator must advertise and settle `exact_gasfree` for that
network and token.
