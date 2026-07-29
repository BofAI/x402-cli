#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@bankofai/x402-fetch";
import { createPaymentClient, decodeRequired, decodeResponse, decodeSignature, encodeRequired, encodeResponse, headers, PaymentRequirement } from "./x402.js";
import { addressesEqual, assertRawAmount, findTokenByAddress, getToken, normalizeAddress, normalizeNetwork, toSmallestUnit, type TokenInfo } from "./tokens.js";
import { CliError, hasFlag, opt, optAll, outputMode, parseArgs, requireArgument, type ParsedOptions } from "./args.js";
import { beginEmitCapture, classify, emit, setInvocationCommand, withSdkStdoutRedirect } from "./output.js";
import { fetchWithTimeout, positiveIntegerOption, readBoundedText, responsePayload, timeoutMs } from "./http-client.js";
import { startServeDaemon } from "./daemon.js";
import { getVersion, helpText } from "./help.js";
import { catalogBuild, catalogPayAssets, gatewayCheck, gatewayScaffold, gatewayStart } from "./gateway-commands.js";
import { catalogSearch, defaultCatalogSource, handleCatalog } from "./catalog-commands.js";

function invalidArgument(message: string, hint = "Run the command with --help to see valid options."): CliError {
  return new CliError("INVALID_ARGUMENT", message, hint, 2);
}

function normalizeNetworkOption(value: string): string {
  try {
    return normalizeNetwork(value);
  } catch (error) {
    throw invalidArgument(error instanceof Error ? error.message : String(error));
  }
}

function resolveDecimals(token: TokenInfo | undefined, decimalsOption: string | undefined): number {
  let supplied: number | undefined;
  if (decimalsOption !== undefined) {
    supplied = Number(decimalsOption);
    if (!Number.isInteger(supplied) || supplied < 0 || supplied > 255) {
      throw invalidArgument("--decimals must be an integer between 0 and 255");
    }
  }
  if (token) {
    if (supplied !== undefined && supplied !== token.decimals) {
      throw invalidArgument(
        `--decimals ${supplied} does not match registered ${token.symbol} decimals ${token.decimals}`,
        "Remove --decimals or pass the registered token decimals.",
      );
    }
    return token.decimals;
  }
  if (supplied === undefined) {
    throw invalidArgument(
      "an unregistered asset requires --decimals",
      "Pass --decimals for the explicit --asset, or use a registered token.",
    );
  }
  return supplied;
}

function rawAmountOption(value: string, name: string): string {
  try {
    return assertRawAmount(value, name);
  } catch (error) {
    throw invalidArgument(error instanceof Error ? error.message : String(error));
  }
}

