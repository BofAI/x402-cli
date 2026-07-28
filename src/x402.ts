import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@bankofai/x402-core/http";
import { x402Client } from "@bankofai/x402-core/client";
import { resolveWallet, type Eip712Capable, type Wallet } from "@bankofai/agent-wallet";
import { ExactEvmScheme, toClientEvmSigner } from "@bankofai/x402-evm";
import { ExactTronScheme, createClientTronSigner } from "@bankofai/x402-tron";
import { ExactGasFreeTronScheme, createGasFreeApiClients, getGasFreeApiBaseUrl } from "@bankofai/x402-tron/gasfree";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TronWeb } from "tronweb";
import { findTokenByAddress } from "./tokens.js";

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

function explicitPrivateKey(names: string[], explicit: string | undefined): `0x${string}` | undefined {
  for (const value of [explicit, ...names.map(name => process.env[name])]) {
    const normalized = normalizePrivateKey(value);
    if (normalized) return normalized;
  }
  return undefined;
}

type SigningWallet = Wallet & Eip712Capable;

async function activeAgentWallet(network: string): Promise<SigningWallet> {
  const wallet = await resolveWallet({
    network,
    ...(process.env.AGENT_WALLET_DIR ? { dir: process.env.AGENT_WALLET_DIR } : {}),
    ...(process.env.AGENT_WALLET_ID ? { walletId: process.env.AGENT_WALLET_ID } : {}),
  });
  if (!("signTypedData" in wallet) || typeof wallet.signTypedData !== "function") {
    throw new Error(`active agent-wallet for ${network} does not support typed-data signing`);
  }
  return wallet as SigningWallet;
}

function prefixedHex(value: string): `0x${string}` {
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

function evmRpcUrl(network: string, explicit?: string): string | undefined {
  const chainId = network.split(":")[1];
  return (
    explicit ||
    process.env[`EVM_RPC_URL_${chainId}`] ||
    process.env.RPC_URL ||
    process.env.EVM_RPC_URL ||
    (chainId === "8453" ? "https://mainnet.base.org" : undefined) ||
    (chainId === "84532" ? "https://sepolia.base.org" : undefined) ||
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

export type CreatePaymentClientArgs = {
  selected: PaymentRequirement;
  resource: string;
  extensions?: Record<string, unknown>;
  privateKey?: string;
  rpcUrl?: string;
  apiKey?: string;
  allowanceMode?: string;
  gasfreeApiUrl?: string;
  maxGasfreeFeeRaw?: string;
};

export async function createPaymentClient(
  args: CreatePaymentClientArgs,
): Promise<{ client: x402Client; gasfreeEstimate?: { fee: string; total: string } }> {
  const selected = ensurePermit2(args.selected);
  if (selected.network.startsWith("eip155:")) {
    if (selected.scheme !== "exact") throw new Error(`unsupported scheme ${selected.scheme} on ${selected.network}`);
    const privateKey = explicitPrivateKey(["EVM_PRIVATE_KEY", "PRIVATE_KEY"], args.privateKey);
    const rpcUrl = evmRpcUrl(selected.network, args.rpcUrl);
    const publicClient = rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : undefined;
    const signer = privateKey
      ? toClientEvmSigner(privateKeyToAccount(privateKey), publicClient)
      : toClientEvmSigner(await createAgentWalletEvmSigner(selected.network), publicClient);
    const scheme = new ExactEvmScheme(signer, rpcUrl ? { rpcUrl } : undefined);
    const client = new x402Client().register(
      selected.network as `${string}:${string}`,
      scheme,
    );
    registerSelectedRequirementPolicy(client, selected);
    return { client };
  }
  if (selected.network.startsWith("tron:")) {
    const privateKey = explicitPrivateKey(["TRON_PRIVATE_KEY", "PRIVATE_KEY"], args.privateKey);
    const wallet = privateKey
      ? await createTronWallet(
          privateKey,
          selected.scheme === "exact_gasfree" ? args.maxGasfreeFeeRaw : undefined,
        )
      : withGasfreeFeeGuard(
          await activeAgentWallet(selected.network),
          selected.scheme === "exact_gasfree" ? args.maxGasfreeFeeRaw : undefined,
        );
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
    registerSelectedRequirementPolicy(client, selected);
    return { client, ...(gasfreeEstimate ? { gasfreeEstimate } : {}) };
  }
  throw new Error(`unsupported network ${selected.network}`);
}

async function createAgentWalletEvmSigner(network: string) {
  const wallet = await activeAgentWallet(network);
  const address = await wallet.getAddress();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`active agent-wallet address is not valid for ${network}: ${address}`);
  }
  return {
    address: address as `0x${string}`,
    async signTypedData(data: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) {
      return prefixedHex(await wallet.signTypedData(data));
    },
    async signTransaction(transaction: Record<string, unknown>) {
      return prefixedHex(await wallet.signTransaction(transaction));
    },
  };
}

function withGasfreeFeeGuard(wallet: SigningWallet, maxGasfreeFeeRaw?: string) {
  return {
    getAddress: () => wallet.getAddress(),
    async signTypedData(args: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) {
      if (maxGasfreeFeeRaw !== undefined && args.primaryType === "PermitTransfer") {
        const maxFee = BigInt(args.message.maxFee as string | number | bigint ?? -1);
        if (maxFee < 0n || maxFee > BigInt(maxGasfreeFeeRaw)) {
          throw new Error(`final GasFree maxFee ${maxFee} exceeds --max-gasfree-fee limit ${maxGasfreeFeeRaw}`);
        }
      }
      return prefixedHex(await wallet.signTypedData(args));
    },
    signTransaction: (transaction: Record<string, unknown>) => wallet.signTransaction(transaction),
  };
}

function registerSelectedRequirementPolicy(client: x402Client, selected: PaymentRequirement): void {
  client.registerPolicy((_version, requirements) =>
    requirements.filter(requirement =>
      requirement.scheme === selected.scheme &&
      requirement.network === selected.network &&
      requirement.asset.toLowerCase() === selected.asset.toLowerCase() &&
      requirement.amount === selected.amount &&
      requirement.payTo.toLowerCase() === selected.payTo.toLowerCase()
    ),
  );
}

export async function createPaymentPayload(
  args: CreatePaymentClientArgs,
): Promise<{ payload: unknown; gasfreeEstimate?: { fee: string; total: string } }> {
  const creation = await createPaymentClient(args);
  const required = paymentRequired(
    ensurePermit2(args.selected),
    args.resource,
    args.extensions,
  );
  const payload = await creation.client.createPaymentPayload(required as never);
  return {
    payload,
    ...(creation.gasfreeEstimate ? { gasfreeEstimate: creation.gasfreeEstimate } : {}),
  };
}
