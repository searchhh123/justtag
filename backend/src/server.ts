import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { launchpadAbi } from "./abi.js";
import { PRESETS, parentRecipients, searchQueryFor, validateRoutes } from "./agents.js";
import { coinCard, coinPageHtml } from "./cards.js";
import { curveOf, findTokenCreated, handleKey, launchIdFor, launchpadAddress, launchpadConfig, operator, operatorWallet, pendingOf, publicClient, signBind, walletOf } from "./chain.js";
import { config } from "./config.js";
import { db, isOptedOut, kvGet, type AgentRow, type CoinRow } from "./db.js";
import { serializePost, shortId, toSplitInputs, type Recipient } from "./launcher.js";
import { parseTag, postIdFromUrl, describeSplit } from "./parse.js";
import { cropCoinImage, pickCoin, saveImage } from "./picker.js";
import { getPost, getUserByUsername, xConfigured } from "./x/client.js";
import { authorizeUrl, deleteSession, finishLogin, getSession, newSession, saveSession } from "./x/oauth2.js";

export const app = new Hono();
const webRoot = path.resolve("web");
const secure = config.origin.startsWith("https://");

// ------------------------------------------------------------------ helpers

const limits = new Map<string, { n: number; reset: number }>();
function rateLimit(c: Context, bucket: string, max: number, windowMs: number) {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const k = `${bucket}:${ip}`;
  const now = Date.now();
  const e = limits.get(k);
  if (!e || e.reset < now) {
    limits.set(k, { n: 1, reset: now + windowMs });
    return true;
  }
  e.n++;
  return e.n <= max;
}

function coinView(c: CoinRow) {
  const split = JSON.parse(c.split_json) as Recipient[];
  return {
    id: c.id,
    token: c.token,
    pair: c.pair,
    symbol: c.symbol,
    name: c.name,
    description: c.description,
    image: `/i/${c.id}`,
    source: c.source,
    status: c.status,
    post: c.post_json ? JSON.parse(c.post_json) : null,
    split: split.map((s) => ({ handle: s.handle ?? null, route: s.route ?? null, wallet: s.wallet ?? null, bps: s.bps, role: s.role })),
    tagger: c.tagger,
    agent: c.agent_id,
    liveAt: c.live_at,
    tagToLiveMs: c.tag_to_live_ms,
    graduated: !!c.graduated,
    priceWei: c.price_wei,
    realEthWei: c.real_eth_wei,
    volumeWei: c.volume_wei,
    trades: c.trades,
    txHash: c.tx_hash,
  };
}

function session(c: Context) {
  const sid = getCookie(c, "jt_sid");
  return { sid, data: getSession(sid) };
}

// ------------------------------------------------------------------ public API

let feeCache: { at: number; fees: { protocolBps: number; creatorBps: number; creationFeeWei: string } | null } = { at: 0, fees: null };
async function fees() {
  if (!config.launchpad) return null;
  if (Date.now() - feeCache.at > 10 * 60_000) {
    try {
      const c = await launchpadConfig();
      feeCache = { at: Date.now(), fees: { protocolBps: c.protocolFeeBps, creatorBps: c.creatorFeeBps, creationFeeWei: c.creationFee.toString() } };
    } catch {
      /* keep the last value */
    }
  }
  return feeCache.fees;
}

app.get("/api/config", async (c) =>
  c.json({
    fees: await fees(),
    origin: config.origin,
    domain: config.domain,
    bot: config.botHandle,
    ca: config.tokenCA ?? null,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    explorer: config.explorer,
    launchpad: config.launchpad ?? null,
    router: config.dexRouter,
    weth: config.weth,
    presets: PRESETS,
    routes: ["holders", "owner", "buyback", "burn", "authors"],
    xLogin: !!config.xClientId,
    live: !!config.launchpad && xConfigured(),
  }),
);

app.get("/api/feed", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 24), 100);
  const rows = db.prepare("SELECT * FROM coins WHERE status = 'live' ORDER BY live_at DESC LIMIT ?").all(limit) as CoinRow[];
  const stats = db.prepare("SELECT COUNT(*) AS coins, AVG(tag_to_live_ms) AS avgMs FROM coins WHERE status = 'live' AND source='tag'").get() as { coins: number; avgMs: number | null };
  return c.json({ coins: rows.map(coinView), stats });
});

