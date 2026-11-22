import type { Address, Hex } from "viem";
import { airdropAbi, launchpadAbi } from "./abi.js";
import { handleKey, Kind, launchpadAddress, operator, operatorWallet, pendingOf, publicClient, routeKey, walletKey, walletOf } from "./chain.js";
import { config } from "./config.js";
import { db, type AgentRow } from "./db.js";
import { holdersOf } from "./indexer.js";
import type { Recipient } from "./launcher.js";

const log = (...a: unknown[]) => console.log("[payouts]", ...a);
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/**
 * "Nothing to claim."
 * 1. Fees owed to X accounts that have linked a wallet are pushed to that wallet (claimMany, gas paid by the operator).
 * 2. Agent coins: Buyback and Burn buckets buy the coin; the Holders bucket is airdropped pro-rata to holders.
 */
export async function startPayouts() {
  const loop = async () => {
    try {
      await pushCreatorFees();
      await runAgentRoutes();
    } catch (e) {
      log("error", (e as Error).message);
    }
    setTimeout(loop, config.payoutPollMs);
  };
  setTimeout(loop, 10_000);
}

function allRecipientKeys(): Hex[] {
  const rows = db.prepare("SELECT split_json FROM coins WHERE status = 'live'").all() as { split_json: string }[];
  const keys = new Set<Hex>();
  for (const r of rows) {
    for (const s of JSON.parse(r.split_json) as Recipient[]) {
      if (s.handle) keys.add(handleKey(s.handle));
      else if (s.wallet) keys.add(walletKey(s.wallet));
    }
  }
  return [...keys];
}

export async function pushCreatorFees() {
  if (!operatorWallet || !operator) return;
  const ready: Hex[] = [];
  for (const key of allRecipientKeys()) {
    const [pending, wallet] = await Promise.all([pendingOf(key), key.startsWith("0x000000000000000000000000") ? Promise.resolve("0x1" as Address) : walletOf(key)]);
    if (pending >= config.payoutMinWei && wallet !== ZERO) ready.push(key);
  }
  for (let i = 0; i < ready.length; i += 50) {
    const batch = ready.slice(i, i + 50);
    const hash = await operatorWallet.writeContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "claimMany", args: [batch], account: operator, chain: operatorWallet.chain });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`pushed fees for ${batch.length} recipients (${hash})`);
  }
}

export async function runAgentRoutes() {
  if (!operatorWallet || !operator) return;
  const agents = db.prepare("SELECT * FROM agents WHERE token IS NOT NULL").all() as AgentRow[];
  for (const a of agents) {
    const token = a.token as Address;
    for (const kind of [Kind.Buyback, Kind.Burn]) {
      const key = routeKey(kind, token);
      if ((await pendingOf(key)) < config.payoutMinWei) continue;
      // Robinhood Chain orders transactions first-come-first-served at the sequencer (no public mempool),
      // so these small operator buys are not practical to sandwich; minOut=1 only guards against zero.
      const hash = await operatorWallet.writeContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "executeRoute", args: [key, 0n, 1n], account: operator, chain: operatorWallet.chain });
      await publicClient.waitForTransactionReceipt({ hash });
      log(`${kind === Kind.Buyback ? "buyback" : "burn"} for ${token} (${hash})`);
    }
    await airdropHolders(token);
  }
}

async function airdropHolders(token: Address) {
  if (!config.airdrop || !operatorWallet || !operator) return;
  const key = routeKey(Kind.Holders, token);
  const pending = await pendingOf(key);
  if (pending < config.payoutMinWei * 5n) return; // batch small amounts

  const coin = db.prepare("SELECT pair FROM coins WHERE token = ?").get(token.toLowerCase()) as { pair: string | null } | undefined;
  const holders = holdersOf(token, [launchpadAddress(), coin?.pair ?? ZERO, DEAD, ZERO, config.airdrop, operator.address], config.holdersAirdropTop);
  if (!holders.length) return;

  const claimHash = await operatorWallet.writeContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "claim", args: [key], account: operator, chain: operatorWallet.chain });
  await publicClient.waitForTransactionReceipt({ hash: claimHash });

  const total = holders.reduce((a, h) => a + h.balance, 0n);
  const amounts = holders.map((h) => (pending * h.balance) / total);
  const sum = amounts.reduce((a, b) => a + b, 0n);
  const hash = await operatorWallet.writeContract({
    address: config.airdrop,
    abi: airdropAbi,
    functionName: "multisend",
    args: [token, holders.map((h) => h.holder), amounts],
    value: sum,
    account: operator,
    chain: operatorWallet.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`airdropped ${sum} wei to ${holders.length} holders of ${token} (${hash})`);
}
