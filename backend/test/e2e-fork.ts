/**
 * Full-stack end-to-end test on a local fork of Robinhood Chain mainnet (real WETH + Uniswap V2).
 *
 *   npm run e2e:fork          (needs Foundry's anvil on PATH and `forge build` done in ../contracts)
 *
 * It starts anvil, deploys fresh contracts with freshly generated keys (anvil's default keys are swept on
 * Robinhood mainnet by EIP-7702 delegations, so they are never used), starts a mock X API, and drives the real
 * bot, agents, payouts, indexer and HTTP API. Everything here is local test data.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, http, parseEther,
  type Abi, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { newId, startMockX } from "./mock-x.js";

const FORK = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const V2_FACTORY = "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DEAD = "0x000000000000000000000000000000000000dEaD";

let passed = 0;
const step = async (name: string, fn: () => Promise<void>) => {
  process.stdout.write(`• ${name} ... `);
  await fn();
  passed++;
  console.log("ok");
};

// ------------------------------------------------------------------ chain

async function startAnvil(): Promise<ChildProcess> {
  const anvil = spawn("anvil", ["--fork-url", FORK, "--port", String(PORT), "--silent"], { stdio: "ignore", shell: process.platform === "win32" });
  const pc = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 60; i++) {
    try {
      await pc.getChainId();
      return anvil;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("anvil did not start");
}

const artifact = (file: string, name: string) => {
  const j = JSON.parse(fs.readFileSync(new URL(`../../contracts/out/${file}/${name}.json`, import.meta.url), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

const anvil = await startAnvil();
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ mode: "anvil", chain, transport: http(RPC) });

const keys = { owner: generatePrivateKey(), operator: generatePrivateKey(), attester: generatePrivateKey(), trader: generatePrivateKey(), treasury: generatePrivateKey() };
const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
for (const a of Object.values(acct)) await testClient.setBalance({ address: a.address, value: parseEther("1000") });

const ownerWallet = createWalletClient({ account: acct.owner, chain, transport: http(RPC) });
const pad = artifact("JustTagLaunchpad.sol", "JustTagLaunchpad");
const air = artifact("JustTagAirdrop.sol", "JustTagAirdrop");
const deployBlock = await pub.getBlockNumber();
const padHash = await ownerWallet.deployContract({
  abi: pad.abi, bytecode: pad.bytecode,
  args: [acct.owner.address, V2_FACTORY, WETH, 30, acct.attester.address, acct.operator.address, acct.treasury.address, {
    initVirtualEth: parseEther("1.26"), initVirtualToken: parseEther("1073000000"), curveSupply: parseEther("793100000"),
    creationFee: parseEther("0.001"), migrationFee: parseEther("0.05"), protocolFeeBps: 65, creatorFeeBps: 60,
  }],
});
const launchpad = (await pub.waitForTransactionReceipt({ hash: padHash })).contractAddress!;
const airHash = await ownerWallet.deployContract({ abi: air.abi, bytecode: air.bytecode });
const airdrop = (await pub.waitForTransactionReceipt({ hash: airHash })).contractAddress!;

// ------------------------------------------------------------------ mock X + backend config

const mock = await startMockX(8791);
const bot = mock.addUser({ id: "999", name: "JustTag", username: "JustTag" });
const poster = mock.addUser({ id: "101", name: "Poster One", username: "poster_one", verified: true });
const tagger = mock.addUser({ id: "102", name: "Tagger One", username: "tagger_one" });
const other = mock.addUser({ id: "103", name: "Other One", username: "other_one" });
mock.addUser({ id: "104", name: "Friend One", username: "friend_one" });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "justtag-e2e-"));
Object.assign(process.env, {
  PUBLIC_ORIGIN: "http://localhost:8787", PUBLIC_DOMAIN: "localhost:8787",
  DB_PATH: path.join(dataDir, "e2e.db"), DATA_DIR: dataDir,
  RPC_URL: RPC, CHAIN_ID: "4663", LAUNCHPAD_ADDRESS: launchpad, AIRDROP_ADDRESS: airdrop,
  LAUNCHPAD_DEPLOY_BLOCK: deployBlock.toString(),
  OPERATOR_PRIVATE_KEY: keys.operator, ATTESTER_PRIVATE_KEY: keys.attester,
  X_API_BASE: mock.url, X_BOT_HANDLE: "JustTag", X_BOT_USER_ID: bot.id,
  X_CONSUMER_KEY: "test", X_CONSUMER_SECRET: "test", X_ACCESS_TOKEN: "test", X_ACCESS_SECRET: "test",
  PAYOUT_MIN_WEI: "1", MAX_TAGS_PER_USER_PER_DAY: "3", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "",
});

const { db } = await import("../src/db.js");
const { initBot, pollOnce } = await import("../src/bot.js");
const { handleKey, routeKey, Kind } = await import("../src/chain.js");
const { launchpadAbi, tokenAbi } = await import("../src/abi.js");
const { runAgent } = await import("../src/agents.js");
const { runAgentRoutes, pushCreatorFees } = await import("../src/payouts.js");
const { indexRange } = await import("../src/indexer.js");
const { app } = await import("../src/server.js");

const trader = createWalletClient({ account: acct.trader, chain, transport: http(RPC) });
const coinByTag = (id: string) => db.prepare("SELECT * FROM coins WHERE tag_tweet_id = ?").get(id) as Record<string, any> | undefined;
const splitsOf = async (token: Address) =>
  ((await pub.readContract({ address: launchpad, abi: launchpadAbi, functionName: "splitsOf", args: [token] })) as { key: Hex; bps: number }[]).map((s) => [s.key, s.bps]);
const buy = async (token: Address, eth: string) => {
  const h = await trader.writeContract({ address: launchpad, abi: launchpadAbi, functionName: "buy", args: [token, 0n, acct.trader.address, BigInt(Math.floor(Date.now() / 1000) + 600)], value: parseEther(eth) });
  await pub.waitForTransactionReceipt({ hash: h });
};
const tweet = (t: Partial<Parameters<typeof mock.addTweet>[0]> & { author_id: string; text: string }) =>
  mock.addTweet({ id: newId(), created_at: new Date().toISOString(), ...t } as Parameters<typeof mock.addTweet>[0]);

try {
  // ================================================================== tag bot
  const photoA = mock.addPhoto("3_1", "#93c5fd");
  const photoB = mock.addPhoto("3_2", "#f59e0b");
  const post = tweet({ author_id: poster.id, text: "A dog on a jet ski rescued a stranded swimmer", attachments: { media_keys: [photoA.media_key, photoB.media_key] }, public_metrics: { reply_count: 300, retweet_count: 4800, like_count: 113000, quote_count: 200, impression_count: 2_000_000 } });

  await step("bot initialises its cursor on an account with no mentions", async () => {
    await initBot();
    await pollOnce();
    assert.equal(db.prepare("SELECT v FROM kv WHERE k='mentions_initialised'").get()?.v, "1");
  });

  let token: Address;
  await step("a tag with '70/30 @friend' launches a coin with that split and replies under the tag", async () => {
    const tag = tweet({ author_id: tagger.id, text: "@poster_one @JustTag 70/30 @friend_one", referenced_tweets: [{ type: "replied_to", id: post.id }] });
    mock.mentions.push(tag.id);
    await pollOnce();
    const c = coinByTag(tag.id);
    assert.ok(c, "coin row");
    assert.equal(c.status, "live", c.error);
    token = c.token;
    assert.deepEqual(await splitsOf(token), [[handleKey("tagger_one"), 7000], [handleKey("friend_one"), 3000]]);
    const r = mock.replies.find((x) => x.inReplyTo === tag.id);
    assert.ok(r, "bot replied");
    assert.match(r.text, new RegExp(`\\$${c.symbol} is on JustTag`));
    assert.match(r.text, /70% @tagger_one, 30% @friend_one/);
    assert.match(r.text, new RegExp(`/coin/${token}`));
    assert.ok(fs.existsSync(c.image_path), "coin image saved");
  });

  await step("a second tag on the same post points at the existing coin", async () => {
    const tag = tweet({ author_id: other.id, text: "@poster_one @JustTag", referenced_tweets: [{ type: "replied_to", id: post.id }] });
    mock.mentions.push(tag.id);
    await pollOnce();
    assert.equal(coinByTag(tag.id), undefined);
    assert.match(mock.replies.at(-1)!.text, /already a coin/);
  });

  await step("tagging your own post with '$SELF Self Coin' gives you 100% with your ticker", async () => {
    const photo = mock.addPhoto("3_3", "#22c55e");
    const tag = tweet({ author_id: other.id, text: "@JustTag $SELF Self Coin", attachments: { media_keys: [photo.media_key] } });
    mock.mentions.push(tag.id);
    await pollOnce();
    const c = coinByTag(tag.id)!;
    assert.equal(c.symbol, "SELF");
    assert.equal(c.name, "Self Coin");
    assert.deepEqual(await splitsOf(c.token), [[handleKey("other_one"), 10000]]);
  });

  await step("the default tag splits 50/50 with the poster", async () => {
    const p2 = tweet({ author_id: poster.id, text: "Second viral moment", attachments: { media_keys: [photoA.media_key] } });
    const tag = tweet({ author_id: tagger.id, text: "@poster_one @JustTag", referenced_tweets: [{ type: "replied_to", id: p2.id }] });
    mock.mentions.push(tag.id);
    await pollOnce();
    assert.deepEqual(await splitsOf(coinByTag(tag.id)!.token), [[handleKey("tagger_one"), 5000], [handleKey("poster_one"), 5000]]);
  });

  await step("the per-user daily limit stops a fourth tag", async () => {
    for (let i = 0; i < 2; i++) {
      const p = tweet({ author_id: poster.id, text: `Limit test ${i}` });
      const tag = tweet({ author_id: tagger.id, text: "@JustTag all mine", referenced_tweets: [{ type: "replied_to", id: p.id }] });
      mock.mentions.push(tag.id);
      await pollOnce();
      assert.equal(!!coinByTag(tag.id), i === 0, `tag ${i}`);
    }
  });

  await step("trades accrue fees to X handles; linking a wallet pays them out", async () => {
    await buy(token, "0.5");
    const key = handleKey("tagger_one");
    const owed = (await pub.readContract({ address: launchpad, abi: launchpadAbi, functionName: "pendingFees", args: [key] })) as bigint;
    assert.ok(owed > 0n);
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const { signBind, operatorWallet, operator } = await import("../src/chain.js");
    const sig = await signBind("tagger_one", payee);
    const h = await operatorWallet!.writeContract({ address: launchpad, abi: launchpadAbi, functionName: "bindWallet", args: [sig.key, payee, BigInt(sig.deadline), sig.signature], account: operator!, chain: operatorWallet!.chain });
    await pub.waitForTransactionReceipt({ hash: h });
    await pushCreatorFees();
    assert.equal(await pub.getBalance({ address: payee }), owed);
  });

  // ================================================================== opt-out + retries
  const quiet = mock.addUser({ id: "105", name: "Quiet One", username: "quiet_one" });
  const fan = mock.addUser({ id: "106", name: "Fan One", username: "fan_one" });

  await step("'@JustTag opt out' blocks tags on that account's posts and keeps it out of splits", async () => {
    const cmd = tweet({ author_id: quiet.id, text: "@JustTag opt out" });
    mock.mentions.push(cmd.id);
    await pollOnce();
    assert.match(mock.replies.at(-1)!.text, /won't launch coins from your posts/);

    const p = tweet({ author_id: quiet.id, text: "A post from someone who opted out" });
    const tag = tweet({ author_id: fan.id, text: "@quiet_one @JustTag", referenced_tweets: [{ type: "replied_to", id: p.id }] });
    mock.mentions.push(tag.id);
    await pollOnce();
    assert.equal(coinByTag(tag.id), undefined);
    assert.match(mock.replies.at(-1)!.text, /opted out of JustTag/);

    // naming the opted-out account as a friend: its share goes back to the tagger
    const p2 = tweet({ author_id: poster.id, text: "Friend split with an opted-out friend" });
    const tag2 = tweet({ author_id: fan.id, text: "@poster_one @JustTag 60/40 @quiet_one", referenced_tweets: [{ type: "replied_to", id: p2.id }] });
    mock.mentions.push(tag2.id);
    await pollOnce();
    assert.deepEqual(await splitsOf(coinByTag(tag2.id)!.token), [[handleKey("fan_one"), 10000]]);

    const back = tweet({ author_id: quiet.id, text: "@JustTag opt in" });
    mock.mentions.push(back.id);
    await pollOnce();
    assert.match(mock.replies.at(-1)!.text, /You're back in/);
  });

  await step("a launch that fails on-chain is retried and announced once it goes through", async () => {
    const { retryFailedLaunches } = await import("../src/bot.js");
    await testClient.setBalance({ address: acct.operator.address, value: 0n }); // operator can't pay gas
    const p = tweet({ author_id: poster.id, text: "Launch during an outage" });
    const tag = tweet({ author_id: fan.id, text: "@poster_one @JustTag", referenced_tweets: [{ type: "replied_to", id: p.id }] });
    mock.mentions.push(tag.id);
    await pollOnce();
    assert.equal(coinByTag(tag.id)!.status, "failed");
    const repliesBefore = mock.replies.length;
    await testClient.setBalance({ address: acct.operator.address, value: parseEther("1000") });
    await retryFailedLaunches();
    const c = coinByTag(tag.id)!;
    assert.equal(c.status, "live", c.error);
    assert.equal(mock.replies.length, repliesBefore + 1);
    assert.equal(mock.replies.at(-1)!.inReplyTo, tag.id);
  });

  // ================================================================== HTTP API
  await step("API: feed, coin, metadata and image", async () => {
    const feed = await (await app.request("/api/feed")).json();
    assert.ok(feed.coins.length >= 4);
    const coin = await (await app.request(`/api/coin/${token}`)).json();
    assert.ok(coin.curve.progress > 0);
    assert.equal(coin.coin.split[0].handle, "tagger_one");
    const meta = await (await app.request(`/m/${coin.coin.id}`)).json();
    assert.equal(meta.symbol, coin.coin.symbol);
    const img = await app.request(`/i/${coin.coin.id}`);
    assert.equal(img.headers.get("content-type"), "image/png");
  });

  await step("status endpoint reports workers, chain lag and operator gas; config exposes live fees", async () => {
    const st = await (await app.request("/api/status")).json();
    assert.equal(st.launchpad, launchpad);
    assert.ok(st.coins.live >= 4);
    assert.equal(st.operator.address, acct.operator.address);
    assert.equal(st.operator.lowGas, false);
    assert.ok(Number(st.chain.lagBlocks) >= 0);
    const cfg = await (await app.request("/api/config")).json();
    assert.deepEqual(cfg.fees, { protocolBps: 65, creatorBps: 60, creationFeeWei: parseEther("0.001").toString() });
    assert.equal(cfg.router, "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba");
  });

  await step("coin pages carry server-rendered share tags and a 1200x630 preview card", async () => {
    const row = db.prepare("SELECT id, symbol FROM coins WHERE token = ?").get(token.toLowerCase()) as any;
    const html = await (await app.request(`/coin/${token}`)).text();
    assert.match(html, new RegExp(`<title>\\$${row.symbol} · `));
    assert.match(html, new RegExp(`og:image" content="[^"]+/og/${row.id}\\.png"`));
    assert.match(html, /twitter:card" content="summary_large_image"/);
    const card = await app.request(`/og/${row.id}.png`);
    const buf = Buffer.from(await card.arrayBuffer());
    const { default: sharp } = await import("sharp");
    const meta = await sharp(buf).metadata();
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
    if (process.env.E2E_CARD_OUT) fs.writeFileSync(process.env.E2E_CARD_OUT, buf);
  });

  // ================================================================== agent coin from the website
  let agentId = "";
  let parent: Address;
  await step("website launch: prepare → wallet sends tx → submit activates the agent", async () => {
    const png = fs.readFileSync(coinByTag(mock.mentions[0])!.image_path);
    const res = await app.request("/api/pad/prepare", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Scout Test", ticker: "SCOUT", image: `data:image/png;base64,${png.toString("base64")}`, preset: "custom",
        prompt: "dogs doing heroic things", wallet: acct.trader.address, devBuyWei: parseEther("0.2").toString(),
        routes: { holders: 4000, owner: 3000, buyback: 2000, burn: 500, authors: 500 },
      }),
    });
    const prep = await res.json();
    assert.equal(res.status, 200, prep.error);
    const h = await trader.sendTransaction({ to: prep.to, data: prep.data, value: BigInt(prep.value) });
    const sub = await (await app.request("/api/pad/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: prep.agentId, txHash: h }) })).json();
    assert.ok(sub.ok, sub.error);
    agentId = prep.agentId;
    parent = sub.token;
    const ownerShare = (await splitsOf(parent)).find(([k]) => k === `0x000000000000000000000000${acct.trader.address.slice(2).toLowerCase()}`);
    assert.equal(ownerShare?.[1], 3500, "owner gets owner + authors share on the parent coin");
  });

  let child: Address;
  await step("the agent launches a child coin from a fresh viral post, routed back to the parent", async () => {
    const a = () => db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    await runAgent(a()); // first pass only sets the search cursor
    const photo = mock.addPhoto("3_9", "#f472b6");
    const viral = tweet({
      author_id: poster.id, text: "This dog just pulled a kid out of a pool",
      attachments: { media_keys: [photo.media_key] }, created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      public_metrics: { reply_count: 500, retweet_count: 6000, like_count: 90000, quote_count: 400, impression_count: 3_000_000 },
    });
    await runAgent(a());
    const c = db.prepare("SELECT * FROM coins WHERE agent_id = ? AND source = 'agent'").get(agentId) as any;
    assert.ok(c, "child coin launched");
    assert.equal(JSON.parse(c.post_json).id, viral.id);
    child = c.token;
    const s = await splitsOf(child);
    assert.deepEqual(s.map(([, b]) => b), [4000, 3000, 2000, 500, 500]);
    assert.equal(s[0][0], routeKey(Kind.Holders, parent));
    assert.equal(s[2][0], routeKey(Kind.Buyback, parent));
    assert.equal(s[4][0], handleKey("poster_one"));
  });

  await step("child trades fund buyback, burn and a holders airdrop of the parent coin", async () => {
    await buy(child, "3");
    const head = await pub.getBlockNumber();
    await indexRange(deployBlock, head);
    const supplyBefore = (await pub.readContract({ address: parent, abi: tokenAbi, functionName: "totalSupply" })) as bigint;
    const deadBefore = (await pub.readContract({ address: parent, abi: tokenAbi, functionName: "balanceOf", args: [DEAD] })) as bigint;
    const traderBefore = await pub.getBalance({ address: acct.trader.address });
    await runAgentRoutes();
    const supplyAfter = (await pub.readContract({ address: parent, abi: tokenAbi, functionName: "totalSupply" })) as bigint;
    const deadAfter = (await pub.readContract({ address: parent, abi: tokenAbi, functionName: "balanceOf", args: [DEAD] })) as bigint;
    assert.ok(deadAfter > deadBefore, "buyback sent parent coins to the dead address");
    assert.ok(supplyAfter < supplyBefore, "burn reduced parent supply");
    assert.ok((await pub.getBalance({ address: acct.trader.address })) > traderBefore, "holder (the trader) received the airdrop");
    const pendingHolders = (await pub.readContract({ address: launchpad, abi: launchpadAbi, functionName: "pendingFees", args: [routeKey(Kind.Holders, parent)] })) as bigint;
    assert.equal(pendingHolders, 0n);
  });

  // ================================================================== graduation → Uniswap
  await step("a sold-out curve graduates; the site's router path trades it and the indexer records the swap", async () => {
    await buy(token, "10"); // more than the curve can absorb: the rest is refunded
    const coinApi = await (await app.request(`/api/coin/${token}`)).json();
    assert.equal(coinApi.curve.graduated, true);
    await indexRange(deployBlock, await pub.getBlockNumber());
    const row = db.prepare("SELECT graduated, pair FROM coins WHERE token = ?").get(token.toLowerCase()) as any;
    assert.equal(row.graduated, 1);

    const ROUTER = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba";
    const routerAbi = [
      { type: "function", name: "getAmountsOut", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address[]" }], outputs: [{ type: "uint256[]" }] },
      { type: "function", name: "swapExactETHForTokens", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "address[]" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256[]" }] },
    ] as const;
    const amounts = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [parseEther("0.1"), [WETH, token]] });
    const before = (await pub.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [acct.trader.address] })) as bigint;
    const h = await trader.writeContract({ address: ROUTER, abi: routerAbi, functionName: "swapExactETHForTokens", args: [(amounts[1] * 97n) / 100n, [WETH, token], acct.trader.address, BigInt(Math.floor(Date.now() / 1000) + 600)], value: parseEther("0.1") });
    const rc = await pub.waitForTransactionReceipt({ hash: h });
    const after = (await pub.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [acct.trader.address] })) as bigint;
    assert.equal(after - before, amounts[1]);

    await indexRange(rc.blockNumber, rc.blockNumber);
    const swap = db.prepare("SELECT * FROM trades WHERE tx_hash = ?").get(h) as any;
    assert.ok(swap, "swap indexed");
    assert.equal(swap.is_buy, 1);
    assert.equal(swap.eth_wei, parseEther("0.1").toString());
    const live = await (await app.request(`/api/coin/${token}`)).json();
    assert.ok(BigInt(live.curve.liquidityWei) > parseEther("3"), "pool holds the graduated ETH");
    assert.ok(BigInt(live.curve.priceWei) > 0n);
  });

  console.log(`\nE2E OK: ${passed} scenarios passed against a Robinhood Chain mainnet fork.`);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  mock.close();
  anvil.kill();
  if (process.platform === "win32" && anvil.pid) spawn("taskkill", ["/pid", String(anvil.pid), "/f", "/t"], { stdio: "ignore" });
  setTimeout(() => process.exit(), 500);
}