/** Posts for the hero wall: configured post ids plus the posts behind the latest coins. Real posts only. */
app.get("/api/wall", async (c) => {
  const posts: ReturnType<typeof serializePost>[] = [];
  if (xConfigured() || config.xBearer) {
    for (const id of config.wallPostIds.slice(0, 30)) {
      try {
        const p = await getPost(id, 6 * 3600_000);
        if (p) posts.push(serializePost(p));
      } catch {
        /* skip deleted or protected posts */
      }
    }
  }
  const recent = db.prepare("SELECT post_json, symbol, name FROM coins WHERE status='live' AND post_json IS NOT NULL ORDER BY live_at DESC LIMIT 30").all() as { post_json: string; symbol: string; name: string }[];
  for (const r of recent) posts.push({ ...JSON.parse(r.post_json), coin: { symbol: r.symbol, name: r.name } });
  const seen = new Set<string>();
  return c.json({ posts: posts.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))) });
});

/** "Paste a link. See what JustTag would launch from it." */
const previewCache = new Map<string, { at: number; body: unknown }>();
app.post("/api/preview", async (c) => {
  const { url, tag } = (await c.req.json().catch(() => ({}))) as { url?: string; tag?: string };
  const id = url ? postIdFromUrl(url) : null;
  if (!id) return c.json({ error: "Paste a link to a post on X" }, 400);
  const cached = previewCache.get(id);
  if (cached && Date.now() - cached.at < 30 * 60_000 && !tag) return c.json(cached.body);
  if (!rateLimit(c, "preview", 12, 3600_000)) return c.json({ error: "Too many previews, try again in a bit" }, 429);
  if (!xConfigured() && !config.xBearer) return c.json({ error: "X API keys are not configured on this server yet" }, 503);

  const post = await getPost(id);
  if (!post) return c.json({ error: "Couldn't load that post. Is it public?" }, 404);
  const parsed = parseTag(`@${config.botHandle} ${tag ?? ""}`, { bot: config.botHandle, tagger: "you", poster: post.author.username });
  const pick = await pickCoin(post, { name: parsed.name, ticker: parsed.ticker });
  const existing = db.prepare("SELECT token, symbol FROM coins WHERE status='live' AND json_extract(post_json,'$.id') = ?").get(id) as { token: string; symbol: string } | undefined;
  const body = {
    post: serializePost(post),
    name: pick.name,
    ticker: pick.ticker,
    description: pick.description,
    scores: pick.scores,
    chosen: pick.chosen,
    image: pick.imageBuffer ? `data:image/png;base64,${pick.imageBuffer.toString("base64")}` : null,
    safe: pick.safe,
    split: parsed.split,
    splitText: describeSplit(parsed.split),
    existing: existing ?? null,
    optedOut: isOptedOut(post.author.username),
    tagIntent: `https://x.com/intent/post?in_reply_to=${id}&text=${encodeURIComponent(`@${config.botHandle} ${tag ?? "50/50"}`)}`,
  };
  if (!tag) previewCache.set(id, { at: Date.now(), body });
  return c.json(body);
});

