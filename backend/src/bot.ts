import type { Hex } from "viem";
import { launchCoin } from "./chain.js";
import { config } from "./config.js";
import { db, isOptedOut, kvGet, kvSet, setOptOut, type CoinRow } from "./db.js";
import { launchFromPost, tagRecipients, toSplitInputs, type Recipient } from "./launcher.js";
import { describeSplit, parseCommand, parseTag } from "./parse.js";
import { fetchImage } from "./picker.js";
import { assemble, bestImageUrl, getMe, getMentions, getPost, reply, XApiError, type FullPost, type XIncludes, type XTweet } from "./x/client.js";

const replyWithLink = process.env.REPLY_INCLUDE_LINK !== "false";
const log = (...a: unknown[]) => console.log("[bot]", ...a);

let botUserId = config.botUserId;
let botHandle = config.botHandle;

export async function initBot() {
  if (!botUserId) {
    const me = await getMe();
    botUserId = me.id;
    botHandle = me.username;
    log(`signed in as @${me.username} (${me.id})`);
  }
}

export async function startBot() {
  await initBot();
  const loop = async () => {
    try {
      await pollOnce();
      await retryFailedLaunches();
    } catch (e) {
      if (e instanceof XApiError && e.status === 429 && e.resetAt) {
        const wait = Math.max(5_000, e.resetAt - Date.now());
        log(`rate limited, sleeping ${Math.round(wait / 1000)}s`);
        setTimeout(loop, wait);
        return;
      }
      log("poll error", (e as Error).message);
    }
    setTimeout(loop, config.mentionPollMs);
  };
  loop();
}

export async function pollOnce() {
  const since = kvGet("mentions_since_id");
  const initialised = kvGet("mentions_initialised") === "1";
  const { tweets, includes, newest } = await getMentions(botUserId!, since);
  // First run: don't launch for the whole mention history, just remember where we are.
  // (An account with no mentions yet has no id to remember, so track "initialised" separately.)
  if (!initialised) {
    if (newest) kvSet("mentions_since_id", newest);
    kvSet("mentions_initialised", "1");
    log("initialised mention cursor", newest ?? "(no mentions yet)");
    return;
  }
  for (const t of tweets) {
    try {
      await handleTag(t, includes);
    } catch (e) {
      log(`tag ${t.id} failed:`, (e as Error).message);
    }
    kvSet("mentions_since_id", t.id);
  }
  if (newest) kvSet("mentions_since_id", newest);
}

export async function handleTag(tag: XTweet, inc: XIncludes) {
  const tagger = inc.users?.find((u) => u.id === tag.author_id);
  if (!tagger || tag.author_id === botUserId) return;
  if (db.prepare("SELECT 1 FROM coins WHERE tag_tweet_id = ?").get(tag.id)) return;

  const command = parseCommand(tag.text);
  if (command) {
    setOptOut(tagger.username, command === "optout");
    log(`@${tagger.username} opted ${command === "optout" ? "out" : "in"}`);
    await safeReply(
      tag.id,
      command === "optout"
        ? `Done. JustTag won't launch coins from your posts or put you in a split. Reply "@${botHandle} opt in" to undo.`
        : `You're back in. Tags on your posts launch coins again, and you can be in a split.`,
    );
    return;
  }

  // The post being tagged: the one this tag replies to, else the one it quotes, else the tag itself.
  const refId = tag.referenced_tweets?.find((r) => r.type === "replied_to")?.id ?? tag.referenced_tweets?.find((r) => r.type === "quoted")?.id;
  let target: FullPost | null = null;
  if (refId) {
    const inline = inc.tweets?.find((t) => t.id === refId);
    target = (inline && assemble(inline, inc)) || (await getPost(refId));
  }
  const selfTag = !target;
  if (!target) target = assemble(tag, inc);
  if (!target) return;
  if (target.author.id === botUserId) return; // tagging the bot's own replies does nothing
  if (isOptedOut(tagger.username)) return; // opted-out accounts can't tag either
  if (isOptedOut(target.author.username)) {
    await safeReply(tag.id, `@${target.author.username} opted out of JustTag, so this post can't be a coin.`);
    return;
  }

  // Per-user daily limit keeps one account from flooding the chain.
  const dayAgo = Date.now() - 24 * 3600_000;
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM coins WHERE tagger = ? AND created_at > ? AND source='tag'").get(tagger.username.toLowerCase(), dayAgo) as { n: number };
  if (n >= config.maxTagsPerUserPerDay) {
    log(`@${tagger.username} hit the daily limit`);
    return;
  }

  // One coin per post: point late taggers at the existing coin.
  const existing = db.prepare("SELECT * FROM coins WHERE status='live' AND json_extract(post_json,'$.id') = ?").get(target.tweet.id) as CoinRow | undefined;
  if (existing) {
    await safeReply(tag.id, `This post is already a coin: $${existing.symbol}.${replyWithLink ? ` ${config.origin}/coin/${existing.token}` : ""}`);
    return;
  }

  const parsed = parseTag(tag.text, { bot: botHandle, tagger: tagger.username, poster: target.author.username });
  // Friends who opted out never get a share: it goes back to the tagger.
  const taggerHandle = tagger.username.toLowerCase();
  const dropped = parsed.split.filter((s) => s.handle !== taggerHandle && isOptedOut(s.handle));
  if (dropped.length) {
    const freed = dropped.reduce((a, s) => a + s.bps, 0);
    parsed.split = parsed.split.filter((s) => !dropped.includes(s));
    const mine = parsed.split.find((s) => s.handle === taggerHandle);
    if (mine) mine.bps += freed;
    else parsed.split.unshift({ handle: taggerHandle, bps: freed, role: "tagger" });
  }

  // An image attached to the tag itself overrides the picker (only when tagging someone else's post).
  let overrideImage: Buffer | null = null;
  if (!selfTag) {
    const tagMedia = (tag.attachments?.media_keys ?? []).map((k) => inc.media?.find((m) => m.media_key === k)).find(Boolean);
    const url = tagMedia && bestImageUrl(tagMedia);
    if (url) overrideImage = await fetchImage(url);
  }

  const { coin, skipped } = await launchFromPost({
    post: target,
    source: "tag",
    recipients: tagRecipients(parsed.split),
    tagger: tagger.username.toLowerCase(),
    tagTweetId: tag.id,
    override: { name: parsed.name, ticker: parsed.ticker, image: overrideImage },
    seed: `tag:${tag.id}`,
    startedAt: Date.now(),
  });

  if (skipped === "unsafe") {
    log(`skipped unsafe post ${target.tweet.id}`);
    return;
  }
  await announce(coin, parsed.split);
  log(`launched $${coin.symbol} ${coin.token} in ${coin.tag_to_live_ms}ms for @${tagger.username}`);
}

