# `x402-cli`

The BankofAI command-line client for the x402 protocol — pay any x402-protected URL, run your own paywall, or test the full handshake locally. **No code required.**

`x402-cli` is the developer tool for one-off payment tests. For production provider onboarding with `providers/**/provider.yml`, use [`x402-gateway`](https://github.com/BofAI/x402-gateway). Both projects depend on the same [`bankofai-x402`](https://github.com/BofAI/x402) SDK.

## 1. Install

```bash
pip install --pre bankofai-x402-cli
x402-cli --version
```

## 2. Set up a wallet (one-time)

`x402-cli` delegates all signing to [`bankofai-agent-wallet`](https://github.com/BofAI/agent-wallet). Fastest path — import a 32-byte hex private key:

```bash
agent-wallet start raw_secret \
  --wallet-id payer \
  --private-key 0x<your-32-byte-hex-private-key>
```

> A single key derives both an EVM address and a TRON address. **You don't need a separate wallet per chain.**
>
> Other setup paths (encrypted local store, mnemonic, Privy-managed): see [agent-wallet — Getting Started](https://github.com/BofAI/agent-wallet/blob/main/doc/getting-started.md).

## 3. What each command does

| Command | Who you are | What it does |
|---|---|---|
| **`x402-cli pay <url>`** | The payer | Hits a URL, and if the server returns `402 Payment Required`, the cli signs + submits the payment + retrieves the response. |
| **`x402-cli serve`** | The recipient | Starts a local `402` paywall endpoint that only returns content after a valid payment is settled. |
| **`x402-cli roundtrip`** | Self-test / one-shot transfer | Spins up a `serve` in the background, runs `pay` against it, and tears it down. **The fastest way to make a payment from the command line** — and the easiest way to verify your install end-to-end. |
| **`x402-cli catalog search <query>`** | API consumer / agent runtime | Searches the public x402 catalog to find a matching paid capability before calling it. |
| **`x402-cli catalog export-gateway <url> --provider <fqn>`** | API provider | Exports public `catalog.json` and `pay.md` files from a self-hosted gateway for PR submission. |

Catalog search can read the hosted catalog, a local `dist/catalog.json`, or a gateway-exported catalog URL. This is the discovery step for agents and local tooling: the user asks for a capability, the catalog search finds matching paid APIs, then the normal x402 payment client can call the selected gateway URL.

```bash
export X402_CATALOG=https://catalog.bankofai.io/api/catalog.json
x402-cli catalog update
x402-cli catalog search "weather"
x402-cli catalog show acme-weather
x402-cli catalog endpoints acme-weather
x402-cli catalog pay-json acme-weather
```

For local gateway development:

```bash
cd ../x402-gateway
docker compose up --build -d gateway
docker compose --profile tools run --rm catalog-build

cd ../x402-cli
PYTHONPATH=src python -m bankofai.x402_cli.cli catalog search \
  "weather" \
  --catalog ../x402-catelog/dist/catalog.json
```

Expected flow with the gateway:

```text
Natural-language intent
  -> x402-cli catalog search
  -> x402-cli catalog show/endpoints/pay-json
  -> provider endpoint from the catalog
  -> x402-cli pay <gateway endpoint>
  -> x402 SDK handles the 402 challenge and payment retry
  -> upstream API result
```

Provider onboarding flow:

```bash
x402-cli catalog export-gateway https://gateway.example.com \
  --provider acme-weather \
  --output-dir providers/acme-weather
```

The command writes public PR files only:

```text
providers/acme-weather/catalog.json
providers/acme-weather/pay.md
```

Do not submit `provider.yml`, `.env`, upstream API keys, bearer tokens, or passwords.

## 4. Copy-paste: a USDT transfer on TRON mainnet

Replace `<recipient-TRON-address>` with a real `T...` address and run:

```bash
x402-cli roundtrip \
  --pay-to <recipient-TRON-address> \
  --amount 1 \
  --token USDT \
  --network tron:mainnet
```

Successful output (excerpt):

```json
{
  "ok": true,
  "result": {
    "scheme": "exact_permit",
    "amount": "1000000",
    "paid": true,
    "transaction": "<64-hex-tx-hash>"
  }
}
```

Verify on chain at `https://tronscan.org/#/transaction/<tx-hash>`.

> **What just happened?** Your wallet signed a permit off-chain (free, no gas), and the facilitator submitted it on chain on your behalf. **You pay no TRX per payment** — the facilitator covers gas.
>
> *First-time only*: if this is your wallet's first payment for this token, the cli will ask you to sign and broadcast a one-time `approve` transaction (~6 TRX on mainnet) so the PaymentPermit contract can move tokens on your behalf later. After that, every payment is gas-free from your side.
>
> **Don't have any TRX at all?** Add `--scheme exact_gasfree` to skip even that one-time approve — it routes everything through a GasFree relayer that fronts gas in exchange for a per-settlement fee deducted from a derived custodial address. Setup: [docs/manual-test-guide.md → Walkthrough A](docs/manual-test-guide.md#4-walkthrough-a--tron-nile--exact_gasfree).

### Templates for other networks

| Network | Replace `--network` with | Notes |
|---|---|---|
| TRON mainnet (default permit) | `tron:mainnet` | Facilitator pays per-payment gas. One-time ~6 TRX approve when you first use a token from a fresh wallet. Add `--scheme exact_gasfree` to skip that too. |
| BSC mainnet (USDT permit) | `eip155:56` | Same model — facilitator pays per-payment gas; one-time approve fee in BNB on first use. |
| TRON Nile (testnet) | `tron:nile` | [Faucet](https://nileex.io/join/getJoinPage) |
| BSC Testnet | `eip155:97` | [Faucet](https://testnet.bnbchain.org/faucet-smart) |

To force a specific settlement scheme (instead of the auto-pick), add `--scheme exact_gasfree | exact_permit | exact`.

## 5. Amount units

```
rawAmount = amount × 10^decimals
```

| What you mean | Flag to use |
|---|---|
| "1.25 USDT" (human-readable decimal) | `--amount 1.25` |
| `1250000` (smallest on-chain unit, USDT has 6 decimals) | `--rawAmount 1250000` |

Spending caps on `pay` follow the same split: `--max-amount` / `--max-rawAmount`.

## 6. Common errors

| Error | Resolution |
|---|---|
| `Insufficient GasFree balance` | The GasFree custodial address is underfunded. See [top-up steps](docs/manual-test-guide.md#42-top-up-gasfreeaddress). |
| `cannot import name 'TokenRegistry' …` | You're on `bankofai-x402-cli ≤ 0.1.0b10`. Upgrade: `pip install --pre --upgrade bankofai-x402-cli`. |
| `resolve_wallet could not find a wallet source` | No wallet configured yet. Go back to step 2. |
| Stuck on `Master Password:` prompt | A `local_secure` wallet without a persisted runtime password. Re-run with `--save-runtime-secrets`. |
| `too many pending transfers` | GasFree relayer rate limit. Wait 30–60s and retry. |

Full troubleshooting matrix: [docs/manual-test-guide.md → Troubleshooting](docs/manual-test-guide.md#7-troubleshooting).

## Learn more

- [docs/manual-test-guide.md](docs/manual-test-guide.md) — full hands-on walkthroughs from install to on-chain tx, covering TRON GasFree, TRON permit, and BSC permit.
- [FEATURES.md](FEATURES.md) — full flag matrix and example output for each command.
- [agent-wallet docs](https://github.com/BofAI/agent-wallet) — wallet setup options (Privy, mnemonic, encrypted local store).
- [bankofai-x402 SDK](https://pypi.org/project/bankofai-x402/) — the underlying protocol and its programmatic API, in case you want to integrate directly instead of through the cli.
