# JustTag · Tag it. It's a coin.

Reply **@JustTag** under any post on X and it becomes a coin on **Robinhood Chain** in seconds. Creator fees from every trade go to the X accounts in the tag. Ticker of the project token: **$JUSTTAG**.

This repo is the full product: smart contracts, the X bot, the AI coin picker, launch agents, fee payouts, an indexer, and the website.

```
contracts/   Solidity (Foundry): launchpad + bonding curve, token, airdrop. Tests fork Robinhood mainnet.
backend/     Node 22 + TypeScript: X bot, AI picker, agents, payouts, indexer, API, serves the website
backend/web/ Website (HTML/CSS + vanilla JS bundled with esbuild): landing, coin pages, trading, get paid, agents
backend/test/ Full-stack e2e suite on a Robinhood mainnet fork, with a mock X API
deploy/      docker-compose + Caddy (automatic HTTPS)
brand/       X profile picture, X header, logo
docs/        Launch kit: profile copy, pinned post, launch thread, saved replies
```

---

## How the features work

| Feature | How JustTag does it |
|---|---|
| **Tag a post → coin** | The bot polls its mentions on the X API (`GET /2/users/:id/mentions`). For each tag it loads the post being replied to (or quoted), launches the coin on-chain, and replies under the tag with the link. One coin per post. There's a daily limit per user. The on-chain `launchId` keeps retries from double-launching. |
| **Split in the tag** | `@JustTag` with nothing after it means 50/50 with the poster. You can also write `70/30`, `all mine`, `all to the poster`, `50/50 @friend`, `40/30/30 @a @b`, or `$TICKER Name` to set the ticker and name. See `backend/src/parse.ts` (12 unit tests). |
| **AI picks image, name, ticker** | Claude vision scores every image in the post, picks the strongest, and writes the name, ticker and a safety flag. `sharp` crops the image square around the action ("attention" crop). An image attached to the tag overrides the pick. A post with no image gets a generated one. See `backend/src/picker.ts`. |
| **Bonding curve** | The pump.fun model, priced in ETH. Supply is 1B tokens, 793.1M of them sell on the curve, and the curve starts with 1.073B virtual tokens. The curve starts at **1.26 virtual ETH**, which is pump.fun's 30 virtual SOL at ETH $1,682 / SOL $70.62 (CoinGecko, 2026-11-21). A coin graduates after raising about 3.57 ETH. |
| **Graduation** | When the curve sells out, the launchpad seeds the official **Uniswap V2** pair on Robinhood Chain at the curve's last price and burns the LP tokens. Nobody can seed the pair before graduation: the token blocks transfers into it. |
| **Creator fees → X accounts** | Fees accrue on-chain under `keccak256("x:" + handle)`. The X account signs in with X on `/claim` and links a wallet. JustTag's attester signs that link (EIP-712) and the operator submits it, so the user pays no gas. Everything that was waiting is paid at once, and every later fee is pushed automatically by the payouts worker (`claimMany`). |
| **Try it on any post** | `POST /api/preview` runs the real picker on any public post link and returns the coin JustTag would launch, plus a ready "Tag it for real" link. |
| **Give your coin an agent** | From the website, a user launches a coin plus an agent with one transaction from their own wallet. The agent watches its sources (the GTA 6 preset), or an X search written by Claude from the user's prompt ("Anything"). It ranks posts by engagement velocity, asks Claude which ones are real moments, and launches child coins. Child coins pay their fees back into the parent coin's routes: **Holders** (ETH airdropped pro-rata), **Owner** (their X account), **Buyback** (buys the coin and sends it to the dead address), **Burn** (buys and burns), and **Post authors**. |
| **Opt out** | Anyone can reply `@JustTag opt out`. After that, JustTag won't launch coins from their posts, they can't tag, and they're left out of splits (a friend's share goes back to the tagger). Agents skip their posts. `@JustTag opt in` undoes it. |
| **Retries** | A launch that fails on-chain (RPC outage, gas) is retried up to 3 times within 6 hours with the same `launchId`, so it can never launch twice. The reply goes out once it's live. |
| **Share cards** | Coin pages render their own title and Open Graph / Twitter tags on the server, because X's crawler doesn't run JavaScript. Each coin also gets a generated 1200x630 card (image, name, ticker, split). |
| **After graduation** | The coin page keeps working: quotes and trades go through the Uniswap V2 router on Robinhood Chain, the price comes from the pool, and the indexer records pool swaps. |
| **Monitoring** | `GET /api/status`: which workers are running, coin counts, indexer lag, operator address and a `lowGas` flag. Point an uptime monitor at it. |
| **Live feed, coin pages, trading** | The indexer follows launchpad events and token transfers. Coin pages show price, market cap, curve progress, holders, chart and trades, and let people buy or sell from MetaMask, Rabby or Robinhood Wallet. |

