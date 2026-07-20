#!/usr/bin/env node
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPaymentPayload, decodeRequired, decodeResponse, decodeSignature, encodeRequired, encodeResponse, encodeSignature, headers, PaymentRequirement } from "./x402.js";
import { assertRawAmount, findTokenByAddress, getToken, normalizeNetwork, toSmallestUnit } from "./tokens.js";
import { CliError, hasFlag, opt, optAll, outputMode, parseArgs, requireArgument, type ParsedOptions } from "./args.js";
import { classify, emit, printJson } from "./output.js";
import { fetchWithTimeout, positiveIntegerOption, readBoundedText, readJson, readText, responsePayload, timeoutMs } from "./http-client.js";
import { loadProviderFile, providerAssetTransferMethod, providerCatalog, providerFiles, providerPrice, providerScheme, validateProvider } from "./provider-config.js";

const require = createRequire(import.meta.url);
const CATALOG_UPDATE_RETRIES = 3;

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function helpText(topic = "root"): string {
  const sections: Record<string, string> = {
    root: `x402-cli ${getVersion()}

Usage:
  x402-cli <command> [options]

Commands:
  pay <url>                 Pay an x402-protected URL
  serve                     Run a local x402 paywall endpoint
  roundtrip                 Start serve, pay it, then exit
  gateway <command>         Manage local gateway provider files
  catalog <command>         Search, cache, and export provider catalog assets

Global options:
  -h, --help                Show help
  -V, --version             Show version
  --json                    Print machine-readable JSON envelope
  --human                   Print human-readable output (default)
`,
    pay: `Usage:
  x402-cli pay <url> [options]

Options:
  --method <method>         HTTP method (default: GET)
  --header "Name: Value"    Request header, repeatable
  --body <body>             Request body for non-GET/HEAD methods
  --network <caip2>         Require a specific network
  --token <symbol>          Require a specific token
  --scheme <scheme>         Require a specific x402 scheme
  --gasfree-api-url <url>   Override the TRON GasFree relayer API URL
  --max-gasfree-fee <amt>   Maximum GasFree relayer fee in token units
  --max-gasfree-fee-raw <n> Maximum GasFree relayer fee in smallest units
  --max-amount <amount>     Maximum human-readable payment amount
  --max-raw-amount <amount> Maximum smallest-unit payment amount
  --dry-run                 Read requirements but do not sign or pay
  --private-key <hex>       Explicit payer private key (or PRIVATE_KEY/TRON_PRIVATE_KEY/EVM_PRIVATE_KEY)
  --rpc-url <url>           Explicit network RPC URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --json                    Print JSON envelope

Examples:
  x402-cli pay https://api.example.com/paid --dry-run --json
  x402-cli pay https://api.example.com/paid --max-amount 0.01
`,
    serve: `Usage:
  x402-cli serve --pay-to <address> [options]

Options:
  --pay-to <address>        Recipient wallet address
  --amount <amount>         Human-readable token amount (default: 0.0001)
  --raw-amount <amount>     Smallest-unit amount
  --network <caip2>         Payment network (default: tron:0xcd8690dc)
  --scheme <scheme>         Payment scheme: exact or exact_gasfree (default: exact)
  --token <symbol>          Token symbol (default: USDT)
  --asset <address>         Explicit token address
  --decimals <count>        Token decimals for unregistered --asset
  --host <host>             Bind host (default: 127.0.0.1)
  --port <port>             Bind port (default: 4020)
  --resource-url <url>      URL advertised in payment requirements
  --facilitator-url <url>   Facilitator base URL
  --timeout-ms <ms>         Facilitator timeout in milliseconds (default: 30000)
  --daemon                  Run in background and print the child pid
  --json                    Print JSON envelope

Examples:
  x402-cli serve --pay-to T... --network tron:0xcd8690dc --token USDT
  x402-cli serve --pay-to 0x... --network eip155:97 --token USDT --amount 0.0001
`,
    roundtrip: `Usage:
  x402-cli roundtrip --pay-to <address> [serve/pay options]
`,
    gateway: `Usage:
  x402-cli gateway <search|start|check|scaffold|catalog> [options]

Commands:
  search <query>            Search a gateway/catalog artifact
  start                     Start a local x402 gateway process
  check <providers>         Validate provider.yml files
  scaffold <name>           Write a starter provider.yml
  catalog <command>         Build/check/search gateway catalog assets
`,
    "gateway-catalog": `Usage:
  x402-cli gateway catalog <build|check|pay-assets|search> [options]

Commands:
  build <providers>         Build a local catalog from provider.yml files
  check <providers>         Validate local provider.yml files
  pay-assets <providers>    List payable endpoint assets
  search <query>            Search a catalog artifact
`,
    catalog: `Usage:
  x402-cli catalog <update|search|show|endpoints|pay-json|export-gateway|build> [options]

Commands:
  update                    Cache hosted/local catalog assets under ~/.cache
  search <query>            Search providers
  show <provider>           Show provider detail JSON
  endpoints <provider>      List provider endpoints
  pay-json <provider>       Print provider pay JSON
  export-gateway <url>      Export catalog.json and pay.md from a gateway
  build <providers>         Build catalog from provider.yml files

Options:
  --catalog <source>        catalog.json path or URL
  --provider <fqn>          Provider FQN for export-gateway
  --output-dir <dir>        Output directory for generated files
  -n, --limit <count>       Search result limit
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --include-blocked         Include blocked providers in search
  --json                    Print JSON envelope
`,
    "catalog-search": `Usage:
  x402-cli catalog search <query> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  -n, --limit <count>       Search result limit
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --include-blocked         Include blocked providers in search
  --json                    Print JSON envelope
`,
    "catalog-show": `Usage:
  x402-cli catalog show <provider> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --json                    Print JSON envelope
`,
    "catalog-pay-json": `Usage:
  x402-cli catalog pay-json <provider> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --raw                     Print raw pay payload instead of JSON envelope
  --json                    Print JSON envelope
`,
    "catalog-endpoints": `Usage:
  x402-cli catalog endpoints <provider> [--catalog <source>] [options]

Options:
  --catalog <source>        catalog.json path or URL
  --timeout-ms <ms>         Network timeout in milliseconds (default: 30000)
  --json                    Print JSON envelope
`,
    "catalog-export-gateway": `Usage:
  x402-cli catalog export-gateway <gateway-url> --provider <fqn> [options]

Options:
  --provider <fqn>          Provider FQN to export
  --output-dir <dir>        Output directory for generated files
  --force                   Overwrite existing files
  --json                    Print JSON envelope
`,
  };
  return sections[topic] ?? sections.root;
}

