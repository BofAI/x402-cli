import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "dist", "cli.js");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  });
}

function runAsync(args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
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
      { fqn: "alpha", title: "Alpha", category: "finance", featured_tags: ["defi"], chains: ["tron:nile"] },
      { fqn: "blocked", title: "Blocked", category: "security", block: true, featured_tags: ["defi"] },
    ],
  };
  const alpha = {
    fqn: "alpha",
    title: "Alpha Provider",
    category: "finance",
    service_url: "https://alpha.example",
    chains: ["tron:nile"],
    featured_tags: ["defi", "tvl"],
    endpoints: [
      {
        method: "GET",
        path: "/protocols",
        url: "https://gateway.example/providers/alpha/protocols",
        description: "DeFi TVL endpoint",
        paid: { network: "tron:nile", currency: "USDT", amount_raw: "1" },
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

test("weighted catalog and gateway search support include-blocked and json output", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-cli-catalog-"));
  try {
    catalogFixture(dir);
    const source = path.join(dir, "catalog.json");
    const search = run(["catalog", "search", "defi", "--catalog", source, "--json"]);
    assert.equal(search.status, 0, search.stderr);
    const parsed = JSON.parse(search.stdout);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.results[0].fqn, "alpha");
    assert.ok(parsed.results[0].score > 0);
    assert.ok(parsed.results[0].matchedFields.includes("tags"));

    const included = run(["gateway", "search", "defi", "--catalog", source, "--include-blocked", "--json"]);
    assert.equal(included.status, 0, included.stderr);
    const includedJson = JSON.parse(included.stdout);
    assert.equal(includedJson.count, 2);

    const human = run(["gateway", "search", "defi", "--catalog", source]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /score=/);
    assert.match(human.stdout, /category=finance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("catalog export-gateway writes public catalog and pay docs", async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "x402-cli-export-"));
  const detail = {
    fqn: "alpha",
    title: "Alpha Provider",
    subtitle: "Alpha subtitle",
    description: "Alpha description",
    category: "finance",
    chains: ["tron:nile"],
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

test("gateway check validates provider files", () => {
  const providerDir = path.resolve(root, "..", "x402-gateway", "providers");
  const result = run(["gateway", "check", providerDir, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.count, 28);
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
