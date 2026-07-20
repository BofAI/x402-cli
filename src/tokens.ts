export type TokenInfo = {
  address: string;
  decimals: number;
  name: string;
  symbol: string;
  version?: string;
  assetTransferMethod?: "permit2";
};

export const TOKENS: Record<string, Record<string, TokenInfo>> = {
  "tron:0x2b6653dc": {
    USDT: {
      address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      decimals: 6,
      name: "Tether USD",
      symbol: "USDT",
      version: "1",
      assetTransferMethod: "permit2",
    },
    USDD: {
      address: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
      decimals: 18,
      name: "Decentralized USD",
      symbol: "USDD",
      version: "1",
      assetTransferMethod: "permit2",
    },
  },
  "tron:0xcd8690dc": {
    USDT: {
      address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      decimals: 6,
      name: "Tether USD",
      symbol: "USDT",
      version: "1",
      assetTransferMethod: "permit2",
    },
    USDD: {
      address: "TGjgvdTWWrybVLaVeFqSyVqJQWjxqRYbaK",
      decimals: 18,
      name: "Decentralized USD",
      symbol: "USDD",
      version: "1",
      assetTransferMethod: "permit2",
    },
  },
  "tron:0x94a9059e": {
    USDT: {
      address: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs",
      decimals: 6,
      name: "Tether USD",
      symbol: "USDT",
      version: "1",
    },
  },
  "eip155:56": {
    USDT: {
      address: "0x55d398326f99059fF775485246999027B3197955",
      decimals: 18,
      name: "Tether USD",
      symbol: "USDT",
      version: "1",
      assetTransferMethod: "permit2",
    },
  },
  "eip155:97": {
    USDT: {
      address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
      decimals: 18,
      name: "Tether USD",
      symbol: "USDT",
      version: "1",
      assetTransferMethod: "permit2",
    },
    USDC: {
      address: "0x64544969ed7EBf5f083679233325356EbE738930",
      decimals: 18,
      name: "USD Coin",
      symbol: "USDC",
      version: "1",
      assetTransferMethod: "permit2",
    },
  },
};

export function normalizeNetwork(network: string): string {
  const legacyTronIds: Record<string, string> = {
    "tron-mainnet": "tron:0x2b6653dc",
    "tron:mainnet": "tron:0x2b6653dc",
    mainnet: "tron:0x2b6653dc",
    "tron-shasta": "tron:0x94a9059e",
    "tron:shasta": "tron:0x94a9059e",
    shasta: "tron:0x94a9059e",
    "tron-nile": "tron:0xcd8690dc",
    "tron:nile": "tron:0xcd8690dc",
    nile: "tron:0xcd8690dc",
  };
  const canonical = legacyTronIds[network];
  if (canonical) {
    throw new Error(`legacy TRON network identifier ${network} is not supported; use ${canonical}`);
  }
  return {
    "bsc-mainnet": "eip155:56",
    "bsc-testnet": "eip155:97",
  }[network] ?? network;
}

export function getToken(network: string, symbol: string): TokenInfo {
  const token = TOKENS[normalizeNetwork(network)]?.[symbol.toUpperCase()];
  if (!token) throw new Error(`unknown token ${symbol} on ${network}`);
  return token;
}

export function findTokenByAddress(network: string, address: string): TokenInfo | undefined {
  const lower = address.toLowerCase();
  return Object.values(TOKENS[normalizeNetwork(network)] ?? {}).find(
    token => token.address.toLowerCase() === lower,
  );
}

export function assertRawAmount(value: string, name = "raw amount"): string {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer string`);
  return value.replace(/^0+(?=\d)/, "");
}

export function toSmallestUnit(amount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("token decimals must be an integer between 0 and 255");
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error("amount must be a non-negative decimal string");
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new Error(`amount has more than ${decimals} decimal places`);
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return assertRawAmount((BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString());
}