type SearchHit = {
  provider: any;
  detail: any;
  fqn: string;
  title: string;
  category: string;
  serviceUrl: string;
  description?: string;
  useCase?: string;
  titleZh?: string;
  mainTitle?: string;
  subTitle?: string;
  categoryMeta?: Record<string, unknown>;
  chains: string[];
  chainKinds: string[];
  chainsMeta: Record<string, unknown>[];
  tags: string[];
  endpoints: any[];
  score: number;
  matchedFields: string[];
};

const FIELD_WEIGHTS: Record<string, number> = {
  fqn: 12,
  title: 10,
  tags: 8,
  chain_kinds: 8,
  chains: 8,
  category: 6,
  category_meta: 6,
  endpoints: 6,
  i18n: 5,
  description: 4,
  use_case: 4,
  service_url: 2,
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => item != null).map(String) : [];
}

function dictValues(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && typeof child === "object" && !Array.isArray(child)) out.push(...dictValues(child));
    else if (Array.isArray(child)) out.push(...child.filter(item => item != null).map(String));
    else if (child != null) out.push(String(child));
  }
  return out;
}

function chainMetaValues(chainsMeta: Record<string, unknown>[]): string[] {
  return chainsMeta.flatMap(dictValues);
}

function endpointFields(endpoints: any[]): string[] {
  const values: string[] = [];
  for (const endpoint of endpoints) {
    values.push(String(endpoint.method ?? ""), String(endpoint.path ?? ""), String(endpoint.probe_status ?? ""));
    const paid = endpoint.paid;
    if (paid && typeof paid === "object") {
      values.push(String(paid.network ?? ""), String(paid.currency ?? ""), String(paid.amount_raw ?? ""));
    }
    values.push(String(endpoint.title ?? ""), String(endpoint.description ?? ""), String(endpoint.use_case ?? endpoint.useCase ?? ""));
  }
  return values;
}

function scoreFields(terms: string[], fields: Record<string, string[]>): { score: number; matchedFields: string[] } {
  let score = 0;
  const matchedFields: string[] = [];
  for (const [field, values] of Object.entries(fields)) {
    const haystack = values.filter(Boolean).join(" ").toLowerCase();
    if (!haystack) continue;
    const count = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    if (count) {
      score += (FIELD_WEIGHTS[field] ?? 1) * count;
      matchedFields.push(field);
    }
  }
  return { score, matchedFields };
}

async function readCatalog(source: string, options?: ParsedOptions): Promise<any[]> {
  const text = await readText(source, options);
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.providers)) return parsed.providers;
  if (Array.isArray(parsed.items)) return parsed.items;
  return [];
}

async function readCatalogObject(source: string, options?: ParsedOptions): Promise<Record<string, any>> {
  const parsed = JSON.parse(await readText(source, options));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`expected JSON object from ${source}`);
  }
  return parsed;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function withSdkStdoutRedirect<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    process.stderr.write(`${args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg, null, 2)).join(" ")}\n`);
  };
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "x402-cli", "catalog");
}

function cachedCatalogPath(): string {
  return path.join(cacheDir(), "catalog.json");
}

function providerFilename(fqn: string): string {
  return `${sanitizeProviderName(fqn).replace(/\//g, "__")}.json`;
}

function sanitizeProviderName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(name) || name.includes("..")) {
    throw new Error("provider name must be a safe FQN using letters, numbers, dots, underscores, dashes, or slashes");
  }
  return name;
}

function safeOutputPath(baseDir: string, ...parts: string[]): string {
  const root = path.resolve(baseDir);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to write outside output directory: ${target}`);
  }
  return target;
}

function ensureWritable(file: string, options: ParsedOptions): void {
  if (fs.existsSync(file) && !hasFlag(options, "force")) {
    throw new Error(`${file} already exists; pass --force to overwrite`);
  }
}

function defaultCatalogSource(): string {
  const envSource = process.env.X402_CATALOG || process.env.X402_GATEWAY_CATALOG;
  if (envSource) return envSource;
  return fs.existsSync(cachedCatalogPath())
    ? cachedCatalogPath()
    : "https://x402-catalog.bankofai.io/api/catalog.json";
}

function remoteBaseFromCatalogPayload(payload: Record<string, any>): string | undefined {
  const base = payload.base_url ?? payload.baseUrl;
  return typeof base === "string" && /^https?:\/\//.test(base) ? `${base.replace(/\/+$/, "")}/` : undefined;
}

async function remoteBaseFromSource(source: string, payload?: Record<string, any>, options?: ParsedOptions): Promise<string | undefined> {
  const fromPayload = payload ? remoteBaseFromCatalogPayload(payload) : undefined;
  if (fromPayload) {
    if (/^https?:\/\//.test(source) && new URL(fromPayload).origin !== new URL(source).origin) throw new Error("catalog base_url must use the same origin as the catalog source");
    return fromPayload;
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return `${source.slice(0, source.lastIndexOf("/") + 1)}`;
  }
  try {
    return remoteBaseFromCatalogPayload(await readCatalogObject(source, options));
  } catch {
    return undefined;
  }
}

function catalogDetailSource(source: string, section: "providers" | "pay", name: string): string {
  name = sanitizeProviderName(name);
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const base = new URL(source);
    const pathname = base.pathname.endsWith("/catalog.json")
      ? base.pathname.slice(0, -"catalog.json".length)
      : base.pathname.endsWith("/")
        ? base.pathname
        : `${base.pathname}/`;
    base.pathname = `${pathname}${section}/${providerFilename(name)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  }
  const stat = fs.existsSync(source) ? fs.statSync(source) : undefined;
  const root = stat?.isDirectory() ? source : path.dirname(source);
  const direct = path.join(root, section, `${name}.json`);
  if (fs.existsSync(direct)) return direct;
  return path.join(root, section, providerFilename(name));
}

async function readCatalogProvider(source: string, name: string, options?: ParsedOptions): Promise<any> {
  const providers = await readCatalog(source, options);
  const summary = providers.find((item: any) => item.name === name || item.fqn === name);
  if (!summary) throw new Error(`provider not found: ${name}`);
  const fqn = summary.fqn ?? summary.name ?? name;
  try {
    return await readJson(catalogDetailSource(source, "providers", fqn), options);
  } catch {
    return summary;
  }
}

