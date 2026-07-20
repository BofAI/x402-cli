import { CliError, type OutputMode } from "./args.js";

export type FriendlyError = { code: string; message: string; hint: string; details?: unknown };

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function emit(args: {
  command: string; result?: any; error?: FriendlyError; network?: string; scheme?: string; mode?: OutputMode;
}): void {
  const mode = args.mode ?? "human";
  if (mode === "json") {
    const envelope: Record<string, unknown> = { ok: !args.error, command: args.command };
    if (args.network) envelope.network = args.network;
    if (args.scheme) envelope.scheme = args.scheme;
    if (args.error) envelope.error = args.error;
    else envelope.result = args.result ?? null;
    printJson(envelope);
    return;
  }
  if (args.error) {
    process.stderr.write(`ERROR ${args.command}: ${args.error.code}\n`);
    process.stderr.write(`  ${args.error.message}\n`);
    if (args.error.hint) process.stderr.write(`  hint: ${args.error.hint}\n`);
    if (args.error.details !== undefined) process.stderr.write(`  details: ${JSON.stringify(args.error.details)}\n`);
    return;
  }
  const suffix = [args.network, args.scheme].filter(Boolean).join(" ");
  process.stdout.write(`OK ${args.command}${suffix ? ` (${suffix})` : ""}\n`);
  if (args.result && typeof args.result === "object" && !Array.isArray(args.result)) {
    for (const [key, value] of Object.entries(args.result)) {
      if (value === undefined) continue;
      process.stdout.write(value && typeof value === "object" ? `  ${key}: ${JSON.stringify(value)}\n` : `  ${key}: ${value}\n`);
    }
  } else if (args.result !== undefined) process.stdout.write(`  ${args.result}\n`);
}

export function classify(error: unknown): FriendlyError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CliError) return { code: error.code, message, hint: error.hint, details: error.details };
  const lower = message.toLowerCase();
  if (lower.includes("missing private key") || lower.includes("could not find a wallet")) return { code: "WALLET_NOT_CONFIGURED", message, hint: "Set PRIVATE_KEY, TRON_PRIVATE_KEY, EVM_PRIVATE_KEY, or configure agent-wallet with a payer wallet." };
  if (lower.includes("wallets_config") || lower.includes("wallet config")) return { code: "WALLET_CONFIG_CORRUPT", message, hint: "Check ~/.agent-wallet/wallets_config.json or recreate the local agent-wallet configuration." };
  if (lower.includes("does not exist") && lower.includes("account [t")) return { code: "TRON_ACCOUNT_NOT_ACTIVATED", message, hint: "Activate the TRON address by sending it a small amount of TRX before signing contract calls." };
  if (lower.includes("permit2_insufficient_balance") || lower.includes("insufficient") && lower.includes("balance")) return { code: "INSUFFICIENT_TOKEN_BALANCE", message, hint: "Fund the payer address with the exact token and network advertised by the provider, then retry." };
  if (lower.includes("transfer_from_failed") || lower.includes("transferfrom failed")) return { code: "TOKEN_TRANSFER_FAILED", message, hint: "Check token balance, token contract, payer address, and that the selected x402 route matches the provider requirement." };
  if (lower.includes("insufficient funds for gas") || lower.includes("insufficient gas") || lower.includes("energy")) return { code: "INSUFFICIENT_GAS", message, hint: "Fund the payer address with the native gas token for this network." };
  if (lower.includes("deadline") || lower.includes("expired")) return { code: "DEADLINE_OR_CLOCK_SKEW", message, hint: "Check local clock sync and retry with a fresh payment requirement." };
  if (lower.includes("permittransferfrom") || lower.includes("invalid signature") || lower.includes("permit reverted")) return { code: "PERMIT_REVERTED", message, hint: "The token or Permit2 contract rejected the signature; retry with a fresh requirement and verify token/network support." };
  if (lower.includes("tokenregistry") && lower.includes("import")) return { code: "SDK_API_DRIFT", message, hint: "Installed x402 SDK packages do not match this CLI; reinstall @bankofai/x402-cli and SDK dependencies." };
  if (lower.includes("429") || lower.includes("too many requests") || lower.includes("rate limit")) return { code: "RATE_LIMITED", message, hint: "Wait briefly and retry; the upstream service or RPC is rate limiting requests." };
  if (lower.includes("402 response missing")) return { code: "INVALID_X402_RESPONSE", message, hint: "The endpoint returned HTTP 402 without a PAYMENT-REQUIRED header." };
  if (lower.includes("no matching payment requirement")) return { code: "NO_MATCHING_PAYMENT_REQUIREMENT", message, hint: "Relax --network, --token, or --scheme, or use values offered by the provider." };
  if (lower.includes("exceeds --max")) return { code: "PAYMENT_AMOUNT_TOO_HIGH", message, hint: "Increase the max amount flag only if this provider price is expected." };
  if (lower.includes("failed to fetch") || lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("timed out")) return { code: "NETWORK_ERROR", message, hint: "Check the URL, local server, proxy, and network connectivity." };
  if (lower.includes(" is required") || lower.includes("must be") || lower.includes("invalid --") || lower.includes("mutually exclusive")) return { code: lower.includes("required") ? "MISSING_ARGUMENT" : "INVALID_ARGUMENT", message, hint: "Run the command with --help to see valid usage and options." };
  return { code: "IO_ERROR", message, hint: "Run with --json for structured output, and check the provider/gateway logs for details." };
}
