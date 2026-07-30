import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { DecryptionError, SigningError } from "@bankofai/agent-wallet";
import { classify } from "../dist/output.js";
import { signTronTypedData } from "../dist/x402.js";
import { addressesEqual, findTokenByAddress, getToken, normalizeNetwork } from "../dist/tokens.js";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "dist", "cli.js");

function run(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    env,
    encoding: "utf8",
  });
}

function runAsync(args, options = {}) {
  return new Promise(resolve => {
    const env = { ...process.env, ...(options.env ?? {}) };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function catalogFixture(dir) {
  const catalog = {
    version: 1,
    providers: [
      { fqn: "alpha", title: "Alpha", category: "finance", featured_tags: ["defi"], chains: ["tron:0xcd8690dc"] },
      { fqn: "blocked", title: "Blocked", category: "security", block: true, featured_tags: ["defi"] },
    ],
  };
  const alpha = {
    fqn: "alpha",
    title: "Alpha Provider",
    category: "finance",
    service_url: "https://alpha.example",
    chains: ["tron:0xcd8690dc"],
    featured_tags: ["defi", "tvl"],
    endpoints: [
      {
        method: "GET",
        path: "/protocols",
        url: "https://gateway.example/providers/alpha/protocols",
        description: "DeFi TVL endpoint",
        paid: { network: "tron:0xcd8690dc", currency: "USDT", amount_raw: "1" },
      },
    ],
  };
  const blocked = { ...alpha, fqn: "blocked", title: "Blocked Provider", category: "security" };
  writeJson(path.join(dir, "catalog.json"), catalog);
  writeJson(path.join(dir, "providers", "alpha.json"), alpha);
  writeJson(path.join(dir, "providers", "blocked.json"), blocked);
  writeJson(path.join(dir, "pay", "alpha.json"), { fqn: "alpha", endpoints: alpha.endpoints });
  return { catalog, alpha };
}

test("help and version work", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /x402-cli/);
  assert.match(help.stdout, /catalog <command>/);

  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("legacy TRON aliases are rejected in favor of canonical CAIP-2 IDs", () => {
  assert.throws(() => normalizeNetwork("tron:nile"), /use tron:0xcd8690dc/);
  assert.throws(() => normalizeNetwork("tron-nile"), /use tron:0xcd8690dc/);
  assert.throws(() => normalizeNetwork("tron:mainnet"), /use tron:0x2b6653dc/);
  assert.throws(() => normalizeNetwork("tron:shasta"), /use tron:0x94a9059e/);
});

test("Base aliases and USDC registry use canonical network data", () => {
  assert.equal(normalizeNetwork("base-mainnet"), "eip155:8453");
  assert.equal(normalizeNetwork("base-sepolia"), "eip155:84532");
  assert.deepEqual(getToken("eip155:8453", "USDC"), {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    name: "USD Coin",
    symbol: "USDC",
    version: "2",
  });
  assert.deepEqual(getToken("base-sepolia", "usdc"), {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    name: "USDC",
    symbol: "USDC",
    version: "2",
  });
});

test("pay dry-run selects Base Sepolia USDC", async () => {
  await withServer((request, response) => {
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${request.headers.host}/pay` },
      accepts: [{
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      }],
    };
    response.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    response.end(JSON.stringify(challenge));
  }, async base => {
    const result = await runAsync([
      "pay", `${base}/pay`, "--dry-run", "--network", "base-sepolia", "--token", "USDC", "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.network, "eip155:84532");
    assert.equal(parsed.result.selected.amount, "1000");
  });
});

test("pay uses the active Agent Wallet by default", async () => {
  const walletDir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-agent-wallet-"));
  const privateKey = `0x${"01".repeat(32)}`;
  writeJson(path.join(walletDir, "wallets_config.json"), {
    active_wallet: "base-payer",
    wallets: {
      "base-payer": {
        type: "raw_secret",
        params: { source: "private_key", private_key: privateKey },
      },
    },
  });

  let requests = 0;
  let paymentSignature;
  try {
    await withServer((request, response) => {
      requests += 1;
      if (requests === 1) {
        const challenge = {
          x402Version: 2,
          resource: { url: `http://${request.headers.host}/pay` },
          accepts: [{
            scheme: "exact",
            network: "eip155:84532",
            amount: "1",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          }],
        };
        response.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        });
        return response.end(JSON.stringify(challenge));
      }

      paymentSignature = request.headers["payment-signature"];
      response.writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
          success: true,
          transaction: "agent-wallet-test",
          network: "eip155:84532",
        })).toString("base64"),
      });
      response.end(JSON.stringify({ ok: true }));
    }, async base => {
      const result = await runAsync(
        ["pay", `${base}/pay`, "--network", "base-sepolia", "--token", "USDC", "--json"],
        {
          env: {
            AGENT_WALLET_DIR: walletDir,
            AGENT_WALLET_ID: undefined,
            AGENT_WALLET_PRIVATE_KEY: undefined,
            EVM_PRIVATE_KEY: undefined,
            PRIVATE_KEY: undefined,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.result.paid, true);
      assert.equal(parsed.result.transaction, "agent-wallet-test");
    });

    assert.equal(requests, 2);
    assert.equal(typeof paymentSignature, "string");
    const payload = JSON.parse(Buffer.from(paymentSignature, "base64").toString("utf8"));
    assert.match(payload.payload.signature, /^0x[0-9a-f]{130}$/i);
  } finally {
    rmSync(walletDir, { recursive: true, force: true });
  }
});

