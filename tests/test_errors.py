"""Tests for the friendly error classifier.

We don't try to be exhaustive — just lock down each rule against a representative
real-world message so future drift is caught."""

from __future__ import annotations

from bankofai.x402_cli.errors import classify


def test_wallet_not_configured() -> None:
    err = RuntimeError("resolve_wallet could not find a wallet source in config or env")
    fe = classify(err)
    assert fe.code == "WALLET_NOT_CONFIGURED"
    assert "agent-wallet start" in fe.hint


def test_wallet_config_corrupt() -> None:
    err = RuntimeError(
        "1 validation error for WalletsTopology\nwallets.ma.params\n  Field required"
    )
    assert classify(err).code == "WALLET_CONFIG_CORRUPT"


def test_gasfree_balance() -> None:
    err = RuntimeError("Insufficient GasFree balance: have 0, need 100100")
    assert classify(err).code == "INSUFFICIENT_GASFREE_BALANCE"


def test_gasfree_not_activated() -> None:
    err = RuntimeError("GasFreeAccountNotActivated: T...")
    assert classify(err).code == "GASFREE_NOT_ACTIVATED"


def test_tron_account_not_activated() -> None:
    """The exact message TRON full nodes return for an inactive address used
    as the owner of a contract call (QA hit this with privy-wallet-4 on
    TRON mainnet)."""
    err = RuntimeError(
        "Approval transaction failed: Contract validate error : "
        "account [TT3mqNohVNyzMr6H2SBHWCWzU7bXPaAGUX] does not exist"
    )
    fe = classify(err)
    assert fe.code == "TRON_ACCOUNT_NOT_ACTIVATED"
    assert "TRX" in fe.hint and "exact_gasfree" in fe.hint


def test_tron_account_does_not_exist_lowercase_safe() -> None:
    """Match should be case-insensitive."""
    err = RuntimeError("account [TXyZ] DOES NOT EXIST")
    assert classify(err).code == "TRON_ACCOUNT_NOT_ACTIVATED"


def test_evm_insufficient_gas() -> None:
    err = RuntimeError(
        "insufficient funds for gas * price + value: "
        "balance 0, tx cost 4688900000000, overshot 4688900000000"
    )
    assert classify(err).code == "INSUFFICIENT_GAS"


def test_token_transfer_failed() -> None:
    err = RuntimeError(
        "execution reverted: TRANSFER_FROM_FAILED: "
        "0x08c379a0000000000000000000000000000000000000000000000000000"
    )
    fe = classify(err)
    assert fe.code == "TOKEN_TRANSFER_FAILED"
    assert "payer address holds enough" in fe.hint


def test_rate_limited_429() -> None:
    err = RuntimeError("HTTP 429 Too Many Requests")
    assert classify(err).code == "RATE_LIMITED"


def test_rate_limited_pending_transfers() -> None:
    err = RuntimeError("too many pending transfers")
    assert classify(err).code == "RATE_LIMITED"


def test_deadline_too_soon() -> None:
    err = RuntimeError("deadline too soon: now=1700, deadline=1750, min=55")
    assert classify(err).code == "DEADLINE_TOO_SOON"


def test_permit_reverted() -> None:
    err = RuntimeError("ERC20Permit: invalid signature at block 999")
    assert classify(err).code == "PERMIT_REVERTED"


def test_unknown_falls_back_to_io_error() -> None:
    err = RuntimeError("something unexpected: cosmic ray flipped a bit")
    fe = classify(err)
    assert fe.code == "IO_ERROR"
    assert "manual-test-guide" in fe.hint


def test_friendly_error_to_dict_shape() -> None:
    """Ensure the dict shape is stable — it's exposed in cli json output."""
    err = RuntimeError("account [TXY] does not exist")
    fe = classify(err)
    d = fe.to_dict()
    assert set(d.keys()) == {"code", "message", "hint"}
    assert all(isinstance(v, str) for v in d.values())