app.get("/api/coin/:token", async (c) => {
  const token = c.req.param("token").toLowerCase();
  const row = db.prepare("SELECT * FROM coins WHERE token = ? OR id = ?").get(token, token) as CoinRow | undefined;
  if (!row) return c.json({ error: "Not found" }, 404);
  let curve = null;
  if (row.token && config.launchpad) {
    try {
      const s = await curveOf(row.token as Address);
      const cfg = await launchpadConfig();
      curve = {
        virtualEth: s.virtualEth.toString(),
        virtualToken: s.virtualToken.toString(),
        realEth: s.realEth.toString(),
        realToken: s.realToken.toString(),
        graduated: s.graduated,
        progress: Number(((cfg.curveSupply - s.realToken) * 10_000n) / cfg.curveSupply) / 100,
        feeBps: cfg.protocolFeeBps + cfg.creatorFeeBps,
        priceWei: ((s.virtualEth * 10n ** 18n) / s.virtualToken).toString(),
        liquidityWei: null as string | null,
      };
      if (s.graduated && row.pair) {
        // After graduation the live price comes from the Uniswap V2 pool reserves.
        const [r0, r1] = (await publicClient.readContract({
          address: row.pair as Address,
          abi: [{ type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] }],
          functionName: "getReserves",
        })) as readonly [bigint, bigint, number];
        const wethIs0 = config.weth.toLowerCase() < row.token.toLowerCase();
        const [rEth, rTok] = wethIs0 ? [r0, r1] : [r1, r0];
        if (rTok > 0n) curve.priceWei = ((rEth * 10n ** 18n) / rTok).toString();
        curve.liquidityWei = rEth.toString();
      }
    } catch {
      /* RPC hiccup: serve DB data */
    }
  }
  const trades = row.token
    ? db.prepare("SELECT tx_hash, trader, is_buy, eth_wei, token_amount, price_wei, ts FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 100").all(row.token)
    : [];
  const holders = row.token ? (db.prepare("SELECT COUNT(*) AS n FROM holders WHERE token = ?").get(row.token) as { n: number }).n : 0;
  return c.json({ coin: coinView(row), curve, trades, holders });
});

// Token metadata (the URI stored on-chain) and coin images.
app.get("/m/:id", (c) => {
  const row = db.prepare("SELECT * FROM coins WHERE id = ?").get(c.req.param("id")) as CoinRow | undefined;
  if (!row) return c.json({ error: "Not found" }, 404);
  const post = row.post_json ? JSON.parse(row.post_json) : null;
  return c.json({
    name: row.name,
    symbol: row.symbol,
    description: row.description ?? "",
    image: `${config.origin}/i/${row.id}`,
    external_url: row.token ? `${config.origin}/coin/${row.token}` : config.origin,
    attributes: [
      { trait_type: "source", value: row.source },
      ...(post ? [{ trait_type: "post", value: post.url }] : []),
    ],
  });
});
app.get("/i/:id", (c) => {
  const row = db.prepare("SELECT image_path FROM coins WHERE id = ?").get(c.req.param("id")) as { image_path: string | null } | undefined;
  if (!row?.image_path || !fs.existsSync(row.image_path)) return c.notFound();
  c.header("cache-control", "public, max-age=86400, immutable");
  c.header("content-type", "image/png");
  return c.body(fs.readFileSync(row.image_path));
});

// Media proxy (X images block hotlinking from some browsers). Only X's own media hosts are allowed.
app.get("/api/media", async (c) => {
  const u = c.req.query("u");
  let url: URL;
  try {
    url = new URL(u ?? "");
  } catch {
    return c.text("bad url", 400);
  }
  if (url.protocol !== "https:" || !["pbs.twimg.com", "video.twimg.com", "abs.twimg.com"].includes(url.hostname)) return c.text("forbidden", 403);
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return c.text("upstream error", 502);
  c.header("content-type", r.headers.get("content-type") ?? "image/jpeg");
  c.header("cache-control", "public, max-age=86400");
  return c.body(Buffer.from(await r.arrayBuffer()));
});

