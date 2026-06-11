# x402 MCP

`x402-mcp` exposes the existing `x402-cli` catalog and payment flows as MCP tools for coding agents.

## Install

```bash
pip install bankofai-x402-cli==0.6.1b3
x402-cli --version
python -c "import bankofai.x402_cli.mcp_server; print('x402-mcp ready')"
```

Configure Agent Wallet once before paying protected endpoints:

```bash
npm i -g @bankofai/agent-wallet
agent-wallet start raw_secret --wallet-id payer --private-key 0x...
```

## Claude Code

```bash
claude mcp add x402 \
  --scope user \
  -- x402-mcp
```

## Codex CLI

Add a server entry to `~/.codex/config.toml`:

```toml
[mcp.servers.x402]
command = "x402-mcp"
args = []
```

Restart Codex after changing MCP configuration.

## Tools

- `catalog_search`: search Bank of AI x402 catalog providers.
- `catalog_show`: show provider details.
- `catalog_endpoints`: list provider endpoints, prices, and x402 routes.
- `catalog_pay_json`: return provider pay metadata.
- `x402_pay`: pay an x402-protected URL through the configured Agent Wallet.
- `wallet_status`: check whether Agent Wallet is installed and can resolve addresses.