async function readCatalogPayProvider(source: string, name: string, options?: ParsedOptions): Promise<any> {
  const providers = await readCatalog(source, options);
  const summary = providers.find((item: any) => item.name === name || item.fqn === name);
  const fqn = summary?.fqn ?? summary?.name ?? name;
  try {
    return await readJson(catalogDetailSource(source, "pay", fqn), options);
  } catch {
    if (summary) return readCatalogProvider(source, name, options);
    throw new Error(`provider not found: ${name}`);
  }
}

async function cacheProviderAssets(source: string, catalogPayload: Record<string, any>, options: ParsedOptions): Promise<{ detailCount: number; payCount: number; warnings: string[] }> {
  const base = await remoteBaseFromSource(source, catalogPayload, options);
  const warnings: string[] = [];
  if (!base) return { detailCount: 0, payCount: 0, warnings };
  let detailCount = 0;
  let payCount = 0;
  for (const provider of catalogPayload.providers ?? []) {
    const fqn = provider?.fqn ?? provider?.name;
    if (typeof fqn !== "string" || !fqn) continue;
    const filename = providerFilename(fqn);
    try {
      const detail = await readJson(new URL(`providers/${filename}`, base).toString(), options);
      writeJson(path.join(cacheDir(), "providers", filename), detail);
      detailCount += 1;
    } catch (error) {
      warnings.push(`failed to cache provider detail ${fqn}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const pay = await readJson(new URL(`pay/${filename}`, base).toString(), options);
      writeJson(path.join(cacheDir(), "pay", filename), pay);
      payCount += 1;
    } catch (error) {
      warnings.push(`failed to cache pay JSON ${fqn}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { detailCount, payCount, warnings };
}

async function catalogUpdate(source: string, options: ParsedOptions): Promise<void> {
  let payload: Record<string, any> | undefined;
  const warnings: string[] = [];
  for (let attempt = 1; attempt <= CATALOG_UPDATE_RETRIES; attempt += 1) {
    try {
      payload = await readCatalogObject(source, options);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === CATALOG_UPDATE_RETRIES) throw error;
      warnings.push(`catalog update attempt ${attempt} failed: ${message}`);
      await delay(250 * attempt);
    }
  }
  if (!payload) throw new Error(`failed to read catalog from ${source}`);
  writeJson(cachedCatalogPath(), payload);
  const cached = await cacheProviderAssets(source, payload, options);
  const result = {
    source,
    path: cachedCatalogPath(),
    providerCount: payload.provider_count ?? payload.providerCount ?? (payload.providers ?? []).length,
    detailCount: cached.detailCount,
    payCount: cached.payCount,
    warnings: [...warnings, ...cached.warnings],
  };
  emit({ command: "catalog update", mode: outputMode(options), result });
}

function zhCopy(title: string, subtitle: string, description: string, useCase: string): Record<string, string> {
  return { title, subtitle, description, useCase };
}

function submissionCatalog(detail: any): any {
  const title = String(detail.title ?? detail.fqn);
  const subtitle = String(detail.subtitle ?? detail.use_case ?? title);
  const description = String(detail.description ?? subtitle);
  const useCase = String(detail.use_case ?? detail.useCase ?? description);
  return {
    version: 1,
    fqn: detail.fqn,
    title,
    subtitle,
    description,
    useCase,
    i18n: detail.i18n ?? { "zh-CN": zhCopy(title, subtitle, description, useCase) },
    logo: detail.logo ?? "https://x402-catalog.bankofai.io/assets/providers/default.png",
    category: detail.category ?? "other",
    chains: detail.chains ?? [],
    isFirstParty: Boolean(detail.is_first_party ?? detail.isFirstParty),
    isFeatured: Boolean(detail.is_featured ?? detail.isFeatured),
    featuredTags: detail.featured_tags ?? detail.featuredTags ?? [],
    serviceUrl: detail.service_url ?? detail.serviceUrl,
    endpoints: (detail.endpoints ?? []).map((endpoint: any) => {
      const endpointTitle = endpoint.title ?? endpoint.path;
      const endpointSubtitle = endpoint.subtitle ?? endpoint.path;
      const endpointDescription = endpoint.description ?? description;
      const endpointUseCase = endpoint.use_case ?? endpoint.useCase ?? useCase;
      return {
        method: endpoint.method,
        path: endpoint.path,
        url: endpoint.url,
        title: endpointTitle,
        subtitle: endpointSubtitle,
        description: endpointDescription,
        useCase: endpointUseCase,
        i18n: endpoint.i18n ?? { "zh-CN": zhCopy(endpointTitle, endpointSubtitle, endpointDescription, endpointUseCase) },
        metered: Boolean(endpoint.metered),
        minPriceUsd: endpoint.min_price_usd ?? endpoint.minPriceUsd ?? 0,
        maxPriceUsd: endpoint.max_price_usd ?? endpoint.maxPriceUsd ?? 0,
      };
    }),
    status: detail.status ?? {
      catalog: "draft",
      gateway: "unknown",
      payment: "unknown",
      upstream: "unknown",
    },
  };
}

function payMarkdownFromDetail(detail: any): string {
  const lines = [
    `# ${detail.title ?? detail.fqn}`,
    "",
    "## Service",
    "",
    `- FQN: \`${detail.fqn}\``,
    `- Service URL: \`${detail.service_url ?? detail.serviceUrl ?? ""}\``,
    `- Category: \`${detail.category ?? ""}\``,
    `- Chains: \`${(detail.chains ?? []).join(", ")}\``,
    "",
    "## Endpoints",
    "",
  ];
  for (const endpoint of detail.endpoints ?? []) {
    const metered = Boolean(endpoint.metered);
    const price = endpoint.min_price_usd ?? endpoint.minPriceUsd ?? 0;
    lines.push(
      `### ${endpoint.method} ${endpoint.path}`,
      "",
      endpoint.description ?? "",
      "",
      `- URL: \`${endpoint.url ?? ""}\``,
      `- Metered: \`${String(metered)}\``,
      `- Price: \`$${price}\``,
      "",
    );
    if (metered) {
      lines.push("```bash", `x402-cli pay '${endpoint.url ?? ""}'`, "```", "");
    } else {
      lines.push("No payment required.", "");
    }
  }
  lines.push(
    "## Notes",
    "",
    "This file is public. Do not include upstream API keys, bearer tokens, provider.yml, `.env`, passwords, or private infrastructure URLs.",
    "",
  );
  return lines.join("\n");
}

async function catalogExportGateway(gatewayUrl: string, options: ParsedOptions): Promise<void> {
  requireArgument(gatewayUrl, "gateway-url", "x402-cli catalog export-gateway <gateway-url> --provider <fqn> [options]");
  const providerFqn = requireArgument(opt(options, "provider"), "--provider", "x402-cli catalog export-gateway <gateway-url> --provider <fqn> [options]");
  sanitizeProviderName(providerFqn);
  const base = gatewayUrl.replace(/\/+$/, "");
  const detail = await readJson(`${base}/__402/catalog/providers/${providerFilename(providerFqn)}`, options);
  const outputRoot = opt(options, "output-dir", "providers")!;
  const target = opt(options, "output-dir")
    ? path.resolve(outputRoot)
    : safeOutputPath("providers", providerFilename(providerFqn).replace(/\.json$/, ""));
  fs.mkdirSync(target, { recursive: true });
  const catalogPath = path.join(target, "catalog.json");
  const payMdPath = path.join(target, "pay.md");
  ensureWritable(catalogPath, options);
  ensureWritable(payMdPath, options);
  writeJson(catalogPath, submissionCatalog(detail));
  fs.writeFileSync(payMdPath, payMarkdownFromDetail(detail));
  emit({ command: "catalog export-gateway", mode: outputMode(options), result: { provider: providerFqn, catalog: catalogPath, payMd: payMdPath } });
}

function buildRequirement(options: ParsedOptions): PaymentRequirement {
  const network = normalizeNetwork(opt(options, "network", "tron:0xcd8690dc")!);
  const scheme = opt(options, "scheme", "exact")!;
  if (!["exact", "exact_gasfree"].includes(scheme)) throw new Error(`unsupported scheme ${scheme}`);
  if (scheme === "exact_gasfree" && !network.startsWith("tron:")) {
    throw new Error("exact_gasfree is supported only on TRON networks");
  }
  const tokenSymbol = opt(options, "token", "USDT")!;
  const explicitAsset = opt(options, "asset");
  const registryToken = explicitAsset
    ? findTokenByAddress(network, explicitAsset)
    : getToken(network, tokenSymbol);
  const decimalsOption = opt(options, "decimals");
  if (explicitAsset && !registryToken && decimalsOption === undefined) {
    throw new Error("When --asset is set without a registry match, --decimals must be provided");
  }
  if (!explicitAsset && !registryToken) throw new Error(`unknown token ${tokenSymbol} on ${network}`);
  const decimals = decimalsOption !== undefined ? Number(decimalsOption) : registryToken!.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("--decimals must be an integer between 0 and 255");
  const rawAmount = opt(options, "rawAmount") ?? opt(options, "raw-amount");
  const humanAmount = opt(options, "amount");
  if (rawAmount && humanAmount) throw new CliError("INVALID_ARGUMENT", "--amount and --raw-amount are mutually exclusive", "Pass either --amount or --raw-amount, not both.", 2);
  const amount = rawAmount ? assertRawAmount(rawAmount, "--raw-amount") : toSmallestUnit(humanAmount ?? "0.0001", decimals);
  const assetAddress = explicitAsset ?? registryToken!.address;
  const assetTransferMethod = registryToken?.assetTransferMethod ?? "permit2";
  const maxTimeoutSeconds = Number(opt(options, "valid-for-seconds", "300"));
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0 || maxTimeoutSeconds > 86400) {
    throw new Error("--valid-for-seconds must be an integer between 1 and 86400");
  }
  return {
    scheme,
    network,
    amount,
    asset: assetAddress,
    payTo: opt(options, "pay-to") ?? opt(options, "payTo") ?? "",
    maxTimeoutSeconds,
    extra: scheme === "exact" && assetTransferMethod ? { assetTransferMethod } : {},
  };
}

async function facilitatorPost(baseUrl: string, path: string, body: unknown, options: ParsedOptions): Promise<any> {
  const response = await fetchWithTimeout(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs(options), `facilitator ${path}`);
  const text = await readBoundedText(response, `facilitator ${path} response`);
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`facilitator ${path} returned invalid JSON`); }
  if (!response.ok) throw new Error(`facilitator ${path} failed with HTTP ${response.status}`);
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

