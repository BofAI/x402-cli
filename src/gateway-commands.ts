import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { opt, outputMode, type ParsedOptions } from "./args.js";
import { emit, printJson } from "./output.js";
import { loadProviderFile, providerAssetTransferMethod, providerCatalog, providerFiles, providerPrice, providerScheme } from "./provider-config.js";
import { normalizeNetwork } from "./tokens.js";

const require = createRequire(import.meta.url);

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

export async function gatewayStart(args: string[], options: ParsedOptions): Promise<void> {
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

export function gatewayCheck(target: string, options: ParsedOptions): void {
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

export function gatewayScaffold(name: string, options: ParsedOptions): void {
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

export function catalogBuild(target: string, options: ParsedOptions): void {
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

export function catalogPayAssets(target: string, options: ParsedOptions): void {
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

