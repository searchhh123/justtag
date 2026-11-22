/**
 * A local stand-in for the X API v2 endpoints JustTag uses, so the bot and agents can be tested end to end
 * without real X credentials. Shapes follow docs.x.com (data / includes / meta). Test data only.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import sharp from "sharp";
import type { XIncludes, XMedia, XTweet, XUser } from "../src/x/client.js";

export type MockX = {
  url: string;
  users: Map<string, XUser>;
  tweets: Map<string, XTweet>;
  media: Map<string, XMedia>;
  mentions: string[]; // tweet ids that mention the bot, oldest first
  replies: { id: string; text: string; inReplyTo?: string }[];
  addUser(u: XUser): XUser;
  addTweet(t: XTweet): XTweet;
  addPhoto(key: string, color: string): XMedia;
  close(): void;
};

let nextId = 2_000_000_000_000_000_000n;
export const newId = () => (nextId++).toString();

export async function startMockX(port: number): Promise<MockX> {
  const url = `http://127.0.0.1:${port}`;
  const m: MockX = {
    url,
    users: new Map(),
    tweets: new Map(),
    media: new Map(),
    mentions: [],
    replies: [],
    addUser(u) { m.users.set(u.id, u); return u; },
    addTweet(t) { m.tweets.set(t.id, t); return t; },
    addPhoto(key, color) {
      const md: XMedia = { media_key: key, type: "photo", url: `${url}/media/${key}.png?c=${encodeURIComponent(color)}`, width: 900, height: 600 };
      m.media.set(key, md);
      return md;
    },
    close: () => server.close(),
  };

  const includesFor = (tweets: XTweet[], deep = false): XIncludes => {
    const users = new Set<string>();
    const media = new Set<string>();
    const refs: XTweet[] = [];
    for (const t of tweets) {
      users.add(t.author_id);
      t.attachments?.media_keys?.forEach((k) => media.add(k));
      if (deep) {
        for (const r of t.referenced_tweets ?? []) {
          const rt = m.tweets.get(r.id);
          if (!rt) continue;
          refs.push(rt);
          users.add(rt.author_id);
          rt.attachments?.media_keys?.forEach((k) => media.add(k));
        }
      }
    }
    return {
      users: [...users].map((id) => m.users.get(id)!).filter(Boolean),
      media: [...media].map((k) => m.media.get(k)!).filter(Boolean),
      ...(refs.length ? { tweets: refs } : {}),
    };
  };
  const after = (ids: string[], since?: string) => (since ? ids.filter((id) => BigInt(id) > BigInt(since)) : ids);

  const app = new Hono();
  app.get("/2/users/me", (c) => c.json({ data: [...m.users.values()].find((u) => u.username === "JustTag") }));
  app.get("/2/users/by/username/:u", (c) => {
    const u = [...m.users.values()].find((x) => x.username.toLowerCase() === c.req.param("u").toLowerCase());
    return u ? c.json({ data: u }) : c.json({ errors: [{ title: "Not Found Error" }] }, 404);
  });
  app.get("/2/users/:id/mentions", (c) => {
    const ids = after(m.mentions, c.req.query("since_id")).slice(-100);
    const tweets = ids.map((id) => m.tweets.get(id)!).reverse(); // newest first, like X
    return c.json({ data: tweets.length ? tweets : undefined, includes: includesFor(tweets, true), meta: { result_count: tweets.length, newest_id: tweets[0]?.id } });
  });
  app.get("/2/users/:id/tweets", (c) => {
    const own = [...m.tweets.values()].filter((t) => t.author_id === c.req.param("id") && !t.referenced_tweets?.length);
    const ids = after(own.map((t) => t.id), c.req.query("since_id"));
    const tweets = ids.map((id) => m.tweets.get(id)!).reverse();
    return c.json({ data: tweets.length ? tweets : undefined, includes: includesFor(tweets), meta: { result_count: tweets.length } });
  });
  app.get("/2/tweets/search/recent", (c) => {
    const tweets = after([...m.tweets.keys()], c.req.query("since_id")).map((id) => m.tweets.get(id)!).filter((t) => t.attachments?.media_keys?.length).reverse();
    return c.json({ data: tweets.length ? tweets : undefined, includes: includesFor(tweets), meta: { result_count: tweets.length } });
  });
  app.get("/2/tweets/:id", (c) => {
    const t = m.tweets.get(c.req.param("id"));
    return t ? c.json({ data: t, includes: includesFor([t]) }) : c.json({ errors: [{ title: "Not Found Error" }] }, 404);
  });
  app.post("/2/tweets", async (c) => {
    if (!c.req.header("authorization")?.startsWith("OAuth ")) return c.json({ title: "Unauthorized" }, 401);
    const body = (await c.req.json()) as { text: string; reply?: { in_reply_to_tweet_id: string } };
    const id = newId();
    m.replies.push({ id, text: body.text, inReplyTo: body.reply?.in_reply_to_tweet_id });
    return c.json({ data: { id, text: body.text } }, 201);
  });
  app.get("/media/:file", async (c) => {
    const color = c.req.query("c") ?? "#f59e0b";
    const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: color } })
      .composite([{ input: Buffer.from(`<svg width="900" height="600"><circle cx="560" cy="300" r="150" fill="#0A0A0B"/></svg>`) }])
      .png()
      .toBuffer();
    c.header("content-type", "image/png");
    return c.body(new Uint8Array(png));
  });

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  return m;
}