function stripFlag(argv: string[], flag: string): string[] {
  return argv.filter(item => item !== flag);
}

async function waitForPort(host: string, port: number, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(50);
  }
  throw new Error(`daemon did not become ready on ${host}:${port}`);
}

async function serveDaemon(argv: string[], options: ParsedOptions): Promise<void> {
  const requirement = buildRequirement(options);
  if (!requirement.payTo) throw new Error("--pay-to is required");
  const daemonArgs = stripFlag(stripFlag(argv, "--daemon"), "-d");
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, ...daemonArgs], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const host = opt(options, "host", "127.0.0.1")!;
  const port = Number(opt(options, "port", "4020"));
  const resourceUrl = opt(options, "resource-url", `http://${host}:${port}/pay`)!;
  try {
    await waitForPort(host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port);
  } catch (error) {
    if (child.pid) {
      try { process.kill(child.pid); } catch { /* child already exited */ }
    }
    throw error;
  }
  emit({
    command: "server",
    mode: outputMode(options),
    network: requirement.network,
    scheme: requirement.scheme,
    result: {
      pid: child.pid,
      pay_url: resourceUrl,
      resource_url: resourceUrl,
      daemon: true,
    },
  });
}

function validateAmountLimits(selected: PaymentRequirement, options: ParsedOptions): void {
  const maxRaw = opt(options, "max-rawAmount") ?? opt(options, "max-raw-amount");
  const maxAmount = opt(options, "max-amount");
  if (maxRaw && BigInt(selected.amount) > BigInt(assertRawAmount(maxRaw, "--max-raw-amount"))) {
    throw new Error(`payment raw amount ${selected.amount} exceeds --max-raw-amount ${maxRaw}`);
  }
  if (maxAmount) {
    const token = findTokenByAddress(selected.network, selected.asset);
    const decimalsOption = opt(options, "decimals");
    if (!token && decimalsOption === undefined) {
      throw new Error("cannot evaluate --max-amount for an unknown asset; pass --max-raw-amount or --decimals");
    }
    const decimals = decimalsOption !== undefined ? Number(decimalsOption) : token!.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("--decimals must be an integer between 0 and 255");
    if (BigInt(selected.amount) > BigInt(toSmallestUnit(maxAmount, decimals))) {
      throw new Error(`payment amount exceeds --max-amount ${maxAmount}`);
    }
  }
}

