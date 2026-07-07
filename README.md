# x402-cli

TypeScript command-line client for BankofAI x402 payments. This version uses
the npm TypeScript SDK packages only:

- `@bankofai/x402-core@1.0.0`
- `@bankofai/x402-evm@1.0.0`
- `@bankofai/x402-tron@1.0.0`

Stablecoin payments use `scheme=exact` with
`extra.assetTransferMethod=permit2`.

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

Set a facilitator URL when needed:

```bash
FACILITATOR_URL=https://facilitator.bankofai.io
```

CLI payment challenges and payload selection always emit `scheme: "exact"` for
the SDK 1.0 Permit2 path.
