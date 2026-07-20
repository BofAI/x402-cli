import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@bankofai/x402-core/http";
import { x402Client } from "@bankofai/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@bankofai/x402-evm";
import { ExactTronScheme, createClientTronSigner } from "@bankofai/x402-tron";
import { ExactGasFreeTronScheme, createGasFreeApiClients, getGasFreeApiBaseUrl } from "@bankofai/x402-tron/gasfree";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TronWeb } from "tronweb";
import { findTokenByAddress } from "./tokens.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PaymentRequirement = {
  scheme: string;
  network: `${string}:${string}` | string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export const headers = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
};

export function encodeRequired(value: unknown): string {
  return encodePaymentRequiredHeader(value as never);
}

export function encodeSignature(value: unknown): string {
  return encodePaymentSignatureHeader(value as never);
}

export function encodeResponse(value: unknown): string {
  return encodePaymentResponseHeader(value as never);
}

export function decodeRequired(value: string): any {
  return decodePaymentRequiredHeader(value);
}

export function decodeSignature(value: string): any {
  return decodePaymentSignatureHeader(value);
}

export function decodeResponse(value: string): any {
  return decodePaymentResponseHeader(value);
}

export function ensurePermit2(requirement: PaymentRequirement): PaymentRequirement {
  if (requirement.scheme !== "exact") return requirement;
  const extra = { ...(requirement.extra ?? {}) };
  if (!extra.assetTransferMethod) {
    const token = findTokenByAddress(requirement.network, requirement.asset);
    if (token?.assetTransferMethod === "permit2") {
      extra.assetTransferMethod = "permit2";
    }
  }
  return { ...requirement, extra };
}

export function paymentRequired(
  requirement: PaymentRequirement,
  resource: string,
  extensions?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: resource },
    accepts: [ensurePermit2(requirement)],
    ...(extensions ? { extensions } : {}),
  };
}

function normalizePrivateKey(value: string | undefined): `0x${string}` | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

