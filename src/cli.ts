#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createPaymentPayload, decodeRequired, decodeResponse, decodeSignature, encodeRequired, encodeResponse, encodeSignature, headers, PaymentRequirement } from "./x402.js";
import { assertRawAmount, findTokenByAddress, getToken, normalizeNetwork, toSmallestUnit } from "./tokens.js";
import { CliError, hasFlag, opt, optAll, outputMode, parseArgs, requireArgument, type ParsedOptions } from "./args.js";
import { classify, emit, withSdkStdoutRedirect } from "./output.js";
import { fetchWithTimeout, readBoundedText, responsePayload, timeoutMs } from "./http-client.js";
import { startServeDaemon } from "./daemon.js";
import { getVersion, helpText } from "./help.js";
import { catalogBuild, catalogPayAssets, gatewayCheck, gatewayScaffold, gatewayStart } from "./gateway-commands.js";
import { catalogSearch, defaultCatalogSource, handleCatalog } from "./catalog-commands.js";

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
