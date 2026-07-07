#!/usr/bin/env node
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { createPaymentPayload, decodeRequired, decodeResponse, encodeRequired, encodeResponse, encodeSignature, headers, PaymentRequirement } from "./x402.js";
import { getToken, normalizeNetwork, toSmallestUnit } from "./tokens.js";

type Options = Record<string, string | boolean>;
type ParsedOptions = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): { command: string; positional: string[]; options: ParsedOptions } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const options: ParsedOptions = {};
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      if (key === "header") {
        const current = options[key];
        options[key] = Array.isArray(current) ? [...current, next] : current ? [String(current), next] : [next];
      } else {
        options[key] = next;
      }
      i += 1;
    }
  }
  return { command, positional, options };
}

function opt(options: ParsedOptions, key: string, fallback?: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : fallback;
}

function optAll(options: ParsedOptions, key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readYaml(file: string): any {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function expandDeep<T>(value: T): T {
  if (typeof value === "string") return expandEnv(value) as T;
  if (Array.isArray(value)) return value.map(expandDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandDeep(item)])) as T;
  }
  return value;
}

function providerFiles(root: string): string[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, String(entry));
    if (file.endsWith("provider.yml") || file.endsWith("provider.yaml")) out.push(file);
  }
  return out.sort();
}

function loadProviderFile(file: string): any {
  const provider = expandDeep(readYaml(file));
  validateProvider(provider, file);
  provider.operator.network = normalizeNetwork(provider.operator.network);
  provider.operator.scheme = "exact";
  return provider;
}

