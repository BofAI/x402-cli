# x402-cli

TypeScript command-line client for BankofAI x402 payments. This version uses
the npm TypeScript SDK packages only:

- `@bankofai/x402-core@1.0.1`
- `@bankofai/x402-evm@1.0.1`
- `@bankofai/x402-tron@1.0.1`

Stablecoin payments support `scheme=exact` and TRON `scheme=exact_gasfree`.
The GasFree flow lets the relayer pay network energy while deducting its fee
from the payment token, so the payer does not need TRX.

## Install

Install the CLI package:

```bash
npm install -g @bankofai/x402-cli@beta
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

For EVM networks use `EVM_PRIVATE_KEY` or `PRIVATE_KEY`.
Prefer environment variables over `--private-key` in shared environments,
because command-line arguments may be visible to other local processes.

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

## Networks

Supported built-in token registry:

- `tron:0x2b6653dc` USDT, USDD
- `tron:0xcd8690dc` USDT, USDD
- `tron:0x94a9059e` USDT
- `eip155:56` USDT
- `eip155:97` USDT, USDC

Non-CAIP TRON aliases are rejected. Use the canonical TRON IDs above.

EVM convenience aliases accepted:

- `bsc-mainnet` -> `eip155:56`
- `bsc-testnet` -> `eip155:97`

## Facilitator

Pass a facilitator URL when needed:

```bash
x402-cli serve --facilitator-url https://facilitator.bankofai.io ...
```

`serve --scheme exact_gasfree` advertises a TRON GasFree requirement. The
configured facilitator must advertise and settle `exact_gasfree` for that
network and token.