function humanAmountOption(value: string, decimals: number, name: string): string {
  try {
    return toSmallestUnit(value, decimals);
  } catch (error) {
    throw invalidArgument(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildRequirement(options: ParsedOptions): PaymentRequirement {
  const network = normalizeNetworkOption(opt(options, "network", "tron:0xcd8690dc")!);
  const scheme = opt(options, "scheme", "exact")!;
  if (!["exact", "exact_gasfree"].includes(scheme)) throw invalidArgument(`unsupported scheme ${scheme}`);
  if (scheme === "exact_gasfree" && !network.startsWith("tron:")) {
    throw invalidArgument("exact_gasfree is supported only on TRON networks");
  }
  const tokenSymbol = opt(options, "token", "USDT")!;
  const explicitAsset = opt(options, "asset");
  if (explicitAsset && !normalizeAddress(network, explicitAsset)) {
    throw invalidArgument(`invalid --asset address for ${network}`);
  }
  let registryToken: TokenInfo | undefined;
  try {
    registryToken = explicitAsset
      ? findTokenByAddress(network, explicitAsset)
      : getToken(network, tokenSymbol);
  } catch (error) {
    throw invalidArgument(error instanceof Error ? error.message : String(error));
  }
  const decimalsOption = opt(options, "decimals");
  if (explicitAsset && !registryToken && decimalsOption === undefined) {
    throw invalidArgument("When --asset is set without a registry match, --decimals must be provided");
  }
  if (!explicitAsset && !registryToken) throw invalidArgument(`unknown token ${tokenSymbol} on ${network}`);
  const isBase = network === "eip155:8453" || network === "eip155:84532";
  if (isBase && !registryToken) {
    throw invalidArgument("Base support is currently limited to the official USDC contract");
  }
  const decimals = resolveDecimals(registryToken, decimalsOption);
  const rawAmount = opt(options, "raw-amount");
  const humanAmount = opt(options, "amount");
  if (rawAmount && humanAmount) throw new CliError("INVALID_ARGUMENT", "--amount and --raw-amount are mutually exclusive", "Pass either --amount or --raw-amount, not both.", 2);
  const amount = rawAmount
    ? rawAmountOption(rawAmount, "--raw-amount")
    : humanAmountOption(humanAmount ?? "0.0001", decimals, "--amount");
  const assetAddress = explicitAsset ?? registryToken!.address;
  const assetTransferMethod =
    registryToken?.assetTransferMethod ?? (isBase ? undefined : "permit2");
  const extra =
    scheme !== "exact"
      ? {}
      : assetTransferMethod
        ? { assetTransferMethod }
        : registryToken?.version
          ? { name: registryToken.name, version: registryToken.version }
          : {};
  const maxTimeoutSeconds = Number(opt(options, "valid-for-seconds", "300"));
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0 || maxTimeoutSeconds > 86400) {
    throw invalidArgument("--valid-for-seconds must be an integer between 1 and 86400");
  }
  const payTo = opt(options, "pay-to") ?? "";
  if (payTo && !normalizeAddress(network, payTo)) {
    throw invalidArgument(`invalid --pay-to address for ${network}`);
  }
  return {
    scheme,
    network,
    amount,
    asset: assetAddress,
    payTo,
    maxTimeoutSeconds,
    extra,
  };
}

async function facilitatorPost(baseUrl: string, path: string, body: unknown, options: ParsedOptions): Promise<any> {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const endpoint = new URL(path.replace(/^\/+/, ""), base);
  const response = await fetchWithTimeout(endpoint, {
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
    if (idx <= 0) throw invalidArgument(`invalid --header '${header}', expected 'Name: Value'`);
    headersOut.set(header.slice(0, idx).trim(), header.slice(idx + 1).trim());
  }
  return headersOut;
}

function validateAmountLimits(selected: PaymentRequirement, options: ParsedOptions): void {
  const maxRaw = opt(options, "max-raw-amount");
  const maxAmount = opt(options, "max-amount");
  if (maxRaw && BigInt(selected.amount) > BigInt(rawAmountOption(maxRaw, "--max-raw-amount"))) {
    throw new CliError(
      "PAYMENT_AMOUNT_TOO_HIGH",
      `payment raw amount ${selected.amount} exceeds --max-raw-amount ${maxRaw}`,
      "Increase the max raw amount only if this provider price is expected.",
      1,
    );
  }
  if (maxAmount) {
    const token = findTokenByAddress(selected.network, selected.asset);
    const decimals = resolveDecimals(token, opt(options, "decimals"));
    if (BigInt(selected.amount) > BigInt(humanAmountOption(maxAmount, decimals, "--max-amount"))) {
      throw new CliError(
        "PAYMENT_AMOUNT_TOO_HIGH",
        `payment amount exceeds --max-amount ${maxAmount}`,
        "Increase the max amount only if this provider price is expected.",
        1,
      );
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
    if (maxRaw || maxHuman) throw invalidArgument("GasFree fee limits require an exact_gasfree payment requirement");
    return undefined;
  }
  if (maxRaw) return rawAmountOption(maxRaw, "--max-gasfree-fee-raw");
  if (!maxHuman) return undefined;
  const token = findTokenByAddress(selected.network, selected.asset);
  const decimals = resolveDecimals(token, opt(options, "decimals"));
  return humanAmountOption(maxHuman, decimals, "--max-gasfree-fee");
}

function invalidRequirement(message: string): CliError {
  return new CliError(
    "INVALID_PAYMENT_REQUIREMENT",
    message,
    "The server returned an x402 requirement that this CLI cannot safely sign.",
    1,
  );
}

function validateSelectedRequirement(selected: PaymentRequirement, resource: string): void {
  if (!selected || !["exact", "exact_gasfree"].includes(selected.scheme)) {
    throw invalidRequirement("unsupported or missing payment scheme");
  }
  if (typeof selected.network !== "string" || (!selected.network.startsWith("eip155:") && !selected.network.startsWith("tron:"))) {
    throw invalidRequirement("unsupported or missing payment network");
  }
  try {
    assertRawAmount(selected.amount, "payment amount");
  } catch (error) {
    throw invalidRequirement(error instanceof Error ? error.message : String(error));
  }
  if (!normalizeAddress(selected.network, selected.asset)) {
    throw invalidRequirement(`invalid asset address for ${selected.network}`);
  }
  if (!normalizeAddress(selected.network, selected.payTo)) {
    throw invalidRequirement(`invalid payTo address for ${selected.network}`);
  }
  if (!Number.isInteger(selected.maxTimeoutSeconds) || selected.maxTimeoutSeconds! <= 0 || selected.maxTimeoutSeconds! > 86400) {
    throw invalidRequirement("maxTimeoutSeconds must be an integer between 1 and 86400");
  }
  try {
    const parsed = new URL(resource);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw invalidRequirement("resource URL must be an absolute HTTP(S) URL");
  }
  if (selected.scheme === "exact_gasfree") {
    if (!selected.network.startsWith("tron:")) {
      throw invalidRequirement("exact_gasfree is supported only on TRON networks");
    }
    return;
  }
  const extra = selected.extra;
  if (!extra || typeof extra !== "object") {
    throw invalidRequirement("exact payment requirement is missing scheme metadata");
  }
  const transferMethod = extra.assetTransferMethod;
  if (transferMethod === "permit2") return;
  if (transferMethod !== undefined) {
    throw invalidRequirement(`unsupported assetTransferMethod ${String(transferMethod)}`);
  }
  if (selected.network.startsWith("eip155:")) {
    const token = findTokenByAddress(selected.network, selected.asset);
    if (typeof extra.name !== "string" || !extra.name || typeof extra.version !== "string" || !extra.version) {
      throw invalidRequirement("EIP-3009 requirement is missing extra.name or extra.version");
    }
    if (token && (extra.name !== token.name || extra.version !== token.version)) {
      throw invalidRequirement("EIP-3009 domain metadata does not match the registered token");
    }
    return;
  }
  throw invalidRequirement("TRON exact requirement must declare Permit2");
}

async function serve(options: ParsedOptions): Promise<void> {
  const host = opt(options, "host", "127.0.0.1")!;
  const port = positiveIntegerOption(options, "port", 4020);
  const facilitatorUrl = opt(options, "facilitator-url", "https://facilitator.bankofai.io")!;
  const requirement = buildRequirement(options);
  if (!requirement.payTo) throw new CliError("MISSING_ARGUMENT", "--pay-to is required", "Pass --pay-to <recipient address>.", 2);
  const resourceUrl = opt(options, "resource-url", `http://${host}:${port}/pay`)!;
  try {
    const parsed = new URL(resourceUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw invalidArgument("--resource-url must be an absolute HTTP(S) URL");
  }
  validateSelectedRequirement(requirement, resourceUrl);
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
  const requiredNetwork = network ? normalizeNetworkOption(network) : undefined;
  const scheme = opt(options, "scheme");
  const token = opt(options, "token");
  const explicitAsset = opt(options, "asset");
  const decimals = opt(options, "decimals");
  const selected = accepts.find(req => {
    if (!req || !["exact", "exact_gasfree"].includes(req.scheme) || typeof req.network !== "string" || typeof req.asset !== "string") return false;
    if (req.scheme === "exact_gasfree" && !req.network.startsWith("tron:")) return false;
    let registryToken;
    try {
      registryToken = findTokenByAddress(req.network, req.asset);
    } catch {
      return false;
    }
    if (!registryToken) {
      if (!explicitAsset || decimals === undefined || !addressesEqual(req.network, explicitAsset, req.asset)) return false;
      if (req.network === "eip155:8453" || req.network === "eip155:84532") return false;
    }
    if (requiredNetwork && requiredNetwork !== req.network) return false;
    if (scheme && scheme !== req.scheme) return false;
    if (token) {
      let tokenInfo;
      try {
        tokenInfo = getToken(req.network, token);
      } catch {
        return false;
      }
      if (!addressesEqual(req.network, tokenInfo.address, req.asset)) return false;
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
  const scheme = opt(options, "scheme");
  if (scheme && !["exact", "exact_gasfree"].includes(scheme)) {
    throw invalidArgument(`unsupported scheme ${scheme}`);
  }
  const network = opt(options, "network");
  const normalizedNetwork = network ? normalizeNetworkOption(network) : undefined;
  const decimals = opt(options, "decimals");
  if (decimals !== undefined) resolveDecimals(undefined, decimals);
  const asset = opt(options, "asset");
  if (asset && normalizedNetwork && !normalizeAddress(normalizedNetwork, asset)) {
    throw invalidArgument(`invalid --asset address for ${normalizedNetwork}`);
  }
  const baseHeaders = requestHeaders(options);
  const probe = await fetchWithTimeout(url, {
    method,
    headers: baseHeaders,
    body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : opt(options, "body"),
    redirect: "manual",
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
  const resource = required.resource?.url ?? url;
  validateSelectedRequirement(selected, resource);
  resolveDecimals(findTokenByAddress(selected.network, selected.asset), opt(options, "decimals"));
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
        resource,
        selected,
        message: "Dry run - no payment submitted",
      },
    });
    return;
  }
  const creation = await withSdkStdoutRedirect(outputMode(options) === "json", () =>
    createPaymentClient({
      selected,
      resource,
      extensions: required.extensions,
      rpcUrl: opt(options, "rpc-url"),
      privateKey: opt(options, "private-key"),
      gasfreeApiUrl: opt(options, "gasfree-api-url"),
      maxGasfreeFeeRaw,
    }),
  );
  let cachedProbe: Response | undefined = probe;
  const transport: typeof globalThis.fetch = async (input, init) => {
    if (cachedProbe) {
      const response = cachedProbe;
      cachedProbe = undefined;
      return response;
    }
    return fetchWithTimeout(input, { ...init, redirect: "manual" }, timeoutMs(options), `fetch ${url}`);
  };
  const fetchWithPayment = wrapFetchWithPayment(transport, creation.client);
  const paid = await withSdkStdoutRedirect(outputMode(options) === "json", () =>
    fetchWithPayment(url, {
      method,
      headers: baseHeaders,
      body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : opt(options, "body"),
    }),
  );
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
  const port = positiveIntegerOption(options, "port", 4020);
  if (outputMode(options) !== "json") {
    await serve(options);
    await pay(`http://127.0.0.1:${port}/pay`, options);
    process.exit(0);
  }
  const capture = beginEmitCapture();
  let events;
  try {
    await serve(options);
    await pay(`http://127.0.0.1:${port}/pay`, options);
    events = capture.finish();
  } catch (error) {
    capture.finish();
    throw error;
  }
  emit({
    command: "roundtrip",
    mode: "json",
    result: {
      serve: events.find(event => event.component === "server")?.result ?? null,
      pay: events.find(event => event.component === "client")?.result ?? null,
    },
  });
  process.exit(0);
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
  else if (sub === "search") await catalogSearch(opt(options, "catalog", defaultCatalogSource())!, requireArgument(positional.slice(1).join(" ") || opt(options, "query"), "query", "x402-cli gateway catalog search <query> [options]"), options);
  else throw new CliError("UNKNOWN_COMMAND", `Unknown gateway catalog command: ${sub}`, "Run x402-cli gateway catalog --help to list commands.", 2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  setInvocationCommand(invocationCommandName(argv));
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
    if (hasFlag(options, "daemon")) await startServeDaemon(argv, options, buildRequirement(options), fileURLToPath(import.meta.url));
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

function invocationCommandName(argv: string[]): string {
  const positional = argv.filter(item => !item.startsWith("-"));
  const [first, second, third] = positional;
  if (first === "gateway" && second === "catalog" && third) return `${first} ${second} ${third}`;
  if ((first === "catalog" || first === "gateway") && second) return `${first} ${second}`;
  return first ?? "x402-cli";
}

main().catch(error => {
  const friendly = classify(error);
  emit({
    command: invocationCommandName(process.argv.slice(2)),
    mode: process.argv.includes("--json") ? "json" : "human",
    error: friendly,
  });
  const usageCodes = new Set(["INVALID_ARGUMENT", "MISSING_ARGUMENT", "UNKNOWN_COMMAND"]);
  process.exit(error instanceof CliError ? error.exitCode : usageCodes.has(friendly.code) ? 2 : 1);
});