function validateProvider(provider: any, file = "provider.yml"): void {
  const required = [
    ["name", provider?.name],
    ["forward_url", provider?.forward_url],
    ["operator.network", provider?.operator?.network],
    ["operator.recipient", provider?.operator?.recipient],
  ];
  for (const [name, value] of required) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: ${name} is required`);
  }
  if (!Array.isArray(provider.endpoints) || !provider.endpoints.length) {
    throw new Error(`${file}: endpoints must contain at least one endpoint`);
  }
  const seen = new Set<string>();
  for (const endpoint of provider.endpoints) {
    if (typeof endpoint.method !== "string" || typeof endpoint.path !== "string") {
      throw new Error(`${file}: each endpoint needs method and path`);
    }
    const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    if (seen.has(key)) throw new Error(`${file}: duplicate endpoint ${key}`);
    seen.add(key);
  }
}

function providerPrice(endpoint: any): number {
  return endpoint?.metering?.dimensions?.[0]?.tiers?.[0]?.price_usd ?? 0;
}

function providerAssetTransferMethod(provider: any): string {
  return provider.operator?.asset_transfer_method ?? provider.operator?.assetTransferMethod ?? "permit2";
}

function providerCatalog(provider: any): any {
  return {
    name: provider.name,
    title: provider.title ?? provider.name,
    description: provider.description ?? "",
    category: provider.category ?? "other",
    service_url: provider.display?.service_url,
    tags: provider.display?.tags ?? [],
    network: normalizeNetwork(provider.operator.network),
    currency: provider.operator.currencies?.usd?.[0] ?? "USDT",
    endpoints: (provider.endpoints ?? []).map((endpoint: any) => ({
      method: endpoint.method.toUpperCase(),
      path: `/providers/${provider.name}${endpoint.path}`,
      upstream_path: endpoint.path,
      description: endpoint.description ?? "",
      paid: providerPrice(endpoint) > 0 ? {
        scheme: "exact",
        network: normalizeNetwork(provider.operator.network),
        currency: provider.operator.currencies?.usd?.[0] ?? "USDT",
        price_usd: providerPrice(endpoint),
      } : null,
      x402_routes: providerPrice(endpoint) > 0 ? [{
        provider: provider.name,
        network: normalizeNetwork(provider.operator.network),
        scheme: "exact",
        assetTransferMethod: providerAssetTransferMethod(provider),
        url: `/providers/${provider.name}${endpoint.path}`,
      }] : [],
    })),
  };
}

async function readCatalog(source: string): Promise<any[]> {
  const text = await readText(source);
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.providers)) return parsed.providers;
  if (Array.isArray(parsed.items)) return parsed.items;
  return [];
}

async function readText(source: string): Promise<string> {
  if (!source.startsWith("http://") && !source.startsWith("https://")) {
    return fs.readFileSync(source, "utf8");
  }
  const response = await fetch(source);
  if (!response.ok) throw new Error(`failed to fetch ${source}: ${response.status}`);
  return response.text();
}

async function readJson(source: string): Promise<any> {
  return JSON.parse(await readText(source));
}

function catalogDetailSource(source: string, section: "providers" | "pay", name: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const base = new URL(source);
    const pathname = base.pathname.endsWith("/catalog.json")
      ? base.pathname.slice(0, -"catalog.json".length)
      : base.pathname.endsWith("/")
        ? base.pathname
        : `${base.pathname}/`;
    base.pathname = `${pathname}${section}/${name}.json`;
    base.search = "";
    base.hash = "";
    return base.toString();
  }
  const stat = fs.existsSync(source) ? fs.statSync(source) : undefined;
  const root = stat?.isDirectory() ? source : path.dirname(source);
  return path.join(root, section, `${name}.json`);
}

async function readCatalogProvider(source: string, name: string): Promise<any> {
  const providers = await readCatalog(source);
  const summary = providers.find((item: any) => item.name === name || item.fqn === name);
  if (!summary) throw new Error(`provider not found: ${name}`);
  if (Array.isArray(summary.endpoints) && summary.endpoints.length) return summary;
  const fqn = summary.fqn ?? summary.name ?? name;
  try {
    return await readJson(catalogDetailSource(source, "providers", fqn));
  } catch {
    return summary;
  }
}

async function readCatalogPayProvider(source: string, name: string): Promise<any> {
  const providers = await readCatalog(source);
  const summary = providers.find((item: any) => item.name === name || item.fqn === name);
  const fqn = summary?.fqn ?? summary?.name ?? name;
  try {
    return await readJson(catalogDetailSource(source, "pay", fqn));
  } catch {
    if (summary) return readCatalogProvider(source, name);
    throw new Error(`provider not found: ${name}`);
  }
}

function buildRequirement(options: ParsedOptions): PaymentRequirement {
  const network = normalizeNetwork(opt(options, "network", "tron:nile")!);
  const tokenSymbol = opt(options, "token", "USDT")!;
  const token = getToken(network, tokenSymbol);
  const amount = opt(options, "rawAmount") ?? toSmallestUnit(opt(options, "amount", "0.0001")!, token.decimals);
  return {
    scheme: "exact",
    network,
    amount,
    asset: opt(options, "asset") ?? token.address,
    payTo: opt(options, "pay-to") ?? opt(options, "payTo") ?? "",
    maxTimeoutSeconds: Number(opt(options, "valid-for-seconds", "300")),
    extra: token.assetTransferMethod ? { assetTransferMethod: token.assetTransferMethod } : {},
  };
}

async function facilitatorPost(baseUrl: string, path: string, body: unknown): Promise<any> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`facilitator ${path} failed: ${response.status} ${text}`);
  return data;
}

function requestHeaders(options: ParsedOptions): Headers {
  const headersOut = new Headers();
  for (const header of optAll(options, "header")) {
    const idx = header.indexOf(":");
    if (idx <= 0) throw new Error(`invalid --header '${header}', expected 'Name: Value'`);
    headersOut.set(header.slice(0, idx).trim(), header.slice(idx + 1).trim());
  }
  return headersOut;
}

function validateAmountLimits(selected: PaymentRequirement, options: ParsedOptions): void {
  const maxRaw = opt(options, "max-rawAmount") ?? opt(options, "max-raw-amount");
  const maxAmount = opt(options, "max-amount");
  if (maxRaw && BigInt(selected.amount) > BigInt(maxRaw)) {
    throw new Error(`payment raw amount ${selected.amount} exceeds --max-rawAmount ${maxRaw}`);
  }
  if (maxAmount) {
    const token = getToken(selected.network, opt(options, "token", "USDT")!);
    if (BigInt(selected.amount) > BigInt(toSmallestUnit(maxAmount, token.decimals))) {
      throw new Error(`payment amount exceeds --max-amount ${maxAmount}`);
    }
  }
}

async function serve(options: ParsedOptions): Promise<void> {
  const host = opt(options, "host", "127.0.0.1")!;
  const port = Number(opt(options, "port", "4020"));
  const facilitatorUrl = opt(options, "facilitator-url", process.env.FACILITATOR_URL ?? "https://facilitator.bankofai.io")!;
  const requirement = buildRequirement(options);
  if (!requirement.payTo) throw new Error("--pay-to is required");
  const resourceUrl = opt(options, "resource-url", `http://${host}:${port}/pay`)!;
  const challenge = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resourceUrl },
    accepts: [requirement],
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/health")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url?.startsWith("/.well-known/x402")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ network: requirement.network, scheme: "exact", asset: requirement.asset, amount: requirement.amount, payTo: requirement.payTo, pay_url: resourceUrl }));
        return;
      }
      if (!request.url?.startsWith("/pay")) {
        response.writeHead(404).end("not found");
        return;
      }
      const signature = request.headers[headers.signature.toLowerCase()];
      if (!signature || Array.isArray(signature)) {
        response.writeHead(402, {
          "content-type": "application/json",
          [headers.required]: encodeRequired(challenge),
        });
        response.end(JSON.stringify(challenge));
        return;
      }
      const payload = Buffer.from(signature, "base64").toString("utf8").startsWith("{")
        ? JSON.parse(Buffer.from(signature, "base64").toString("utf8"))
        : signature;
      const verify = await facilitatorPost(facilitatorUrl, "/verify", {
        paymentPayload: payload,
        paymentRequirements: requirement,
      });
      if (verify?.valid === false || verify?.isValid === false) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "payment verification failed", verify }));
        return;
      }
      const settle = await facilitatorPost(facilitatorUrl, "/settle", {
        paymentPayload: payload,
        paymentRequirements: requirement,
      });
      response.writeHead(200, {
        "content-type": "application/json",
        [headers.response]: encodeResponse(settle),
      });
      response.end(JSON.stringify({ success: true, network: requirement.network, scheme: "exact", transaction: settle.transaction ?? settle.txHash ?? null }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.listen(port, host, () => {
    printJson({ ok: true, command: "server", network: requirement.network, scheme: "exact", result: { pay_url: resourceUrl, token: opt(options, "token", "USDT"), rawAmount: requirement.amount, pay_to: requirement.payTo } });
  });
}

function selectRequirement(accepts: PaymentRequirement[], options: ParsedOptions): PaymentRequirement {
  const network = opt(options, "network");
  const scheme = opt(options, "scheme");
  const token = opt(options, "token");
  const selected = accepts.find(req => {
    if (network && normalizeNetwork(network) !== req.network) return false;
    if (scheme && scheme !== req.scheme) return false;
    if (token) {
      const tokenInfo = getToken(req.network, token);
      if (tokenInfo.address.toLowerCase() !== req.asset.toLowerCase()) return false;
    }
    return true;
  });
  if (!selected) throw new Error("no matching payment requirement");
  return selected;
}

async function pay(url: string, options: ParsedOptions): Promise<void> {
  const method = opt(options, "method", "GET")!;
  const baseHeaders = requestHeaders(options);
  const probe = await fetch(url, {
    method,
    headers: baseHeaders,
    body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : opt(options, "body"),
  });
  if (probe.status !== 402) {
    printJson({ ok: true, command: "client", result: { status: probe.status, body: await probe.text() } });
    return;
  }
  const header = probe.headers.get(headers.required);
  if (!header) throw new Error("402 response missing PAYMENT-REQUIRED header");
  const required = decodeRequired(header);
  const selected = selectRequirement(required.accepts ?? [], options);
  validateAmountLimits(selected, options);
  if (options["dry-run"]) {
    printJson({
      ok: true,
      command: "client",
      network: selected.network,
      scheme: "exact",
      result: {
        url,
        resource: required.resource?.url ?? url,
        selected,
        message: "Dry run - no payment submitted",
      },
    });
    return;
  }
  const payload = await createPaymentPayload({
    selected,
    resource: required.resource?.url ?? url,
    extensions: required.extensions,
    rpcUrl: opt(options, "rpc-url"),
    privateKey: opt(options, "private-key"),
  });
  const retryHeaders = new Headers(baseHeaders);
  retryHeaders.set(headers.signature, encodeSignature(payload));
  const paid = await fetch(url, {
    method,
    headers: retryHeaders,
    body: opt(options, "body"),
  });
  const text = await paid.text();
  const paymentResponse = paid.headers.get(headers.response);
  printJson({
    ok: paid.ok,
    command: "client",
    network: selected.network,
    scheme: "exact",
    result: {
      status: paid.status,
      body: text,
      ...(paymentResponse ? { paymentResponse: decodeResponse(paymentResponse) } : {}),
    },
  });
}

async function roundtrip(options: ParsedOptions): Promise<void> {
  const port = Number(opt(options, "port", "4020"));
  serve(options);
  await delay(500);
  await pay(`http://127.0.0.1:${port}/pay`, options);
  process.exit(0);
}

function gatewayBinary(): string {
  return process.env.X402_GATEWAY_BIN ||
    path.resolve(process.cwd(), "../x402-gateway/dist/cli.js");
}

async function gatewayStart(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [gatewayBinary(), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`gateway exited with ${code}`)));
    child.on("error", reject);
  });
}