test("pay refuses to silently select the first configured Agent Wallet", async () => {
  const walletDir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-agent-wallet-no-active-"));
  writeJson(path.join(walletDir, "wallets_config.json"), {
    active_wallet: null,
    wallets: {
      first: {
        type: "raw_secret",
        params: { source: "private_key", private_key: `0x${"01".repeat(32)}` },
      },
      intended: {
        type: "raw_secret",
        params: { source: "private_key", private_key: `0x${"02".repeat(32)}` },
      },
    },
  });

  let requests = 0;
  try {
    await withServer((request, response) => {
      requests += 1;
      const challenge = {
        x402Version: 2,
        resource: { url: `http://${request.headers.host}/pay` },
        accepts: [{
          scheme: "exact",
          network: "eip155:84532",
          amount: "1",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        }],
      };
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      response.end(JSON.stringify(challenge));
    }, async base => {
      const result = await runAsync(
        ["pay", `${base}/pay`, "--network", "base-sepolia", "--token", "USDC", "--json"],
        {
          env: {
            AGENT_WALLET_DIR: walletDir,
            AGENT_WALLET_ID: undefined,
            AGENT_WALLET_PRIVATE_KEY: undefined,
            EVM_PRIVATE_KEY: undefined,
            PRIVATE_KEY: undefined,
          },
        },
      );
      assert.equal(result.status, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.error.code, "WALLET_NOT_CONFIGURED");
      assert.match(parsed.error.message, /no active wallet/i);
    });
    assert.equal(requests, 1);
  } finally {
    rmSync(walletDir, { recursive: true, force: true });
  }
});

test("serve advertises Base USDC exact with EIP-712 domain metadata", async () => {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const started = run([
    "serve",
    "--pay-to", "0x0000000000000000000000000000000000000001",
    "--amount", "0.001",
    "--network", "base-sepolia",
    "--token", "USDC",
    "--port", String(port),
    "--daemon",
    "--json",
  ]);
  assert.equal(started.status, 0, started.stderr);
  const pid = JSON.parse(started.stdout).result.pid;
  try {
    for (let i = 0; i < 20; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/pay`);
        assert.equal(response.status, 402);
        const required = JSON.parse(
          Buffer.from(response.headers.get("payment-required"), "base64").toString("utf8"),
        );
        assert.equal(required.accepts[0].network, "eip155:84532");
        assert.equal(required.accepts[0].asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
        assert.deepEqual(required.accepts[0].extra, { name: "USDC", version: "2" });
        break;
      } catch (error) {
        if (i === 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  } finally {
    try {
      process.kill(pid);
    } catch {
      // Daemon may already have exited.
    }
  }
});

test("serve advertises exact_gasfree and rejects it on EVM", async () => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  const started = run([
    "serve",
    "--pay-to", "TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i",
    "--network", "tron:0xcd8690dc",
    "--scheme", "exact_gasfree",
    "--port", String(port),
    "--daemon",
    "--json",
  ]);
  assert.equal(started.status, 0, started.stderr);
  const parsed = JSON.parse(started.stdout);
  assert.equal(parsed.scheme, "exact_gasfree");
  const pid = parsed.result.pid;
  try {
    for (let i = 0; i < 20; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/pay`);
        if (response.status !== 402) throw new Error(`unexpected status ${response.status}`);
        const challenge = await response.json();
        assert.equal(challenge.accepts[0].scheme, "exact_gasfree");
        assert.deepEqual(challenge.accepts[0].extra, {});
        break;
      } catch (error) {
        if (i === 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  } finally {
    try {
      process.kill(pid);
    } catch {
      // Process may already have exited.
    }
  }

  const evm = run([
    "serve",
    "--pay-to", "0x0000000000000000000000000000000000000001",
    "--network", "eip155:97",
    "--scheme", "exact_gasfree",
    "--daemon",
    "--json",
  ]);
  assert.equal(evm.status, 2);
  assert.match(evm.stdout, /supported only on TRON/);
});

test("pay dry-run preserves an exact_gasfree requirement", async () => {
  await withServer((request, response) => {
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${request.headers.host}/pay` },
      accepts: [{
        scheme: "exact_gasfree",
        network: "tron:0xcd8690dc",
        amount: "1",
        asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        payTo: "TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i",
        maxTimeoutSeconds: 300,
      }],
    };
    response.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    response.end(JSON.stringify(challenge));
  }, async base => {
    const result = await runAsync(["pay", `${base}/pay`, "--dry-run", "--scheme", "exact_gasfree", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scheme, "exact_gasfree");
    assert.equal(parsed.result.selected.scheme, "exact_gasfree");
  });
});

test("pay skips unknown-network requirements when selecting a token", async () => {
  await withServer((request, response) => {
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${request.headers.host}/pay` },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:999999",
          amount: "1",
          asset: "0x0000000000000000000000000000000000000001",
          payTo: "0x0000000000000000000000000000000000000002",
        },
        {
          scheme: "exact_gasfree",
          network: "tron:0xcd8690dc",
          amount: "1",
          asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
          payTo: "TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i",
          maxTimeoutSeconds: 300,
        },
      ],
    };
    response.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    response.end(JSON.stringify(challenge));
  }, async base => {
    const result = await runAsync(["pay", `${base}/pay`, "--dry-run", "--token", "USDT", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result.selected.network, "tron:0xcd8690dc");
  });
});

