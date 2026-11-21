// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {JustTagLaunchpad} from "../src/JustTagLaunchpad.sol";
import {JustTagToken} from "../src/JustTagToken.sol";
import {IUniswapV2Pair} from "../src/interfaces/IUniswapV2.sol";

/// Runs against a fork of Robinhood Chain mainnet so graduation hits the real Uniswap V2 deployment.
/// Override the RPC with ROBINHOOD_RPC_URL if the public endpoint rate-limits you.
contract JustTagLaunchpadTest is Test {
    address constant V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    JustTagLaunchpad pad;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    uint256 attesterPk = 0xA11CE;
    address attester;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 tagger = keccak256("x:alice_tags");
    bytes32 poster = keccak256("x:dexerto");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        attester = vm.addr(attesterPk);
        pad = new JustTagLaunchpad(owner, V2_FACTORY, WETH, 30, attester, operator, treasury, _config());
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _config() internal pure returns (JustTagLaunchpad.Config memory) {
        return JustTagLaunchpad.Config({
            initVirtualEth: 1.26 ether,
            initVirtualToken: 1_073_000_000 ether,
            curveSupply: 793_100_000 ether,
            creationFee: 0.001 ether,
            migrationFee: 0.05 ether,
            protocolFeeBps: 65,
            creatorFeeBps: 60
        });
    }

    function _split5050() internal view returns (JustTagLaunchpad.SplitInput[] memory s) {
        s = new JustTagLaunchpad.SplitInput[](2);
        s[0] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.XAccount, tagger, 5000);
        s[1] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.XAccount, poster, 5000);
    }

    function _launch() internal returns (JustTagToken t) {
        vm.prank(operator);
        t = JustTagToken(pad.createToken("Jet Ski Dog", "JETDOG", "https://justtag.fun/m/1", keccak256("tag-1"), _split5050(), 0));
    }

    function test_operatorLaunchIsFreeAndIdempotent() public {
        JustTagToken t = _launch();
        assertEq(t.balanceOf(address(pad)), 1_000_000_000 ether);
        assertEq(t.symbol(), "JETDOG");
        assertTrue(t.pair() != address(0));
        vm.prank(operator);
        vm.expectRevert(JustTagLaunchpad.LaunchIdUsed.selector);
        pad.createToken("x", "X", "", keccak256("tag-1"), _split5050(), 0);
    }

    function test_publicLaunchNeedsFeeAndDevBuys() public {
        vm.prank(alice);
        vm.expectRevert(JustTagLaunchpad.InsufficientFee.selector);
        pad.createToken("A", "A", "", 0, _split5050(), 0);

        vm.prank(alice);
        address t = pad.createToken{value: 0.101 ether}("A", "A", "", 0, _split5050(), 1);
        assertGt(JustTagToken(t).balanceOf(alice), 0);
        assertEq(pad.protocolFeesAccrued() > 0.001 ether, true);
    }

    function test_buySellRoundTripAndFees() public {
        JustTagToken t = _launch();
        (uint256 quoted,) = pad.quoteBuy(address(t), 1 ether);
        vm.prank(alice);
        uint256 got = pad.buy{value: 1 ether}(address(t), quoted, alice, block.timestamp);
        assertEq(got, quoted);

        uint256 fee = 1 ether * 125 / 10_000;
        uint256 creatorPart = fee * 60 / 125;
        assertEq(pad.pendingFees(tagger) + pad.pendingFees(poster), creatorPart);
        assertEq(pad.pendingFees(tagger), creatorPart / 2);

        vm.startPrank(alice);
        t.approve(address(pad), got);
        (uint256 ethQuote,) = pad.quoteSell(address(t), got);
        uint256 before = alice.balance;
        pad.sell(address(t), got, ethQuote, alice, block.timestamp);
        vm.stopPrank();
        assertEq(alice.balance - before, ethQuote);
        // round trip loses only fees (+ rounding)
        assertApproxEqRel(ethQuote, 1 ether - fee - (1 ether - fee) * 125 / 10_000, 1e14);
        // launchpad stays solvent
        (,, uint256 realEth,,,,,) = pad.curves(address(t));
        assertGe(address(pad).balance, realEth + pad.protocolFeesAccrued() + pad.pendingFees(tagger) + pad.pendingFees(poster));
    }

    function test_pairLockedBeforeGraduation() public {
        JustTagToken t = _launch();
        vm.prank(alice);
        pad.buy{value: 0.1 ether}(address(t), 0, alice, block.timestamp);
        address pair = t.pair();
        vm.prank(alice);
        vm.expectRevert(JustTagToken.PairLockedUntilGraduation.selector);
        t.transfer(pair, 1 ether);
    }

    function test_graduatesIntoRealUniswapV2() public {
        JustTagToken t = _launch();
        // pre-seed griefing: donate WETH to the pair and sync before graduation
        address pair = t.pair();
        vm.deal(bob, 1 ether);
        vm.startPrank(bob);
        (bool ok,) = WETH.call{value: 0.01 ether}(abi.encodeWithSignature("deposit()"));
        assertTrue(ok);
        (ok,) = WETH.call(abi.encodeWithSignature("transfer(address,uint256)", pair, 0.01 ether));
        assertTrue(ok);
        IUniswapV2Pair(pair).sync();
        vm.stopPrank();

        uint256 before = alice.balance;
        vm.prank(alice);
        pad.buy{value: 10 ether}(address(t), 0, alice, block.timestamp);
        uint256 spent = before - alice.balance;
        assertLt(spent, 4 ether); // refund of the excess
        assertEq(t.balanceOf(alice), 793_100_000 ether);

        (,,,,,,, bool graduated) = pad.curves(address(t));
        assertTrue(graduated);
        assertTrue(t.graduated());
        assertEq(t.balanceOf(address(pad)), 0);
        assertGt(IUniswapV2Pair(pair).balanceOf(pad.DEAD()), 0);

        // trading continues on Uniswap, transfers into the pair now allowed
        vm.prank(alice);
        t.transfer(pair, 1000 ether);

        vm.prank(alice);
        vm.expectRevert(JustTagLaunchpad.AlreadyGraduated.selector);
        pad.buy{value: 1 ether}(address(t), 0, alice, block.timestamp);
    }

    function test_bindAndPushFees() public {
        JustTagToken t = _launch();
        vm.prank(alice);
        pad.buy{value: 1 ether}(address(t), 0, alice, block.timestamp);

        vm.expectRevert(JustTagLaunchpad.NoWallet.selector);
        pad.claim(poster);

        address posterWallet = makeAddr("posterWallet");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(poster, posterWallet, 0, deadline);
        pad.bindWallet(poster, posterWallet, deadline, sig);

        vm.expectRevert(JustTagLaunchpad.BadSignature.selector); // replay
        pad.bindWallet(poster, posterWallet, deadline, sig);

        uint256 owed = pad.pendingFees(poster);
        vm.prank(bob); // anyone can push
        pad.claim(poster);
        assertEq(posterWallet.balance, owed);
        assertEq(pad.pendingFees(poster), 0);
    }

    function test_agentRoutesBuybackBurnHolders() public {
        JustTagToken parent = _launch();
        JustTagLaunchpad.SplitInput[] memory s = new JustTagLaunchpad.SplitInput[](4);
        s[0] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.Holders, bytes32(uint256(uint160(address(parent)))), 4000);
        s[1] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.XAccount, tagger, 3000);
        s[2] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.Buyback, bytes32(uint256(uint160(address(parent)))), 2000);
        s[3] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.Burn, bytes32(0), 1000);
        vm.prank(operator);
        address child = pad.createToken("Child", "KID", "", keccak256("agent-1"), s, 0);

        vm.prank(alice);
        pad.buy{value: 2 ether}(child, 0, alice, block.timestamp);

        bytes32 buybackKey = pad.routeKey(JustTagLaunchpad.Kind.Buyback, address(parent));
        bytes32 burnKey = pad.routeKey(JustTagLaunchpad.Kind.Burn, child);
        bytes32 holdersKey = pad.routeKey(JustTagLaunchpad.Kind.Holders, address(parent));
        assertGt(pad.pendingFees(buybackKey), 0);

        vm.prank(alice);
        vm.expectRevert(JustTagLaunchpad.NotAuthorized.selector);
        pad.executeRoute(buybackKey, 0, 0);

        uint256 supplyBefore = JustTagToken(child).totalSupply();
        vm.startPrank(operator);
        uint256 bought = pad.executeRoute(buybackKey, 0, 1);
        uint256 burned = pad.executeRoute(burnKey, 0, 1);
        vm.stopPrank();
        assertEq(parent.balanceOf(pad.DEAD()), bought);
        assertEq(JustTagToken(child).totalSupply(), supplyBefore - burned);

        uint256 h = pad.pendingFees(holdersKey);
        pad.claim(holdersKey);
        assertEq(operator.balance, h);
    }

    function test_buybackAfterGraduationUsesPool() public {
        JustTagToken t = _launch();
        JustTagLaunchpad.SplitInput[] memory s = new JustTagLaunchpad.SplitInput[](1);
        s[0] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.Buyback, bytes32(uint256(uint160(address(t)))), 10_000);
        vm.prank(operator);
        address child = pad.createToken("Child", "KID", "", 0, s, 0);
        vm.prank(alice);
        pad.buy{value: 3 ether}(child, 0, alice, block.timestamp);
        vm.prank(alice);
        pad.buy{value: 10 ether}(address(t), 0, alice, block.timestamp); // graduate parent
        bytes32 key = pad.routeKey(JustTagLaunchpad.Kind.Buyback, address(t));
        vm.prank(operator);
        uint256 out = pad.executeRoute(key, 0, 1);
        assertEq(t.balanceOf(pad.DEAD()), out);
    }

    function test_withdrawProtocolFees() public {
        JustTagToken t = _launch();
        vm.prank(alice);
        pad.buy{value: 1 ether}(address(t), 0, alice, block.timestamp);
        uint256 accrued = pad.protocolFeesAccrued();
        pad.withdrawProtocolFees();
        assertEq(treasury.balance, accrued);
    }

    function testFuzz_solvency(uint96 a, uint96 b, uint8 sellPct) public {
        JustTagToken t = _launch();
        uint256 x = bound(uint256(a), 1e9, 2 ether);
        uint256 y = bound(uint256(b), 1e9, 1 ether);
        vm.prank(alice);
        uint256 ga = pad.buy{value: x}(address(t), 0, alice, block.timestamp);
        vm.prank(bob);
        uint256 gb = pad.buy{value: y}(address(t), 0, bob, block.timestamp);
        uint256 sa = ga * bound(sellPct, 1, 100) / 100;
        vm.startPrank(alice);
        t.approve(address(pad), sa);
        pad.sell(address(t), sa, 0, alice, block.timestamp);
        vm.stopPrank();
        vm.startPrank(bob);
        t.approve(address(pad), gb);
        pad.sell(address(t), gb, 0, bob, block.timestamp);
        vm.stopPrank();
        (,, uint256 realEth,,,,,) = pad.curves(address(t));
        assertGe(address(pad).balance, realEth + pad.protocolFeesAccrued() + pad.pendingFees(tagger) + pad.pendingFees(poster));
    }

    function _sign(bytes32 key, address wallet, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(pad.BIND_TYPEHASH(), key, wallet, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", pad.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
