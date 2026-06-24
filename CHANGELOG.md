# Changelog

All notable changes to `bankofai-x402-cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1b7] — 2026-06-24

### Changed

- Point the default hosted catalog URL at `https://x402-catelog.bankofai.io/api/catalog.json`.
- Refresh CLI README and community examples to use production `x402-gateway.bankofai.io` mainnet routes.
- Align catalog command fixtures with the merged production provider catalog: SunPump TRON/BSC mainnet `exact_permit` routes.

## [0.6.1b6] — 2026-06-12

### Changed

- Classify token `TRANSFER_FROM_FAILED` settlement reverts as `TOKEN_TRANSFER_FAILED` with a payer balance/token mismatch hint.

## [0.6.1b5] — 2026-06-12

### Changed

- Re-publish the CLI beta after PyPI accepted `0.6.1b2` through `0.6.1b4` files without exposing them in the simple package index.

## [0.6.1b4] — 2026-06-11

### Changed

- Point the default hosted catalog URL at `https://tm-x402-catelog.bankofai.io/api/catalog.json`.
- Refresh Bank of AI gateway examples to `https://tm-x402-gateway.bankofai.io`.
- Cache provider detail and pay JSON files during `x402-cli catalog update`, with remote fallback from catalog `base_url` when local detail files are missing.

## [0.6.1b2] — 2026-06-11

### Added

- **`x402-mcp` stdio server** — exposes the existing catalog and payment flows as MCP tools for agents. Tools include `catalog_search`, `catalog_show`, `catalog_endpoints`, `catalog_pay_json`, `x402_pay`, and `wallet_status`.
- **MCP setup guide** — `mcp/README.md` documents Claude Code and Codex CLI configuration using the same `bankofai-x402-cli` package.

### Notes

- The MCP server reuses `x402-cli` and Agent Wallet behavior; there is no separate payment implementation or wallet path.

## [0.1.0] — 2026-05-08

First stable release. Consolidates everything from `0.1.0-beta.5` through `0.1.0-beta.17`. The package is `pip install bankofai-x402-cli` (no `--pre` needed) and the binary is `x402-cli`.

### What you get