test("pay reports non-2xx gateway responses as failures", async () => {
  await withServer((_request, response) => {
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "36",
    });
    response.end(JSON.stringify({ error: "facilitator rate limited" }));
  }, async base => {
    const result = await runAsync(["pay", `${base}/pay`, "--json"]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "RATE_LIMITED");
    assert.match(parsed.error.message, /HTTP 429/);
    assert.match(parsed.error.message, /retry after 36s/);
  });
});

test("pay preserves settlement details from a failed paid response", async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      const challenge = {
        x402Version: 2,
        resource: { url: `http://${request.headers.host}/pay` },
        accepts: [{
          scheme: "exact",
          network: "eip155:97",
          amount: "1",
          asset: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 300,
          extra: { assetTransferMethod: "permit2" },
        }],
      };
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      return response.end(JSON.stringify(challenge));
    }
    const settlement = { success: true, transaction: "settled-transaction", network: "eip155:97" };
    response.writeHead(502, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settlement)).toString("base64"),
    });
    response.end(JSON.stringify({ error: "upstream failed after payment settlement", settled: true }));
  }, async base => {
    const result = await runAsync([
      "pay", `${base}/pay`, "--json",
      "--private-key", `0x${"01".repeat(32)}`,
    ]);
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "HTTP_ERROR");
    assert.equal(parsed.error.details.status, 502);
    assert.equal(parsed.error.details.paid, true);
    assert.equal(parsed.error.details.settled, true);
    assert.equal(parsed.error.details.delivered, false);
    assert.equal(parsed.error.details.transaction, "settled-transaction");
    assert.equal(parsed.error.details.paymentResponse.transaction, "settled-transaction");
    assert.equal(requests, 2);
  });
});

