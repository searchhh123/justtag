# JustTag contracts

- `src/JustTagLaunchpad.sol`: bonding curve, fee splits (X accounts, wallets, holder/buyback/burn routes), X-account to wallet binding (EIP-712), graduation into Uniswap V2.
- `src/JustTagToken.sol`: 1B fixed-supply ERC20, locked out of its DEX pair until graduation.
- `src/JustTagAirdrop.sol`: batch ETH sender for holder airdrops.
- `script/Deploy.s.sol`, `script/LaunchJustTag.s.sol`

`forge test` runs against a fork of Robinhood Chain mainnet (set `ROBINHOOD_RPC_URL` to use a private RPC). See the root README for deployment.
