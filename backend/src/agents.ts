import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Address } from "viem";
import { z } from "zod";
import { config } from "./config.js";
import { db, kvGet, kvSet, type AgentRow } from "./db.js";
import { launchFromPost, type Recipient } from "./launcher.js";
import { getUserByUsername, getUserPosts, post as xPost, searchRecent, type FullPost } from "./x/client.js";

const log = (...a: unknown[]) => console.log("[agents]", ...a);
const anthropic = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new Anthropic() : null;

/** Built-in presets. Sources are real X accounts that cover the topic. */
export const PRESETS = [
  {
    id: "gta6",
    name: "GTA 6",
    prompt:
      "Launch a coin the second a new GTA 6 moment takes off: Rockstar drops, trailers, leaks, map finds, easter eggs and viral gameplay clips.",
    sources: ["RockstarGames", "gtasix_", "Dexerto", "GTABase", "GTANet", "RockstarIntel", "kick", "IGN", "GameSpot"],
  },
  { id: "custom", name: "Anything", prompt: "", sources: [] as string[] },
] as const;

export type Routes = { holders: number; owner: number; buyback: number; burn: number; authors: number };
export const ROUTE_KEYS: (keyof Routes)[] = ["holders", "owner", "buyback", "burn", "authors"];

export function validateRoutes(r: Partial<Routes>): Routes {
  const routes = Object.fromEntries(ROUTE_KEYS.map((k) => [k, Math.max(0, Math.round(Number(r[k] ?? 0)))])) as Routes;
  const sum = ROUTE_KEYS.reduce((a, k) => a + routes[k], 0);
  if (sum !== 10_000) throw new Error("Routes must add up to 100%");
  return routes;
}

/** Splits for coins an agent launches: every route points back at the parent (agent) coin. */
export function childRecipients(a: AgentRow, parent: Address, postAuthor: string): Recipient[] {
  const r = JSON.parse(a.routes_json) as Routes;
  const out: Recipient[] = [];
  if (r.holders) out.push({ route: "holders", routeToken: parent, bps: r.holders, role: "holders" });
  if (r.owner) out.push(a.owner_handle ? { handle: a.owner_handle, bps: r.owner, role: "owner" } : { wallet: a.owner_wallet as Address, bps: r.owner, role: "owner" });
  if (r.buyback) out.push({ route: "buyback", routeToken: parent, bps: r.buyback, role: "buyback" });
  if (r.burn) out.push({ route: "burn", routeToken: parent, bps: r.burn, role: "burn" });
  if (r.authors) out.push({ handle: postAuthor.toLowerCase(), bps: r.authors, role: "author" });
  return out;
}

/** Splits for the agent coin itself (launched from the website). There is no post author, so that share goes to the owner. */
export function parentRecipients(routes: Routes, owner: { handle?: string | null; wallet: Address }): Recipient[] {
  const out: Recipient[] = [];
  const ownerBps = routes.owner + routes.authors;
  if (routes.holders) out.push({ route: "holders", routeToken: null, bps: routes.holders, role: "holders" });
  if (ownerBps) out.push(owner.handle ? { handle: owner.handle, bps: ownerBps, role: "owner" } : { wallet: owner.wallet, bps: ownerBps, role: "owner" });
  if (routes.buyback) out.push({ route: "buyback", routeToken: null, bps: routes.buyback, role: "buyback" });
  if (routes.burn) out.push({ route: "burn", routeToken: null, bps: routes.burn, role: "burn" });
  return out;
}

// ------------------------------------------------------------------ AI

const QuerySchema = z.object({ query: z.string().describe("an X recent-search query, max 400 chars, using OR and -is:retweet -is:reply lang:en has:media where useful") });

export async function searchQueryFor(prompt: string): Promise<string> {
  if (!anthropic) return `(${prompt.split(/\s+/).slice(0, 6).join(" OR ")}) -is:retweet -is:reply has:media`;
  const res = await anthropic.beta.messages.parse({
    model: config.anthropicModel,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(QuerySchema) },
    messages: [
      {
        role: "user",
        content: `Write one X API v2 recent-search query that finds fresh, viral posts matching this launch brief:\n"""${prompt}"""\nUse the standard operators (OR, quotes, -is:retweet, -is:reply, has:media, lang:). Keep it under 400 characters.`,
      },
    ],
  });
  return res.parsed_output?.query.slice(0, 450) ?? prompt.slice(0, 200);
}

const ChoiceSchema = z.object({
  launch: z.array(z.object({ post_id: z.string(), why: z.string() })).describe("posts worth a coin right now, best first, at most 2"),
});