app.get("/api/av/:handle", async (c) => {
  const handle = c.req.param("handle").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
  try {
    const u = (xConfigured() || config.xBearer) ? await getUserByUsername(handle) : null;
    if (u?.profile_image_url) return c.redirect(`/api/media?u=${encodeURIComponent(u.profile_image_url.replace("_normal", "_200x200"))}`);
  } catch {
    /* fall through */
  }
  const letter = (handle[0] ?? "?").toUpperCase();
  c.header("content-type", "image/svg+xml");
  c.header("cache-control", "public, max-age=3600");
  return c.body(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="#E6E8EB"/><text x="48" y="60" text-anchor="middle" font-family="Arial" font-weight="700" font-size="40" fill="#3D4248">${letter}</text></svg>`);
});

// ------------------------------------------------------------------ X sign-in + payouts

app.get("/auth/x/login", (c) => {
  const returnTo = c.req.query("returnTo") ?? "/claim";
  const s = { returnTo: returnTo.startsWith("/") ? returnTo : "/claim" };
  const url = authorizeUrl(s);
  const sid = newSession(s);
  setCookie(c, "jt_sid", sid, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: 7 * 24 * 3600 });
  return c.redirect(url);
});

app.get("/auth/x/callback", async (c) => {
  const { sid, data } = session(c);
  if (!sid || !data) return c.redirect("/claim?error=session");
  try {
    const s = await finishLogin(data, c.req.query("code") ?? "", c.req.query("state") ?? "");
    saveSession(sid, s);
    return c.redirect(s.returnTo ?? "/claim");
  } catch (e) {
    return c.redirect(`/claim?error=${encodeURIComponent((e as Error).message.slice(0, 120))}`);
  }
});

app.post("/auth/logout", (c) => {
  const { sid } = session(c);
  if (sid) deleteSession(sid);
  deleteCookie(c, "jt_sid", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const { data } = session(c);
  if (!data?.handle) return c.json({ signedIn: false });
  const key = handleKey(data.handle);
  let pending = "0";
  let wallet: string | null = null;
  if (config.launchpad) {
    try {
      pending = (await pendingOf(key)).toString();
      const w = await walletOf(key);
      wallet = w === "0x0000000000000000000000000000000000000000" ? null : w;
    } catch {
      /* rpc */
    }
  }
  const coins = db
    .prepare("SELECT * FROM coins WHERE status='live' AND EXISTS (SELECT 1 FROM json_each(coins.split_json) WHERE json_extract(value,'$.handle') = ?) ORDER BY live_at DESC LIMIT 50")
    .all(data.handle) as CoinRow[];
  return c.json({ signedIn: true, handle: data.handle, name: data.name, avatar: data.avatar, key, pending, wallet, coins: coins.map(coinView) });
});

/** Link a wallet to the signed-in X account. The operator submits the signed binding, so it costs the user no gas. */
app.post("/api/bind", async (c) => {
  const { data } = session(c);
  if (!data?.handle) return c.json({ error: "Sign in with X first" }, 401);
  const { wallet } = (await c.req.json().catch(() => ({}))) as { wallet?: string };
  if (!wallet || !isAddress(wallet)) return c.json({ error: "Enter a valid wallet address" }, 400);
  if (!rateLimit(c, "bind", 5, 3600_000)) return c.json({ error: "Too many attempts" }, 429);
  const sig = await signBind(data.handle, wallet as Address);
  let txHash: Hex | null = null;
  if (operatorWallet && operator) {
    txHash = await operatorWallet.writeContract({
      address: launchpadAddress(),
      abi: launchpadAbi,
      functionName: "bindWallet",
      args: [sig.key, wallet as Address, BigInt(sig.deadline), sig.signature],
      account: operator,
      chain: operatorWallet.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    // pay out whatever was waiting
    const pending = await pendingOf(sig.key);
    if (pending > 0n) {
      const h = await operatorWallet.writeContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "claim", args: [sig.key], account: operator, chain: operatorWallet.chain });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
  }
  db.prepare("UPDATE accounts SET wallet = ?, bound_tx = ?, updated_at = ? WHERE handle = ?").run(wallet.toLowerCase(), txHash, Date.now(), data.handle);
  // When no operator key is configured the user submits it from their own wallet.
  return c.json({ ok: true, txHash, signature: txHash ? undefined : sig });
});

// ------------------------------------------------------------------ launch an agent coin from the website

app.get("/api/pad/presets", (c) => c.json({ presets: PRESETS }));

app.post("/api/pad/prepare", async (c) => {
  if (!config.launchpad) return c.json({ error: "Launchpad not deployed yet" }, 503);
  if (!rateLimit(c, "pad", 10, 3600_000)) return c.json({ error: "Too many attempts" }, 429);
  const { data: sess } = session(c);
  const b = (await c.req.json().catch(() => ({}))) as {
    name?: string; ticker?: string; image?: string; preset?: string; prompt?: string;
    routes?: Record<string, number>; wallet?: string; devBuyWei?: string;
  };
  const name = (b.name ?? "").trim().slice(0, 32);
  const ticker = (b.ticker ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  if (!name || !ticker) return c.json({ error: "Name and ticker are required" }, 400);
  if (!b.wallet || !isAddress(b.wallet)) return c.json({ error: "Connect your wallet" }, 400);
  const preset = PRESETS.find((p) => p.id === b.preset) ?? PRESETS[0];
  const prompt = preset.id === "custom" ? (b.prompt ?? "").trim().slice(0, 600) : preset.prompt;
  if (!prompt) return c.json({ error: "Write a prompt for your agent" }, 400);
  let routes;
  try {
    routes = validateRoutes(b.routes ?? {});
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  let image: Buffer | null = null;
  if (b.image?.startsWith("data:image/")) {
    const raw = Buffer.from(b.image.split(",")[1] ?? "", "base64");
    if (raw.length > 8_000_000) return c.json({ error: "Image too large (8 MB max)" }, 400);
    image = await cropCoinImage(raw);
  }
  if (!image) return c.json({ error: "Add an image" }, 400);

  const coinId = shortId();
  const agentId = shortId();
  const launchId = launchIdFor(`pad:${agentId}`);
  const recipients = parentRecipients(routes, { handle: sess?.handle ?? null, wallet: b.wallet as Address });
  const imagePath = saveImage(coinId, image);
  db.prepare(
    `INSERT INTO coins (id, launch_id, status, source, name, symbol, description, image_path, split_json, agent_id, created_at)
     VALUES (?, ?, 'pending', 'pad', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(coinId, launchId, name, ticker, `${name} ($${ticker}) - an agent coin on JustTag. ${prompt}`.slice(0, 280), imagePath, JSON.stringify(recipients), agentId, Date.now());
  db.prepare(
    `INSERT INTO agents (id, coin_id, owner_wallet, owner_handle, preset, prompt, sources_json, routes_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(agentId, coinId, b.wallet.toLowerCase(), sess?.handle ?? null, preset.id, prompt, JSON.stringify(preset.sources), JSON.stringify(routes), Date.now());

  const cfg = await launchpadConfig();
  const devBuy = BigInt(b.devBuyWei && /^\d+$/.test(b.devBuyWei) ? b.devBuyWei : "0");
  const data = encodeFunctionData({
    abi: launchpadAbi,
    functionName: "createToken",
    args: [name, ticker, `${config.origin}/m/${coinId}`, launchId, toSplitInputs(recipients), 0n],
  });
  return c.json({ agentId, coinId, to: launchpadAddress(), data, value: (cfg.creationFee + devBuy).toString(), chainId: config.chainId });
});

app.post("/api/pad/submit", async (c) => {
  const { agentId, txHash } = (await c.req.json().catch(() => ({}))) as { agentId?: string; txHash?: Hex };
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId ?? "") as AgentRow | undefined;
  if (!agent || !txHash) return c.json({ error: "Unknown launch" }, 404);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") return c.json({ error: "Transaction reverted" }, 400);
  const created = findTokenCreated(receipt.logs);
  const coin = db.prepare("SELECT * FROM coins WHERE id = ?").get(agent.coin_id) as CoinRow;
  if (!created || created.launchId !== coin.launch_id) return c.json({ error: "That transaction did not launch this coin" }, 400);
  const token = created.token.toLowerCase();
  const query = agent.preset === "custom" ? await searchQueryFor(agent.prompt).catch(() => null) : null;
  db.prepare("UPDATE coins SET status='live', token=?, pair=?, tx_hash=?, live_at=? WHERE id=?").run(token, created.pair.toLowerCase(), txHash, Date.now(), coin.id);
  db.prepare("UPDATE agents SET status='active', token=?, search_query=? WHERE id=?").run(token, query, agent.id);
  return c.json({ ok: true, token });
});

app.get("/api/pad/status/:id", (c) => {
  const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(c.req.param("id")) as AgentRow | undefined;
  if (!a) return c.json({ error: "Not found" }, 404);
  const launched = db.prepare("SELECT * FROM coins WHERE agent_id = ? AND source = 'agent' AND status='live' ORDER BY live_at DESC LIMIT 20").all(a.id) as CoinRow[];
  return c.json({ id: a.id, status: a.status, token: a.token, preset: a.preset, prompt: a.prompt, routes: JSON.parse(a.routes_json), launched: launched.map(coinView) });
});

app.get("/api/agents", (c) => {
  const rows = db.prepare("SELECT a.*, c.symbol, c.name FROM agents a JOIN coins c ON c.id = a.coin_id WHERE a.status='active' ORDER BY a.created_at DESC LIMIT 30").all() as (AgentRow & { symbol: string; name: string })[];
  return c.json({ agents: rows.map((a) => ({ id: a.id, token: a.token, symbol: a.symbol, name: a.name, image: `/i/${a.coin_id}`, preset: a.preset, prompt: a.prompt, routes: JSON.parse(a.routes_json) })) });
});

// ------------------------------------------------------------------ website

app.get("/health", (c) => c.json({ ok: true }));

/** Operational status for monitoring (uptime checks, alerts on low operator gas or indexer lag). */
app.get("/api/status", async (c) => {
  const counts = db.prepare(
    "SELECT SUM(status='live') AS live, SUM(status='failed') AS failed, SUM(status='pending') AS pending, SUM(graduated) AS graduated FROM coins",
  ).get() as Record<string, number | null>;
  const agents = (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status='active'").get() as { n: number }).n;
  const out: Record<string, unknown> = {
    chainId: config.chainId,
    launchpad: config.launchpad ?? null,
    coins: { live: counts.live ?? 0, failed: counts.failed ?? 0, pending: counts.pending ?? 0, graduated: counts.graduated ?? 0 },
    activeAgents: agents,
    mentionCursor: kvGet("mentions_since_id") ?? null,
    workers: { bot: config.runBot && xConfigured() && !!operator, agents: config.runAgents && !!operator, payouts: config.runPayouts && !!operator, indexer: config.runIndexer && !!config.launchpad },
    ai: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  };
  try {
    const head = await publicClient.getBlockNumber();
    const indexed = BigInt(kvGet("indexer_block") ?? config.launchpadDeployBlock.toString());
    out.chain = { head: head.toString(), indexedTo: indexed.toString(), lagBlocks: (head - indexed).toString() };
    if (operator) {
      const bal = await publicClient.getBalance({ address: operator.address });
      out.operator = { address: operator.address, balanceWei: bal.toString(), lowGas: bal < 5n * 10n ** 15n };
    }
  } catch (e) {
    out.chain = { error: (e as Error).message.slice(0, 200) };
  }
  return c.json(out);
});
const page = (file: string) => (c: Context) => c.html(fs.readFileSync(path.join(webRoot, file), "utf8"));
app.get("/coin/:token", (c) => {
  const html = fs.readFileSync(path.join(webRoot, "coin.html"), "utf8");
  const t = c.req.param("token").toLowerCase();
  const row = db.prepare("SELECT * FROM coins WHERE token = ? OR id = ?").get(t, t) as CoinRow | undefined;
  return c.html(row ? coinPageHtml(html, row) : html);
});
app.get("/og/:file", async (c) => {
  const id = c.req.param("file").replace(/\.png$/, "");
  const row = db.prepare("SELECT * FROM coins WHERE id = ?").get(id) as CoinRow | undefined;
  if (!row) return c.redirect("/img/og.png");
  c.header("content-type", "image/png");
  c.header("cache-control", "public, max-age=86400");
  return c.body(new Uint8Array(await coinCard(row)));
});
app.get("/claim", page("claim.html"));
app.get("/agent/:id", page("agent.html"));
app.use("/dist/*", async (c, next) => { await next(); c.header("cache-control", "no-cache"); });
app.use("/css/*", async (c, next) => { await next(); c.header("cache-control", "no-cache"); });
app.use("/*", serveStatic({ root: path.relative(process.cwd(), webRoot) || "." }));
app.get("/", page("index.html"));
