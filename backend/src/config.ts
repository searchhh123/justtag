import fs from "node:fs";

/** Tiny .env loader so the backend has no dotenv dependency. Real env vars win. */
function loadDotEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env var ${k}`);
  return v;
};
const opt = (k: string) => process.env[k] || undefined;
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k: string, d: boolean) => (process.env[k] ? process.env[k] === "true" : d);

export const config = {
  port: num("PORT", 8787),
  origin: env("PUBLIC_ORIGIN", "http://localhost:8787"),
  domain: env("PUBLIC_DOMAIN", "localhost"),
  dbPath: env("DB_PATH", "./data/justtag.db"),
  dataDir: env("DATA_DIR", "./data"),

  // ---- chain (Robinhood Chain mainnet = 4663) ----
  chainId: num("CHAIN_ID", 4663),
  rpcUrl: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  explorer: env("EXPLORER_URL", "https://robinhoodchain.blockscout.com"),
  launchpad: opt("LAUNCHPAD_ADDRESS") as `0x${string}` | undefined,
  airdrop: opt("AIRDROP_ADDRESS") as `0x${string}` | undefined,
  // Uniswap V2 on Robinhood Chain (verified on-chain: router.factory() and router.WETH() match)
  dexRouter: env("DEX_ROUTER", "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba") as `0x${string}`,
  weth: env("WETH_ADDRESS", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73") as `0x${string}`,
  launchpadDeployBlock: BigInt(env("LAUNCHPAD_DEPLOY_BLOCK", "0")),
  operatorKey: opt("OPERATOR_PRIVATE_KEY") as `0x${string}` | undefined,
  attesterKey: opt("ATTESTER_PRIVATE_KEY") as `0x${string}` | undefined,
  tokenCA: opt("JUSTTAG_TOKEN_ADDRESS"), // $JUSTTAG, shown in the header once launched

  // ---- X (Twitter) ----
  botHandle: env("X_BOT_HANDLE", "JustTag"),
  botUserId: opt("X_BOT_USER_ID"),
  xConsumerKey: opt("X_CONSUMER_KEY"),
  xConsumerSecret: opt("X_CONSUMER_SECRET"),
  xAccessToken: opt("X_ACCESS_TOKEN"),
  xAccessSecret: opt("X_ACCESS_SECRET"),
  xBearer: opt("X_BEARER_TOKEN"),
  xClientId: opt("X_OAUTH2_CLIENT_ID"),
  xClientSecret: opt("X_OAUTH2_CLIENT_SECRET"),
  mentionPollMs: num("MENTION_POLL_MS", 15_000),
  wallPostIds: (opt("WALL_POST_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),

  // ---- AI ----
  anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-5-5"),
  anthropicEffort: env("ANTHROPIC_EFFORT", "low") as "low" | "medium" | "high",

  // ---- workers ----
  runBot: bool("RUN_BOT", true),
  runAgents: bool("RUN_AGENTS", true),
  runPayouts: bool("RUN_PAYOUTS", true),
  runIndexer: bool("RUN_INDEXER", true),
  agentPollMs: num("AGENT_POLL_MS", 120_000),
  agentMaxLaunchesPerDay: num("AGENT_MAX_LAUNCHES_PER_DAY", 6),
  payoutPollMs: num("PAYOUT_POLL_MS", 300_000),
  payoutMinWei: BigInt(env("PAYOUT_MIN_WEI", "1000000000000000")), // 0.001 ETH
  holdersAirdropTop: num("HOLDERS_AIRDROP_TOP", 100),
  maxTagsPerUserPerDay: num("MAX_TAGS_PER_USER_PER_DAY", 5),
  sessionSecret: env("SESSION_SECRET", "change-me-in-production-please-32+chars"),
};

export type Config = typeof config;
