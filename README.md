# x402-cli

TypeScript command-line client for BankofAI x402 payments. This version uses
the npm TypeScript SDK packages only:

- `@bankofai/x402-core@1.0.1-beta.2`
- `@bankofai/x402-evm@1.0.1-beta.2`
- `@bankofai/x402-tron@1.0.1-beta.2`

Stablecoin payments support `scheme=exact` and TRON `scheme=exact_gasfree`.
The GasFree flow lets the relayer pay network energy while deducting its fee
from the payment token, so the payer does not need TRX.

## Install

```bash
npm install
npm run build
```

Run from source during development:

```bash
npm run dev -- serve --pay-to <recipient> --amount 0.0001 --network tron:nile --token USDT
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
node dist/cli.js serve \
  --pay-to <recipient> \
  --amount 0.0001 \
  --network tron:nile \
  --token USDT \
  --port 4020
```

The server exposes:

- `GET /health`
- `GET /.well-known/x402`
- `GET /pay` returns `402 Payment Required`
- `POST /pay` verifies and settles with the facilitator

### Pay

Pay an x402-protected URL:

```bash
TRON_PRIVATE_KEY=<hex> \
node dist/cli.js pay http://127.0.0.1:4020/pay \
  --network tron:nile \
  --token USDT
```

Pay a TRON GasFree endpoint (the CLI normally selects this automatically from
the server challenge):

```bash
TRON_PRIVATE_KEY=<hex> \
node dist/cli.js pay https://api.example.com/pay \
  --network tron:nile \
  --token USDT \
  --scheme exact_gasfree
```

Use `--gasfree-api-url <url>` or `X402_GASFREE_API_URL` to override the SDK's
default relayer endpoint.

For EVM networks use `EVM_PRIVATE_KEY` or `PRIVATE_KEY`.

### Roundtrip

Start a temporary local server and immediately pay it:

```bash
TRON_PRIVATE_KEY=<hex> \
node dist/cli.js roundtrip \
  --pay-to <recipient> \
  --amount 0.0001 \
  --network tron:nile \
  --token USDT
```

## Networks

Supported built-in token registry:

- `tron:mainnet` USDT, USDD
- `tron:nile` USDT, USDD
- `tron:shasta` USDT
- `eip155:56` USDT
- `eip155:97` USDT, USDC

Aliases accepted:

- `tron-mainnet` -> `tron:mainnet`
- `tron-nile` -> `tron:nile`
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
