import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@bankofai/x402-core/http";
import { x402Client } from "@bankofai/x402-core/client";
import {
  ConfigWalletProvider,
  resolveWalletProvider,
  type Eip712Capable,
  type Wallet,
} from "@bankofai/agent-wallet";
import { ExactEvmScheme, toClientEvmSigner } from "@bankofai/x402-evm";
import { ExactTronScheme, createClientTronSigner } from "@bankofai/x402-tron";
import { ExactGasFreeTronScheme, createGasFreeApiClients, getGasFreeApiBaseUrl } from "@bankofai/x402-tron/gasfree";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TronWeb } from "tronweb";
import { CliError } from "./args.js";
import { addressesEqual, findTokenByAddress } from "./tokens.js";

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

export type PayerContext = {
  walletId: string | null;
  address: string;
};

type SelectedAgentWallet = {
  wallet: SigningWallet;
  payer: PayerContext;
};

async function activeAgentWallet(network: string, requestedWalletId?: string): Promise<SelectedAgentWallet> {
  let wallet: Wallet;
  let walletId: string | null = null;
  try {
    const dir = process.env.AGENT_WALLET_DIR?.trim() || undefined;
    const explicitWalletId = requestedWalletId?.trim() || process.env.AGENT_WALLET_ID?.trim() || undefined;
    const provider = resolveWalletProvider({
      network,
      ...(dir ? { dir } : {}),
    });
    if (provider instanceof ConfigWalletProvider) {
      walletId = explicitWalletId ?? provider.getActiveId();
      if (!walletId) {
        throw new CliError(
          "WALLET_NOT_CONFIGURED",
          "Agent Wallet has configured wallets but no active wallet",
          "Set an active Agent Wallet or explicitly select one with --wallet-id or AGENT_WALLET_ID.",
          1,
        );
      }
      wallet = await provider.getWallet(walletId, network);
    } else {
      if (explicitWalletId) {
        throw new CliError(
          "WALLET_NOT_CONFIGURED",
          `Agent Wallet '${explicitWalletId}' was requested but no configured wallet directory is available`,
          "Check AGENT_WALLET_DIR, or remove --wallet-id/AGENT_WALLET_ID when using an environment-backed wallet.",
          1,
        );
      }
      wallet = await provider.getActiveWallet(network);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SyntaxError || /wallets_config|wallet config/i.test(message)) {
      throw new CliError(
        "WALLET_CONFIG_CORRUPT",
        message,
        "Check the Agent Wallet configuration or recreate the wallet.",
        1,
      );
    }
    if (/password required/i.test(message)) {
      throw new CliError(
        "WALLET_PASSWORD_REQUIRED",
        message,
        "Provide the Agent Wallet password using its supported secure configuration.",
        1,
      );
    }
    throw error;
  }
  if (!("signTypedData" in wallet) || typeof wallet.signTypedData !== "function") {
    throw new Error(`active agent-wallet for ${network} does not support typed-data signing`);
  }
  const address = await wallet.getAddress();
  return {
    wallet: wallet as SigningWallet,
    payer: { walletId, address },
  };
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
  walletId?: string;
};

const erc20BalanceAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

async function requireEvmTokenBalance(
  publicClient: ReturnType<typeof createPublicClient> | undefined,
  selected: PaymentRequirement,
  payer: PayerContext,
): Promise<string | undefined> {
  if (!publicClient) return undefined;
  let balance: bigint;
  try {
    balance = await publicClient.readContract({
      address: selected.asset as `0x${string}`,
      abi: erc20BalanceAbi,
      functionName: "balanceOf",
      args: [payer.address as `0x${string}`],
    });
  } catch (error) {
    throw new CliError(
      "TOKEN_BALANCE_CHECK_FAILED",
      `failed to read token balance for payer ${payer.address}: ${error instanceof Error ? error.message : String(error)}`,
      "Check --rpc-url and confirm it serves the selected payment network.",
      1,
      { payer, network: selected.network, asset: selected.asset, requiredRaw: selected.amount },
    );
  }
  const required = BigInt(selected.amount);
  if (balance < required) {
    throw new CliError(
      "INSUFFICIENT_TOKEN_BALANCE",
      `payer ${payer.address} has token balance ${balance} but payment requires ${required}`,
      "Fund this exact payer address with the advertised token on the selected network, or select another wallet.",
      1,
      {
        payer,
        network: selected.network,
        asset: selected.asset,
        balanceRaw: balance.toString(),
        requiredRaw: required.toString(),
      },
    );
  }
  return balance.toString();
}

