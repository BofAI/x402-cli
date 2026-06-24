# `x402-cli`

## 中文说明

`x402-cli` 是用户侧唯一需要记住的命令入口。它集成了三类能力：

- `x402-cli pay <url>`：调用 x402 付费接口，自动处理 402 challenge、签名和重试。
- `x402-cli catalog ...`：搜索公开 Catalog，找到适合的 API、endpoint、价格和调用说明。
- `x402-cli gateway ...`：服务方本地启动 Gateway、校验 provider、导出公开 Catalog PR 文件。

安装：

```bash
pip install bankofai-x402-cli==0.6.1b7
x402-cli --version
```

典型使用流程：

```bash
x402-cli catalog update
x402-cli catalog search "token launch"
x402-cli catalog show sunpump-token-launch
x402-cli catalog endpoints sunpump-token-launch
x402-cli catalog pay-json sunpump-token-launch
x402-cli pay 'https://x402-gateway.bankofai.io/providers/sunpump-token-launch-tron/pump-api/ai/agentTokenLaunch' \
  --method POST \
  --network tron:mainnet \
  --scheme exact_permit \
  --token USDT \
  --json '{"name":"TestAutoLaunch","symbol":"TAL","description":"sun flower 666","imageBase64":"","twitterUrl":"","telegramUrl":"","websiteUrl":"","tweetUsername":""}'
```

服务方提交流程：

```bash
x402-cli gateway check providers/sunpump-token-launch-tron/provider.yml
x402-cli gateway start --providers-dir providers --host 0.0.0.0 --port 4020
x402-cli catalog export-gateway https://x402-gateway.bankofai.io \
  --provider sunpump-token-launch-tron \
  --output-dir providers/sunpump-token-launch-tron
```

只把导出的 `catalog.json` 和 `pay.md` 提交到 `x402-catelog`。不要提交 `provider.yml`、`.env`、API key、bearer token 或钱包私钥。

## English

The BankofAI command-line client for the x402 protocol — pay any x402-protected URL, run your own paywall, or test the full handshake locally. **No code required.**

`x402-cli` is the single user-facing entrypoint. It includes payment commands, public catalog discovery, and provider gateway operations under one command tree. The gateway runtime is packaged underneath the CLI, so most users only install and remember `x402-cli`.

Community copy-paste examples live in [`examples/README.md`](examples/README.md).

## 1. Install

```bash
pip install bankofai-x402-cli==0.6.1b7
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
| **`x402-cli gateway start ...`** | API provider | Starts a self-hosted provider gateway from local `provider.yml` files. |
| **`x402-cli catalog export-gateway <url> --provider <fqn>`** | API provider | Exports public `catalog.json` and `pay.md` files from a self-hosted gateway for PR submission. |

Catalog search can read the hosted catalog, a local `dist/catalog.json`, or a gateway-exported catalog URL. This is the discovery step for agents and local tooling: the user asks for a capability, the catalog search finds matching paid APIs, then the normal x402 payment client can call the selected gateway URL.

```bash
export X402_CATALOG=https://x402-catelog.bankofai.io/api/catalog.json
x402-cli catalog update
x402-cli catalog search "token launch"
x402-cli catalog show sunpump-token-launch
x402-cli catalog endpoints sunpump-token-launch
x402-cli catalog pay-json sunpump-token-launch
```

For local gateway development:

```bash
x402-cli gateway scaffold sunpump-token-launch-tron \
  --output-dir providers/sunpump-token-launch-tron \
  --forward-url https://tn-api.sunpump.meme

x402-cli gateway check providers/sunpump-token-launch-tron/provider.yml
x402-cli gateway start --providers-dir providers --host 0.0.0.0 --port 4020
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
x402-cli gateway check providers/sunpump-token-launch-tron/provider.yml
x402-cli gateway start --providers-dir providers --host 0.0.0.0 --port 4020

x402-cli catalog export-gateway https://x402-gateway.bankofai.io \
  --provider sunpump-token-launch-tron \
  --output-dir providers/sunpump-token-launch-tron
```

The command writes public PR files only:

```text
providers/sunpump-token-launch/catalog.json
providers/sunpump-token-launch/pay.md
```

Do not submit `provider.yml`, `.env`, upstream API keys, bearer tokens, or passwords.

Provider catalog build commands are also under `x402-cli`:

```bash
x402-cli gateway catalog generate providers/sunpump-token-launch-tron/provider.yml
x402-cli gateway catalog pay-assets providers/sunpump-token-launch-tron/provider.yml
x402-cli gateway catalog check providers
x402-cli gateway catalog build providers --dist-dir dist
x402-cli gateway catalog search providers sunpump
```

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
