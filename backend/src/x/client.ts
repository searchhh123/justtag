import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

/**
 * Minimal X API v2 client.
 * - User-context calls (reading the bot's mentions, posting replies) are signed with OAuth 1.0a using the bot
 *   account's keys from the X developer portal.
 * - App-only reads can use the bearer token.
 * Pricing (pay-per-use, docs.x.com/x-api/getting-started/pricing): owned reads such as your own mentions cost
 * less than general post reads, and replies to a post that summoned the bot are billed as "summoned" creates.
 */

const API = "https://api.x.com";

const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauth1Header(method: string, url: string, query: Record<string, string>) {
  const { xConsumerKey, xConsumerSecret, xAccessToken, xAccessSecret } = config;
  if (!xConsumerKey || !xConsumerSecret || !xAccessToken || !xAccessSecret) {
    throw new Error("X OAuth 1.0a keys are not configured (X_CONSUMER_KEY/SECRET, X_ACCESS_TOKEN/SECRET)");
  }
  const oauth: Record<string, string> = {
    oauth_consumer_key: xConsumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: xAccessToken,
    oauth_version: "1.0",
  };
  // JSON bodies are not part of the signature base string; query params are.
  const all = { ...query, ...oauth };
  const paramStr = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramStr)].join("&");
  const key = `${pct(xConsumerSecret)}&${pct(xAccessSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

export class XApiError extends Error {
  constructor(public status: number, public body: string, public resetAt?: number) {
    super(`X API ${status}: ${body.slice(0, 300)}`);
  }
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; auth?: "user" | "app" } = {},
): Promise<T> {
  const url = API + path;
  const query = opts.query ?? {};
  const qs = new URLSearchParams(query).toString();
  const auth =
    (opts.auth ?? "user") === "app" && config.xBearer
      ? `Bearer ${config.xBearer}`
      : oauth1Header(method, url, query);
  const res = await fetch(qs ? `${url}?${qs}` : url, {
    method,
    headers: {
      authorization: auth,
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const reset = res.headers.get("x-rate-limit-reset");
    throw new XApiError(res.status, text, reset ? Number(reset) * 1000 : undefined);
  }
  return JSON.parse(text) as T;
}

// ------------------------------------------------------------------ types

export type XUser = { id: string; name: string; username: string; profile_image_url?: string; verified?: boolean };
export type XMedia = {
  media_key: string;
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
};
export type XTweet = {
  id: string;
  text: string;
  author_id: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted"; id: string }[];
  attachments?: { media_keys?: string[] };
  entities?: { mentions?: { username: string; start: number; end: number }[] };
  public_metrics?: { reply_count: number; retweet_count: number; like_count: number; quote_count: number; impression_count?: number };
};
export type XIncludes = { users?: XUser[]; tweets?: XTweet[]; media?: XMedia[] };
type XList = { data?: XTweet[]; includes?: XIncludes; meta?: { newest_id?: string; result_count: number; next_token?: string } };

const TWEET_FIELDS = "created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,attachments,entities,public_metrics";
const EXPANSIONS = "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys";
const MEDIA_FIELDS = "url,preview_image_url,type,width,height";
const USER_FIELDS = "username,name,profile_image_url,verified";

// ------------------------------------------------------------------ calls

export async function getMe(): Promise<XUser> {
  const r = await call<{ data: XUser }>("GET", "/2/users/me", { query: { "user.fields": USER_FIELDS } });
  return r.data;
}

/** Mentions of the bot, oldest first, with the tweets they reply to expanded. */
export async function getMentions(userId: string, sinceId?: string): Promise<{ tweets: XTweet[]; includes: XIncludes; newest?: string }> {
  const query: Record<string, string> = {
    max_results: "100",
    "tweet.fields": TWEET_FIELDS,
    expansions: EXPANSIONS,
    "media.fields": MEDIA_FIELDS,
    "user.fields": USER_FIELDS,
  };
  if (sinceId) query.since_id = sinceId;
  const r = await call<XList>("GET", `/2/users/${userId}/mentions`, { query });
  return { tweets: (r.data ?? []).reverse(), includes: r.includes ?? {}, newest: r.meta?.newest_id };
}

export type FullPost = { tweet: XTweet; author: XUser; media: XMedia[] };

/** One post with author and media. Cached in SQLite for 10 minutes to avoid paying for repeat reads. */
export async function getPost(id: string, maxAgeMs = 10 * 60_000): Promise<FullPost | null> {
  const cached = db.prepare("SELECT json, fetched_at FROM x_cache WHERE id = ?").get(`post:${id}`) as
    | { json: string; fetched_at: number }
    | undefined;
  if (cached && Date.now() - cached.fetched_at < maxAgeMs) return JSON.parse(cached.json);
  const r = await call<{ data?: XTweet; includes?: XIncludes }>("GET", `/2/tweets/${id}`, {
    query: { "tweet.fields": TWEET_FIELDS, expansions: "author_id,attachments.media_keys", "media.fields": MEDIA_FIELDS, "user.fields": USER_FIELDS },
    auth: config.xBearer ? "app" : "user",
  });
  if (!r.data) return null;
  const post = assemble(r.data, r.includes ?? {});
  if (post) {
    db.prepare("INSERT OR REPLACE INTO x_cache (id, json, fetched_at) VALUES (?, ?, ?)").run(`post:${id}`, JSON.stringify(post), Date.now());
  }
  return post;
}

export function assemble(tweet: XTweet, inc: XIncludes): FullPost | null {
  const author = inc.users?.find((u) => u.id === tweet.author_id);
  if (!author) return null;
  const media = (tweet.attachments?.media_keys ?? [])
    .map((k) => inc.media?.find((m) => m.media_key === k))
    .filter((m): m is XMedia => !!m);
  return { tweet, author, media };
}

export async function getUserByUsername(username: string): Promise<XUser | null> {
  const key = `user:${username.toLowerCase()}`;
  const cached = db.prepare("SELECT json, fetched_at FROM x_cache WHERE id = ?").get(key) as { json: string; fetched_at: number } | undefined;
  if (cached && Date.now() - cached.fetched_at < 24 * 3600_000) return JSON.parse(cached.json);
  try {
    const r = await call<{ data?: XUser }>("GET", `/2/users/by/username/${encodeURIComponent(username)}`, {
      query: { "user.fields": USER_FIELDS },
      auth: config.xBearer ? "app" : "user",
    });
    if (!r.data) return null;
    db.prepare("INSERT OR REPLACE INTO x_cache (id, json, fetched_at) VALUES (?, ?, ?)").run(key, JSON.stringify(r.data), Date.now());
    return r.data;
  } catch (e) {
    if (e instanceof XApiError && e.status === 404) return null;
    throw e;
  }
}

/** Recent original posts from a user, newest first. Used by agents watching a source list. */
export async function getUserPosts(userId: string, sinceId?: string): Promise<FullPost[]> {
  const query: Record<string, string> = {
    max_results: "10",
    exclude: "replies,retweets",
    "tweet.fields": TWEET_FIELDS,
    expansions: "author_id,attachments.media_keys",
    "media.fields": MEDIA_FIELDS,
    "user.fields": USER_FIELDS,
  };
  if (sinceId) query.since_id = sinceId;
  const r = await call<XList>("GET", `/2/users/${userId}/tweets`, { query, auth: config.xBearer ? "app" : "user" });
  return (r.data ?? []).map((t) => assemble(t, r.includes ?? {})).filter((p): p is FullPost => !!p);
}

/** Recent search (last 7 days). Used by "Anything" agents with a free-form prompt. */
export async function searchRecent(q: string, sinceId?: string): Promise<FullPost[]> {
  const query: Record<string, string> = {
    query: q,
    max_results: "25",
    sort_order: "relevancy",
    "tweet.fields": TWEET_FIELDS,
    expansions: "author_id,attachments.media_keys",
    "media.fields": MEDIA_FIELDS,
    "user.fields": USER_FIELDS,
  };
  if (sinceId) query.since_id = sinceId;
  const r = await call<XList>("GET", "/2/tweets/search/recent", { query, auth: config.xBearer ? "app" : "user" });
  return (r.data ?? []).map((t) => assemble(t, r.includes ?? {})).filter((p): p is FullPost => !!p);
}

/** Reply as the bot. Replies are only allowed when the bot was summoned (mentioned) in that conversation. */
export async function reply(toTweetId: string, text: string): Promise<string> {
  const r = await call<{ data: { id: string } }>("POST", "/2/tweets", {
    body: { text, reply: { in_reply_to_tweet_id: toTweetId } },
  });
  return r.data.id;
}

/** Plain post as the bot (agent launch announcements). */
export async function post(text: string): Promise<string> {
  const r = await call<{ data: { id: string } }>("POST", "/2/tweets", { body: { text } });
  return r.data.id;
}

export function bestImageUrl(m: XMedia): string | undefined {
  const u = m.type === "photo" ? m.url : m.preview_image_url;
  if (!u) return undefined;
  // pbs.twimg.com supports ?name=orig for full resolution
  return u.includes("pbs.twimg.com") && !u.includes("name=") ? `${u}${u.includes("?") ? "&" : "?"}name=orig` : u;
}

export function xConfigured() {
  return !!(config.xConsumerKey && config.xConsumerSecret && config.xAccessToken && config.xAccessSecret);
}