export async function createPaymentClient(
  args: CreatePaymentClientArgs,
): Promise<{
  client: x402Client;
  payer: PayerContext;
  balanceRaw?: string;
  gasfreeEstimate?: { fee: string; total: string };
}> {
  const selected = ensurePermit2(args.selected);
  if (selected.network.startsWith("eip155:")) {
    if (selected.scheme !== "exact") throw new Error(`unsupported scheme ${selected.scheme} on ${selected.network}`);
    const privateKey = explicitPrivateKey(["EVM_PRIVATE_KEY", "PRIVATE_KEY"], args.privateKey);
    const rpcUrl = evmRpcUrl(selected.network, args.rpcUrl);
    const publicClient = rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : undefined;
    let signer;
    let payer: PayerContext;
    if (privateKey) {
      const account = privateKeyToAccount(privateKey);
      signer = toClientEvmSigner(account, publicClient);
      payer = { walletId: null, address: account.address };
    } else {
      const agentWallet = await createAgentWalletEvmSigner(selected.network, args.walletId);
      signer = toClientEvmSigner(agentWallet.signer, publicClient);
      payer = agentWallet.payer;
    }
    const balanceRaw = await requireEvmTokenBalance(publicClient, selected, payer);
    const scheme = new ExactEvmScheme(signer, rpcUrl ? { rpcUrl } : undefined);
    const client = new x402Client().register(
      selected.network as `${string}:${string}`,
      scheme,
    );
    registerSelectedRequirementPolicy(client, selected);
    return { client, payer, ...(balanceRaw !== undefined ? { balanceRaw } : {}) };
  }
  if (selected.network.startsWith("tron:")) {
    const privateKey = explicitPrivateKey(["TRON_PRIVATE_KEY", "PRIVATE_KEY"], args.privateKey);
    let wallet;
    let payer: PayerContext;
    if (privateKey) {
      wallet = await createTronWallet(
          privateKey,
          selected.scheme === "exact_gasfree" ? args.maxGasfreeFeeRaw : undefined,
        );
      payer = { walletId: null, address: await wallet.getAddress() };
    } else {
      const agentWallet = await activeAgentWallet(selected.network, args.walletId);
      wallet = withGasfreeFeeGuard(
          agentWallet.wallet,
          selected.scheme === "exact_gasfree" ? args.maxGasfreeFeeRaw : undefined,
        );
      payer = agentWallet.payer;
    }
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
    return { client, payer, ...(gasfreeEstimate ? { gasfreeEstimate } : {}) };
  }
  throw new Error(`unsupported network ${selected.network}`);
}

async function createAgentWalletEvmSigner(
  network: string,
  requestedWalletId?: string,
): Promise<{
  signer: {
    address: `0x${string}`;
    signTypedData(data: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`>;
    signTransaction(transaction: Record<string, unknown>): Promise<`0x${string}`>;
  };
  payer: PayerContext;
}> {
  const selected = await activeAgentWallet(network, requestedWalletId);
  const { wallet, payer } = selected;
  const address = payer.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`active agent-wallet address is not valid for ${network}: ${address}`);
  }
  return {
    payer,
    signer: {
      address: address as `0x${string}`,
      async signTypedData(data: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      }) {
        const messageFrom = data.message.from;
        if (
          typeof messageFrom === "string" &&
          !addressesEqual(network, address, messageFrom)
        ) {
          throw new CliError(
            "WALLET_ADDRESS_MISMATCH",
            `selected wallet address ${address} does not match typed-data payer ${messageFrom}`,
            "Do not sign this payment; reselect the intended wallet and request a fresh payment requirement.",
            1,
            { payer, payloadFrom: messageFrom, network },
          );
        }
        return prefixedHex(await wallet.signTypedData(data));
      },
      async signTransaction(transaction: Record<string, unknown>) {
        return prefixedHex(await wallet.signTransaction(transaction));
      },
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
      addressesEqual(requirement.network, requirement.asset, selected.asset) &&
      requirement.amount === selected.amount &&
      addressesEqual(requirement.network, requirement.payTo, selected.payTo)
    ),
  );
}

export async function createPaymentPayload(
  args: CreatePaymentClientArgs,
): Promise<{
  payload: unknown;
  payer: PayerContext;
  balanceRaw?: string;
  gasfreeEstimate?: { fee: string; total: string };
}> {
  const creation = await createPaymentClient(args);
  const required = paymentRequired(
    ensurePermit2(args.selected),
    args.resource,
    args.extensions,
  );
  const payload = await creation.client.createPaymentPayload(required as never);
  return {
    payload,
    payer: creation.payer,
    ...(creation.balanceRaw !== undefined ? { balanceRaw: creation.balanceRaw } : {}),
    ...(creation.gasfreeEstimate ? { gasfreeEstimate: creation.gasfreeEstimate } : {}),
  };
}
