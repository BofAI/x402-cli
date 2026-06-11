# Manual Testing Guide — x402-cli on TRON & BSC

End-to-end walkthroughs for verifying x402-cli against real testnets. Every command is copy-paste runnable. Use this when you want to:

- Confirm a fresh install works.
- Test a specific `(network, scheme)` combination by hand.
- Reproduce a bug report against a known-good baseline.

Each walkthrough ends with a real on-chain transaction you can inspect on Tronscan / BscScan.

---

## Contents

- [0. Prerequisites](#0-prerequisites)
- [1. Install](#1-install)
- [2. Configure `agent-wallet`](#2-configure-agent-wallet)
- [3. Pick a scheme](#3-pick-a-scheme)
- [4. Walkthrough A — TRON Nile + `exact_gasfree`](#4-walkthrough-a--tron-nile--exact_gasfree)
- [5. Walkthrough B — TRON Nile + `exact_permit`](#5-walkthrough-b--tron-nile--exact_permit)
- [6. Walkthrough C — BSC Testnet + `exact_permit`](#6-walkthrough-c--bsc-testnet--exact_permit)
- [7. Troubleshooting](#7-troubleshooting)

---

## 0. Prerequisites

| Item | Notes |
|---|---|
| Python ≥ 3.11 | `python3 --version` |
| One private key (32-byte hex) | Same key works for EVM and TRON. The two address derivations come from the same secp256k1 keypair. |
| A `pay-to` address | Can be the same address as the payer ("self-pay") or a separate one. |
| Test funds | TRON Nile USDT + TRX (Nile faucet) for walkthroughs A/B; BSC testnet USDT + BNB for walkthrough C. |

---

## 1. Install

```bash
pip install bankofai-x402-cli==0.6.1b3
x402-cli --version
agent-wallet --help | head -3      # confirm agent-wallet ships with the CLI
```

---

## 2. Configure `agent-wallet`

`x402-cli` delegates **all** signing to `bankofai-agent-wallet`. There is no `--wallet` flag. agent-wallet's resolution order:

1. Encrypted local store at `~/.agent-wallet/` (or `$AGENT_WALLET_DIR`).
2. Env vars (`AGENT_WALLET_PRIVATE_KEY`, `TRON_PRIVATE_KEY`, `AGENT_WALLET_MNEMONIC`, `TRON_MNEMONIC`).

If you want to keep your existing `~/.agent-wallet/` untouched, point agent-wallet at a throw-away directory:

```bash
export AGENT_WALLET_DIR=/tmp/x402-test-wallet     # used by both `agent-wallet` CLI and x402-cli
```

### 2.A Quick path — plaintext wallet (test only)

```bash
agent-wallet start raw_secret \
  --wallet-id payer \
  --private-key 0x<your-32-byte-hex-private-key>
```

### 2.B Recommended path — encrypted, non-interactive

```bash
agent-wallet start local_secure \
  --wallet-id payer \
  --private-key 0x<...> \
  --save-runtime-secrets
# prompts for a master password, then persists it so x402-cli won't prompt again
```

### 2.C Verify

```bash
agent-wallet list                   # active wallet should show '*'
agent-wallet resolve-address payer  # prints derived EVM (0x…) and TRON (T…) addresses
```

Take note of both addresses — you'll need them in the walkthroughs.

### 2.D Skip agent-wallet entirely

Set one env var; the cli's fallback uses agent-wallet's `EnvWalletProvider` directly:

```bash
export TRON_PRIVATE_KEY=0x<your-key>
```

---

## 3. Pick a scheme

| Scheme | Payer pays gas? | USDT debited from | When to use |
|---|---|---|---|
| `exact_permit` (EVM, TRON) — **default for USDT/USDD/USDC** | Yes (TRX/BNB on payer) | Payer's main wallet | Token supports EIP-2612 / TIP-2612 `permit` and payer holds gas |
| `exact_gasfree` (TRON only, opt-in) | **No** — relayer pays | Payer's `gasFreeAddress` (custodial) | Payer has no TRX; willing to pre-fund a GasFree address |
| `exact` (EVM, default for DHLU on BSC Testnet) | Yes | Payer's main wallet | Token supports ERC-3009 `transferWithAuthorization` |

x402-cli auto-selects per `(network, token)` from the registry; on TRON USDT/USDD that's **`exact_permit`**, with `exact_gasfree` registered as an opt-in second choice. Override with `--scheme <name>`.

---

## 4. Walkthrough A — TRON Nile + `exact_gasfree` (opt-in path)

> **Note**: `exact_permit` is the cli's default for TRON USDT (Walkthrough B is the default-path version). `exact_gasfree` is the **opt-in alternative** for payers who don't hold any TRX — you trade per-settlement fees for not paying TRX gas yourself. Pick this walkthrough if your scenario is "I have USDT but no TRX in this wallet."

GasFree means **the user's main TRON wallet does not need TRX**. A relayer pays gas. USDT is debited from a derived custodial address (`gasFreeAddress`), not the main wallet.

### 4.1 Read your `gasFreeAddress` and balance

```bash
PAYER=<your TRON Base58 address from step 2.C>
curl -s "https://facilitator.bankofai.io/nile/api/v1/address/$PAYER" | python3 -m json.tool
```

Look at:

```json
{
  "data": {
    "gasFreeAddress": "T...",         ← fund THIS address, not PAYER
    "active": false,                  ← first-time use auto-activates but costs ~2 USDT extra
    "assets": [{
      "tokenAddress": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      "balance": 0,                   ← raw smallest-unit (6 decimals)
      "transferFee": 1000000,         ← ≈1 USDT per settlement
      "activateFee": 2050000          ← ≈2.05 USDT, charged once if not active
    }]
  }
}
```

Required GasFree balance: `amount + transferFee + activateFee` (only the first time). For 0.0001 USDT payments, fund **≥ 5 USDT** to give yourself room.

### 4.2 Top up `gasFreeAddress`

Send Nile USDT to the `gasFreeAddress` from any TRON wallet. CLI option using `tronpy`:

```bash
python3 - <<'PY'
from tronpy import Tron
from tronpy.keys import PrivateKey
from tronpy.providers import HTTPProvider

priv = PrivateKey(bytes.fromhex("<your-private-key-no-0x>"))
client = Tron(HTTPProvider("https://api.nileex.io"))

USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
GASFREE = "<gasFreeAddress from 4.1>"
AMOUNT = 5_000_000   # 5 USDT in raw units

txn = (
    client.get_contract(USDT)
    .functions.transfer(GASFREE, AMOUNT)
    .with_owner(priv.public_key.to_base58check_address())
    .fee_limit(20_000_000)
    .build()
    .sign(priv)
)
print(txn.broadcast().wait())
PY
```

Wait ~10 seconds, re-run the curl from 4.1, and confirm `assets[0].balance > 0`.

### 4.3 One-shot roundtrip

You **must** pass `--scheme exact_gasfree` explicitly — the cli's default for TRON USDT is `exact_permit`.

```bash
x402-cli roundtrip \
  --pay-to <pay-to TRON address> \
  --amount 0.0001 \
  --network tron:nile \
  --token USDT \
  --scheme exact_gasfree \
  --json
```

Expected:

```json
{
  "ok": true,
  "result": {
    "scheme": "exact_gasfree",
    "amount": "100",
    "paid": true,
    "transaction": "<64-hex>"
  }
}
```

### 4.4 On-chain check

```
https://nile.tronscan.org/#/transaction/<tx-hash>
```

Notice the **payer's TRX balance is unchanged** — the relayer covered gas. USDT decreased on `gasFreeAddress`, increased on `pay-to`.

---

## 5. Walkthrough B — TRON Nile + `exact_permit` (DEFAULT)

This is the **default path** for TRON USDT — `--scheme exact_permit` is what the cli auto-picks if you don't override it. The flow:

1. Your wallet signs a permit **off-chain** (no gas, no broadcast).
2. The facilitator submits `permit + transferFrom` on chain on your behalf — **the facilitator pays the gas**, not you.

**One-time exception**: the very first payment from a fresh wallet to a given token contract triggers an extra `approve` transaction that you sign and broadcast yourself (so the PaymentPermit contract is allowed to move tokens on your behalf in future settlements). On Nile that costs ~6 TRX of energy. After that, all subsequent payments are gas-free from your wallet's perspective.

> Nile USDT (`TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf`) implements TIP-2612 correctly, so this path works on Nile. **TRON USDT defaults to `exact_permit` cli-wide** (mainnet too) — `exact_gasfree` is the opt-in fallback for payers without TRX.

### 5.1 Verify main-wallet balances

```bash
python3 - <<'PY'
from tronpy import Tron
from tronpy.providers import HTTPProvider

USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"
PAYER = "<your TRON address from step 2.C>"

client = Tron(HTTPProvider("https://api.nileex.io"))
print(f"USDT: {client.get_contract(USDT).functions.balanceOf(PAYER) / 10**6}")
print(f"TRX:  {client.get_account(PAYER).get('balance', 0) / 10**6}")
PY
```

Need: USDT > `amount`. TRX is **only required if this is the wallet's first payment for this token** — in that case ≳ 10 TRX covers the one-time `approve` (~6 TRX on Nile). After that first time, your wallet's TRX balance won't move during a payment — the facilitator covers gas for `permit + transferFrom`.

### 5.2 Start server (terminal A)

```bash
x402-cli serve \
  --pay-to <pay-to TRON address> \
  --amount 0.0001 \
  --network tron:nile \
  --token USDT \
  --scheme exact_permit \
  --port 4020
```

Wait for `Uvicorn running on http://127.0.0.1:4020`.

### 5.3 Probe + pay (terminal B)

```bash
# Sanity: confirm 402 advertises exact_permit
curl -s http://127.0.0.1:4020/.well-known/x402 | python3 -m json.tool
curl -s -i http://127.0.0.1:4020/pay | head -3   # HTTP/1.1 402 Payment Required

# Real payment
x402-cli pay http://127.0.0.1:4020/pay \
  --network tron:nile \
  --token USDT \
  --scheme exact_permit \
  --json
```

### 5.4 On-chain verification

```bash
TX=<tx-hash from 5.3 output>
python3 - <<PY
from tronpy import Tron
from tronpy.providers import HTTPProvider
client = Tron(HTTPProvider("https://api.nileex.io"))
info = client.get_transaction_info("$TX")
print("block:   ", info.get("blockNumber"))
print("receipt: ", info.get("receipt", {}).get("result"))
print("fee:     ", info.get("fee", 0) / 10**6, "TRX")
print("contract:", info.get("contract_address"))
PY
echo "https://nile.tronscan.org/#/transaction/$TX"
```

Expected: `receipt: SUCCESS`, contract = `TFxDcGvS7zfQrS1YzcCMp673ta2NHHzsiH` (Nile `PaymentPermit`).

If this is the wallet's **first** payment for this token, the cli also broadcasts a one-time `approve` (a separate tx, slightly earlier in the run) — that's what costs ~6 TRX from your wallet. The actual `permit + transferFrom` settlement above doesn't draw from your wallet at all (facilitator pays). **From the second payment onward, your TRX balance stays put.**

---

## 6. Walkthrough C — BSC Testnet + `exact_permit`

Same flow as walkthrough B, with EVM-flavored values.

```bash
# 1. Balance check (need BNB for gas, USDT for the payment)
python3 - <<'PY'
from web3 import Web3
RPC = "https://data-seed-prebsc-1-s1.binance.org:8545"
USDT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd"
PAYER = "<your EVM address from step 2.C>"

w3 = Web3(Web3.HTTPProvider(RPC))
abi = [{"name":"balanceOf","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"}]
print(f"USDT: {w3.eth.contract(address=USDT, abi=abi).functions.balanceOf(PAYER).call() / 10**18}")
print(f"BNB:  {w3.from_wei(w3.eth.get_balance(PAYER), 'ether')}")
PY

# 2. Roundtrip (auto picks exact_permit because there's no GasFree on BSC)
x402-cli roundtrip \
  --pay-to <pay-to EVM address> \
  --amount 0.0001 \
  --network eip155:97 \
  --token USDT \
  --json
```

Verify on BscScan: `https://testnet.bscscan.com/tx/<tx-hash>`.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `WalletsTopology … wallets.<id>.params Field required` at startup | A previous agent-wallet config is partially written | Run `agent-wallet reset -y` (deletes **all** wallets in `$AGENT_WALLET_DIR`) and redo step 2 |
| Stuck on `Master Password:` prompt when running x402-cli | `local_secure` wallet without persisted runtime secret | Recreate with `--save-runtime-secrets`, or use 2.A `raw_secret` |
| `resolve_wallet could not find a wallet source` | No wallet config and no env var | Run step 2; fallback option is 2.D |
| `Insufficient GasFree balance` (walkthrough A) | gasFreeAddress balance < amount + transferFee + (activateFee if first time) | Top up gasFreeAddress (4.2) and re-check (4.1) |
| `GasFree account not activated` | First-time use of a gasFreeAddress | Make sure balance covers `activateFee`; first settlement auto-activates |
| `too many pending transfers` | GasFree relayer rate limit | Wait 30–60s, retry |
| `429 Too Many Requests` from facilitator | Settlement endpoint rate limit | Wait 30–60s, retry |
| Settlement reverts with `permit`-related error (walkthrough B/C) | Token contract's `permit` domain doesn't match SDK's | Use `exact_gasfree` on TRON, or `exact` on EVM if the token supports ERC-3009 |
| `web3 not available for approval` | Stale environment without `web3` (shouldn't happen on ≥ beta.10) | `pip install --upgrade bankofai-x402-cli` |
| `deadline too soon` (TRON) | System clock skew | Sync system time (NTP) |
| `Address already in use: 4020` | Previous `serve` not cleaned up | `pkill -f bankofai.x402_cli` or use `--port 4021` |

---

## Quick reference card

```
# install
pip install bankofai-x402-cli==0.6.1b3

# wallet (one-time, plaintext for testing)
export AGENT_WALLET_DIR=/tmp/x402-test-wallet
agent-wallet start raw_secret --wallet-id payer --private-key 0x...
agent-wallet resolve-address payer    # note the EVM and TRON addresses

# TRON permit — DEFAULT (payer's main wallet pays TRX gas)
x402-cli roundtrip --pay-to <T...> --amount 0.0001 --network tron:nile --token USDT

# TRON GasFree — opt-in path (relayer pays gas; needs gasFreeAddress pre-funded)
x402-cli roundtrip --pay-to <T...> --amount 0.0001 --network tron:nile --token USDT --scheme exact_gasfree

# BSC permit
x402-cli roundtrip --pay-to <0x...> --amount 0.0001 --network eip155:97 --token USDT
```