async function choosePosts(a: AgentRow, posts: FullPost[]): Promise<FullPost[]> {
  if (!posts.length) return [];
  const now = Date.now();
  // Engagement velocity: likes + reposts per minute since posting.
  const scored = posts
    .map((p) => {
      const m = p.tweet.public_metrics;
      const ageMin = Math.max(1, (now - Date.parse(p.tweet.created_at ?? new Date().toISOString())) / 60_000);
      return { p, velocity: m ? (m.like_count + 3 * m.retweet_count + 2 * m.quote_count) / ageMin : 0, ageMin };
    })
    .filter((s) => s.ageMin < 6 * 60)
    .sort((x, y) => y.velocity - x.velocity)
    .slice(0, 12);
  if (!anthropic) return scored.filter((s) => s.velocity > 5).slice(0, 1).map((s) => s.p);

  const list = scored
    .map((s) => `id=${s.p.tweet.id} @${s.p.author.username} age=${Math.round(s.ageMin)}m velocity=${s.velocity.toFixed(1)}/min media=${s.p.media.length}\n${s.p.tweet.text.slice(0, 400)}`)
    .join("\n---\n");
  const res = await anthropic.beta.messages.parse({
    model: config.anthropicModel,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: config.anthropicEffort, format: betaZodOutputFormat(ChoiceSchema) },
    system:
      "You run a memecoin launch agent on JustTag. Pick only posts that are a genuine, fresh, shareable moment matching the brief and climbing fast. Skip ads, giveaways, routine announcements with no hook, and anything unsafe. Returning an empty list is normal.",
    messages: [{ role: "user", content: `Brief:\n"""${a.prompt}"""\n\nCandidates:\n${list}` }],
  });
  const ids = new Set((res.parsed_output?.launch ?? []).map((l) => l.post_id));
  return scored.filter((s) => ids.has(s.p.tweet.id)).map((s) => s.p).slice(0, 2);
}

// ------------------------------------------------------------------ loop

async function candidatesFor(a: AgentRow): Promise<FullPost[]> {
  const sources = JSON.parse(a.sources_json) as string[];
  const out: FullPost[] = [];
  if (sources.length) {
    for (const handle of sources) {
      const user = await getUserByUsername(handle);
      if (!user) continue;
      const cursorKey = `agent:${a.id}:src:${user.id}`;
      const since = kvGet(cursorKey);
      const posts = await getUserPosts(user.id, since);
      if (posts.length) kvSet(cursorKey, posts[0].tweet.id);
      if (since) out.push(...posts); // first pass only sets the cursor
    }
  } else if (a.search_query) {
    const cursorKey = `agent:${a.id}:search`;
    const since = kvGet(cursorKey);
    const posts = await searchRecent(a.search_query, since);
    const newest = posts.map((p) => BigInt(p.tweet.id)).sort((x, y) => (x > y ? -1 : 1))[0];
    if (newest) kvSet(cursorKey, newest.toString());
    if (since) out.push(...posts);
  }
  // never relaunch a post that already has a coin
  return out.filter((p) => !db.prepare("SELECT 1 FROM coins WHERE json_extract(post_json,'$.id') = ?").get(p.tweet.id));
}

export async function runAgent(a: AgentRow) {
  const today = new Date().toISOString().slice(0, 10);
  if (a.launches_day !== today) {
    db.prepare("UPDATE agents SET launches_today = 0, launches_day = ? WHERE id = ?").run(today, a.id);
    a.launches_today = 0;
  }
  if (a.launches_today >= config.agentMaxLaunchesPerDay || !a.token) return;

  const picks = await choosePosts(a, await candidatesFor(a));
  for (const p of picks) {
    if (a.launches_today >= config.agentMaxLaunchesPerDay) break;
    const { coin, skipped } = await launchFromPost({
      post: p,
      source: "agent",
      recipients: childRecipients(a, a.token as Address, p.author.username),
      tagger: null,
      tagTweetId: null,
      agentId: a.id,
      seed: `agent:${a.id}:${p.tweet.id}`,
    });
    if (skipped) continue;
    a.launches_today++;
    db.prepare("UPDATE agents SET launches_today = ? WHERE id = ?").run(a.launches_today, a.id);
    log(`agent ${a.id} launched $${coin.symbol} from @${p.author.username}`);
    if (process.env.AGENT_ANNOUNCE === "true") {
      const parent = db.prepare("SELECT symbol FROM coins WHERE id = ?").get(a.coin_id) as { symbol: string } | undefined;
      try {
        await xPost(`$${parent?.symbol ?? "AGENT"}'s agent just launched $${coin.symbol} from @${p.author.username}'s post.\n\n${config.origin}/coin/${coin.token}`);
      } catch (e) {
        log("announce failed", (e as Error).message);
      }
    }
  }
}

export async function startAgents() {
  const loop = async () => {
    const agents = db.prepare("SELECT * FROM agents WHERE status = 'active'").all() as AgentRow[];
    for (const a of agents) {
      try {
        await runAgent(a);
      } catch (e) {
        log(`agent ${a.id} error:`, (e as Error).message);
      }
    }
    setTimeout(loop, config.agentPollMs);
  };
  loop();
}