### One honest difference from tagy.fun: X Money

Tagy says its fees are "paid out on X Money". **X has no public X Money payout API.** I checked docs.x.com and the developer forum. The only related item is an open feature request, and X Money itself launched in July 2026 for US Premium users. So JustTag pays to X accounts the way that can actually work today: fees are held on-chain under the handle, the account owner proves it with X sign-in, links a wallet once, and is paid automatically from then on. If X ever ships a payout API, only `payouts.ts` needs to change.

---

## Network facts used (verified 2026-11-21)

| | Value | Source |
|---|---|---|
| Robinhood Chain mainnet | chain id **4663** (`0x1237`), Arbitrum Nitro, ETH gas, live | https://docs.robinhood.com/chain/connecting, plus `eth_chainId` and `web3_clientVersion` (`nitro/v3.13.0-rc.9`) |
| RPC | https://rpc.mainnet.chain.robinhood.com (public, rate-limited) | same |
| Explorer | https://robinhoodchain.blockscout.com (Blockscout) | same |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | https://docs.robinhood.com/chain/contracts |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` | Uniswap v2 deployments page; verified on-chain (`allPairsLength` 151,406) |
| Uniswap V2 Router02 | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` | same |
| Bridge | https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum | https://docs.robinhood.com/chain/bridging |
| Testnet | chain id 46630, https://rpc.testnet.chain.robinhood.com. **No WETH or Uniswap there**, so test on a mainnet fork instead (below) | docs + on-chain check |
| X API | Pay-per-use. Owned reads (your own mentions) $0.001, post read $0.005, user read $0.010, "summoned" reply $0.010, post with a URL $0.200 | https://docs.x.com/x-api/getting-started/pricing |
| pump.fun curve | 30 virtual SOL / 1.073B virtual tokens, 793.1M real, 1B supply, graduates when real tokens hit 0 | https://github.com/pump-fun/pump-public-docs |

**Fees (my defaults, all configurable by the owner, hard-capped at 3% total):** 1.25% per trade, matching pump.fun's current 1.25% total. JustTag splits it 0.65% protocol / 0.60% creators (pump.fun is 0.95 / 0.30). On top of that: a 0.001 ETH creation fee for website launches (bot launches are free) and a 0.05 ETH migration fee at graduation. Change them with the deploy env vars or `setConfig`.

---

## What's tested

- **Contracts, 10 tests, all passing on a fork of Robinhood mainnet** (`cd contracts && forge test`): free and idempotent operator launches, paid public launches with a first buy, buy/sell round trip and fee math, the pair lock before graduation, **graduation into the real Uniswap V2 on Robinhood Chain** (including a griefing donation made to the pair beforehand), X-account binding with replay protection, Holders/Buyback/Burn routes, buyback through the pool after graduation, treasury withdrawal, and a fuzzed solvency check.
- **Tag parser:** 13 unit tests (`cd backend && npm test`).
- **Full stack, 16 scenarios** (`cd backend && npm run e2e:fork`). The suite starts its own anvil fork of Robinhood mainnet, deploys fresh contracts with freshly generated keys, and drives the real bot, agents, payouts, indexer and API against a local mock of the X API:
  - Bot: a `70/30 @friend` tag launches with that split and replies under the tag. A second tag on the same post gets the existing coin. Self-tag with `$TICKER Name`. Default 50/50. Daily limit.
  - Fees accrue to X handles, and a gasless wallet link pays them out.
  - Opt out and opt in, including an opted-out friend's share going back to the tagger.
  - A launch that fails during an outage is retried and announced.
  - The API and status endpoint. Share tags and cards.
  - Website agent launch (prepare, wallet transaction, submit). The agent launches a child coin from a viral post, and child trades fund buyback, burn and a holders airdrop of the parent coin.
  - Graduation into the real Uniswap V2, a router trade, and the indexed pool swap.
- **CI:** `.github/workflows/ci.yml` runs all three suites on every push. Add a `ROBINHOOD_RPC_URL` secret if the public RPC rate-limits the runners.
- **Not tested live, because they need your accounts:** the X bot against the real X API, X sign-in, and Claude calls. The code follows the documented endpoints and the Anthropic SDK, but please test them with your keys before announcing.

---

## Launch checklist

### 1. Wallets
Create four separate keys:
- **Owner**: ideally a Safe multisig or a hardware wallet. It can change fees (max 3%) and rotate roles.
- **Operator**: a hot key on the server. It launches coins, pays gas, and pushes payouts. Keep only gas money on it. Bridge some ETH to Robinhood Chain for it (bridge link above).
- **Attester**: a hot key on the server that only signs wallet links. It never holds funds. If it leaks, rotate it with `setRoles`.
- **Treasury**: where protocol fees are withdrawn to.

> Never use anvil's default keys on mainnet. They are public, and on Robinhood mainnet they already have EIP-7702 sweepers attached (I hit this during testing).

### 2. Deploy the contracts
```powershell
cd contracts
forge test
$env:OWNER="0x..."; $env:ATTESTER="0x..."; $env:OPERATOR="0x..."; $env:TREASURY="0x..."
forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --private-key <DEPLOYER_KEY> --verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
```
The addresses are written to `contracts/deployments/4663.json`. Blockscout sits behind Cloudflare, so if verification fails, run `forge verify-contract` again later.

### 3. X developer setup (developer.x.com)
1. Create the bot account (for example @JustTag) and a developer app with pay-per-use credits.
2. Set app permissions to **Read and Write**, then generate the **OAuth 1.0a** access token and secret *for the bot account*.
3. Enable **OAuth 2.0** (Web App, confidential). Callback URL: `https://YOUR_DOMAIN/auth/x/callback`. Scopes used: `users.read tweet.read`.
4. Optionally add the bot's numeric user id as `X_BOT_USER_ID`. Otherwise it's fetched at start-up.

