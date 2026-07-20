import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { normalizeNetwork } from "./tokens.js";

function readYaml(file: string): any {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    if (!(name in process.env)) throw new Error(`environment variable \${${name}} is not set`);
    return process.env[name] ?? "";
  });
}

function expandDeep<T>(value: T): T {
  if (typeof value === "string") return expandEnv(value) as T;
  if (Array.isArray(value)) return value.map(expandDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandDeep(item)])) as T;
  return value;
}

export function providerFiles(root: string): string[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, String(entry));
    if (file.endsWith("provider.yml") || file.endsWith("provider.yaml")) out.push(file);
  }
  return out.sort();
}

export function providerPrice(endpoint: any): number {
  return endpoint?.metering?.dimensions?.[0]?.tiers?.[0]?.price_usd ?? 0;
}

export function validateProvider(provider: any, file = "provider.yml"): void {
  const required = [["name", provider?.name], ["forward_url", provider?.forward_url], ["operator.network", provider?.operator?.network], ["operator.recipient", provider?.operator?.recipient]];
  for (const [name, value] of required) if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: ${name} is required`);
  try {
    const url = new URL(provider.forward_url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
  } catch { throw new Error(`${file}: forward_url must be a valid http(s) URL`); }
  if (!Array.isArray(provider.endpoints) || !provider.endpoints.length) throw new Error(`${file}: endpoints must contain at least one endpoint`);
  const seen = new Set<string>();
  for (const endpoint of provider.endpoints) {
    if (typeof endpoint.method !== "string" || typeof endpoint.path !== "string") throw new Error(`${file}: each endpoint needs method and path`);
    if (!endpoint.method.trim() || !endpoint.path.trim() || !endpoint.path.startsWith("/")) throw new Error(`${file}: endpoint method/path must be non-empty and path must start with /`);
    const price = providerPrice(endpoint);
    if (!Number.isFinite(price) || price < 0) throw new Error(`${file}: endpoint price_usd must be a finite number >= 0`);
    const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    if (seen.has(key)) throw new Error(`${file}: duplicate endpoint ${key}`);
    seen.add(key);
  }
}

export function loadProviderFile(file: string): any {
  const provider = expandDeep(readYaml(file));
  validateProvider(provider, file);
  provider.operator.network = normalizeNetwork(provider.operator.network);
  provider.operator.scheme = provider.operator.scheme ?? "exact";
  return provider;
}

export function providerAssetTransferMethod(provider: any): string {
  return provider.operator?.asset_transfer_method ?? provider.operator?.assetTransferMethod ?? "permit2";
}

export function providerScheme(provider: any): string {
  return provider.operator?.scheme ?? "exact";
}

export function providerCatalog(provider: any): any {
  return {
    name: provider.name, title: provider.title ?? provider.name, description: provider.description ?? "",
    category: provider.category ?? "other", service_url: provider.display?.service_url, tags: provider.display?.tags ?? [],
    network: normalizeNetwork(provider.operator.network), currency: provider.operator.currencies?.usd?.[0] ?? "USDT",
    endpoints: (provider.endpoints ?? []).map((endpoint: any) => ({
      method: endpoint.method.toUpperCase(), path: `/providers/${provider.name}${endpoint.path}`, upstream_path: endpoint.path,
      description: endpoint.description ?? "",
      paid: providerPrice(endpoint) > 0 ? { scheme: providerScheme(provider), network: normalizeNetwork(provider.operator.network), currency: provider.operator.currencies?.usd?.[0] ?? "USDT", price_usd: providerPrice(endpoint) } : null,
      x402_routes: providerPrice(endpoint) > 0 ? [{ provider: provider.name, network: normalizeNetwork(provider.operator.network), scheme: providerScheme(provider), assetTransferMethod: providerAssetTransferMethod(provider), url: `/providers/${provider.name}${endpoint.path}` }] : [],
    })),
  };
}
