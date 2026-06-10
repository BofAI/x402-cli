# x402-cli Community Examples

## 中文说明

这里是社区用户使用 `x402-cli` 的复制粘贴示例。`x402-cli` 是唯一用户入口，支付、Catalog 搜索、Gateway 操作都在这一个命令下。

常用流程：

```bash
pip install bankofai-x402-cli==0.6.1b1
x402-cli catalog update
x402-cli catalog search "weather"
x402-cli catalog show acme-weather
x402-cli catalog endpoints acme-weather
x402-cli pay 'https://gateway.bankofai.io/providers/acme-weather/v1/current?city=Shanghai'
```

服务方导出公开 PR 文件：

```bash
x402-cli catalog export-gateway https://gateway.example.com \
  --provider acme-weather \
  --output-dir providers/acme-weather
```

只提交 `catalog.json` 和 `pay.md`，不要提交 `provider.yml`、`.env` 或任何密钥。

## English

This directory shows the common ways a community user should use `x402-cli`.
The CLI is the only user-facing entrypoint: payment, catalog discovery, and
gateway operations all live under `x402-cli`.

## 1. Install

```bash
pip install bankofai-x402-cli==0.6.1b1
x402-cli --version
```

Expected:

```text
x402-cli, version 0.6.1b1
```

## 2. Find a Paid API

Search the public catalog:

```bash
x402-cli catalog update
x402-cli catalog search "weather"
x402-cli catalog show acme-weather
x402-cli catalog endpoints acme-weather
x402-cli catalog pay-json acme-weather
```

Use a local catalog during development:

```bash
x402-cli catalog search "weather" \
  --catalog ../x402-catelog/dist/catalog.json \
  --json
```

## 3. Call a Paid API

After choosing an endpoint from the catalog:

```bash
x402-cli pay 'https://gateway.bankofai.io/providers/acme-weather/v1/current?city=Shanghai'
```

For a dry run that reads the payment requirement without signing:

```bash
x402-cli pay \
  'https://gateway.bankofai.io/providers/acme-weather/v1/current?city=Shanghai' \
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
x402-cli catalog search "current weather for a city" --json
x402-cli catalog pay-json acme-weather
x402-cli pay 'https://gateway.bankofai.io/providers/acme-weather/v1/current?city=Shanghai'
```

The catalog response gives the provider FQN, endpoint URL, price range, chains,
and human/agent-readable usage text.
