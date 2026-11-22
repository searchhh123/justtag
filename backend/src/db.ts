import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- One row per launched (or launching) coin.
CREATE TABLE IF NOT EXISTS coins (
  id TEXT PRIMARY KEY,               -- short id used in /m/:id and /i/:id
  launch_id TEXT UNIQUE NOT NULL,    -- bytes32 idempotency key sent on-chain
  status TEXT NOT NULL,              -- pending | live | failed
  source TEXT NOT NULL,              -- tag | agent | pad
  token TEXT,                        -- ERC20 address once live
  pair TEXT,
  tx_hash TEXT,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT,
  image_path TEXT,
  post_json TEXT,                    -- the X post the coin came from
  split_json TEXT NOT NULL,          -- [{handle|route|wallet, bps, role}]
  tagger TEXT,
  tag_tweet_id TEXT UNIQUE,
  reply_tweet_id TEXT,
  agent_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  live_at INTEGER,
  tag_to_live_ms INTEGER,
  graduated INTEGER NOT NULL DEFAULT 0,
  price_wei TEXT,
  real_eth_wei TEXT,
  volume_wei TEXT NOT NULL DEFAULT '0',
  trades INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS coins_live ON coins(status, live_at DESC);
CREATE INDEX IF NOT EXISTS coins_token ON coins(token);

CREATE TABLE IF NOT EXISTS trades (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  token TEXT NOT NULL,
  trader TEXT NOT NULL,
  is_buy INTEGER NOT NULL,
  eth_wei TEXT NOT NULL,
  token_amount TEXT NOT NULL,
  price_wei TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS trades_token ON trades(token, block DESC);

-- Agent coins launched from the website.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  coin_id TEXT NOT NULL,
  token TEXT,
  owner_wallet TEXT NOT NULL,
  owner_handle TEXT,
  preset TEXT NOT NULL,
  prompt TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  search_query TEXT,
  routes_json TEXT NOT NULL,         -- {holders, owner, buyback, burn, authors} in bps
  status TEXT NOT NULL,              -- pending | active | paused
  last_seen_id TEXT,
  launches_today INTEGER NOT NULL DEFAULT 0,
  launches_day TEXT,
  created_at INTEGER NOT NULL
);

-- X accounts that signed in on the website, and the wallet they linked.
CREATE TABLE IF NOT EXISTS accounts (
  handle TEXT PRIMARY KEY,           -- lowercase
  x_user_id TEXT,
  wallet TEXT,
  bound_tx TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS x_cache (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`);

export function kvGet(k: string): string | undefined {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return row?.v;
}
export function kvSet(k: string, v: string) {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export type CoinRow = {
  id: string;
  launch_id: string;
  status: "pending" | "live" | "failed";
  source: "tag" | "agent" | "pad";
  token: string | null;
  pair: string | null;
  tx_hash: string | null;
  name: string;
  symbol: string;
  description: string | null;
  image_path: string | null;
  post_json: string | null;
  split_json: string;
  tagger: string | null;
  tag_tweet_id: string | null;
  reply_tweet_id: string | null;
  agent_id: string | null;
  error: string | null;
  created_at: number;
  live_at: number | null;
  tag_to_live_ms: number | null;
  graduated: number;
  price_wei: string | null;
  real_eth_wei: string | null;
  volume_wei: string;
  trades: number;
};

export type AgentRow = {
  id: string;
  coin_id: string;
  token: string | null;
  owner_wallet: string;
  owner_handle: string | null;
  preset: string;
  prompt: string;
  sources_json: string;
  search_query: string | null;
  routes_json: string;
  status: "pending" | "active" | "paused";
  last_seen_id: string | null;
  launches_today: number;
  launches_day: string | null;
  created_at: number;
};

// ---- added after v0.1: opt-outs and launch retries
db.exec(`CREATE TABLE IF NOT EXISTS optouts (handle TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
try {
  db.exec("ALTER TABLE coins ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
} catch {
  /* column exists */
}

/** Accounts that asked JustTag never to launch coins from their posts or put them in a split. */
export function isOptedOut(handle: string): boolean {
  return !!db.prepare("SELECT 1 FROM optouts WHERE handle = ?").get(handle.replace(/^@/, "").toLowerCase());
}
export function setOptOut(handle: string, out: boolean) {
  const h = handle.replace(/^@/, "").toLowerCase();
  if (out) db.prepare("INSERT OR REPLACE INTO optouts (handle, at) VALUES (?, ?)").run(h, Date.now());
  else db.prepare("DELETE FROM optouts WHERE handle = ?").run(h);
}
