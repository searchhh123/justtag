import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, robinhoodTestnet } from "viem/chains";
import { defineChain } from "viem";
import { launchpadAbi, airdropAbi } from "./abi.js";
import { config } from "./config.js";

const knownChain = [robinhood, robinhoodTestnet].find((c) => c.id === config.chainId);
export const chain =
  knownChain ??
  defineChain({
    id: config.chainId,
    name: `Chain ${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 3 }) });

export const operator = config.operatorKey ? privateKeyToAccount(config.operatorKey) : undefined;
export const attester = config.attesterKey ? privateKeyToAccount(config.attesterKey) : undefined;
export const operatorWallet = operator
  ? createWalletClient({ account: operator, chain, transport: http(config.rpcUrl, { retryCount: 3 }) })
  : undefined;

export function launchpadAddress(): Address {
  if (!config.launchpad) throw new Error("LAUNCHPAD_ADDRESS is not set. Deploy the contracts first (see README).");
  return config.launchpad;
}

// ------------------------------------------------------------------ keys (must match the contract)

export enum Kind {
  XAccount = 0,
  Wallet = 1,
  Holders = 2,
  Buyback = 3,
  Burn = 4,
}

/** keccak256("x:" + lowercase handle). The same value the website and contract use. */
export const handleKey = (handle: string): Hex => keccak256(toBytes(`x:${handle.replace(/^@/, "").toLowerCase()}`));
export const walletKey = (wallet: Address): Hex => pad(wallet, { size: 32 });
export const routeKey = (kind: Kind, token: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [kind, token]));
export const tokenId = (token: Address | null | undefined): Hex => (token ? pad(token, { size: 32 }) : (`0x${"0".repeat(64)}` as Hex));

export type SplitInput = { kind: Kind; id: Hex; bps: number };

export function launchIdFor(seed: string): Hex {
  return keccak256(toBytes(`justtag:${seed}`));
}

// ------------------------------------------------------------------ launch

export type LaunchResult = { token: Address; pair: Address; txHash: Hex };

/** Launches a coin as the operator (free). Idempotent through `launchId`: a retry after a crash finds the coin. */
export async function launchCoin(p: {
  name: string;
  symbol: string;
  uri: string;
  launchId: Hex;
  splits: SplitInput[];
}): Promise<LaunchResult> {
  if (!operatorWallet || !operator) throw new Error("OPERATOR_PRIVATE_KEY is not set");
  const address = launchpadAddress();

  const existing = (await publicClient.readContract({ address, abi: launchpadAbi, functionName: "tokenByLaunchId", args: [p.launchId] })) as Address;
  if (existing && existing !== "0x0000000000000000000000000000000000000000") {
    const pair = (await publicClient.readContract({
      address: existing,
      abi: [{ type: "function", name: "pair", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
      functionName: "pair",
    })) as Address;
    return { token: existing, pair, txHash: "0x" };
  }

  const args = [p.name, p.symbol, p.uri, p.launchId, p.splits.map((s) => ({ kind: s.kind, id: s.id, bps: s.bps })), 0n] as const;
  const { request } = await publicClient.simulateContract({
    account: operator,
    address,
    abi: launchpadAbi,
    functionName: "createToken",
    args,
  });
  const txHash = await operatorWallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`createToken reverted: ${txHash}`);
  const created = findTokenCreated(receipt.logs);
  if (!created) throw new Error("TokenCreated event not found");
  return { token: created.token, pair: created.pair, txHash };
}

export function findTokenCreated(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== launchpadAddress().toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: launchpadAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "TokenCreated") {
        const a = ev.args as unknown as { token: Address; creator: Address; launchId: Hex; pair: Address; name: string; symbol: string; uri: string };
        return a;
      }
    } catch {
      /* other event */
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ X account -> wallet binding

/** EIP-712 signature the user submits to `bindWallet`. Only produced after the user signed in with X. */
export async function signBind(handle: string, wallet: Address) {
  if (!attester) throw new Error("ATTESTER_PRIVATE_KEY is not set");
  const address = launchpadAddress();
  const key = handleKey(handle);
  const nonce = (await publicClient.readContract({ address, abi: launchpadAbi, functionName: "bindNonce", args: [key] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const signature = await attester.signTypedData({
    domain: { name: "JustTag", version: "1", chainId: config.chainId, verifyingContract: address },
    types: {
      Bind: [
        { name: "key", type: "bytes32" },
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Bind",
    message: { key, wallet, nonce, deadline },
  });
  return { key, wallet, nonce: nonce.toString(), deadline: deadline.toString(), signature };
}

// ------------------------------------------------------------------ reads

export async function pendingOf(key: Hex): Promise<bigint> {
  return (await publicClient.readContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "pendingFees", args: [key] })) as bigint;
}

export async function walletOf(key: Hex): Promise<Address> {
  return (await publicClient.readContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "walletOf", args: [key] })) as Address;
}

export type CurveState = {
  virtualEth: bigint;
  virtualToken: bigint;
  realEth: bigint;
  realToken: bigint;
  reserveToken: bigint;
  creator: Address;
  createdAt: bigint;
  graduated: boolean;
};

export async function curveOf(token: Address): Promise<CurveState> {
  const r = (await publicClient.readContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "curves", args: [token] })) as readonly [
    bigint, bigint, bigint, bigint, bigint, Address, bigint, boolean,
  ];
  return { virtualEth: r[0], virtualToken: r[1], realEth: r[2], realToken: r[3], reserveToken: r[4], creator: r[5], createdAt: r[6], graduated: r[7] };
}

export async function launchpadConfig() {
  const r = (await publicClient.readContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "config" })) as readonly [
    bigint, bigint, bigint, bigint, bigint, number, number,
  ];
  return {
    initVirtualEth: r[0],
    initVirtualToken: r[1],
    curveSupply: r[2],
    creationFee: r[3],
    migrationFee: r[4],
    protocolFeeBps: r[5],
    creatorFeeBps: r[6],
  };
}

export { airdropAbi, launchpadAbi };