function gatewayCheck(target: string): void {
  const files = providerFiles(target);
  const providers = files.map(loadProviderFile);
  const names = new Set<string>();
  for (const provider of providers) {
    if (names.has(provider.name)) throw new Error(`duplicate provider name: ${provider.name}`);
    names.add(provider.name);
  }
  printJson({ ok: true, providers: providers.map(p => p.name), count: providers.length });
}

function gatewayScaffold(name: string, options: ParsedOptions): void {
  const outputDir = opt(options, "output-dir", path.join("providers", name))!;
  const forwardUrl = opt(options, "forward-url", "https://api.example.com")!;
  fs.mkdirSync(outputDir, { recursive: true });
  const body = `name: ${name}
title: "${name}"
description: "x402 provider"
category: data
version: v1

forward_url: ${forwardUrl}

routing:
  type: proxy

operator:
  network: tron-nile
  currencies:
    usd: ["USDT"]
  recipient: \${X402_PROVIDER_RECIPIENT_TRON}
  scheme: exact
  protocol: exact
  asset_transfer_method: permit2
  facilitator_url: \${X402_FACILITATOR_URL}
  facilitator_api_key: \${X402_FACILITATOR_API_KEY}
  valid_for_seconds: 300

endpoints:
  - method: GET
    path: /v1/ping
    metering:
      dimensions:
        - tiers:
            - price_usd: 0.0001
`;
  fs.writeFileSync(path.join(outputDir, "provider.yml"), body);
  printJson({ ok: true, file: path.join(outputDir, "provider.yml") });
}