test("GasFree fee limits are enforced before signing", async () => {
  await withServer((_apiRequest, apiResponse) => {
    apiResponse.writeHead(200, { "content-type": "application/json" });
    apiResponse.end(JSON.stringify({
      code: 200,
      data: {
        accountAddress: "TD3tTestAccount",
        gasFreeAddress: "TNyzTestGasFree",
        active: true,
        nonce: 1,
        allowSubmit: true,
        assets: [{
          tokenAddress: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
          tokenSymbol: "USDT",
          activateFee: "0",
          transferFee: "500000",
          decimal: 6,
          frozen: 0,
        }],
      },
    }));
  }, async gasfreeApi => {
    await withServer((request, response) => {
      const challenge = {
        x402Version: 2,
        resource: { url: `http://${request.headers.host}/pay` },
        accepts: [{
          scheme: "exact_gasfree",
          network: "tron:0xcd8690dc",
          amount: "1",
          asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
          payTo: "TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i",
          maxTimeoutSeconds: 300,
          extra: {},
        }],
      };
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      response.end(JSON.stringify(challenge));
    }, async gateway => {
      const result = await runAsync([
        "pay", `${gateway}/pay`, "--json",
        "--private-key", `0x${"01".repeat(32)}`,
        "--gasfree-api-url", gasfreeApi,
        "--max-gasfree-fee-raw", "499999",
      ]);
      assert.equal(result.status, 1, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.match(parsed.error.message, /estimated GasFree fee 500000 exceeds/);
    });
  });
});

test("weighted catalog and gateway search support include-blocked and json output", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-catalog-"));
  try {
    catalogFixture(dir);
    const source = path.join(dir, "catalog.json");
    const search = run(["catalog", "search", "defi", "--catalog", source, "--json"]);
    assert.equal(search.status, 0, search.stderr);
    const parsed = JSON.parse(search.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.count, 1);
    assert.equal(parsed.result.results[0].fqn, "alpha");
    assert.ok(parsed.result.results[0].score > 0);
    assert.ok(parsed.result.results[0].matchedFields.includes("tags"));

    const included = run(["gateway", "search", "defi", "--catalog", source, "--include-blocked", "--json"]);
    assert.equal(included.status, 0, included.stderr);
    const includedJson = JSON.parse(included.stdout);
    assert.equal(includedJson.result.count, 2);

    const human = run(["gateway", "search", "defi", "--catalog", source]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /score=/);
    assert.match(human.stdout, /category=finance/);

    const invalidLimit = run(["catalog", "search", "defi", "--catalog", source, "--limit", "abc", "--json"]);
    assert.equal(invalidLimit.status, 2);
    assert.equal(JSON.parse(invalidLimit.stdout).error.code, "INVALID_ARGUMENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog env override is honored", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-catalog-env-"));
  try {
    catalogFixture(dir);
    const search = run(["catalog", "search", "defi", "--json"], {
      env: { X402_CATALOG: path.join(dir, "catalog.json") },
    });
    assert.equal(search.status, 0, search.stderr);
    assert.equal(JSON.parse(search.stdout).result.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI usage errors are explicit and machine-readable", () => {
  const unknown = run(["unknown", "--json"]);
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, "UNKNOWN_COMMAND");

  const missingUrl = run(["pay", "--json"]);
  assert.equal(missingUrl.status, 2);
  assert.equal(JSON.parse(missingUrl.stdout).error.code, "MISSING_ARGUMENT");

  const missingProvider = run(["catalog", "show", "--json"], {
    env: { X402_CATALOG: "http://127.0.0.1:9/catalog.json" },
  });
  assert.equal(missingProvider.status, 2);
  assert.equal(JSON.parse(missingProvider.stdout).error.code, "MISSING_ARGUMENT");
  assert.doesNotMatch(missingProvider.stdout, /NETWORK_ERROR/);

  const invalidLimit = run(["catalog", "search", "q", "--limit", "0", "--json"], {
    env: { X402_CATALOG: "http://127.0.0.1:9/catalog.json" },
  });
  assert.equal(invalidLimit.status, 2);
  assert.equal(JSON.parse(invalidLimit.stdout).error.code, "INVALID_ARGUMENT");
  assert.doesNotMatch(invalidLimit.stdout, /NETWORK_ERROR/);

  const conflictingOutput = run(["catalog", "search", "q", "--json", "--human"]);
  assert.equal(conflictingOutput.status, 2);
  assert.equal(JSON.parse(conflictingOutput.stdout).error.code, "INVALID_ARGUMENT");
});

test("TRON typed data signing prefers public tronweb API", async () => {
  const calls = [];
  const tronWeb = {
    trx: {
      signTypedData(domain, types, message, privateKey) {
        calls.push(["public", domain, types, message, privateKey]);
        return "abc123";
      },
      _signTypedData() {
        calls.push(["private"]);
        return "private";
      },
    },
  };
  const signature = await signTronTypedData(tronWeb, { domain: { name: "x" }, types: { A: [] }, message: { a: 1 } }, "01");
  assert.equal(signature, "abc123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "public");
});

test("pay honors timeout-ms", async () => {
  await withServer((_request, _response) => {
    // Keep the request open until the client aborts.
  }, async base => {
    const result = await runAsync(["pay", `${base}/slow`, "--timeout-ms", "50", "--json"]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.error.code, "NETWORK_ERROR");
    assert.match(parsed.error.message, /timed out/);
  });
});

test("nested command help is specific", () => {
  const gatewayCatalog = run(["gateway", "catalog", "--help"]);
  assert.equal(gatewayCatalog.status, 0);
  assert.match(gatewayCatalog.stdout, /gateway catalog <build\|check\|pay-assets\|search>/);

  const catalogSearch = run(["catalog", "search", "--help"]);
  assert.equal(catalogSearch.status, 0);
  assert.match(catalogSearch.stdout, /catalog search <query>/);

  const serveHelp = run(["serve", "--help"]);
  assert.equal(serveHelp.status, 0);
  assert.match(serveHelp.stdout, /--raw-amount/);
  assert.doesNotMatch(serveHelp.stdout, /--rawAmount/);

  const payHelp = run(["pay", "--help"]);
  assert.equal(payHelp.status, 0);
  assert.match(payHelp.stdout, /--max-raw-amount/);
  assert.doesNotMatch(payHelp.stdout, /--max-rawAmount/);
});

test("catalog update caches index, details, and pay json", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-cache-home-"));
  const fixture = mkdtempSync(path.join(os.tmpdir(), "x402-cli-remote-"));
  const { catalog, alpha } = catalogFixture(fixture);
  await withServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    const payload =
      url.pathname === "/api/catalog.json" ? { ...catalog, base_url: "" } :
      url.pathname === "/api/providers/alpha.json" ? alpha :
      url.pathname === "/api/pay/alpha.json" ? { fqn: "alpha", endpoints: alpha.endpoints } :
      null;
    if (!payload) {
      response.writeHead(404).end("not found");
      return;
    }
    if (url.pathname === "/api/catalog.json") payload.base_url = `http://${request.headers.host}/api/`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }, async base => {
    const result = await runAsync(["catalog", "update", "--catalog", `${base}/api/catalog.json`, "--json"], {
      env: { HOME: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout).result;
    assert.equal(parsed.providerCount, 2);
    assert.equal(parsed.detailCount, 1);
    assert.equal(parsed.payCount, 1);
    assert.equal(JSON.parse(readFileSync(path.join(dir, ".cache", "x402-cli", "catalog", "providers", "alpha.json"), "utf8")).fqn, "alpha");
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

test("catalog update retries transient catalog fetch failures", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-cache-retry-home-"));
  let attempts = 0;
  await withServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    if (url.pathname !== "/api/catalog.json") {
      response.writeHead(404).end("not found");
      return;
    }
    attempts += 1;
    if (attempts < 3) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("temporary");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: 1, providers: [], base_url: `http://${request.headers.host}/api/` }));
  }, async base => {
    const result = await runAsync(["catalog", "update", "--catalog", `${base}/api/catalog.json`, "--json", "--timeout-ms", "1000"], {
      env: { HOME: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout).result;
    assert.equal(parsed.providerCount, 0);
    assert.equal(parsed.warnings.length, 2);
    assert.equal(attempts, 3);
  });
  rmSync(dir, { recursive: true, force: true });
});


test("catalog export-gateway writes public catalog and pay docs", async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "x402-cli-export-"));
  const detail = {
    fqn: "alpha",
    title: "Alpha Provider",
    subtitle: "Alpha subtitle",
    description: "Alpha description",
    category: "finance",
    chains: ["tron:0xcd8690dc"],
    endpoints: [{ method: "GET", path: "/v1", url: "https://gateway.example/v1", metered: true, min_price_usd: 0.1 }],
  };
  await withServer((request, response) => {
    if (request.url === "/__402/catalog/providers/alpha.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(detail));
      return;
    }
    response.writeHead(404).end("not found");
  }, async base => {
    const result = await runAsync(["catalog", "export-gateway", base, "--provider", "alpha", "--output-dir", out, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(out, "catalog.json"), "utf8")).fqn, "alpha");
    assert.match(readFileSync(path.join(out, "pay.md"), "utf8"), /Alpha Provider/);
  });
  rmSync(out, { recursive: true, force: true });
});