function gasfreeFeeLimitRaw(selected: PaymentRequirement, options: ParsedOptions): string | undefined {
  const maxRaw = opt(options, "max-gasfree-fee-raw");
  const maxHuman = opt(options, "max-gasfree-fee");
  if (maxRaw && maxHuman) {
    throw new CliError("INVALID_ARGUMENT", "--max-gasfree-fee and --max-gasfree-fee-raw are mutually exclusive", "Pass one GasFree fee limit.", 2);
  }
  if (selected.scheme !== "exact_gasfree") {
    if (maxRaw || maxHuman) throw new Error("GasFree fee limits require an exact_gasfree payment requirement");
    return undefined;
  }
  if (maxRaw) return assertRawAmount(maxRaw, "--max-gasfree-fee-raw");
  if (!maxHuman) return undefined;
  const token = findTokenByAddress(selected.network, selected.asset);
  const decimalsOption = opt(options, "decimals");
  if (!token && decimalsOption === undefined) {
    throw new Error("cannot evaluate --max-gasfree-fee for an unknown asset; pass --max-gasfree-fee-raw or --decimals");
  }
  const decimals = decimalsOption !== undefined ? Number(decimalsOption) : token!.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("--decimals must be an integer between 0 and 255");
  return toSmallestUnit(maxHuman, decimals);
}

async function serve(options: ParsedOptions): Promise<void> {
  const host = opt(options, "host", "127.0.0.1")!;
  const port = Number(opt(options, "port", "4020"));
  const facilitatorUrl = opt(options, "facilitator-url", "https://facilitator.bankofai.io")!;
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
      const pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
      if (pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === "/.well-known/x402") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ network: requirement.network, scheme: requirement.scheme, asset: requirement.asset, rawAmount: requirement.amount, amount: requirement.amount, payTo: requirement.payTo, pay_url: resourceUrl }));
        return;
      }
      if (pathname !== "/pay") {
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
      let payload: unknown;
      try {
        payload = decodeSignature(signature);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid payment signature" }));
        return;
      }
      const verify = await facilitatorPost(facilitatorUrl, "/verify", {
        paymentPayload: payload,
        paymentRequirements: requirement,
      }, options);
      if (!(verify?.valid === true || verify?.isValid === true)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "payment verification failed" }));
        return;
      }
      const settle = await facilitatorPost(facilitatorUrl, "/settle", {
        paymentPayload: payload,
        paymentRequirements: requirement,
      }, options);
      if (!(settle?.success === true && typeof settle?.transaction === "string" && settle.transaction.length > 0 && typeof settle?.network === "string" && settle.network.length > 0)) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "settlement failed" }));
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        [headers.response]: encodeResponse(settle),
      });
      response.end(JSON.stringify({ success: true, network: requirement.network, scheme: requirement.scheme, transaction: settle.transaction }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      emit({
        command: "server",
        network: requirement.network,
        scheme: requirement.scheme,
        mode: outputMode(options),
        result: { pay_url: resourceUrl, token: opt(options, "token", "USDT"), rawAmount: requirement.amount, pay_to: requirement.payTo },
      });
      resolve();
    });
  });
}

function selectRequirement(accepts: PaymentRequirement[], options: ParsedOptions): PaymentRequirement {
  const network = opt(options, "network");
  const scheme = opt(options, "scheme");
  const token = opt(options, "token");
  const selected = accepts.find(req => {
    if (!req || !["exact", "exact_gasfree"].includes(req.scheme) || typeof req.network !== "string" || typeof req.asset !== "string") return false;
    if (req.scheme === "exact_gasfree" && !req.network.startsWith("tron:")) return false;
    try {
      if (!findTokenByAddress(req.network, req.asset)) return false;
    } catch {
      return false;
    }
    if (network && normalizeNetwork(network) !== req.network) return false;
    if (scheme && scheme !== req.scheme) return false;
    if (token) {
      let tokenInfo;
      try {
        tokenInfo = getToken(req.network, token);
      } catch {
        return false;
      }
      if (tokenInfo.address.toLowerCase() !== req.asset.toLowerCase()) return false;
    }
    return true;
  });
  if (!selected) throw new Error("no matching payment requirement");
  return selected;
}

