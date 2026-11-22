# JustTag launch kit

Ready-to-post copy for the @JustTag account. Replace `justtag.fun` with your domain and `@JustTag` with your bot handle if they differ. Images are in `/brand`.

## Profile

- **Name:** JustTag
- **Bio:** Tag any post. It's a coin. Reply @JustTag under any post and it's live on Robinhood Chain in seconds. Creator fees go to the X accounts in your tag. $JUSTTAG
- **Website:** https://justtag.fun
- **Profile picture:** `brand/x-avatar-400.png`
- **Header:** `brand/x-header-1500x500.png`

## Pinned post (post this, then tag it yourself to launch $JUSTTAG)

> Tag it. It's a coin.
>
> Reply @JustTag under any post and it's live on Robinhood Chain in seconds.
>
> Creator fees go to the X accounts in your tag. 50/50 with the poster by default, or write your own split.
>
> Free. justtag.fun

Then reply to it from the bot account (or your own) with: `@JustTag $JUSTTAG JustTag all mine`

## Launch thread

1/
> JustTag is live on Robinhood Chain.
>
> See a post that should be a coin? Reply @JustTag under it. That's it. The coin is live in seconds and JustTag replies with the link.

2/
> Write the deal in the tag:
>
> @JustTag → 50/50 with the poster
> @JustTag 70/30 → 70% you, 30% the poster
> @JustTag all mine
> @JustTag all to the poster
> @JustTag 50/50 @friend
> @JustTag $TICKER Name → your ticker and name

3/
> No image, no name, no ticker? Fine. JustTag scores every picture in the post, keeps the strongest, cuts the coin image around the action, and writes the name and ticker.

4/
> Creator fees are owed to X accounts, not wallets. They wait on-chain under your handle until you claim them.
>
> Sign in with X once at justtag.fun/claim, link a wallet, and every payout after that arrives by itself. JustTag pays the gas.

5/
> Want coins launched for you around the clock? Give your coin an agent. GTA 6 is built in, or write a prompt for anything. Every coin it launches pays back into yours: holders, buybacks, burns, you.

6/
> Every coin starts on a bonding curve. When it sells out, it graduates to Uniswap on Robinhood Chain and the liquidity is burned.
>
> Don't want your posts turned into coins? Reply "@JustTag opt out".
>
> Memecoins are risky. Nothing here is financial advice.

## Saved replies for common questions

- **"How do I get my fees?"** Sign in with X at justtag.fun/claim and link a wallet. Everything that waited is paid out at once, and new fees are sent automatically. JustTag pays the gas.
- **"I didn't agree to this."** Reply "@JustTag opt out" and JustTag won't launch coins from your posts or put you in a split. Fees already owed to you stay claimable at justtag.fun/claim.
- **"What chain? Which wallet?"** Robinhood Chain (an Ethereum L2, gas in ETH). Robinhood Wallet, MetaMask or any EVM wallet works. justtag.fun adds the network for you.
- **"What are the fees?"** 1.25% per trade on the curve: 0.60% to the creators in the split and 0.65% to the protocol. After graduation it trades on Uniswap with Uniswap's pool fee.
- **"Can it launch the same post twice?"** No. One coin per post. A second tag gets a link to the existing coin.

## Notes

- A bot reply with a link costs more on the X API ($0.20) than one without ($0.01). See `REPLY_INCLUDE_LINK` in `backend/.env.example`.
- Do not claim payouts happen "on X Money". X has no public X Money payout API; JustTag pays to the wallet the X account links.