function liveText(coin: CoinRow, split: { handle?: string; bps: number }[]) {
  const link = replyWithLink ? `\n\n${config.origin}/coin/${coin.token}` : "";
  const handles = split.filter((s): s is { handle: string; bps: number } => !!s.handle);
  return (
    `Live. $${coin.symbol} is on JustTag (Robinhood Chain).\n` +
    `Creator fees: ${describeSplit(handles)}. Sign in at ${config.domain}/claim to get paid.` +
    link
  );
}

async function announce(coin: CoinRow, split: { handle?: string; bps: number }[]) {
  if (!coin.tag_tweet_id) return;
  const replyId = await safeReply(coin.tag_tweet_id, liveText(coin, split));
  if (replyId) db.prepare("UPDATE coins SET reply_tweet_id = ? WHERE id = ?").run(replyId, coin.id);
}

/**
 * Launches that failed on-chain (RPC outage, gas spike, nonce clash) are retried up to 3 times. The image,
 * name and split were already chosen, so only the transaction is sent again; the launchId keeps it idempotent.
 */
export async function retryFailedLaunches() {
  const rows = db
    .prepare("SELECT * FROM coins WHERE status = 'failed' AND (error IS NULL OR error != 'unsafe') AND attempts < 3 AND created_at > ? ORDER BY created_at LIMIT 5")
    .all(Date.now() - 6 * 3600_000) as (CoinRow & { attempts: number })[];
  for (const c of rows) {
    db.prepare("UPDATE coins SET attempts = attempts + 1 WHERE id = ?").run(c.id);
    try {
      const recipients = JSON.parse(c.split_json) as Recipient[];
      const res = await launchCoin({ name: c.name, symbol: c.symbol, uri: `${config.origin}/m/${c.id}`, launchId: c.launch_id as Hex, splits: toSplitInputs(recipients) });
      const now = Date.now();
      db.prepare("UPDATE coins SET status='live', token=?, pair=?, tx_hash=?, live_at=?, tag_to_live_ms=?, error=NULL WHERE id=?").run(
        res.token.toLowerCase(), res.pair.toLowerCase(), res.txHash, now, now - c.created_at, c.id,
      );
      const live = db.prepare("SELECT * FROM coins WHERE id = ?").get(c.id) as CoinRow;
      if (live.source === "tag" && !live.reply_tweet_id) await announce(live, recipients);
      log(`retry launched $${live.symbol} ${live.token} (attempt ${c.attempts + 1})`);
    } catch (e) {
      db.prepare("UPDATE coins SET error = ? WHERE id = ?").run(String((e as Error).message).slice(0, 500), c.id);
      log(`retry ${c.id} failed:`, (e as Error).message);
    }
  }
}

async function safeReply(to: string, text: string) {
  try {
    return await reply(to, text);
  } catch (e) {
    log("reply failed", (e as Error).message);
    return null;
  }
}