function catalogBuild(target: string, options: ParsedOptions): void {
  const providers = providerFiles(target).map(loadProviderFile).map(providerCatalog);
  const catalog = { version: 1, generatedAt: new Date().toISOString(), providers };
  const output = opt(options, "output", opt(options, "dist-dir") ? path.join(opt(options, "dist-dir")!, "catalog.json") : undefined);
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(catalog, null, 2));
    printJson({ ok: true, output, count: providers.length });
  } else {
    printJson(catalog);
  }
}

function catalogPayAssets(target: string): void {
  const rows = providerFiles(target).map(loadProviderFile).flatMap(provider =>
    (provider.endpoints ?? []).map((endpoint: any) => ({
      provider: provider.name,
      method: endpoint.method,
      path: `/providers/${provider.name}${endpoint.path}`,
      network: normalizeNetwork(provider.operator.network),
      currency: provider.operator.currencies?.usd?.[0] ?? "USDT",
      price_usd: providerPrice(endpoint),
      scheme: "exact",
      assetTransferMethod: providerAssetTransferMethod(provider),
    })),
  );
  printJson({ assets: rows, count: rows.length });
}

async function catalogSearch(source: string, query: string, options: ParsedOptions): Promise<void> {
  const providers = await readCatalog(source);
  const q = query.toLowerCase();
  const hits = providers
    .map((provider: any) => {
      const haystack = [
        provider.fqn,
        provider.name,
        provider.title,
        provider.main_title,
        provider.mainTitle,
        provider.description,
        provider.category,
        ...(provider.chains ?? []),
        ...(provider.featured_tags ?? []),
        ...(provider.featuredTags ?? []),
        ...(provider.tags ?? []),
        ...(provider.endpoints ?? []).map((e: any) => `${e.method} ${e.path} ${e.description ?? ""}`),
      ].join(" ").toLowerCase();
      const score = q.split(/\s+/).filter(Boolean).reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { provider, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(opt(options, "limit", "10")));
  printJson({ query, count: hits.length, results: hits.map(item => item.provider) });
}

async function catalogShow(source: string, name: string): Promise<void> {
  printJson(await readCatalogProvider(source, name));
}

async function catalogEndpoints(source: string, name: string): Promise<void> {
  const provider = await readCatalogProvider(source, name);
  printJson({ provider: provider.fqn ?? provider.name, endpoints: provider.endpoints ?? [] });
}

async function catalogPayJson(source: string, name: string): Promise<void> {
  const provider = await readCatalogPayProvider(source, name);
  const endpoint = (provider.endpoints ?? []).find((item: any) => item.paid || item.x402_routes?.length || item.x402Routes?.length) ?? provider.endpoints?.[0];
  if (!endpoint) throw new Error(`provider has no endpoints: ${name}`);
  printJson({
    provider: provider.fqn ?? provider.name,
    url: endpoint.url ?? endpoint.path,
    method: endpoint.method,
    paid: endpoint.paid,
    x402_routes: endpoint.x402_routes ?? endpoint.x402Routes ?? [],
    endpoint,
  });
}

async function handleGateway(args: string[]): Promise<void> {
  const { command, positional, options } = parseArgs(args);
  if (command === "start") await gatewayStart(["--providers", opt(options, "providers", opt(options, "providers-dir", positional[0] ?? "providers"))!, "--host", opt(options, "host", "127.0.0.1")!, "--port", opt(options, "port", "4020")!]);
  else if (command === "check") gatewayCheck(positional[0] ?? opt(options, "providers", "providers")!);
  else if (command === "scaffold") gatewayScaffold(positional[0] ?? "example-provider", options);
  else if (command === "catalog") await handleGatewayCatalog(positional, options);
  else throw new Error("Usage: x402-cli gateway <start|check|scaffold|catalog>");
}

async function handleGatewayCatalog(positional: string[], options: ParsedOptions): Promise<void> {
  const sub = positional[0] ?? "build";
  const target = positional[1] ?? opt(options, "providers", "providers")!;
  if (sub === "build") catalogBuild(target, options);
  else if (sub === "check") gatewayCheck(target);
  else if (sub === "pay-assets") catalogPayAssets(target);
  else if (sub === "search") await catalogSearch(opt(options, "catalog", target)!, positional.slice(2).join(" ") || opt(options, "query", "")!, options);
  else throw new Error("Usage: x402-cli gateway catalog <build|check|pay-assets|search>");
}

async function handleCatalog(args: string[]): Promise<void> {
  const { command, positional, options } = parseArgs(args);
  const source = opt(options, "catalog", process.env.X402_CATALOG || "dist/catalog.json")!;
  if (command === "search") await catalogSearch(source, positional.join(" "), options);
  else if (command === "show") await catalogShow(source, positional[0]);
  else if (command === "endpoints") await catalogEndpoints(source, positional[0]);
  else if (command === "pay-json") await catalogPayJson(source, positional[0]);
  else if (command === "build") catalogBuild(positional[0] ?? "providers", options);
  else throw new Error("Usage: x402-cli catalog <search|show|endpoints|pay-json|build>");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, positional, options } = parseArgs(argv);
  if (command === "serve") await serve(options);
  else if (command === "pay") await pay(positional[0], options);
  else if (command === "roundtrip") await roundtrip(options);
  else if (command === "gateway") await handleGateway(argv.slice(1));
  else if (command === "catalog") await handleCatalog(argv.slice(1));
  else {
    process.stdout.write("Usage: x402-cli <serve|pay|roundtrip|gateway|catalog> [options]\n");
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
