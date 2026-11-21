import crypto from "node:crypto";
import type { Address, Hex } from "viem";
import { config } from "./config.js";
import { db, type CoinRow } from "./db.js";
import { handleKey, Kind, launchCoin, launchIdFor, tokenId, walletKey, type SplitInput } from "./chain.js";
import { pickCoin, placeholderImage, saveImage } from "./picker.js";
import type { FullPost } from "./x/client.js";

/** A recipient of creator fees, as stored off-chain. Exactly one of handle / route / wallet is set. */
export type Recipient = {
  bps: number;
  role: string; // tagger | poster | friend | owner | author | holders | buyback | burn | wallet
  handle?: string;
  route?: "holders" | "buyback" | "burn";
  routeToken?: Address | null; // null = this coin
  wallet?: Address;
};

export function toSplitInputs(recipients: Recipient[]): SplitInput[] {
  return recipients.map((r) => {
    if (r.handle) return { kind: Kind.XAccount, id: handleKey(r.handle), bps: r.bps };
    if (r.wallet) return { kind: Kind.Wallet, id: walletKey(r.wallet), bps: r.bps };
    const kind = r.route === "holders" ? Kind.Holders : r.route === "buyback" ? Kind.Buyback : Kind.Burn;
    return { kind, id: tokenId(r.routeToken ?? null), bps: r.bps };
  });
}

export function shortId() {
  return crypto.randomBytes(5).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 8);
}

export function serializePost(p: FullPost) {
  const m = p.tweet.public_metrics;
  return {
    id: p.tweet.id,
    url: `https://x.com/${p.author.username}/status/${p.tweet.id}`,
    handle: p.author.username,
    name: p.author.name,
    avatar: `/api/av/${p.author.username}`,
    verified: !!p.author.verified,
    text: p.tweet.text,
    created: p.tweet.created_at ? Date.parse(p.tweet.created_at) : null,
    thumb: p.media[0] ? `/api/media?u=${encodeURIComponent((p.media[0].type === "photo" ? p.media[0].url : p.media[0].preview_image_url) ?? "")}` : null,
    isVideo: p.media[0]?.type === "video" || p.media[0]?.type === "animated_gif",
    metrics: m ? { replies: m.reply_count, reposts: m.retweet_count, likes: m.like_count, views: m.impression_count ?? null } : null,
  };
}

export type LaunchRequest = {
  post: FullPost;
  source: "tag" | "agent";
  recipients: Recipient[];
  tagger: string | null;
  tagTweetId: string | null;
  agentId?: string | null;
  override?: { name?: string; ticker?: string; image?: Buffer | null };
  seed: string; // stable idempotency seed
  startedAt?: number;
};

export type LaunchOutcome = { coin: CoinRow; skipped?: "unsafe" | "duplicate" };

/** Pick image/name/ticker, store metadata, launch on-chain, record the result. */
export async function launchFromPost(req: LaunchRequest): Promise<LaunchOutcome> {
  const launchId = launchIdFor(req.seed);
  const dup = db.prepare("SELECT * FROM coins WHERE launch_id = ?").get(launchId) as CoinRow | undefined;
  if (dup && dup.status === "live") return { coin: dup, skipped: "duplicate" };

  const started = req.startedAt ?? Date.now();
  const pick = await pickCoin(req.post, req.override);
  const id = dup?.id ?? shortId();

  if (!pick.safe) {
    const row = upsertCoin({
      id, launch_id: launchId, status: "failed", source: req.source, name: pick.name, symbol: pick.ticker,
      description: pick.description, post_json: JSON.stringify(serializePost(req.post)), split_json: JSON.stringify(req.recipients),
      tagger: req.tagger, tag_tweet_id: req.tagTweetId, agent_id: req.agentId ?? null, error: "unsafe", created_at: started,
    });
    return { coin: row, skipped: "unsafe" };
  }

  const img = pick.imageBuffer ?? (await placeholderImage(pick.ticker));
  const imagePath = saveImage(id, img);
  upsertCoin({
    id, launch_id: launchId, status: "pending", source: req.source, name: pick.name, symbol: pick.ticker,
    description: pick.description, image_path: imagePath, post_json: JSON.stringify(serializePost(req.post)),
    split_json: JSON.stringify(req.recipients), tagger: req.tagger, tag_tweet_id: req.tagTweetId, agent_id: req.agentId ?? null,
    created_at: started,
  });

  try {
    const res = await launchCoin({
      name: pick.name,
      symbol: pick.ticker,
      uri: `${config.origin}/m/${id}`,
      launchId: launchId as Hex,
      splits: toSplitInputs(req.recipients),
    });
    const now = Date.now();
    db.prepare(
      "UPDATE coins SET status='live', token=?, pair=?, tx_hash=?, live_at=?, tag_to_live_ms=?, error=NULL WHERE id=?",
    ).run(res.token.toLowerCase(), res.pair.toLowerCase(), res.txHash, now, now - started, id);
  } catch (e) {
    db.prepare("UPDATE coins SET status='failed', error=? WHERE id=?").run(String((e as Error).message).slice(0, 500), id);
    throw e;
  }
  return { coin: db.prepare("SELECT * FROM coins WHERE id = ?").get(id) as CoinRow };
}

function upsertCoin(c: Partial<CoinRow> & Pick<CoinRow, "id" | "launch_id" | "status" | "source" | "name" | "symbol" | "split_json" | "created_at">): CoinRow {
  const cols = Object.keys(c);
  db.prepare(
    `INSERT INTO coins (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(id) DO UPDATE SET ${cols.filter((k) => k !== "id").map((k) => `${k}=excluded.${k}`).join(",")}`,
  ).run(...cols.map((k) => (c as Record<string, unknown>)[k] as string | number | null));
  return db.prepare("SELECT * FROM coins WHERE id = ?").get(c.id) as CoinRow;
}

/** Off-chain recipients for a tag: every share is an X account. */
export function tagRecipients(split: { handle: string; bps: number; role: string }[]): Recipient[] {
  return split.map((s) => ({ handle: s.handle, bps: s.bps, role: s.role }));
}