async function pay(url: string, options: ParsedOptions): Promise<void> {
  requireArgument(url, "URL", "x402-cli pay <url> [options]");
  const method = opt(options, "method", "GET")!;
  if (!/^[A-Z]+$/.test(method) || !["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].includes(method)) {
    throw new CliError("INVALID_ARGUMENT", `unsupported HTTP method ${method}`, "Use an uppercase standard HTTP method.", 2);
  }
  const baseHeaders = requestHeaders(options);
  const probe = await fetchWithTimeout(url, {
    method,
    headers: baseHeaders,
    body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : opt(options, "body"),
  }, timeoutMs(options), `fetch ${url}`);
  if (probe.status !== 402) {
    const body = await responsePayload(probe);
    if (!probe.ok) {
      const retryAfter = probe.headers.get("retry-after");
      throw new Error(
        `HTTP ${probe.status} from ${url}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}: ${
          typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)
        }`,
      );
    }
    emit({
      command: "client",
      mode: outputMode(options),
      result: {
        url,
        status: probe.status,
        message: "Not a payment-required endpoint",
        response: body,
      },
    });
    return;
  }
  const header = probe.headers.get(headers.required);
  if (!header) throw new Error("402 response missing PAYMENT-REQUIRED header");
  const required = decodeRequired(header);
  const selected = selectRequirement(required.accepts ?? [], options);
  validateAmountLimits(selected, options);
  const maxGasfreeFeeRaw = gasfreeFeeLimitRaw(selected, options);
  if (options["dry-run"]) {
    emit({
      command: "client",
      network: selected.network,
      scheme: selected.scheme,
      mode: outputMode(options),
      result: {
        url,
        resource: required.resource?.url ?? url,
        selected,
        message: "Dry run - no payment submitted",
      },
    });
    return;
  }
  const creation = await withSdkStdoutRedirect(outputMode(options) === "json", () =>
    createPaymentPayload({
      selected,
      resource: required.resource?.url ?? url,
      extensions: required.extensions,
      rpcUrl: opt(options, "rpc-url"),
      privateKey: opt(options, "private-key"),
      gasfreeApiUrl: opt(options, "gasfree-api-url"),
      maxGasfreeFeeRaw,
    }),
  );
  const retryHeaders = new Headers(baseHeaders);
  retryHeaders.set(headers.signature, encodeSignature(creation.payload));
  const paid = await fetchWithTimeout(url, {
    method,
    headers: retryHeaders,
    body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : opt(options, "body"),
  }, timeoutMs(options), `fetch ${url}`);
  const body = await responsePayload(paid);
  const paymentResponse = paid.headers.get(headers.response);
  const settlement = paymentResponse ? decodeResponse(paymentResponse) : undefined;
  const settled = settlement?.success === true && typeof settlement?.transaction === "string" && settlement.transaction.length > 0 && typeof settlement?.network === "string" && settlement.network.length > 0;
  const result = {
    url,
    status: paid.status,
    paid: settled,
    settled,
    delivered: paid.ok,
    response: body,
    ...(settlement !== undefined ? {
      paymentResponse: settlement,
      transaction: settlement?.transaction ?? settlement?.txHash ?? null,
    } : {}),
    ...(creation.gasfreeEstimate ? { gasfreeEstimate: creation.gasfreeEstimate } : {}),
  };
  if (paymentResponse && !settled) {
    throw new CliError("INVALID_SETTLEMENT", "gateway returned an invalid or unsuccessful PAYMENT-RESPONSE", "Do not treat this request as paid; contact the gateway operator.", 1, result);
  }
  if (!paid.ok) {
    const retryAfter = paid.headers.get("retry-after");
    throw new CliError(
      paid.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR",
      `HTTP ${paid.status} from ${url}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}: ${
        typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)
      }`,
      paymentResponse
        ? "The gateway reports that payment was settled; retain paymentResponse for support or reconciliation."
        : "Inspect the HTTP response and retry only when it is safe to do so.",
      1,
      result,
    );
  }
  emit({
    command: "client",
    network: selected.network,
    scheme: selected.scheme,
    mode: outputMode(options),
    result,
  });
}

async function roundtrip(options: ParsedOptions): Promise<void> {
  const port = Number(opt(options, "port", "4020"));
  await serve(options);
  await pay(`http://127.0.0.1:${port}/pay`, options);
  process.exit(0);
}

function executableInPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

function resolveGatewayPackageRuntime(): string | undefined {
  try {
    return require.resolve("@bankofai/x402-gateway/dist/cli.js");
  } catch {
    return undefined;
  }
}

function gatewayCommand(options: ParsedOptions): { command: string; argsPrefix: string[]; source: string } {
  const explicit = opt(options, "gateway-bin");
  const gatewayPackageRuntime = resolveGatewayPackageRuntime();
  const candidates = [
    explicit ? { file: explicit, source: "--gateway-bin" } : undefined,
    gatewayPackageRuntime ? { file: gatewayPackageRuntime, source: "@bankofai/x402-gateway dependency" } : undefined,
    { file: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "gateway", "cli.js"), source: "bundled gateway runtime" },
    executableInPath("x402-gateway") ? { file: executableInPath("x402-gateway")!, source: "PATH x402-gateway" } : undefined,
    { file: path.resolve(process.cwd(), "../x402-gateway/dist/cli.js"), source: "sibling ../x402-gateway" },
  ].filter(Boolean) as Array<{ file: string; source: string }>;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate.file, fs.constants.R_OK);
      if (candidate.file.endsWith(".js")) {
        return { command: process.execPath, argsPrefix: [candidate.file], source: candidate.source };
      }
      return { command: candidate.file, argsPrefix: [], source: candidate.source };
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "x402-gateway runtime not found. Install @bankofai/x402-gateway, run from a checkout with ../x402-gateway/dist/cli.js, or pass --gateway-bin <path>.",
  );
}

async function gatewayStart(args: string[], options: ParsedOptions): Promise<void> {
  const gateway = gatewayCommand(options);
  const child = spawn(gateway.command, [...gateway.argsPrefix, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`gateway exited with ${code}`)));
    child.on("error", reject);
  });
}

function gatewayCheck(target: string, options: ParsedOptions): void {
  const files = providerFiles(target);
  const providers = files.map(loadProviderFile);
  const names = new Set<string>();
  for (const provider of providers) {
    if (names.has(provider.name)) throw new Error(`duplicate provider name: ${provider.name}`);
    names.add(provider.name);
  }
  emit({
    command: "gateway check",
    mode: outputMode(options),
    result: { providers: providers.map(p => p.name), count: providers.length },
  });
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
  network: tron:0xcd8690dc
  currencies:
    usd: ["USDT"]
  recipient: <provider-recipient-address>
  scheme: exact
  protocol: exact
  asset_transfer_method: permit2
  facilitator_url: https://facilitator.bankofai.io
  facilitator_api_key: <facilitator-api-key>
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
  emit({
    command: "gateway scaffold",
    mode: outputMode(options),
    result: { file: path.join(outputDir, "provider.yml") },
  });
}

function catalogBuild(target: string, options: ParsedOptions): void {
  const providers = providerFiles(target).map(loadProviderFile).map(providerCatalog);
  const catalog = { version: 1, generatedAt: new Date().toISOString(), providers };
  const output = opt(options, "output", opt(options, "dist-dir") ? path.join(opt(options, "dist-dir")!, "catalog.json") : undefined);
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(catalog, null, 2));
    emit({
      command: "catalog build",
      mode: outputMode(options),
      result: { output, count: providers.length },
    });
  } else if (outputMode(options) === "json") {
    emit({ command: "catalog build", mode: "json", result: catalog });
  } else {
    printJson(catalog);
  }
}

function catalogPayAssets(target: string, options: ParsedOptions): void {
  const rows = providerFiles(target).map(loadProviderFile).flatMap(provider =>
    (provider.endpoints ?? []).map((endpoint: any) => ({
      provider: provider.name,
      method: endpoint.method,
      path: `/providers/${provider.name}${endpoint.path}`,
      network: normalizeNetwork(provider.operator.network),
      currency: provider.operator.currencies?.usd?.[0] ?? "USDT",
      price_usd: providerPrice(endpoint),
      scheme: providerScheme(provider),
      assetTransferMethod: providerAssetTransferMethod(provider),
    })),
  );
  emit({
    command: "gateway catalog pay-assets",
    mode: outputMode(options),
    result: { count: rows.length, assets: rows },
  });
}

