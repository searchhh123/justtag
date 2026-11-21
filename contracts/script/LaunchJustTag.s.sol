// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {JustTagLaunchpad} from "../src/JustTagLaunchpad.sol";

/// Launches $JUSTTAG itself through the launchpad, the same way every tagged coin launches.
/// Run it with the OPERATOR key so it launches free. Env: LAUNCHPAD, JUSTTAG_URI (metadata JSON URL),
/// JUSTTAG_X_HANDLE (lowercase, no at-sign: the account that receives the creator fees), DEV_BUY_WEI (optional).
contract LaunchJustTag is Script {
    function run() external returns (address token) {
        JustTagLaunchpad pad = JustTagLaunchpad(payable(vm.envAddress("LAUNCHPAD")));
        string memory handle = vm.envString("JUSTTAG_X_HANDLE");
        JustTagLaunchpad.SplitInput[] memory s = new JustTagLaunchpad.SplitInput[](1);
        s[0] = JustTagLaunchpad.SplitInput(JustTagLaunchpad.Kind.XAccount, keccak256(abi.encodePacked("x:", handle)), 10_000);

        vm.startBroadcast();
        token = pad.createToken{value: vm.envOr("DEV_BUY_WEI", uint256(0))}(
            "JustTag", "JUSTTAG", vm.envString("JUSTTAG_URI"), keccak256("JUSTTAG-genesis"), s, 0
        );
        vm.stopBroadcast();
        console2.log("$JUSTTAG", token);
    }
}