### 4. Anthropic
Create an API key at console.anthropic.com and set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5` at low effort, with server-side fallbacks enabled for refusals. Without a key, the picker falls back to a simple heuristic (first image, name from the post's words).

### 5. Run the backend
```powershell
cd backend
copy .env.example .env   # fill it in
npm ci
npm run build
npm start
```
Or, on a server with Docker and your domain's DNS pointing at it, run `docker compose -f deploy/docker-compose.yml up -d --build` (set `DOMAIN=yourdomain` in `deploy/.env`). That runs the backend behind Caddy, which gets HTTPS certificates automatically. X sign-in needs the HTTPS callback. For production, use a dedicated RPC endpoint (for example Alchemy `robinhood-mainnet`); the public one is rate-limited.

### 6. Launch $JUSTTAG
Either run the script with the operator key (free launch):
```powershell
cd contracts
$env:LAUNCHPAD="0x..."; $env:JUSTTAG_URI="https://YOUR_DOMAIN/justtag.json"; $env:JUSTTAG_X_HANDLE="justtag"
forge script script/LaunchJustTag.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --private-key <OPERATOR_KEY>
```
Or tag the bot's own announcement post: `@JustTag $JUSTTAG JustTag all mine`. Edit `backend/web/justtag.json` with your domain first (it is the metadata the token points to). Then set `JUSTTAG_TOKEN_ADDRESS` so the header shows the CA.

### 7. Set up the X profile
Use `brand/x-avatar-400.png` and `brand/x-header-1500x500.png`, and the bio, pinned post and launch thread in `docs/launch-kit.md`.

### 8. Seed the hero wall
Set `WALL_POST_IDS` to the ids of real, popular posts. The wall shows them through the X API, along with the posts behind the latest coins. It never shows invented posts.

---

## Local fork test (no real money)
Needs Foundry (`anvil`, `forge`) and Node 22.13 or newer:
```powershell
cd contracts; forge build; cd ../backend; npm ci; npm run e2e:fork
```
The suite starts and stops anvil itself, on port 8546.

---

## Costs to run (X API, pay-per-use)
Per tag: about $0.001 for the mention read (owned), up to $0.005 if the post isn't already included, and **$0.20 for the reply when it contains a link** ($0.01 without a link: set `REPLY_INCLUDE_LINK=false`). Previews on the website cost one post read each. They're cached for 30 minutes and rate-limited per IP. Agents read their sources every `AGENT_POLL_MS` (10 posts per source per poll), so tune the interval to your budget. Gas on Robinhood Chain is paid in ETH by the operator.

## Security notes
- Get the contracts audited before significant volume. They're compact and tested, but they hold user funds.
- **Owner** can change fees (capped at 3%) and roles. It cannot touch the curves, the escrowed fees, or the LP.
- **Operator** can trigger Buyback and Burn buys and receives the Holders bucket to airdrop it (`JustTagAirdrop`). That part is trusted.
- **Attester** decides which wallet an X handle is linked to. Keep it on the server only and rotate it if you suspect a leak.
- Robinhood Chain orders transactions first-come-first-served at the sequencer, with no public mempool, so sandwiching the operator's route buys is not practical.

## Not affiliated
JustTag is not affiliated with X Corp., Robinhood Markets, or tagy.fun. Memecoins are risky. Check the rules that apply to you before you launch.