test("remote catalog detail and pay files use escaped FQN filenames", async () => {
  const seen = [];
  await withServer((request, response) => {
    seen.push(request.url);
    const catalog = {
      version: 1,
      providers: [{ fqn: "bankofai/demo", title: "Demo" }],
    };
    const detail = {
      fqn: "bankofai/demo",
      title: "Demo Detail",
      endpoints: [{ method: "GET", path: "/v1", paid: { network: "tron:0xcd8690dc" } }],
    };
    const payload =
      request.url === "/api/catalog.json" ? catalog :
      request.url === "/api/providers/bankofai__demo.json" ? detail :
      request.url === "/api/pay/bankofai__demo.json" ? { ...detail, pay: true } :
      null;
    if (!payload) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }, async base => {
    const show = await runAsync(["catalog", "show", "bankofai/demo", "--catalog", `${base}/api/catalog.json`, "--json"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Demo Detail/);

    const pay = await runAsync(["catalog", "pay-json", "bankofai/demo", "--catalog", `${base}/api/catalog.json`]);
    assert.equal(pay.status, 0, pay.stderr);
    assert.match(pay.stdout, new RegExp("bankofai/demo"));
  });
  assert.ok(seen.includes("/api/providers/bankofai__demo.json"));
  assert.ok(seen.includes("/api/pay/bankofai__demo.json"));
});

test("catalog export-gateway escapes FQN and refuses to overwrite without force", async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "x402-cli-export-safe-"));
  const detail = {
    fqn: "bankofai/demo",
    title: "Demo Provider",
    endpoints: [{ method: "GET", path: "/v1", metered: true, min_price_usd: 0.1 }],
  };
  try {
    await withServer((request, response) => {
      if (request.url === "/__402/catalog/providers/bankofai__demo.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(detail));
        return;
      }
      response.writeHead(404).end("not found");
    }, async base => {
      const first = await runAsync(["catalog", "export-gateway", base, "--provider", "bankofai/demo", "--output-dir", out, "--json"]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(JSON.parse(readFileSync(path.join(out, "catalog.json"), "utf8")).fqn, "bankofai/demo");

      const second = await runAsync(["catalog", "export-gateway", base, "--provider", "bankofai/demo", "--output-dir", out, "--json"]);
      assert.equal(second.status, 1);
      assert.match(second.stdout, /already exists/);
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("amount inputs are strict", () => {
  const base = [
    "serve",
    "--pay-to", "0x0000000000000000000000000000000000000001",
    "--network", "eip155:97",
    "--asset", "0x0000000000000000000000000000000000000002",
    "--decimals", "6",
    "--daemon",
    "--json",
  ];
  assert.equal(run([...base, "--amount", "1.2345678"]).status, 2);
  assert.equal(run([...base, "--amount", "1.2.3"]).status, 2);
  assert.equal(run([...base, "--amount", "-1"]).status, 2);
  assert.equal(run([...base, "--amount", "1", "--raw-amount", "1"]).status, 2);
  assert.equal(run([...base, "--raw-amount", "abc"]).status, 2);
});

test("serve rejects malformed payment signature and exact pay route only", async () => {
  const port = 49000 + Math.floor(Math.random() * 1000);
  const started = run([
    "serve",
    "--pay-to", "0x0000000000000000000000000000000000000001",
    "--network", "eip155:97",
    "--asset", "0x0000000000000000000000000000000000000002",
    "--decimals", "8",
    "--amount", "1.25",
    "--port", String(port),
    "--daemon",
    "--json",
  ]);
  assert.equal(started.status, 0, started.stderr);
  const pid = JSON.parse(started.stdout).result.pid;
  try {
    for (let i = 0; i < 20; i += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.ok) break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const wrongRoute = await fetch(`http://127.0.0.1:${port}/payanything`);
    assert.equal(wrongRoute.status, 404);
    const badSignature = await fetch(`http://127.0.0.1:${port}/pay`, {
      headers: { "PAYMENT-SIGNATURE": "bad" },
    });
    assert.equal(badSignature.status, 400);
  } finally {
    try {
      process.kill(pid);
    } catch {
      // Process may already have exited.
    }
  }
});

test("gateway check validates provider files", () => {
  const providerDir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-providers-"));
  try {
    const providerFile = path.join(providerDir, "fixture", "provider.yml");
    mkdirSync(path.dirname(providerFile), { recursive: true });
    writeFileSync(providerFile, `name: fixture-provider
forward_url: https://api.example.com
operator:
  network: tron:0xcd8690dc
  recipient: TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i
  currencies:
    usd: ["USDT"]
  scheme: exact
  asset_transfer_method: permit2
endpoints:
  - method: GET
    path: /v1/ping
    metering:
      dimensions:
        - tiers:
            - price_usd: 0.0001
`);
    const result = run(["gateway", "check", providerDir, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result, { providers: ["fixture-provider"], count: 1 });
  } finally {
    rmSync(providerDir, { recursive: true, force: true });
  }
});

test("gateway check fails on missing provider environment variables", () => {
  const providerDir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-provider-env-"));
  try {
    const providerFile = path.join(providerDir, "provider.yml");
    writeFileSync(providerFile, `name: env-provider
forward_url: \${MISSING_X402_TEST_FORWARD_URL}
operator:
  network: tron:0xcd8690dc
  recipient: TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i
endpoints:
  - method: GET
    path: /v1/ping
`);
    const result = run(["gateway", "check", providerDir, "--json"], {
      env: { MISSING_X402_TEST_FORWARD_URL: undefined },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /MISSING_X402_TEST_FORWARD_URL/);
  } finally {
    rmSync(providerDir, { recursive: true, force: true });
  }
});

test("serve daemon supports arbitrary asset decimals", async () => {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const started = run([
    "serve",
    "--pay-to", "0x0000000000000000000000000000000000000001",
    "--network", "eip155:97",
    "--asset", "0x0000000000000000000000000000000000000002",
    "--decimals", "8",
    "--amount", "1.25",
    "--port", String(port),
    "--daemon",
    "--json",
  ]);
  assert.equal(started.status, 0, started.stderr);
  const pid = JSON.parse(started.stdout).result.pid;
  assert.ok(pid);
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/x402`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.amount, "125000000");
    assert.equal(body.asset, "0x0000000000000000000000000000000000000002");
  } finally {
    try {
      process.kill(pid);
    } catch {
      // Process may already have exited.
    }
  }
});

test("registered token decimals cannot be overridden in serve or payment caps", async () => {
  const serveResult = run([
    "serve",
    "--pay-to", "0x0000000000000000000000000000000000000001",
    "--network", "eip155:8453",
    "--token", "USDC",
    "--decimals", "18",
    "--daemon",
    "--json",
  ]);
  assert.equal(serveResult.status, 2);
  assert.equal(JSON.parse(serveResult.stdout).error.code, "INVALID_ARGUMENT");

  await withServer((request, response) => {
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${request.headers.host}/pay` },
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      }],
    };
    response.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    response.end(JSON.stringify(challenge));
  }, async base => {
    const mismatch = await runAsync([
      "pay", `${base}/pay`, "--dry-run", "--max-amount", "0.01",
      "--decimals", "18", "--json",
    ]);
    assert.equal(mismatch.status, 2);
    assert.equal(JSON.parse(mismatch.stdout).error.code, "INVALID_ARGUMENT");

    const protectedCap = await runAsync([
      "pay", `${base}/pay`, "--dry-run", "--max-amount", "0.01",
      "--decimals", "6", "--json",
    ]);
    assert.equal(protectedCap.status, 1);
    assert.equal(JSON.parse(protectedCap.stdout).error.code, "PAYMENT_AMOUNT_TOO_HIGH");
  });
});

