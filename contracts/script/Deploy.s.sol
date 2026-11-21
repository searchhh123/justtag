// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {JustTagLaunchpad} from "../src/JustTagLaunchpad.sol";
import {JustTagAirdrop} from "../src/JustTagAirdrop.sol";

/// Deploys the launchpad on Robinhood Chain (mainnet 4663) against the official Uniswap V2 deployment.
/// Env: OWNER, ATTESTER, OPERATOR, TREASURY (addresses). Optional overrides: INIT_VIRTUAL_ETH, CREATION_FEE,
/// MIGRATION_FEE, PROTOCOL_FEE_BPS, CREATOR_FEE_BPS, V2_FACTORY, WETH.
contract Deploy is Script {
    // https://docs.robinhood.com/chain/contracts and Uniswap v2 deployments page
    address constant RH_V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address constant RH_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external returns (JustTagLaunchpad pad) {
        JustTagLaunchpad.Config memory cfg = JustTagLaunchpad.Config({
            // 1.26 ETH ~= pump.fun's 30 virtual SOL at ETH $1,682 / SOL $70.62 (CoinGecko, 2026-11-21)
            initVirtualEth: vm.envOr("INIT_VIRTUAL_ETH", uint256(1.26 ether)),
            initVirtualToken: 1_073_000_000 ether,
            curveSupply: 793_100_000 ether,
            creationFee: vm.envOr("CREATION_FEE", uint256(0.001 ether)),
            migrationFee: vm.envOr("MIGRATION_FEE", uint256(0.05 ether)),
            protocolFeeBps: uint16(vm.envOr("PROTOCOL_FEE_BPS", uint256(65))),
            creatorFeeBps: uint16(vm.envOr("CREATOR_FEE_BPS", uint256(60)))
        });

        vm.startBroadcast();
        pad = new JustTagLaunchpad(
            vm.envAddress("OWNER"),
            vm.envOr("V2_FACTORY", RH_V2_FACTORY),
            vm.envOr("WETH", RH_WETH),
            30,
            vm.envAddress("ATTESTER"),
            vm.envAddress("OPERATOR"),
            vm.envAddress("TREASURY"),
            cfg
        );
        JustTagAirdrop airdrop = new JustTagAirdrop();
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("d", "launchpad", address(pad));
        json = vm.serializeAddress("d", "airdrop", address(airdrop));
        json = vm.serializeUint("d", "chainId", block.chainid);
        json = vm.serializeUint("d", "deployedAtTimestamp", block.timestamp);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("JustTagLaunchpad", address(pad));
    }
}