async function readProviderDetailForSearch(source: string, fqn: string, options: ParsedOptions): Promise<any> {
  try {
    return await readJson(catalogDetailSource(source, "providers", fqn), options);
  } catch {
    return {};
  }
}

async function searchCatalog(source: string, query: string, options: ParsedOptions): Promise<SearchHit[]> {
  const providers = await readCatalog(source, options);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const includeBlocked = hasFlag(options, "include-blocked");
  const hits: SearchHit[] = [];
  for (const provider of providers) {
    if (provider.block && !includeBlocked) continue;
    const fqn = String(provider.fqn ?? provider.name ?? "");
    if (!fqn) continue;
    const detail = await readProviderDetailForSearch(source, fqn, options);
    const tags = stringList(detail.featured_tags ?? provider.featured_tags ?? detail.tags ?? provider.tags);
    const endpoints = Array.isArray(detail.endpoints) ? detail.endpoints : Array.isArray(provider.endpoints) ? provider.endpoints : [];
    const categoryMeta = detail.category_meta ?? provider.category_meta;
    const chains = stringList(detail.chains ?? provider.chains);
    const chainKinds = stringList(detail.chain_kinds ?? provider.chain_kinds);
    const chainsMetaRaw = detail.chains_meta ?? provider.chains_meta ?? [];
    const chainsMeta = Array.isArray(chainsMetaRaw) ? chainsMetaRaw.filter(item => item && typeof item === "object") : [];
    const titleZh = String(detail.title_zh ?? provider.title_zh ?? "");
    const mainTitle = String(detail.main_title ?? provider.main_title ?? detail.mainTitle ?? provider.mainTitle ?? "");
    const subTitle = String(detail.sub_title ?? provider.sub_title ?? detail.subTitle ?? provider.subTitle ?? "");
    const fields = {
      fqn: [fqn],
      title: [String(detail.title ?? provider.title ?? ""), mainTitle],
      i18n: [titleZh, subTitle, ...dictValues(detail.i18n ?? provider.i18n)],
      category: [String(detail.category ?? provider.category ?? "")],
      category_meta: dictValues(categoryMeta),
      chains: [...chains, ...chainMetaValues(chainsMeta)],
      chain_kinds: chainKinds,
      service_url: [String(detail.service_url ?? provider.service_url ?? detail.serviceUrl ?? provider.serviceUrl ?? "")],
      description: [String(detail.description ?? provider.description ?? "")],
      use_case: [String(detail.use_case ?? provider.use_case ?? detail.useCase ?? provider.useCase ?? "")],
      tags,
      endpoints: endpointFields(endpoints),
    };
    const scored = scoreFields(terms, fields);
    if (scored.score === 0) continue;
    hits.push({
      provider,
      detail,
      fqn,
      title: fields.title[0],
      category: fields.category[0],
      serviceUrl: fields.service_url[0],
      description: fields.description[0] || undefined,
      useCase: fields.use_case[0] || undefined,
      titleZh: titleZh || undefined,
      mainTitle: mainTitle || undefined,
      subTitle: subTitle || undefined,
      categoryMeta: categoryMeta && typeof categoryMeta === "object" ? categoryMeta : undefined,
      chains,
      chainKinds,
      chainsMeta,
      tags,
      endpoints,
      score: scored.score,
      matchedFields: scored.matchedFields,
    });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.fqn.localeCompare(b.fqn))
    .slice(0, positiveIntegerOption(options, "limit", 10));
}

function searchHitToJson(hit: SearchHit): Record<string, unknown> {
  return {
    fqn: hit.fqn,
    title: hit.title,
    category: hit.category,
    serviceUrl: hit.serviceUrl,
    description: hit.description,
    useCase: hit.useCase,
    title_zh: hit.titleZh,
    main_title: hit.mainTitle,
    sub_title: hit.subTitle,
    category_meta: hit.categoryMeta,
    chains: hit.chains,
    chain_kinds: hit.chainKinds,
    chains_meta: hit.chainsMeta,
    tags: hit.tags,
    score: hit.score,
    matchedFields: hit.matchedFields,
    endpoints: hit.endpoints,
  };
}

async function catalogSearch(source: string, query: string, options: ParsedOptions): Promise<void> {
  positiveIntegerOption(options, "limit", 10);
  const hits = await searchCatalog(source, query, options);
  const results = hits.map(searchHitToJson);
  if (outputMode(options) === "json") {
    emit({ command: "catalog search", mode: "json", result: { query, catalog: source, count: hits.length, results } });
    return;
  }
  if (!hits.length) {
    process.stdout.write("no matches\n");
    return;
  }
  for (const hit of hits) {
    const tags = hit.tags.length ? hit.tags.join(",") : "-";
    process.stdout.write(`${hit.fqn.padEnd(32)}  score=${String(hit.score).padEnd(3)}  category=${hit.category.padEnd(12)}  tags=${tags}\n`);
    if (hit.title) process.stdout.write(`  ${hit.title}\n`);
    if (hit.description) process.stdout.write(`  ${hit.description.split("\n")[0]}\n`);
    if (hit.serviceUrl) process.stdout.write(`  service: ${hit.serviceUrl}\n`);
    for (const endpoint of hit.endpoints.slice(0, 3)) {
      const method = String(endpoint.method ?? "");
      const pathText = String(endpoint.path ?? endpoint.url ?? "");
      const paid = endpoint.paid;
      let suffix = "";
      if (paid && typeof paid === "object") {
        suffix = `  ${paid.network ?? ""} ${paid.currency ?? ""} ${paid.amount_raw ?? ""}`.trimEnd();
      }
      process.stdout.write(`  ${method.padEnd(6)} ${pathText}${suffix ? `  ${suffix}` : ""}\n`);
    }
    process.stdout.write("\n");
  }
}

async function catalogShow(source: string, name: string, options: ParsedOptions): Promise<void> {
  requireArgument(name, "provider", "x402-cli catalog show <provider> [--catalog <source>]");
  const provider = await readCatalogProvider(source, name, options);
  if (outputMode(options) === "json") {
    emit({ command: "catalog show", mode: "json", result: provider });
    return;
  }
  process.stdout.write(`${provider.fqn ?? provider.name} - ${provider.title ?? provider.main_title ?? provider.name}\n`);
  if (provider.description) process.stdout.write(`${String(provider.description).split("\n")[0]}\n`);
  if (provider.category) process.stdout.write(`category: ${provider.category}\n`);
  if (provider.chains) process.stdout.write(`chains: ${provider.chains.join(", ")}\n`);
}

