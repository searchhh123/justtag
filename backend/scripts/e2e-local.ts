/**
 * End-to-end test against a local anvil fork of Robinhood Chain mainnet (real Uniswap V2 + WETH).
 *   1. anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8545
 *   2. deploy with contracts/script/Deploy.s.sol to http://127.0.0.1:8545
 *   3. fill backend/.env (see README "Local fork test"), then: npx tsx scripts/e2e-local.ts
 * The post below is a local test fixture only; it never leaves this machine.
 */
import assert from "node:assert/strict";
import { createWalletClient, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { launchpadAbi } from "../src/abi.js";
import { chain, handleKey, launchpadAddress, operator, operatorWallet, pendingOf, publicClient, signBind } from "../src/chain.js";
import { config } from "../src/config.js";
import { launchFromPost, tagRecipients } from "../src/launcher.js";
import { parseTag } from "../src/parse.js";
import { pushCreatorFees } from "../src/payouts.js";
import type { FullPost } from "../src/x/client.js";

const TRADER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil #2
const PAYEE = privateKeyToAccount(generatePrivateKey()).address; // fresh wallet with no code

const fixture: FullPost = {
  tweet: { id: String(Date.now()), text: "Local fork test fixture: a dog on a jet ski", author_id: "1", created_at: new Date().toISOString() },
  author: { id: "1", name: "Fixture Poster", username: "fixture_poster" },
  media: [],
};

const tagger = "fixture_tagger";
const parsed = parseTag(`@${config.botHandle} 70/30`, { bot: config.botHandle, tagger, poster: fixture.author.username });
console.log("split", parsed.split);

const t0 = Date.now();
const { coin } = await launchFromPost({
  post: fixture,
  source: "tag",
  recipients: tagRecipients(parsed.split),
  tagger,
  tagTweetId: `fixture-${fixture.tweet.id}`,
  seed: `fixture:${fixture.tweet.id}`,
});
console.log(`launched $${coin.symbol} at ${coin.token} in ${Date.now() - t0}ms`);
assert.equal(coin.status, "live");

// idempotency: same seed returns the same coin
const again = await launchFromPost({ post: fixture, source: "tag", recipients: tagRecipients(parsed.split), tagger, tagTweetId: `fixture-${fixture.tweet.id}`, seed: `fixture:${fixture.tweet.id}` });
assert.equal(again.coin.token, coin.token);

// a trader buys on the curve
const trader = createWalletClient({ account: privateKeyToAccount(TRADER_PK), chain, transport: http(config.rpcUrl) });
const [quoted] = (await publicClient.readContract({ address: launchpadAddress(), abi: launchpadAbi, functionName: "quoteBuy", args: [coin.token as Address, parseEther("0.5")] })) as [bigint, bigint];
const buy = await trader.writeContract({
  address: launchpadAddress(), abi: launchpadAbi, functionName: "buy",
  args: [coin.token as Address, (quoted * 97n) / 100n, trader.account.address, BigInt(Math.floor(Date.now() / 1000) + 600)],
  value: parseEther("0.5"),
});
await publicClient.waitForTransactionReceipt({ hash: buy });
console.log("bought", quoted / 10n ** 18n, "tokens");

// fees are escrowed under the poster's X handle
const posterKey = handleKey(fixture.author.username);
const owed = await pendingOf(posterKey);
console.log("owed to @fixture_poster:", owed, "wei");
assert.ok(owed > 0n);

// the poster signs in with X (simulated here) and links a wallet: attester signs, operator submits (gasless)
const sig = await signBind(fixture.author.username, PAYEE);
const bindTx = await operatorWallet!.writeContract({
  address: launchpadAddress(), abi: launchpadAbi, functionName: "bindWallet",
  args: [sig.key, PAYEE, BigInt(sig.deadline), sig.signature], account: operator!, chain: operatorWallet!.chain,
});
await publicClient.waitForTransactionReceipt({ hash: bindTx });

const before = await publicClient.getBalance({ address: PAYEE, blockTag: "latest" });
console.log("pending before push:", await pendingOf(posterKey));
await pushCreatorFees();
const after = await publicClient.getBalance({ address: PAYEE, blockTag: "latest" });
console.log("paid out:", after - before, "wei");
assert.equal(after - before, owed);
assert.equal(await pendingOf(posterKey), 0n);

console.log("\nE2E OK. Open", `${config.origin}/coin/${coin.token}`);
process.exit(0);