function privateKeyFromAgentWallet(walletIds: string[]): `0x${string}` | undefined {
  const configPath = process.env.AGENT_WALLET_CONFIG ||
    path.join(process.env.AGENT_WALLET_DIR || path.join(os.homedir(), ".agent-wallet"), "wallets_config.json");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const wallets = config.wallets ?? {};
    const ids = [
      process.env.AGENT_WALLET_ID,
      config.activeWalletId,
      ...walletIds,
      ...Object.keys(wallets),
    ].filter(Boolean);
    for (const id of ids) {
      const wallet = wallets[String(id)];
      const key = wallet?.params?.private_key ?? wallet?.material?.private_key ?? wallet?.private_key;
      const normalized = normalizePrivateKey(key);
      if (normalized) return normalized;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function privateKeyFrom(names: string[], explicit: string | undefined, walletIds: string[]): `0x${string}` {
  for (const value of [explicit, ...names.map(name => process.env[name])]) {
    const normalized = normalizePrivateKey(value);
    if (normalized) return normalized;
  }
  const walletKey = privateKeyFromAgentWallet(walletIds);
  if (walletKey) return walletKey;
  throw new Error(`missing private key; set one of ${names.join(", ")}`);
}

function evmRpcUrl(network: string, explicit?: string): string | undefined {
  const chainId = network.split(":")[1];
  return (
    explicit ||
    process.env[`EVM_RPC_URL_${chainId}`] ||
    process.env.RPC_URL ||
    process.env.EVM_RPC_URL ||
    (chainId === "56" ? "https://bsc-dataseed.binance.org" : undefined) ||
    (chainId === "97" ? "https://data-seed-prebsc-1-s1.binance.org:8545" : undefined)
  );
}

async function createTronWallet(privateKey: `0x${string}`, maxGasfreeFeeRaw?: string) {
  const rawKey = privateKey.replace(/^0x/, "");
  const tronWeb = new TronWeb({ fullHost: "https://api.trongrid.io" });
  const address = TronWeb.address.fromPrivateKey(rawKey);
  if (!address) throw new Error("invalid TRON private key");
  return {
    getAddress: () => address,
    async signTypedData(args: any) {
      if (maxGasfreeFeeRaw !== undefined && args?.primaryType === "PermitTransfer") {
        const maxFee = BigInt(args?.message?.maxFee ?? -1);
        if (maxFee < 0n || maxFee > BigInt(maxGasfreeFeeRaw)) {
          throw new Error(`final GasFree maxFee ${maxFee} exceeds --max-gasfree-fee limit ${maxGasfreeFeeRaw}`);
        }
      }
      const signature = await signTronTypedData(tronWeb, args, rawKey);
      return signature.startsWith("0x") ? signature : `0x${signature}`;
    },
    async signTransaction(tx: any) {
      return tronWeb.trx.sign(tx, rawKey);
    },
  };
}

export async function signTronTypedData(tronWeb: Pick<TronWeb, "trx">, args: any, rawPrivateKey: string): Promise<string> {
  const trx = tronWeb.trx as any;
  const signer = typeof trx.signTypedData === "function" ? trx.signTypedData.bind(trx) : trx._signTypedData?.bind(trx);
  if (!signer) throw new Error("tronweb typed-data signing is not available");
  return signer(args.domain, args.types, args.message, rawPrivateKey);
}

export async function createPaymentPayload(args: {
  selected: PaymentRequirement;
  resource: string;
  extensions?: Record<string, unknown>;
  privateKey?: string;
  rpcUrl?: string;
  apiKey?: string;
  allowanceMode?: string;
  gasfreeApiUrl?: string;
  maxGasfreeFeeRaw?: string;
}): Promise<{ payload: unknown; gasfreeEstimate?: { fee: string; total: string } }> {
  const selected = ensurePermit2(args.selected);
  const required = paymentRequired(selected, args.resource, args.extensions);
  if (selected.network.startsWith("eip155:")) {
    if (selected.scheme !== "exact") throw new Error(`unsupported scheme ${selected.scheme} on ${selected.network}`);
    const privateKey = privateKeyFrom(
      ["EVM_PRIVATE_KEY", "AGENT_WALLET_PRIVATE_KEY", "PRIVATE_KEY"],
      args.privateKey,
      ["evm_client", "payer", "default"],
    );
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = evmRpcUrl(selected.network, args.rpcUrl);
    const publicClient = rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : undefined;
    const signer = toClientEvmSigner(account, publicClient);
    const scheme = new ExactEvmScheme(signer, rpcUrl ? { rpcUrl } : undefined);
    const payload = await new x402Client()
      .register(selected.network as `${string}:${string}`, scheme)
      .createPaymentPayload(required as never);
    return { payload };
  }
  if (selected.network.startsWith("tron:")) {
    const privateKey = privateKeyFrom(
      ["TRON_PRIVATE_KEY", "AGENT_WALLET_PRIVATE_KEY", "PRIVATE_KEY"],
      args.privateKey,
      ["tron_client", "payer", "default"],
    );
    const wallet = await createTronWallet(privateKey, selected.scheme === "exact_gasfree" ? args.maxGasfreeFeeRaw : undefined);
    const signer = await createClientTronSigner(wallet, {
      network: selected.network,
      rpcUrl: args.rpcUrl || process.env.TRON_RPC_URL,
      apiKey: args.apiKey || process.env.TRON_GRID_API_KEY,
      allowanceMode: args.allowanceMode || process.env.X402_TRON_ALLOWANCE_MODE || "auto",
    } as never);
    const client = new x402Client();
    let gasfreeEstimate: { fee: string; total: string } | undefined;
    if (selected.scheme === "exact_gasfree") {
      const apiUrl = args.gasfreeApiUrl || process.env.X402_GASFREE_API_URL || getGasFreeApiBaseUrl(selected.network);
      const scheme = new ExactGasFreeTronScheme(signer, {
        apiClients: createGasFreeApiClients({ [selected.network]: apiUrl }),
      });
      const total = await scheme.estimateCost(selected as never);
      const amount = BigInt(selected.amount);
      const fee = total - amount;
      if (args.maxGasfreeFeeRaw !== undefined && fee > BigInt(args.maxGasfreeFeeRaw)) {
        throw new Error(`estimated GasFree fee ${fee} exceeds --max-gasfree-fee limit ${args.maxGasfreeFeeRaw}`);
      }
      gasfreeEstimate = { fee: fee.toString(), total: total.toString() };
      client.register(selected.network as `${string}:${string}`, scheme);
    } else if (selected.scheme === "exact") {
      client.register(selected.network as `${string}:${string}`, new ExactTronScheme(signer));
    } else {
      throw new Error(`unsupported scheme ${selected.scheme} on ${selected.network}`);
    }
    const payload = await client.createPaymentPayload(required as never);
    return { payload, ...(gasfreeEstimate ? { gasfreeEstimate } : {}) };
  }
  throw new Error(`unsupported network ${selected.network}`);
}
