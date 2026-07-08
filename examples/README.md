# x402-cli Community Examples

This directory shows the common ways a community user should use `x402-cli`.
The CLI is the only user-facing entrypoint: payment, catalog discovery, and
gateway operations all live under `x402-cli`.

## 1. Install

```bash
pip install bankofai-x402-cli==0.6.1
x402-cli --version
```

Expected:

```text
x402-cli, version 0.6.1
```

## 2. Find a Paid API

Search the public catalog:

```bash
x402-cli catalog update
x402-cli catalog search "defillama"
x402-cli catalog show defillama
x402-cli catalog endpoints defillama
x402-cli catalog pay-json defillama
```

Use a local catalog during development:

```bash
x402-cli catalog search "defillama" \
  --catalog ../x402-catelog/dist/catalog.json \
  --json
```

## 3. Call a Paid API

After choosing an endpoint from the catalog:

```bash
x402-cli pay 'https://x402-gateway.bankofai.io/providers/defillama-tvl-tron/protocols' \
  --method GET \
  --network tron:mainnet \
  --scheme exact_permit \
  --token USDT \
  --max-amount 0.001
```

For a dry run that reads the payment requirement without signing:

```bash
x402-cli pay \
  'https://x402-gateway.bankofai.io/providers/defillama-tvl-tron/protocols' \
  --dry-run \
  --json
```

## 4. Start a Provider Gateway

Create a local provider configuration:

```bash
x402-cli gateway scaffold acme-weather \
  --output-dir providers/acme-weather \
  --forward-url https://api.example.com \
  --network tron:shasta
```

Validate and start it:

```bash
x402-cli gateway check providers/acme-weather/provider.yml
x402-cli gateway start --providers-dir providers --host 0.0.0.0 --port 4020
```

`provider.yml` is private. Do not submit it to the public catalog repository.

## 5. Export Public Catalog PR Files

After the gateway is reachable:

```bash
x402-cli catalog export-gateway https://gateway.example.com \
  --provider acme-weather \
  --output-dir providers/acme-weather
```

This writes:

```text
providers/acme-weather/catalog.json
providers/acme-weather/pay.md
```

Submit only these public files to `BofAI/x402-catelog`.

## 6. Agent/Codex Usage

Agents should use the catalog first, then call the selected endpoint:

```bash
x402-cli catalog search "defillama tvl" --json
x402-cli catalog pay-json defillama
x402-cli pay 'https://x402-gateway.bankofai.io/providers/defillama-tvl-tron/protocols' \
  --method GET \
  --network tron:mainnet \
  --scheme exact_permit \
  --token USDT \
  --max-amount 0.001
```

The catalog response gives the provider FQN, endpoint URL, price range, chains,
and human/agent-readable usage text.
