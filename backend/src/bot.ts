import { config } from "./config.js";
import { db, kvGet, kvSet, type CoinRow } from "./db.js";
import { launchFromPost, tagRecipients } from "./launcher.js";
import { describeSplit, parseTag } from "./parse.js";
import { fetchImage } from "./picker.js";
import { assemble, bestImageUrl, getMe, getMentions, getPost, reply, XApiError, type FullPost, type XIncludes, type XTweet } from "./x/client.js";

const replyWithLink = process.env.REPLY_INCLUDE_LINK !== "false";
const log = (...a: unknown[]) => console.log("[bot]", ...a);

let botUserId = config.botUserId;
let botHandle = config.botHandle;

export async function startBot() {
  if (!botUserId) {
    const me = await getMe();
    botUserId = me.id;
    botHandle = me.username;
    log(`signed in as @${me.username} (${me.id})`);
  }
  const loop = async () => {
    try {
      await pollOnce();
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

async function pollOnce() {
  const since = kvGet("mentions_since_id");
  const { tweets, includes, newest } = await getMentions(botUserId!, since);
  // First run: don't launch for the whole mention history, just remember where we are.
  if (!since) {
    if (newest) kvSet("mentions_since_id", newest);
    log("initialised mention cursor", newest ?? "(none)");
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
  const link = replyWithLink ? `\n\n${config.origin}/coin/${coin.token}` : "";
  const text =
    `Live. $${coin.symbol} is on JustTag (Robinhood Chain).\n` +
    `Creator fees: ${describeSplit(parsed.split)}. Sign in at ${config.domain}/claim to get paid.` +
    link;
  const replyId = await safeReply(tag.id, text);
  if (replyId) db.prepare("UPDATE coins SET reply_tweet_id = ? WHERE id = ?").run(replyId, coin.id);
  log(`launched $${coin.symbol} ${coin.token} in ${coin.tag_to_live_ms}ms for @${tagger.username}`);
}

async function safeReply(to: string, text: string) {
  try {
    return await reply(to, text);
  } catch (e) {
    log("reply failed", (e as Error).message);
    return null;
  }
}
