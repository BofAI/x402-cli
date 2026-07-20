import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, hasFlag, opt, outputMode, parseArgs, requireArgument, type ParsedOptions } from "./args.js";
import { catalogBuild } from "./gateway-commands.js";
import { helpText } from "./help.js";
import { positiveIntegerOption, readJson, readText, timeoutMs } from "./http-client.js";
import { emit, printJson } from "./output.js";

const CATALOG_UPDATE_RETRIES = 3;

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

export function defaultCatalogSource(): string {
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

export async function catalogSearch(source: string, query: string, options: ParsedOptions): Promise<void> {
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


export async function handleCatalog(args: string[]): Promise<void> {
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
