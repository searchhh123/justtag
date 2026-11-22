import { decodeEventLog, parseAbiItem, type Address, type Hex, type Log } from "viem";
import { launchpadAbi } from "./abi.js";
import { launchpadAddress, publicClient } from "./chain.js";
import { config } from "./config.js";
import { db, kvGet, kvSet } from "./db.js";

const log = (...a: unknown[]) => console.log("[indexer]", ...a);

db.exec(`CREATE TABLE IF NOT EXISTS holders (token TEXT NOT NULL, holder TEXT NOT NULL, balance TEXT NOT NULL, PRIMARY KEY (token, holder));`);

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";

/** Follows launchpad events (trades, graduations) and the Transfer logs of every JustTag coin. */
export async function startIndexer() {
  let span = 20_000n;
  const loop = async () => {
    try {
      const head = await publicClient.getBlockNumber();
      let from = BigInt(kvGet("indexer_block") ?? config.launchpadDeployBlock.toString());
      while (from <= head) {
        const to = from + span - 1n > head ? head : from + span - 1n;
        try {
          await indexRange(from, to);
          kvSet("indexer_block", (to + 1n).toString());
          from = to + 1n;
          if (span < 50_000n) span += span / 4n;
        } catch (e) {
          if (span > 500n) {
            span /= 2n; // RPC refused the range; shrink it
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      log("error", (e as Error).message);
    }
    setTimeout(loop, 4_000);
  };
  loop();
}

export async function indexRange(from: bigint, to: bigint) {
  const pad = launchpadAddress();
  const logs = await publicClient.getLogs({ address: pad, fromBlock: from, toBlock: to });
  const known = (db.prepare("SELECT token FROM coins WHERE token IS NOT NULL").all() as { token: string }[]).map((r) => r.token.toLowerCase());
  // Coins created inside this range are not in the DB yet when the bot is still waiting for its receipt.
  for (const l of logs) {
    try {
      const ev = decodeEventLog({ abi: launchpadAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "TokenCreated") known.push((ev.args as unknown as { token: Address }).token.toLowerCase());
    } catch {
      /* not ours */
    }
  }
  const tokens = [...new Set(known)] as Address[];
  const transfers = tokens.length
    ? await publicClient.getLogs({ address: tokens, event: transferEvent, fromBlock: from, toBlock: to })
    : [];

  const blockTs = new Map<bigint, number>();
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber!))].slice(0, 40);
  await Promise.all(
    uniqueBlocks.map(async (b) => {
      const blk = await publicClient.getBlock({ blockNumber: b });
      blockTs.set(b, Number(blk.timestamp) * 1000);
    }),
  );

  db.exec("BEGIN");
  try {
    for (const l of logs) handleLaunchpadLog(l, blockTs.get(l.blockNumber!) ?? Date.now());
    for (const t of transfers) {
      const { from: f, to: tt, value } = t.args as { from: Address; to: Address; value: bigint };
      const token = t.address.toLowerCase();
      if (f !== ZERO) addBalance(token, f.toLowerCase(), -value);
      if (tt !== ZERO) addBalance(token, tt.toLowerCase(), value);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function addBalance(token: string, holder: string, delta: bigint) {
  const row = db.prepare("SELECT balance FROM holders WHERE token = ? AND holder = ?").get(token, holder) as { balance: string } | undefined;
  const next = BigInt(row?.balance ?? "0") + delta;
  if (next <= 0n) db.prepare("DELETE FROM holders WHERE token = ? AND holder = ?").run(token, holder);
  else db.prepare("INSERT OR REPLACE INTO holders (token, holder, balance) VALUES (?, ?, ?)").run(token, holder, next.toString());
}

function handleLaunchpadLog(l: Log, ts: number) {
  let ev;
  try {
    ev = decodeEventLog({ abi: launchpadAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
  } catch {
    return;
  }
  if (ev.eventName === "Trade") {
    const a = ev.args as unknown as { token: Address; trader: Address; isBuy: boolean; ethAmount: bigint; tokenAmount: bigint; virtualEth: bigint; virtualToken: bigint; realEth: bigint };
    const token = a.token.toLowerCase();
    const price = (a.virtualEth * 10n ** 18n) / a.virtualToken;
    db.prepare(
      "INSERT OR IGNORE INTO trades (tx_hash, log_index, token, trader, is_buy, eth_wei, token_amount, price_wei, block, ts) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(l.transactionHash!, l.logIndex!, token, a.trader.toLowerCase(), a.isBuy ? 1 : 0, a.ethAmount.toString(), a.tokenAmount.toString(), price.toString(), Number(l.blockNumber), ts);
    const c = db.prepare("SELECT volume_wei FROM coins WHERE token = ?").get(token) as { volume_wei: string } | undefined;
    if (c) {
      db.prepare("UPDATE coins SET price_wei = ?, real_eth_wei = ?, volume_wei = ?, trades = trades + 1 WHERE token = ?").run(
        price.toString(), a.realEth.toString(), (BigInt(c.volume_wei) + a.ethAmount).toString(), token,
      );
    }
  } else if (ev.eventName === "Graduated") {
    const a = ev.args as unknown as { token: Address; pair: Address };
    db.prepare("UPDATE coins SET graduated = 1, pair = ? WHERE token = ?").run(a.pair.toLowerCase(), a.token.toLowerCase());
    log(`graduated ${a.token}`);
  }
}

export function holdersOf(token: string, exclude: string[], top: number) {
  const ex = new Set(exclude.map((e) => e.toLowerCase()));
  return (db.prepare("SELECT holder, balance FROM holders WHERE token = ?").all(token.toLowerCase()) as { holder: string; balance: string }[])
    .filter((h) => !ex.has(h.holder))
    .map((h) => ({ holder: h.holder as Address, balance: BigInt(h.balance) }))
    .sort((a, b) => (b.balance > a.balance ? 1 : -1))
    .slice(0, top);
}