- **Three commands** — `x402-cli pay <url>`, `x402-cli serve`, `x402-cli roundtrip`. Each has a one-paragraph `--help` and a short summary in the top-level command list.
- **Wallet** — fully delegated to [`bankofai-agent-wallet`](https://github.com/BofAI/agent-wallet) (`raw_secret`, `local_secure`, `privy`, mnemonic). One private key derives both EVM and TRON addresses; no `--wallet` flag, no in-tree env fallback.
- **Settlement schemes** — auto-picked per `(network, token)` registry; override with `--scheme exact_gasfree | exact_permit | exact`. **TRON USDT / USDD default to `exact_permit`** (verified stable on mainnet by multiple QA on-chain receipts). With `exact_permit`, per-payment gas is paid by the facilitator — the payer signs an off-chain permit and the wallet's native-token balance does not move on each payment. The cli's `ensure_allowance` step does ask the payer to broadcast a one-time `approve` when first using a given token's PaymentPermit contract (~6 TRX on TRON mainnet); subsequent payments are gas-free from the payer's perspective. `exact_gasfree` is registered as an opt-in second choice for payers who don't want even that one-time approve. BSC USDT/USDC default to `exact_permit`; BSC Testnet DHLU defaults to `exact` (ERC-3009).
- **Networks** — TRON (`tron:mainnet` / `tron:nile` / `tron:shasta`) and EVM (`eip155:56` / `eip155:97`).
- **Tokens** — USDT / USDC / USDD / DHLU through the registry, plus `--asset` + `--decimals` for any other ERC-20.
- **Amount** — `rawAmount = amount × 10^decimals`. `--amount` / `--rawAmount` are mutually exclusive; `pay` mirrors them as `--max-amount` / `--max-rawAmount`.
- **Output** — JSON envelope with `--json`, human-readable line-per-field by default. SDK's noisy `TRON_GRID_API_KEY` startup warning is silenced — falling back to the BankofAI gateway is the documented default for cli users.
- **Friendly errors** — 10 classified codes (`WALLET_NOT_CONFIGURED`, `WALLET_CONFIG_CORRUPT`, `INSUFFICIENT_GASFREE_BALANCE`, `GASFREE_NOT_ACTIVATED`, `TRON_ACCOUNT_NOT_ACTIVATED`, `INSUFFICIENT_GAS`, `RATE_LIMITED`, `DEADLINE_TOO_SOON`, `PERMIT_REVERTED`, `SDK_API_DRIFT`) each with a one-line resolution hint. Anything unmatched falls back to `IO_ERROR` with a pointer to the troubleshooting doc.
- **Compat shim** — `_tron_patch.py` fills in the `raw_data_hex` field on TRON unsigned transactions that all released `tronpy` versions (0.4–0.6) leave empty, using tronpy's own protobuf serializer. Without this, the privy wallet adapter (which strictly requires non-empty `raw_data_hex`) cannot sign approval transactions on TRON. Verified bit-for-bit equal to tronpy's own `txid` calculation. Idempotent and forward-compatible — becomes a no-op the day the SDK starts emitting `raw_data_hex` natively.
- **TokenRegistry/AssetRegistry import-drift tolerance** — pre-installed older or newer SDKs are auto-aligned by pip; cli accepts either symbol name at import time.
- **Pinned dependency upper bounds** — `bankofai-x402[evm,tron]>=0.5.9,<0.6`, `bankofai-agent-wallet>=2.4,<3`, plus caps on click/httpx/pydantic/fastapi/uvicorn. A future major bump of any dependency cannot silently land in user environments.
- **Documentation** — English-only, end-user-facing README on PyPI plus `docs/manual-test-guide.md` with three full hands-on walkthroughs (TRON GasFree, TRON permit, BSC permit) ending in real on-chain receipts.

### On-chain receipts (verified end-to-end on a clean PyPI install)

| Network + scheme | tx hash |
|---|---|
| `tron:nile` + `exact_permit` | [`f2c5ed31…`](https://nile.tronscan.org/#/transaction/f2c5ed31a5bb07ae7de4d35094b589f7197de6ccb444014eadcd6914e03e6e33) |
| `tron:nile` + `exact_gasfree` | [`133a0edb…`](https://nile.tronscan.org/#/transaction/133a0edb32f394fdb35797e51224745bec35ddcd081b81d00468aab710aa414f) |
| `eip155:97` + `exact_permit` | [`ff8bff7e…`](https://testnet.bscscan.com/tx/ff8bff7ee35d63a44fb6c9109af7f1c616a2c2863a11f8f25f477d13ada5552f) |
| `tron:mainnet` + `exact_permit` (QA, b16+ raw_data_hex patch) | [`fd1c6678…`](https://tronscan.org/#/transaction/fd1c6678574f7d68454ad76c1ab2efaddaabbcbb61e5f123575619d8c662dba4) |
| `tron:mainnet` + `exact_permit` (QA, local serve) | [`9ad3be69…`](https://tronscan.org/#/transaction/9ad3be693d42c6aed3ff732f2072b6ca26fc0d878dac1326058a44de8636f078) |
| `tron:mainnet` + `exact_permit` (QA, roundtrip) | [`1383a0db…`](https://tronscan.org/#/transaction/1383a0db66c46520fafb1ad98db7d7ce8a6b68ad0fb12131704ec78b7f1959a6) |

### Known limitations (not cli bugs)

- **TRON main-wallet activation** — fresh TRON addresses (e.g. brand-new privy wallets) must receive at least one inflow before they can be the owner of a contract call. cli now surfaces the node's `account does not exist` error as `TRON_ACCOUNT_NOT_ACTIVATED` with a one-line hint.
- **BSC USDC `0x8AC76a51…`** does not implement `transferWithAuthorization` (or `permit`). `--scheme exact` against this token will revert at the facilitator's settle step. This is a (token, scheme) compatibility matter for the facilitator, not the cli.

## [0.1.0-beta.17] — 2026-05-07

### Added

- **Friendly error for "TRON account does not exist"** ([errors.py](src/bankofai/x402_cli/errors.py)). When a fresh TRON address tries to sign its first contract call, full nodes reject with `Contract validate error : account [T...] does not exist`. This is a TRON activation rule (every address must have received any inflow once before it can be the owner of a contract call), not a cli/SDK bug. The cli now classifies this error as `TRON_ACCOUNT_NOT_ACTIVATED` and prints a one-line hint: send ~1 TRX from any other wallet/exchange to bootstrap the address, or use `--scheme exact_gasfree` to skip the activation requirement entirely.

## [0.1.0-beta.16] — 2026-05-07

### Fixed

- **TRON `exact_permit` first-time approval no longer fails on `privy` wallets** ([_tron_patch.py](src/bankofai/x402_cli/_tron_patch.py)). The SDK's `_build_unsigned_tx_payload` ships the unsigned TRON tx with `raw_data_hex=None` because tronpy 0.4–0.6 don't expose `raw_data_hex` on the `Transaction` object. The local `raw_secret` / `local_secure` adapters tolerated this (they sign `txID` directly), but the new `privy` adapter in `bankofai-agent-wallet` 2.4 strictly requires a non-empty `raw_data_hex` for compliance review and rejected the payload with `Payload must include raw_data_hex for TRON signing`. The cli now monkey-patches `TronClientSigner._build_unsigned_tx_payload` at import time to fill in the missing `raw_data_hex` using tronpy's own protobuf serialization helper (the same code path tronpy itself uses for offline txid calculation). Verified bit-equal against `txn.txid`. Idempotent and forward-compatible — when the SDK starts emitting `raw_data_hex` natively, the patch becomes a no-op.

### Added

- `protobuf>=4.21,<7` direct dependency, required by `tronpy.proto` for the patch above.

### Notes

- This unblocks `--scheme exact_permit` on TRON for any wallet backend that doesn't accept `None` payloads (privy, future hosted signers). raw_secret / local_secure / mnemonic flows already worked and remain unchanged.

## [0.1.0-beta.15] — 2026-05-01

### Changed

- **Dependency tree cleaned up**:
  - Removed direct `web3` and `tronpy` declarations from `pyproject.toml`. Cli source never imports either; they are pulled in through the SDK's own `[evm,tron]` extras now (`bankofai-x402[evm,tron]>=0.5.9,<0.6`). Version ranges for those two libs are now owned by the SDK, not duplicated here.
  - Net dependency graph and resolved versions are unchanged for end users.
- **`x402-cli` with no arguments now prints `--help`** instead of an empty error. `-h` is also accepted as an alias for `--help`.
- **Top-level `--help` includes a "Common flows" section, a one-line first-time-setup hint, and a copy-paste GasFree example**, so users see what to do without leaving the terminal.
- **`--scheme` help text** lists every supported value (`exact_gasfree` / `exact_permit` / `exact`) with a one-phrase explanation, plus "omit to auto-pick from the (network, token) registry."

### Added

- **Friendly error classifier** (`bankofai.x402_cli.errors`). Common failure modes now ship with a `hint` line in the error envelope:
  - `WALLET_NOT_CONFIGURED`, `WALLET_CONFIG_CORRUPT` — agent-wallet missing / corrupt
  - `INSUFFICIENT_GASFREE_BALANCE`, `GASFREE_NOT_ACTIVATED` — GasFree-specific
  - `INSUFFICIENT_GAS` — EVM/permit path with no native gas token
  - `RATE_LIMITED`, `DEADLINE_TOO_SOON`, `PERMIT_REVERTED`
  - `SDK_API_DRIFT` — for the TokenRegistry/AssetRegistry case from b11
  - Anything unmatched falls back to `IO_ERROR` with a pointer to the troubleshooting doc.

### Fixed

- `specs/smoke-tests.md` example referenced the long-removed `--decimal` flag. Updated to `--amount`.

## [0.1.0-beta.14] — 2026-04-30

### Changed

- **Silence the SDK's "TRON_GRID_API_KEY is not set" startup warning.** The fallback (`https://hptg.bankofai.io`) is the documented default for cli users, so emitting it as `WARNING` on every invocation is noise, not signal. Cli now sets `bankofai.x402.utils.tron_client` to `ERROR` level in `setup_logging()`. Users who *do* want TronGrid still configure `TRON_GRID_API_KEY` exactly as before.

## [0.1.0-beta.13] — 2026-04-30

### Changed

- **README is now English-only** so the PyPI project page renders correctly for non-CN readers. Same structure and content as b12 — the rewrite into a user-facing layout (install → wallet → command roles → copy-paste GasFree transfer → other-network templates → amount units → common errors) is unchanged. Wallet/setup details continue to live in [agent-wallet's getting-started doc](https://github.com/BofAI/agent-wallet/blob/main/doc/getting-started.md), and the multi-scheme hands-on walkthrough is still in [docs/manual-test-guide.md](docs/manual-test-guide.md).

### Verified

Same on-chain test matrix as b12 (no code changes between b12 and b13), so the b12 testnet roundtrips remain authoritative for runtime behavior.

## [0.1.0-beta.12] — 2026-04-30

### Fixed

- **Pin all dependency upper bounds** so a future major-version release of any dep can no longer silently land in user environments and break us, repeating the b10/v2-SDK incident:
  - `bankofai-x402>=0.5.9,<0.6` (was `>=0.5.9` — the one that bit us)
  - `bankofai-agent-wallet>=2.4,<3` (was `>=2.4`)
  - `pydantic>=2.0,<3` (was `>=2.0`)
  - `fastapi>=0.110,<1.0` (was `>=0.110`)
  - `uvicorn>=0.27,<1.0` (was `>=0.27`)
  - `click>=8.1.0,<10` (was `>=8.1.0`)
  - `httpx`, `web3`, `tronpy` already had caps — kept as-is.

### Changed

- **README rewritten for end users**, not contributors. New flow: install → wallet setup (one command + link out) → what each of the three commands is for → a copy-paste GasFree TRON-mainnet transfer → other-network templates → amount units → common errors. Removed the "Design", "Environment variables", and "Development" sections.

### Verified

Three real-testnet roundtrips against the b12 wheel from a clean venv:

| Network + scheme | tx hash |
|---|---|
| `tron:nile` + `exact_permit` | [`887c65b6…`](https://nile.tronscan.org/#/transaction/887c65b63a81009ca7ccc1545575189bf4b604174205187638189b3d61e1cdcb) |
| `tron:nile` + `exact_gasfree` | [`524d01f8…`](https://nile.tronscan.org/#/transaction/524d01f8ac1451bfd7d0fd835922c7930a4714749efe28471bd6a10dc064375b) |
| `eip155:97` + `exact_permit` | [`90bd524e…`](https://testnet.bscscan.com/tx/90bd524e7cda5a9587ab7212e3a9efea5e0725fe4d249e53b4a460f89bdd6e4e) |

## [0.1.0-beta.11] — 2026-04-30

### Fixed

- **SDK symbol-rename break**: `bankofai-x402` renamed `TokenRegistry` → `AssetRegistry` mid-stream. Fresh installs were fine (PyPI's `bankofai-x402==0.5.9` still has `TokenRegistry`), but environments with a newer SDK already preinstalled (e.g. anaconda3 base) would `ImportError: cannot import name 'TokenRegistry' from 'bankofai.x402'` on `x402-cli --help`. Each call site now does `try TokenRegistry / except → AssetRegistry as TokenRegistry`, so either symbol resolves. No SDK changes; CLI only.

### Changed

- **Module rename**: `src/bankofai/x402_tools/` → `src/bankofai/x402_cli/`. The package on PyPI, the binary, and the docs were all already `x402-cli`; only the importable Python module still carried the old name. Tracebacks, `python -m bankofai.x402_cli.cli`, and the `roundtrip` subprocess invocation now match.
- **`--network` / `--token` help text** lists every supported value (`tron:mainnet`, `tron:nile`, `tron:shasta`, `eip155:56`, `eip155:97`; `USDT`, `USDC`, `USDD`, `DHLU`) instead of the previous vague "e.g. tron:nile, eip155:97".

### Added

- [`docs/manual-test-guide.md`](docs/manual-test-guide.md) — end-to-end walkthrough covering install → agent-wallet setup → on-chain test for three combinations: TRON Nile + `exact_gasfree`, TRON Nile + `exact_permit`, BSC Testnet + `exact_permit`. Uses an isolated `AGENT_WALLET_DIR` so users don't have to nuke their existing `~/.agent-wallet/`.

### Removed

- README "Design" section (internal-implementation note, not user-facing). The only useful bit (per-network default scheme rationale) moved into a new compact "Schemes" table.
- README's multi-step agent-wallet setup walkthrough: now two sentences plus a link out to [agent-wallet — Getting Started](https://github.com/BofAI/agent-wallet/blob/main/doc/getting-started.md).

### Verified

Three real-testnet roundtrips against this exact wheel from PyPI:

| Network + scheme | tx hash |
|---|---|
| `tron:nile` + `exact_permit` | [`d99103df…`](https://nile.tronscan.org/#/transaction/d99103df399e50875b02ebce919af73638801b682fe00b97c65671aea92e3fe0) |
| `tron:nile` + `exact_gasfree` | [`133a0edb…`](https://nile.tronscan.org/#/transaction/133a0edb32f394fdb35797e51224745bec35ddcd081b81d00468aab710aa414f) |
| `eip155:97` + `exact_permit` | [`ff8bff7e…`](https://testnet.bscscan.com/tx/ff8bff7ee35d63a44fb6c9109af7f1c616a2c2863a11f8f25f477d13ada5552f) |

## [0.1.0-beta.10] — 2026-04-29

### Fixed

- **`pay --token <symbol>` was a dead flag**. The CLI parsed it and threaded it through to `cmd_client`, but the filter dict passed to `select_payment_requirements` only contained `network` and `scheme`, so `--token foo` was silently ignored. The SDK's selector also doesn't take a `token` filter, so the CLI now filters candidates itself by symbol (case-insensitive) via `TokenRegistry.find_by_address` *before* delegating to the SDK. `--token foo` now errors out with `No payment options match --token foo among N offered`.

### Changed (breaking)

- **Removed `--wallet` flag**. All signing now goes through `bankofai-agent-wallet` unconditionally. agent-wallet itself picks between its encrypted local store (`~/.agent-wallet/`) and env vars (`AGENT_WALLET_PRIVATE_KEY` / `TRON_PRIVATE_KEY` / `AGENT_WALLET_MNEMONIC` / `TRON_MNEMONIC`), so no in-tree fallback is needed.
- Removed `LocalTronWallet` / `LocalEvmWallet` / `read_private_key` from `wallet.py`. The module is now ~10 lines that just call `TronClientSigner.create()` / `EvmClientSigner.create()`.

### Added

- **README "Wallet — agent-wallet" section** explaining the two setup paths (`agent-wallet start` for the encrypted store, or one env var for ad-hoc use).
- `bankofai-agent-wallet>=2.4` declared as a direct dependency (was previously only transitive via `bankofai-x402`).

### Removed

- Direct deps `eth-account` and `eth-keys` (still pulled in transitively by the SDK; the CLI itself no longer imports them).

### Migration

| beta.9 invocation | beta.10 equivalent |
|---|---|
| `x402-cli serve --wallet env ...` | `x402-cli serve ...` (set `TRON_PRIVATE_KEY` first, or run `agent-wallet start`) |
| `x402-cli pay --wallet agent-wallet ...` | `x402-cli pay ...` |

## [0.1.0-beta.9] — 2026-04-29

### Changed (breaking)

- **Swap `--amount` / `--rawAmount` semantics to match the math** `rawAmount = amount × 10^decimals`. Previous betas had this backwards.
  - `--amount` is now the **human-readable** decimal (e.g. `1.25`).
  - `--rawAmount` is now the **smallest-unit integer** (e.g. `1250000` for 1.25 USDT).
  - Same swap for `--max-amount` (human-readable cap) / `--max-rawAmount` (smallest-unit cap).
  - JSON output fields `amount` and `rawAmount` follow the new convention.
- `--max-rawAmount` is now actually wired up (was previously documented but unimplemented).

### Migration from beta.8 and earlier

| Old (wrong) | New (correct) |
|---|---|
| `--rawAmount 1.25` | `--amount 1.25` |
| `--amount 1250000` | `--rawAmount 1250000` |
| `--max-rawAmount 1.25` | `--max-amount 1.25` |
| `--max-amount 1250000` | `--max-rawAmount 1250000` |

## [0.1.0-beta.8] — 2026-04-29

### Fixed

- **Add `web3` and `tronpy` to runtime dependencies**: EVM `exact_permit` allowance checks call `web3` (via the SDK's `EvmClientSigner.ensure_allowance`); TRON balance reads call `tronpy`. Without them, fresh installs fail at first chain access.

## [0.1.0-beta.7] — 2026-04-29

### Fixed

- **Pin httpx < 1.0.0**: PyPI was resolving `httpx 1.0.dev3` (a pre-release with breaking API changes — `httpx.AsyncClient` was removed). Cap to the stable 0.x series.
- **Pin `eth-account` and `eth-keys`** to known-good majors so `eth-account 0.14b1` (currently on PyPI) is not picked up.

## [0.1.0-beta.6] — 2026-04-29

### Fixed

- **Missing runtime dependencies**: add `fastapi`, `uvicorn`, `eth-account`, `eth-keys` to `pyproject.toml`. beta.5 imports these but did not declare them, breaking fresh installs.
- **Documentation**: replace residual `x402-tools` references in `README.md`, `FEATURES.md`, `specs/README.md` with `x402-cli`. Replace deprecated `--max-decimal` with `--max-rawAmount`.

## [0.1.0-beta.5] — 2026-04-29

### Fixed

- **TRON `exact_gasfree`**: properly initialize `ExactGasFreeClientMechanism` with required `clients` argument (`GasFreeAPIClient` instances per network).
- **TRON address format**: convert EVM hex (derived from private key) to TRON Base58 before passing to GasFree API, which rejects 0x-prefixed addresses.
- **EIP-712 / TIP-712 signing**: introduce `LocalTronWallet` and `LocalEvmWallet` classes implementing `sign_typed_data(typed_data)` so that env-based wallets can sign payment permits.
- **`paymentPermitContext`**: forward `extensions` from the 402 response to `create_payment_payload`, fixing `PermitValidationError("missing_context")` for `exact_permit` schemes.
- **HTTP timeout**: bump client timeout from 10s to 60s to accommodate facilitator settlement latency on TRON Nile and BSC.
- **Error logging**: include traceback and `repr(err)` fallback when the exception message is empty.

### Verified on-chain

- **TRON Nile** (`exact_gasfree`): roundtrip + serve/pay both succeed end-to-end via `https://facilitator.bankofai.io/nile`.
- **BSC Testnet** (`exact_permit`): roundtrip succeeds end-to-end via the main facilitator.

## [0.1.0-beta.3] — 2026-04-29

### Added

First public beta of the Python x402-cli CLI.

- **Binary**: `x402-cli`, published as `bankofai-x402-cli`.
- **`x402-cli serve`** — starts a local x402 payment server using the SDK's `X402Server`.
  - Endpoints: `GET /health`, `GET /.well-known/x402`, `GET | POST /pay`.
  - Supports `--rawAmount | --amount`, `--network`, `--token`, `--scheme`, `--host`, `--port`.
  - Human output and `--json` envelope report payment terms.
- **`x402-cli pay <url>`** — pays an x402-protected URL.
  - Probes once; if not 402, prints summary and exits.
  - On 402, parses requirements, filters against `--max-rawAmount | --max-amount | --network | --token | --scheme`.
  - Signs and retries with payment payload.
- **Wallet selector** (D1) — `--wallet agent-wallet` (default) or `--wallet env`.
- **Auto-scheme picker** — maps (network, token) to recommended scheme.
- **Wrapped JSON envelope** (D2) — every command emits `{ ok, command, network?, scheme?, result | error }`.
- **15 standardized error codes**.

### Design note

Unlike the TypeScript CLI which implements its own HTTP server and facilitator client, the Python CLI directly uses:

- `bankofai.x402.server.X402Server` — no duplication of challenge-response logic
- `bankofai.x402.facilitator.FacilitatorClient` — no duplication of `/verify` / `/settle` calls

This keeps the Python tools thin and avoids the code divergence seen in the TS version.
