"""Friendly error mapping.

The cli sees a wide variety of exceptions: from agent-wallet (no wallet
configured), from the SDK (insufficient GasFree balance, deadline-too-soon),
from httpx (429, 5xx), from on-chain RPCs (insufficient gas). Surfacing the
raw exception message is rarely actionable. This module translates the
recognizable ones into a triplet ``(code, message, hint)`` so the cli can
emit a structured error with a one-line resolution hint.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FriendlyError:
    code: str
    message: str
    hint: str

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message, "hint": self.hint}


def classify(err: BaseException) -> FriendlyError:
    """Best-effort map an exception to (code, message, hint).

    Falls back to ``IO_ERROR`` with a generic hint when no rule matches.
    """
    msg = str(err)
    lower = msg.lower()

    # --- agent-wallet: nothing to sign with ---
    if "could not find a wallet source" in lower:
        return FriendlyError(
            code="WALLET_NOT_CONFIGURED",
            message=msg,
            hint=(
                "Run 'agent-wallet start raw_secret --wallet-id payer "
                "--private-key 0x...' once, or set TRON_PRIVATE_KEY / "
                "AGENT_WALLET_PRIVATE_KEY in your shell."
            ),
        )

    # --- agent-wallet: corrupted local config ---
    if "wallets.ma.params" in msg or "WalletsTopology" in msg:
        return FriendlyError(
            code="WALLET_CONFIG_CORRUPT",
            message=msg,
            hint=(
                "~/.agent-wallet/wallets_config.json is partially written. "
                "Run 'agent-wallet reset -y' to clear it, then redo "
                "'agent-wallet start ...'."
            ),
        )

    # --- GasFree custodial address underfunded ---
    if "InsufficientGasFreeBalance" in msg or "Insufficient GasFree balance" in msg:
        return FriendlyError(
            code="INSUFFICIENT_GASFREE_BALANCE",
            message=msg,
            hint=(
                "Top up your GasFree custodial address (NOT your main wallet). "
                "See docs/manual-test-guide.md → Walkthrough A → 4.2."
            ),
        )

    # --- GasFree account never settled before ---
    if "GasFreeAccountNotActivated" in msg or "not activated" in lower:
        return FriendlyError(
            code="GASFREE_NOT_ACTIVATED",
            message=msg,
            hint=(
                "First-time use of this GasFree address. Make sure the "
                "balance covers amount + transferFee + activateFee (~2 USDT) "
                "— the first settlement auto-activates."
            ),
        )

    # --- TRON: account never activated on this network ---
    # Triggered the first time a fresh TRON address tries to be the owner of a
    # contract call. TRON nodes refuse "account [T...] does not exist" until
    # the address has received any inflow (TRX / TRC10 / TRC20). This is a
    # one-time bootstrap, not a cli/SDK bug.
    if "does not exist" in lower and "account [t" in lower:
        return FriendlyError(
            code="TRON_ACCOUNT_NOT_ACTIVATED",
            message=msg,
            hint=(
                "TRON requires an address to be activated (have received any "
                "inflow at least once) before it can sign contract calls. "
                "Send ~1 TRX to this address from any other wallet or "
                "exchange withdrawal — it's a one-time bootstrap. "
                "Alternatively use --scheme exact_gasfree (default for USDT "
                "on TRON), which routes through the GasFree relayer and "
                "needs no main-wallet activation."
            ),
        )

    # --- on-chain gas shortfall (EVM permit path) ---
    if "insufficient funds for gas" in lower:
        return FriendlyError(
            code="INSUFFICIENT_GAS",
            message=msg,
            hint=(
                "Payer wallet has zero (or too little) native gas token. "
                "On BSC fund it with BNB; on TRON permit path fund with TRX. "
                "Or switch to GasFree on TRON: --scheme exact_gasfree."
            ),
        )

    # --- token transfer failed after permit/allowance path reached transferFrom ---
    if "transfer_from_failed" in lower or "transferfrom failed" in lower:
        return FriendlyError(
            code="TOKEN_TRANSFER_FAILED",
            message=msg,
            hint=(
                "The settlement contract reached token transferFrom(), but "
                "the token transfer reverted. Check that the payer address "
                "holds enough of the exact token advertised by the provider "
                "on this network, and that the selected scheme/token matches "
                "the provider pay JSON. On BSC Testnet, verify the token "
                "contract and try a smaller --max-amount."
            ),
        )

    # --- rate limits ---
    if "429" in msg or "too many requests" in lower or "too many pending" in lower:
        return FriendlyError(
            code="RATE_LIMITED",
            message=msg,
            hint="Upstream rate limit. Wait 30–60 seconds and retry.",
        )

    # --- deadline / clock skew ---
    if "deadline too soon" in lower or "deadline_too_soon" in lower:
        return FriendlyError(
            code="DEADLINE_TOO_SOON",
            message=msg,
            hint=(
                "System clock is out of sync with chain/facilitator. Run "
                "an NTP sync (e.g. `sudo sntp -sS time.apple.com` on macOS)."
            ),
        )

    # --- permit settlement reverted ---
    if "permitTransferFrom" in msg or "ERC20Permit: invalid signature" in msg:
        return FriendlyError(
            code="PERMIT_REVERTED",
            message=msg,
            hint=(
                "The token's on-chain permit() rejected the signature. "
                "On TRON USDT prefer --scheme exact_gasfree; on EVM ensure "
                "the token contract supports EIP-2612."
            ),
        )

    # --- TokenRegistry / AssetRegistry import drift (very early) ---
    if "TokenRegistry" in msg and "import" in lower:
        return FriendlyError(
            code="SDK_API_DRIFT",
            message=msg,
            hint=(
                "Your installed bankofai-x402 SDK has a different API surface "
                "than this cli expects. Run "
                "'pip install --pre --upgrade bankofai-x402-cli' to get a "
                "version that handles both names."
            ),
        )

    # fallback
    return FriendlyError(
        code="IO_ERROR",
        message=msg,
        hint="See docs/manual-test-guide.md → Troubleshooting for the full table.",
    )