async function catalogEndpoints(source: string, name: string, options: ParsedOptions): Promise<void> {
  requireArgument(name, "provider", "x402-cli catalog endpoints <provider> [--catalog <source>]");
  const provider = await readCatalogProvider(source, name, options);
  const endpoints = provider.endpoints ?? [];
  if (outputMode(options) === "json") {
    emit({ command: "catalog endpoints", mode: "json", result: { provider: provider.fqn ?? provider.name, endpoints } });
    return;
  }
  for (const endpoint of endpoints) {
    process.stdout.write(`${String(endpoint.method ?? "").padEnd(6)} ${endpoint.path ?? endpoint.url ?? ""}\n`);
    if (endpoint.description) process.stdout.write(`  ${String(endpoint.description).split("\n")[0]}\n`);
  }
}

async function catalogPayJson(source: string, name: string, options: ParsedOptions): Promise<void> {
  requireArgument(name, "provider", "x402-cli catalog pay-json <provider> [--catalog <source>]");
  const provider = await readCatalogPayProvider(source, name, options);
  const endpoint = (provider.endpoints ?? []).find((item: any) => item.paid || item.x402_routes?.length || item.x402Routes?.length) ?? provider.endpoints?.[0];
  if (!endpoint) throw new Error(`provider has no endpoints: ${name}`);
  const result = {
    provider: provider.fqn ?? provider.name,
    url: endpoint.url ?? endpoint.path,
    method: endpoint.method,
    paid: endpoint.paid,
    x402_routes: endpoint.x402_routes ?? endpoint.x402Routes ?? [],
    endpoint,
  };
  if (hasFlag(options, "raw")) printJson(result);
  else emit({ command: "catalog pay-json", mode: outputMode(options), result });
}

async function handleGateway(args: string[]): Promise<void> {
  const { command, positional, options } = parseArgs(args);
  if (hasFlag(options, "help") || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(helpText(command === "catalog" || positional[0] === "catalog" ? "gateway-catalog" : "gateway"));
    return;
  }
  if (command === "search") await catalogSearch(opt(options, "catalog", defaultCatalogSource())!, requireArgument(positional.join(" "), "query", "x402-cli gateway search <query> [options]"), options);
  else if (command === "start") await gatewayStart(["--providers", opt(options, "providers", opt(options, "providers-dir", positional[0] ?? "providers"))!, "--host", opt(options, "host", "127.0.0.1")!, "--port", opt(options, "port", "4020")!], options);
  else if (command === "check") gatewayCheck(positional[0] ?? opt(options, "providers", "providers")!, options);
  else if (command === "scaffold") gatewayScaffold(positional[0] ?? "example-provider", options);
  else if (command === "catalog") await handleGatewayCatalog(positional, options);
  else throw new CliError("UNKNOWN_COMMAND", `Unknown gateway command: ${command}`, "Run x402-cli gateway --help to list commands.", 2);
}

async function handleGatewayCatalog(positional: string[], options: ParsedOptions): Promise<void> {
  const sub = positional[0] ?? "build";
  const target = positional[1] ?? opt(options, "providers", "providers")!;
  if (sub === "build") catalogBuild(target, options);
  else if (sub === "check") gatewayCheck(target, options);
  else if (sub === "pay-assets") catalogPayAssets(target, options);
  else if (sub === "search") await catalogSearch(opt(options, "catalog", defaultCatalogSource())!, requireArgument(positional.slice(2).join(" ") || opt(options, "query"), "query", "x402-cli gateway catalog search <query> [options]"), options);
  else throw new CliError("UNKNOWN_COMMAND", `Unknown gateway catalog command: ${sub}`, "Run x402-cli gateway catalog --help to list commands.", 2);
}

async function handleCatalog(args: string[]): Promise<void> {
  const { command, positional, options } = parseArgs(args);
  if (hasFlag(options, "help") || ["help", "--help", "-h"].includes(command)) {
    const topic = command === "help" ? positional[0] : command;
    process.stdout.write(helpText(topic ? `catalog-${topic}` : "catalog"));
    return;
  }
  const source = opt(options, "catalog", defaultCatalogSource())!;
  if (command === "update") await catalogUpdate(source, options);
  else if (command === "search") await catalogSearch(source, requireArgument(positional.join(" "), "query", "x402-cli catalog search <query> [options]"), options);
  else if (command === "show") await catalogShow(source, positional[0], options);
  else if (command === "endpoints") await catalogEndpoints(source, positional[0], options);
  else if (command === "pay-json") await catalogPayJson(source, positional[0], options);
  else if (command === "export-gateway") await catalogExportGateway(positional[0], options);
  else if (command === "build") catalogBuild(positional[0] ?? "providers", options);
  else throw new CliError("UNKNOWN_COMMAND", `Unknown catalog command: ${command}`, "Run x402-cli catalog --help to list commands.", 2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, positional, options } = parseArgs(argv);
  if (hasFlag(options, "help") && command === "gateway") {
    await handleGateway(argv.slice(1));
    return;
  }
  if (hasFlag(options, "help") && command === "catalog") {
    await handleCatalog(argv.slice(1));
    return;
  }
  if (command === "--help" || command === "-h" || command === "help" || hasFlag(options, "help")) {
    const topic = command === "help" ? positional[0] : command.startsWith("-") ? undefined : command;
    process.stdout.write(helpText(topic));
    return;
  }
  if (command === "--version" || command === "-V" || hasFlag(options, "version")) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }
  if (command === "serve") {
    if (hasFlag(options, "daemon")) await serveDaemon(argv, options);
    else await serve(options);
  }
  else if (command === "pay") await pay(positional[0], options);
  else if (command === "roundtrip") await roundtrip(options);
  else if (command === "gateway") await handleGateway(argv.slice(1));
  else if (command === "catalog") await handleCatalog(argv.slice(1));
  else {
    throw new CliError("UNKNOWN_COMMAND", `Unknown command: ${command}`, "Run x402-cli --help to list commands.", 2);
  }
}

function errorCommandName(argv: string[]): string {
  const [first, second] = argv;
  if ((first === "catalog" || first === "gateway") && second && !second.startsWith("-")) return `${first} ${second}`;
  return first ?? "x402-cli";
}

main().catch(error => {
  emit({
    command: errorCommandName(process.argv.slice(2)),
    mode: process.argv.includes("--json") ? "json" : "human",
    error: classify(error),
  });
  process.exit(error instanceof CliError ? error.exitCode : 1);
});