test("dry-run rejects un-signable requirements and accepts explicit non-Base assets", async () => {
  async function runRequirement(requirement, extraArgs = []) {
    return withServer((request, response) => {
      const challenge = {
        x402Version: 2,
        resource: { url: `http://${request.headers.host}/pay` },
        accepts: [requirement],
      };
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      response.end(JSON.stringify(challenge));
    }, base => runAsync(["pay", `${base}/pay`, "--dry-run", "--json", ...extraArgs]));
  }

  const base = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x0000000000000000000000000000000000000001",
    maxTimeoutSeconds: 300,
  };
  const missingMetadata = await runRequirement(base);
  assert.equal(missingMetadata.status, 1);
  assert.equal(JSON.parse(missingMetadata.stdout).error.code, "INVALID_PAYMENT_REQUIREMENT");

  const invalidPayTo = await runRequirement({
    ...base,
    payTo: "not-an-address",
    extra: { name: "USD Coin", version: "2" },
  });
  assert.equal(invalidPayTo.status, 1);
  assert.match(JSON.parse(invalidPayTo.stdout).error.message, /invalid payTo/);

  const invalidAmount = await runRequirement({
    ...base,
    amount: "-1",
    extra: { name: "USD Coin", version: "2" },
  });
  assert.equal(invalidAmount.status, 1);
  assert.match(JSON.parse(invalidAmount.stdout).error.message, /non-negative integer/);

  const customAsset = "0x0000000000000000000000000000000000000002";
  const supportedCustom = await runRequirement({
    scheme: "exact",
    network: "eip155:97",
    amount: "125000000",
    asset: customAsset,
    payTo: "0x0000000000000000000000000000000000000001",
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "permit2" },
  }, ["--asset", customAsset, "--decimals", "8"]);
  assert.equal(supportedCustom.status, 0, supportedCustom.stderr);

  let customRequests = 0;
  let customSignature;
  await withServer((request, response) => {
    customRequests += 1;
    if (customRequests === 1) {
      const challenge = {
        x402Version: 2,
        resource: { url: `http://${request.headers.host}/pay` },
        accepts: [{
          scheme: "exact",
          network: "eip155:97",
          amount: "125000000",
          asset: customAsset,
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 300,
          extra: { assetTransferMethod: "permit2" },
        }],
      };
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      response.end(JSON.stringify(challenge));
      return;
    }
    customSignature = request.headers["payment-signature"];
    response.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
        success: true,
        transaction: "custom-asset-test",
        network: "eip155:97",
      })).toString("base64"),
    });
    response.end(JSON.stringify({ ok: true }));
  }, async gateway => {
    const result = await runAsync([
      "pay", `${gateway}/pay`,
      "--asset", customAsset,
      "--decimals", "8",
      "--private-key", `0x${"01".repeat(32)}`,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result.transaction, "custom-asset-test");
  });
  assert.equal(typeof customSignature, "string");
});

