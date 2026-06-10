# x402-cli Specifications

## 中文说明

这里是 `x402-cli` 的设计和协议参考文档，主要给维护者和贡献者使用。普通用户优先阅读仓库根目录的 `README.md` 和 `examples/README.md`。

阅读顺序：

1. `../README.md`：了解安装、搜索、支付和 Gateway 操作。
2. `server.md`：了解本地付费服务端如何暴露 payment requirement。
3. `client.md`：了解客户端如何探测 402、签名并重试。
4. `smoke-tests.md`：了解如何验证核心流程。

如果文档和当前 CLI 行为不一致，以代码、测试和 CHANGELOG 为准，然后再更新规格文档。

## English

Design documents and protocol specifications for the x402-cli CLI.

## Contents

### Design Documents

- **[server.md](server.md)** — Server command design
  - Architecture and flow
  - All HTTP endpoints (/health, /.well-known/x402, /pay)
  - Parameter reference
  - Error handling
  - Mechanism registration strategy

- **[client.md](client.md)** — Client command design
  - Payment client architecture
  - Complete flow sequence (probe → parse → sign → retry)
  - Signer resolution logic
  - Payment requirement filtering
  - Error handling and examples

- **[smoke-tests.md](smoke-tests.md)** — Smoke test specification
  - Test suite definition
  - Each test's objective and assertions
  - Test execution instructions
  - Coverage analysis
  - Known limitations and future scenarios

## Design Philosophy

### Why These Documents?

The x402-cli CLI has clear, distinct responsibilities:

1. **Server** — Advertise payment terms and verify signatures
2. **Client** — Discover payment requirements and pay them

Each command has a well-defined flow that benefits from upfront specification:
- Helps developers understand the architecture
- Enables early design review (before implementation)
- Documents expected behavior for testing
- Provides a reference for debugging

### What We Document

- **Architecture**: How components fit together (X402Server, X402Client, signers, etc.)
- **Flows**: Step-by-step request/response sequences
- **Parameters**: All CLI flags and their interaction
- **Endpoints**: HTTP request/response formats
- **Errors**: How failures are handled and reported
- **Examples**: Real-world usage patterns

### What We Don't Document

- **Implementation details**: How the code works internally (read the source)
- **SDK internals**: How bankofai-x402 works (refer to SDK docs)
- **User guides**: Getting started and feature matrix (see README.md)

## Reading Order

If you're new to x402-cli, read in this order:

1. **../README.md** — Understand what x402-cli is
2. **server.md** — Learn how the payment server works
3. **client.md** — Learn how the payment client works
4. **smoke-tests.md** — See how we validate the implementation

If you're debugging or adding features:

1. **server.md** or **client.md** — Find the relevant flow
2. **../src/*.py** — Read the implementation
3. **smoke-tests.md** — Check test expectations

## Updating These Specs

These docs are **architecture references**, not living contracts. The day-to-day record of what changed (and why) lives in:

1. **[`CHANGELOG.md`](../CHANGELOG.md)** — every release's behavior changes, with rationale. The canonical "what's the current behavior" source.
2. **Source + tests** — the implementation truth. `pytest -q tests/` is the regression gate.
3. **These specs** — refreshed when the *architecture* shifts (a new endpoint, a new mechanism, a new compat layer like `_tron_patch.py`). For day-to-day flag tweaks or error-message polish, the CHANGELOG entry is enough.

In practice this project is **code-first**: behavior lands in a release, the CHANGELOG records it, and these specs get a sweep at major-version boundaries (e.g. `0.1.0` consolidated b5..b17). If you find a discrepancy between a spec file and the running cli, **the cli is canonical** — file an issue or open a PR fixing the spec.

### When to actually edit a spec file

- Adding a new HTTP endpoint to `serve` → `server.md` "Endpoints" section
- Adding a new settlement scheme → both `server.md` and `client.md` mechanism tables
- Adding a new `errors.py` classification rule → `client.md` "Error Codes" table
- Adding a new compat layer like `_tron_patch.py` → `server.md` (or `client.md`, wherever the layer lives)

### When NOT to bother

- Renaming a flag, tweaking help text, adding examples → CHANGELOG only
- Internal refactors with no behavior change → no doc update needed
- One-off bug fixes → CHANGELOG only

## Protocol Reference

x402-cli implements the **x402 Payment Protocol v2**:

- **Spec**: See the [x402 repository](https://github.com/x402-foundation/x402/blob/main/specs/protocol.md)
- **Our implementation**: Uses `bankofai-x402` SDK directly
- **Key concepts**:
  - **402 Payment Required**: HTTP status code for payment endpoints
  - **PAYMENT-REQUIRED header**: Challenge with payment options
  - **PAYMENT-SIGNATURE header**: Client's signed payment
  - **Three schemes**: exact, exact_permit, exact_gasfree
  - **Two networks**: EVM (CAIP-2) and TRON (tron:name)

## File Structure

```
specs/
├── README.md           ← You are here
├── server.md           ← Server command design
├── client.md           ← Client command design
└── smoke-tests.md      ← Testing specification
```

## Questions?

- **How do I add a new endpoint?** → Update server.md with endpoint docs, then implement
- **How do I support a new scheme?** → Update both server.md and client.md with mechanism info
- **How do I debug a failure?** → Find the relevant flow in the spec, trace the code
- **How do I run tests?** → See smoke-tests.md "Test Execution" section
