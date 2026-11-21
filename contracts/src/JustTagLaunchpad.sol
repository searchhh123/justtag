// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {JustTagToken} from "./JustTagToken.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IWETH} from "./interfaces/IUniswapV2.sol";

/// @title JustTagLaunchpad
/// @notice Tag a post on X, get a coin. Every coin is a fixed 1B-supply ERC20 sold on a constant-product
///         bonding curve with virtual reserves (the same model pump.fun uses). When the curve sells out the coin
///         graduates: the raised ETH and the reserved tokens seed a Uniswap-V2-style pool and the LP is burned.
///
///         Every trade pays a fee. Part goes to the protocol, part to the coin's creators. Creators are written in
///         the tag (for example "50/50" or "70/30 with a friend") and stored as splits. A split can point at:
///           - an X account (key = keccak256("x:" + lowercase handle)). Fees wait in escrow until the account
///             links a wallet through an attester signature (X login on the website), then anyone can push them out.
///           - a plain wallet address.
///           - a route of a coin: airdrop to holders, buyback, or buy-and-burn (used by agent coins).
contract JustTagLaunchpad is Ownable2Step, ReentrancyGuard, EIP712 {
    // ---------------------------------------------------------------- types

    enum Kind {
        XAccount, // id = keccak256("x:" + lowercase handle)
        Wallet, // id = bytes32(uint256(uint160(wallet)))
        Holders, // id = bytes32(token) or 0 for "this coin"
        Buyback, // id = bytes32(token) or 0 for "this coin"
        Burn // id = bytes32(token) or 0 for "this coin"
    }

    struct SplitInput {
        Kind kind;
        bytes32 id;
        uint16 bps;
    }

    struct Split {
        bytes32 key;
        uint16 bps;
    }

    struct Route {
        Kind kind;
        address token;
    }

    struct Curve {
        uint256 virtualEth;
        uint256 virtualToken;
        uint256 realEth;
        uint256 realToken;
        uint256 reserveToken; // held back for the DEX pool
        address creator;
        uint64 createdAt;
        bool graduated;
    }

    struct Config {
        uint256 initVirtualEth;
        uint256 initVirtualToken;
        uint256 curveSupply;
        uint256 creationFee; // charged to non-operator creators, in wei
        uint256 migrationFee; // taken from the raised ETH at graduation, in wei
        uint16 protocolFeeBps;
        uint16 creatorFeeBps;
    }

    // ---------------------------------------------------------------- constants

    bytes32 public constant BIND_TYPEHASH =
        keccak256("Bind(bytes32 key,address wallet,uint256 nonce,uint256 deadline)");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_SPLITS = 6;
    uint16 public constant MAX_TOTAL_FEE_BPS = 300; // hard cap: 3%
    uint256 internal constant BPS = 10_000;

    // ---------------------------------------------------------------- storage

    IUniswapV2Factory public immutable dexFactory;
    IWETH public immutable weth;
    uint16 public immutable dexFeeBps; // 30 for a standard Uniswap V2 fork

    Config public config;
    address public attester; // signs X-account -> wallet bindings after X OAuth
    address public operator; // the @JustTag bot / agent runner
    address public treasury;

    uint256 public protocolFeesAccrued;

    mapping(address token => Curve) public curves;
    mapping(address token => Split[]) internal _splits;
    mapping(bytes32 key => Route) public routes; // only set for Holders / Buyback / Burn keys
    mapping(bytes32 key => uint256) public pendingFees;
    mapping(bytes32 key => address) public walletOf;
    mapping(bytes32 key => uint256) public bindNonce;
    mapping(bytes32 launchId => address) public tokenByLaunchId;
    address[] public allTokens;

    // ---------------------------------------------------------------- events

    event TokenCreated(
        address indexed token,
        address indexed creator,
        bytes32 indexed launchId,
        string name,
        string symbol,
        string uri,
        address pair
    );
    event SplitSet(address indexed token, bytes32 indexed key, Kind kind, bytes32 id, uint16 bps);
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualEth,
        uint256 virtualToken,
        uint256 realEth,
        uint256 realToken
    );
    event Graduated(address indexed token, address indexed pair, uint256 eth, uint256 tokens, uint256 liquidity);
    event WalletBound(bytes32 indexed key, address indexed wallet, uint256 nonce);
    event Claimed(bytes32 indexed key, address indexed to, uint256 amount);
    event RouteExecuted(address indexed token, bytes32 indexed key, Kind kind, uint256 ethIn, uint256 tokensOut);
    event ConfigUpdated(Config config);
    event RolesUpdated(address attester, address operator, address treasury);

    // ---------------------------------------------------------------- errors

    error BadParams();
    error UnknownToken();
    error AlreadyGraduated();
    error NotGraduated();
    error Expired();
    error Slippage();
    error LaunchIdUsed();
    error InsufficientFee();
    error NotAuthorized();
    error BadSignature();
    error NoWallet();
    error TransferFailed();

    // ---------------------------------------------------------------- setup

    constructor(
        address owner_,
        address dexFactory_,
        address weth_,
        uint16 dexFeeBps_,
        address attester_,
        address operator_,
        address treasury_,
        Config memory config_
    ) Ownable(owner_) EIP712("JustTag", "1") {
        if (dexFactory_ == address(0) || weth_ == address(0) || dexFeeBps_ >= 1000) revert BadParams();
        dexFactory = IUniswapV2Factory(dexFactory_);
        weth = IWETH(weth_);
        dexFeeBps = dexFeeBps_;
        _setRoles(attester_, operator_, treasury_);
        _setConfig(config_);
    }

    receive() external payable {
        // only WETH unwraps send ETH here
        if (msg.sender != address(weth)) revert NotAuthorized();
    }

    // ---------------------------------------------------------------- create

    /// @notice Launch a coin. The operator (the X bot) launches for free; anyone else pays `creationFee`.
    ///         Any ETH above the fee is an initial buy for msg.sender.
    /// @param launchId idempotency key (e.g. keccak of the tag tweet id). 0 to skip the check.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata uri,
        bytes32 launchId,
        SplitInput[] calldata splits,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token) {
        uint256 nameLen = bytes(name).length;
        uint256 symLen = bytes(symbol).length;
        if (nameLen == 0 || nameLen > 32 || symLen == 0 || symLen > 12) revert BadParams();
        if (bytes(uri).length > 256) revert BadParams();

        uint256 value = msg.value;
        if (msg.sender != operator) {
            if (value < config.creationFee) revert InsufficientFee();
            value -= config.creationFee;
            protocolFeesAccrued += config.creationFee;
        }

        if (launchId != bytes32(0)) {
            if (tokenByLaunchId[launchId] != address(0)) revert LaunchIdUsed();
        }

        JustTagToken t = new JustTagToken(name, symbol, uri);
        token = address(t);
        address pair = dexFactory.getPair(token, address(weth));
        if (pair == address(0)) pair = dexFactory.createPair(token, address(weth));
        t.initPair(pair);

        if (launchId != bytes32(0)) tokenByLaunchId[launchId] = token;
        allTokens.push(token);

        Config memory c = config;
        curves[token] = Curve({
            virtualEth: c.initVirtualEth,
            virtualToken: c.initVirtualToken,
            realEth: 0,
            realToken: c.curveSupply,
            reserveToken: t.TOTAL_SUPPLY() - c.curveSupply,
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            graduated: false
        });

        _storeSplits(token, splits);
        emit TokenCreated(token, msg.sender, launchId, name, symbol, uri, pair);

        if (value > 0) {
            uint256 out = _buy(token, value, msg.sender, msg.sender);
            if (out < minTokensOut) revert Slippage();
        }
    }

    function _storeSplits(address token, SplitInput[] calldata splits) internal {
        uint256 n = splits.length;
        if (n == 0 || n > MAX_SPLITS) revert BadParams();
        uint256 total;
        Split[] storage dst = _splits[token];
        for (uint256 i; i < n; ++i) {
            SplitInput calldata s = splits[i];
            if (s.bps == 0) revert BadParams();
            total += s.bps;
            bytes32 key;
            if (s.kind == Kind.XAccount) {
                if (s.id == bytes32(0)) revert BadParams();
                key = s.id;
            } else if (s.kind == Kind.Wallet) {
                if (s.id == bytes32(0) || uint256(s.id) >> 160 != 0) revert BadParams();
                key = s.id;
            } else {
                address target = s.id == bytes32(0) ? token : address(uint160(uint256(s.id)));
                if (target != token && curves[target].createdAt == 0) revert UnknownToken();
                key = routeKey(s.kind, target);
                if (routes[key].token == address(0)) routes[key] = Route({kind: s.kind, token: target});
            }
            dst.push(Split({key: key, bps: s.bps}));
            emit SplitSet(token, key, s.kind, s.id, s.bps);
        }
        if (total != BPS) revert BadParams();
    }

    // ---------------------------------------------------------------- trade

    function buy(address token, uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0)) revert BadParams();
        tokensOut = _buy(token, msg.value, msg.sender, to);
        if (tokensOut < minTokensOut) revert Slippage();
    }

    function sell(address token, uint256 tokensIn, uint256 minEthOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0) || tokensIn == 0) revert BadParams();
        Curve storage c = curves[token];
        if (c.createdAt == 0) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();

        JustTagToken(token).transferFrom(msg.sender, address(this), tokensIn);

        uint256 k = c.virtualEth * c.virtualToken;
        uint256 newVT = c.virtualToken + tokensIn;
        uint256 newVE = Math.ceilDiv(k, newVT);
        uint256 gross = c.virtualEth - newVE;
        if (gross > c.realEth) gross = c.realEth; // dust guard, should never trigger

        c.virtualEth = newVE;
        c.virtualToken = newVT;
        c.realEth -= gross;
        c.realToken += tokensIn;

        uint256 fee = (gross * _totalFeeBps()) / BPS;
        ethOut = gross - fee;
        if (ethOut < minEthOut) revert Slippage();
        _takeFee(token, fee);

        emit Trade(token, msg.sender, false, gross, tokensIn, fee, newVE, newVT, c.realEth, c.realToken);
        _sendEth(to, ethOut);
    }

    /// @dev Buys with `gross` wei (fee included). Refunds whatever the curve could not absorb to `payer`.
    function _buy(address token, uint256 gross, address payer, address to) internal returns (uint256 tokensOut) {
        Curve storage c = curves[token];
        if (c.createdAt == 0) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (gross == 0) revert BadParams();

        uint16 feeBps = _totalFeeBps();
        uint256 fee = (gross * feeBps) / BPS;
        uint256 used;
        (tokensOut, used) = _curveBuy(c, gross - fee);

        uint256 refund;
        if (used < gross - fee) {
            // curve sold out: charge the fee on what was actually used
            fee = Math.mulDiv(used, feeBps, BPS - feeBps, Math.Rounding.Ceil);
            refund = gross - used - fee;
        }
        _takeFee(token, fee);

        JustTagToken(token).transfer(to, tokensOut);
        emit Trade(token, payer, true, used, tokensOut, fee, c.virtualEth, c.virtualToken, c.realEth, c.realToken);

        if (c.realToken == 0) _graduate(token, c);
        if (refund > 0) _sendEth(payer, refund);
    }

    /// @dev Constant product on virtual reserves. Never sells past the curve supply.
    function _curveBuy(Curve storage c, uint256 ethIn) internal returns (uint256 tokensOut, uint256 used) {
        uint256 vE = c.virtualEth;
        uint256 vT = c.virtualToken;
        uint256 k = vE * vT;
        uint256 newVE = vE + ethIn;
        uint256 newVT = Math.ceilDiv(k, newVE);
        tokensOut = vT - newVT;
        used = ethIn;
        if (tokensOut >= c.realToken) {
            tokensOut = c.realToken;
            newVT = vT - tokensOut;
            newVE = Math.ceilDiv(k, newVT);
            used = newVE - vE;
        }
        c.virtualEth = newVE;
        c.virtualToken = newVT;
        c.realEth += used;
        c.realToken -= tokensOut;
    }

    function _takeFee(address token, uint256 fee) internal {
        if (fee == 0) return;
        Config memory cfg = config;
        uint256 total = uint256(cfg.protocolFeeBps) + cfg.creatorFeeBps;
        uint256 creatorPart = total == 0 ? 0 : (fee * cfg.creatorFeeBps) / total;
        protocolFeesAccrued += fee - creatorPart;
        if (creatorPart == 0) return;

        Split[] storage s = _splits[token];
        uint256 n = s.length;
        uint256 left = creatorPart;
        for (uint256 i; i < n; ++i) {
            uint256 amt = i == n - 1 ? left : (creatorPart * s[i].bps) / BPS;
            left -= amt;
            pendingFees[s[i].key] += amt;
        }
    }

    // ---------------------------------------------------------------- graduation

    function _graduate(address token, Curve storage c) internal {
        c.graduated = true;
        uint256 raised = c.realEth;
        uint256 mf = config.migrationFee < raised ? config.migrationFee : 0;
        uint256 ethForLp = raised - mf;
        protocolFeesAccrued += mf;
        c.realEth = 0;

        // Seed the pool at the curve's final price so there is no gap to arbitrage. Burn whatever is left over.
        uint256 lpTokens = Math.mulDiv(ethForLp, c.virtualToken, c.virtualEth);
        if (lpTokens > c.reserveToken) lpTokens = c.reserveToken;
        uint256 leftover = c.reserveToken - lpTokens;
        c.reserveToken = 0;

        JustTagToken t = JustTagToken(token);
        t.markGraduated();
        address pair = t.pair();

        weth.deposit{value: ethForLp}();
        if (!weth.transfer(pair, ethForLp)) revert TransferFailed();
        t.transfer(pair, lpTokens);
        uint256 liquidity = IUniswapV2Pair(pair).mint(DEAD);
        if (leftover > 0) t.burn(leftover);

        emit Graduated(token, pair, ethForLp, lpTokens, liquidity);
    }

    // ---------------------------------------------------------------- X account binding + payouts

    /// @notice Link an X account key to a wallet. `sig` comes from the attester after the user signs in with X.
    ///         Re-binding (new wallet) needs a fresh signature; nonces stop replays.
    function bindWallet(bytes32 key, address wallet, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        if (wallet == address(0) || routes[key].token != address(0) || uint256(key) >> 160 == 0) revert BadParams();
        uint256 nonce = bindNonce[key];
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(BIND_TYPEHASH, key, wallet, nonce, deadline)));
        if (ECDSA.recover(digest, sig) != attester) revert BadSignature();
        bindNonce[key] = nonce + 1;
        walletOf[key] = wallet;
        emit WalletBound(key, wallet, nonce);
    }

    /// @notice Push pending fees for X-account or wallet keys to their wallet. Anyone can call it, so the
    ///         backend pays everyone automatically ("nothing to claim").
    function claim(bytes32 key) public nonReentrant returns (uint256 amount) {
        address to = payoutAddress(key);
        if (to == address(0)) revert NoWallet();
        amount = pendingFees[key];
        if (amount == 0) return 0;
        pendingFees[key] = 0;
        emit Claimed(key, to, amount);
        _sendEth(to, amount);
    }

    function claimMany(bytes32[] calldata keys) external {
        for (uint256 i; i < keys.length; ++i) {
            if (payoutAddress(keys[i]) != address(0) && pendingFees[keys[i]] > 0) claim(keys[i]);
        }
    }

    /// @notice Where `claim` would send fees for `key`. Holders routes pay the operator, which airdrops them.
    function payoutAddress(bytes32 key) public view returns (address) {
        Route memory r = routes[key];
        if (r.token != address(0)) return r.kind == Kind.Holders ? operator : address(0);
        if (uint256(key) >> 160 == 0) return address(uint160(uint256(key)));
        return walletOf[key];
    }

    /// @notice Spend a coin's Buyback or Burn bucket buying that coin (on the curve, or the pool once graduated).
    ///         Buyback sends the coins to the dead address, Burn destroys them. Operator/owner only, to keep
    ///         the buys from being sandwiched.
    function executeRoute(bytes32 key, uint256 maxEth, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.sender != operator && msg.sender != owner()) revert NotAuthorized();
        Route memory r = routes[key];
        if (r.kind != Kind.Buyback && r.kind != Kind.Burn) revert BadParams();
        uint256 amount = pendingFees[key];
        if (maxEth != 0 && amount > maxEth) amount = maxEth;
        if (amount == 0) return 0;
        pendingFees[key] -= amount;

        Curve storage c = curves[r.token];
        address recipient = r.kind == Kind.Burn ? address(this) : DEAD;
        if (!c.graduated) {
            uint256 used;
            (tokensOut, used) = _curveBuy(c, amount);
            if (used < amount) pendingFees[key] += amount - used;
            JustTagToken(r.token).transfer(recipient, tokensOut);
            emit Trade(r.token, address(this), true, used, tokensOut, 0, c.virtualEth, c.virtualToken, c.realEth, c.realToken);
            if (c.realToken == 0) _graduate(r.token, c);
        } else {
            tokensOut = _swapEthForTokens(r.token, amount, recipient);
        }
        if (tokensOut < minTokensOut) revert Slippage();
        if (r.kind == Kind.Burn) JustTagToken(r.token).burn(tokensOut);
        emit RouteExecuted(r.token, key, r.kind, amount, tokensOut);
    }

    function _swapEthForTokens(address token, uint256 ethIn, address to) internal returns (uint256 out) {
        address pair = JustTagToken(token).pair();
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        bool wethIs0 = IUniswapV2Pair(pair).token0() == address(weth);
        (uint256 rIn, uint256 rOut) = wethIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inWithFee = ethIn * (BPS - dexFeeBps);
        out = (inWithFee * rOut) / (rIn * BPS + inWithFee);
        weth.deposit{value: ethIn}();
        if (!weth.transfer(pair, ethIn)) revert TransferFailed();
        IUniswapV2Pair(pair).swap(wethIs0 ? 0 : out, wethIs0 ? out : 0, to, "");
    }

    // ---------------------------------------------------------------- views

    function routeKey(Kind kind, address token) public pure returns (bytes32) {
        return keccak256(abi.encode(uint8(kind), token));
    }

    function walletKey(address wallet) external pure returns (bytes32) {
        return bytes32(uint256(uint160(wallet)));
    }

    function splitsOf(address token) external view returns (Split[] memory) {
        return _splits[token];
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Tokens out for `ethIn` wei sent to `buy` (fee included).
    function quoteBuy(address token, uint256 ethIn) external view returns (uint256 tokensOut, uint256 fee) {
        Curve memory c = curves[token];
        if (c.createdAt == 0 || c.graduated) return (0, 0);
        uint16 feeBps = _totalFeeBps();
        fee = (ethIn * feeBps) / BPS;
        uint256 newVE = c.virtualEth + ethIn - fee;
        tokensOut = c.virtualToken - Math.ceilDiv(c.virtualEth * c.virtualToken, newVE);
        if (tokensOut > c.realToken) tokensOut = c.realToken;
    }

    /// @notice ETH out (after fee) for selling `tokensIn`.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee) {
        Curve memory c = curves[token];
        if (c.createdAt == 0 || c.graduated) return (0, 0);
        uint256 newVE = Math.ceilDiv(c.virtualEth * c.virtualToken, c.virtualToken + tokensIn);
        uint256 gross = c.virtualEth - newVE;
        if (gross > c.realEth) gross = c.realEth;
        fee = (gross * _totalFeeBps()) / BPS;
        ethOut = gross - fee;
    }

    /// @notice Spot price in wei per whole token (1e18 units).
    function priceOf(address token) external view returns (uint256) {
        Curve memory c = curves[token];
        if (c.virtualToken == 0) return 0;
        return Math.mulDiv(c.virtualEth, 1e18, c.virtualToken);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _totalFeeBps() internal view returns (uint16) {
        return config.protocolFeeBps + config.creatorFeeBps;
    }

    // ---------------------------------------------------------------- admin

    function setConfig(Config calldata c) external onlyOwner {
        _setConfig(c);
    }

    function setRoles(address attester_, address operator_, address treasury_) external onlyOwner {
        _setRoles(attester_, operator_, treasury_);
    }

    function withdrawProtocolFees() external nonReentrant {
        uint256 amount = protocolFeesAccrued;
        protocolFeesAccrued = 0;
        _sendEth(treasury, amount);
    }

    function _setConfig(Config memory c) internal {
        if (c.initVirtualEth == 0 || c.initVirtualToken == 0) revert BadParams();
        if (c.curveSupply == 0 || c.curveSupply >= c.initVirtualToken || c.curveSupply >= 1_000_000_000 ether) {
            revert BadParams();
        }
        if (uint256(c.protocolFeeBps) + c.creatorFeeBps > MAX_TOTAL_FEE_BPS) revert BadParams();
        config = c;
        emit ConfigUpdated(c);
    }

    function _setRoles(address attester_, address operator_, address treasury_) internal {
        if (attester_ == address(0) || operator_ == address(0) || treasury_ == address(0)) revert BadParams();
        attester = attester_;
        operator = operator_;
        treasury = treasury_;
        emit RolesUpdated(attester_, operator_, treasury_);
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