test("paid request does not forward PAYMENT-SIGNATURE across redirects", async () => {
  let redirectedRequests = 0;
  await withServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ shouldNotBeReached: true }));
  }, async redirectedBase => {
    let originRequests = 0;
    await withServer((request, response) => {
      originRequests += 1;
      if (originRequests === 1) {
        const challenge = {
          x402Version: 2,
          resource: { url: `http://${request.headers.host}/pay` },
          accepts: [{
            scheme: "exact",
            network: "eip155:84532",
            amount: "1",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          }],
        };
        response.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        });
        response.end(JSON.stringify(challenge));
        return;
      }
      assert.equal(typeof request.headers["payment-signature"], "string");
      response.writeHead(307, { location: `${redirectedBase}/capture` });
      response.end();
    }, async originBase => {
      const result = await runAsync([
        "pay", `${originBase}/pay`, "--json",
        "--private-key", `0x${"01".repeat(32)}`,
      ]);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, "HTTP_ERROR");
    });
  });
  assert.equal(redirectedRequests, 0);
});

test("TRON token matching validates Base58Check instead of lowercasing", () => {
  const canonical = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const invalidLowercase = canonical.toLowerCase();
  assert.equal(findTokenByAddress("tron:0x2b6653dc", canonical)?.symbol, "USDT");
  assert.equal(findTokenByAddress("tron:0x2b6653dc", invalidLowercase), undefined);
  assert.equal(addressesEqual("tron:0x2b6653dc", canonical, invalidLowercase), false);
  assert.equal(
    addressesEqual(
      "eip155:8453",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    ),
    true,
  );
});

