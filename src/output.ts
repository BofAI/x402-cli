import {
  DecryptionError,
  NetworkError as WalletNetworkError,
  PrivyAuthError,
  PrivyConfigError,
  PrivyRateLimitError,
  SigningError,
  UnsupportedOperationError,
  WalletError,
  WalletNotFoundError,
} from "@bankofai/agent-wallet";
import { CliError, type OutputMode } from "./args.js";

export type FriendlyError = { code: string; message: string; hint: string; details?: unknown };
export type OutputEnvelope = {
  ok: boolean;
  command: string;
  component?: string;
  network?: string;
  scheme?: string;
  result?: unknown;
  error?: FriendlyError;
};

let invocationCommand: string | undefined;
let emitCapture: OutputEnvelope[] | undefined;

export function setInvocationCommand(command: string): void {
  invocationCommand = command;
}

export function beginEmitCapture(): { finish: () => OutputEnvelope[] } {
  if (emitCapture) throw new Error("output capture is already active");
  emitCapture = [];
  return {
    finish() {
      const captured = emitCapture ?? [];
      emitCapture = undefined;
      return captured;
    },
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function emit(args: {
  command: string; result?: any; error?: FriendlyError; network?: string; scheme?: string; mode?: OutputMode;
}): void {
  const mode = args.mode ?? "human";
  const command = invocationCommand ?? args.command;
  if (mode === "json") {
    const envelope: OutputEnvelope = { ok: !args.error, command };
    if (args.command !== command) envelope.component = args.command;
    if (args.network) envelope.network = args.network;
    if (args.scheme) envelope.scheme = args.scheme;
    if (args.error) envelope.error = args.error;
    else envelope.result = args.result ?? null;
    if (emitCapture) {
      emitCapture.push(envelope);
      return;
    }
    printJson(envelope);
    return;
  }
  if (args.error) {
    process.stderr.write(`ERROR ${command}: ${args.error.code}\n`);
    process.stderr.write(`  ${args.error.message}\n`);
    if (args.error.hint) process.stderr.write(`  hint: ${args.error.hint}\n`);
    if (args.error.details !== undefined) process.stderr.write(`  details: ${JSON.stringify(args.error.details)}\n`);
    return;
  }
  const suffix = [args.network, args.scheme].filter(Boolean).join(" ");
  process.stdout.write(`OK ${command}${suffix ? ` (${suffix})` : ""}\n`);
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
  if (error instanceof WalletNotFoundError) return { code: "WALLET_NOT_CONFIGURED", message, hint: "Configure an active Agent Wallet for this network." };
  if (error instanceof DecryptionError) return { code: "WALLET_DECRYPTION_FAILED", message, hint: "Unlock the Agent Wallet with the correct password and retry." };
  if (error instanceof SigningError) return { code: "WALLET_SIGNING_FAILED", message, hint: "Check that the active wallet supports this network and typed-data request." };
  if (error instanceof UnsupportedOperationError) return { code: "WALLET_UNSUPPORTED_OPERATION", message, hint: "Use a wallet backend that supports typed-data signing for this network." };
  if (error instanceof PrivyAuthError) return { code: "WALLET_AUTH_FAILED", message, hint: "Check the remote wallet authentication configuration." };
  if (error instanceof PrivyConfigError) return { code: "WALLET_CONFIG_CORRUPT", message, hint: "Check the remote Agent Wallet configuration." };
  if (error instanceof PrivyRateLimitError) return { code: "RATE_LIMITED", message, hint: "Wait briefly before retrying the remote wallet request." };
  if (error instanceof WalletNetworkError) return { code: "WALLET_NETWORK_ERROR", message, hint: "Check connectivity to the configured Agent Wallet backend." };
  if (error instanceof WalletError) return { code: "WALLET_ERROR", message, hint: "Inspect the active Agent Wallet configuration and backend status." };
  const lower = message.toLowerCase();
  if (lower.includes("password required")) return { code: "WALLET_PASSWORD_REQUIRED", message, hint: "Provide the Agent Wallet password using its supported secure configuration." };
  if (lower.includes("missing private key") || lower.includes("could not find a wallet") || lower.includes("wallet not found")) return { code: "WALLET_NOT_CONFIGURED", message, hint: "Configure an active Agent Wallet for this network. For development/CI, use --private-key or the chain-specific private-key environment variable." };
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

export async function withSdkStdoutRedirect<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const redirect = (...args: unknown[]) => {
    process.stderr.write(`${args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg, null, 2)).join(" ")}\n`);
  };
  console.log = redirect;
  console.info = redirect;
  console.debug = redirect;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
  }
}