test("Agent Wallet configuration failures have stable error codes", async () => {
  assert.equal(classify(new DecryptionError("wrong password")).code, "WALLET_DECRYPTION_FAILED");
  assert.equal(classify(new SigningError("typed data rejected")).code, "WALLET_SIGNING_FAILED");
  await withServer((request, response) => {
    const challenge = {
      x402Version: 2,
      resource: { url: `http://${request.headers.host}/pay` },
      accepts: [{
        scheme: "exact",
        network: "eip155:84532",
        amount: "1",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      }],
    };
    response.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
    });
    response.end(JSON.stringify(challenge));
  }, async base => {
    const malformedDir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-wallet-malformed-"));
    const lockedDir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-wallet-locked-"));
    try {
      writeFileSync(path.join(malformedDir, "wallets_config.json"), "{");
      const malformed = await runAsync(["pay", `${base}/pay`, "--json"], {
        env: {
          AGENT_WALLET_DIR: malformedDir,
          AGENT_WALLET_PASSWORD: undefined,
          AGENT_WALLET_PRIVATE_KEY: undefined,
          EVM_PRIVATE_KEY: undefined,
          PRIVATE_KEY: undefined,
        },
      });
      assert.equal(malformed.status, 1);
      assert.equal(JSON.parse(malformed.stdout).error.code, "WALLET_CONFIG_CORRUPT");

      writeJson(path.join(lockedDir, "wallets_config.json"), {
        active_wallet: "locked",
        wallets: {
          locked: {
            type: "local_secure",
            params: { secret_ref: "locked" },
          },
        },
      });
      const locked = await runAsync(["pay", `${base}/pay`, "--json"], {
        env: {
          AGENT_WALLET_DIR: lockedDir,
          AGENT_WALLET_PASSWORD: undefined,
          AGENT_WALLET_PRIVATE_KEY: undefined,
          EVM_PRIVATE_KEY: undefined,
          PRIVATE_KEY: undefined,
        },
      });
      assert.equal(locked.status, 1);
      assert.equal(JSON.parse(locked.stdout).error.code, "WALLET_PASSWORD_REQUIRED");
    } finally {
      rmSync(malformedDir, { recursive: true, force: true });
      rmSync(lockedDir, { recursive: true, force: true });
    }
  });
});

test("invalid CLI options consistently use INVALID_ARGUMENT and exit 2", () => {
  const cases = [
    ["serve", "--scheme", "foo", "--json"],
    ["serve", "--decimals", "abc", "--json"],
    ["serve", "--port", "abc", "--json"],
    ["pay", "https://example.invalid", "--method", "get", "--json"],
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
  }
});

test("nested search, repeatable inline headers, help, and JSON identity are stable", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-review-contract-"));
  try {
    catalogFixture(dir);
    const source = path.join(dir, "catalog.json");
    const nested = run(["gateway", "catalog", "search", "defi", "--catalog", source, "--json"]);
    assert.equal(nested.status, 0, nested.stderr);
    const nestedJson = JSON.parse(nested.stdout);
    assert.equal(nestedJson.command, "gateway catalog search");
    assert.equal(nestedJson.result.query, "defi");

    for (const [args, expected] of [
      [["catalog", "--help"], /catalog <update\|search/],
      [["catalog", "update", "--help"], /catalog update/],
      [["catalog", "build", "--help"], /catalog build/],
    ]) {
      const result = run(args);
      assert.equal(result.status, 0);
      assert.match(result.stdout, expected);
    }

    await withServer((request, response) => {
      assert.equal(request.headers.a, "1");
      assert.equal(request.headers.b, "2");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }, async base => {
      const success = await runAsync([
        "pay", `${base}/plain`, "--header=A: 1", "--header=B: 2", "--json",
      ]);
      assert.equal(success.status, 0, success.stderr);
      assert.equal(JSON.parse(success.stdout).command, "pay");
    });

    const failure = run(["pay", "--json"]);
    assert.equal(JSON.parse(failure.stdout).command, "pay");

    const port = 50000 + Math.floor(Math.random() * 1000);
    const roundtrip = await runAsync([
      "roundtrip",
      "--pay-to", "TTX1Us19zqsLXhY39PPR7KRUoMa93s3J3i",
      "--port", String(port),
      "--dry-run",
      "--json",
    ]);
    assert.equal(roundtrip.status, 0, roundtrip.stderr);
    const roundtripJson = JSON.parse(roundtrip.stdout);
    assert.equal(roundtripJson.command, "roundtrip");
    assert.ok(roundtripJson.result.serve);
    assert.ok(roundtripJson.result.pay);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
