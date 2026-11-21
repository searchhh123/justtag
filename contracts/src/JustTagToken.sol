// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title JustTagToken
/// @notice Fixed-supply ERC20 minted once to the JustTag launchpad, which sells it on a bonding curve.
///         Until the coin graduates, nobody but the launchpad can send tokens into the DEX pair. That stops
///         anyone from seeding the pool at a bad price before the launchpad migrates the real liquidity.
contract JustTagToken is ERC20, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    address public immutable launchpad;
    address public pair;
    bool public graduated;
    string public metadataURI;

    error OnlyLaunchpad();
    error PairLockedUntilGraduation();

    constructor(string memory name_, string memory symbol_, string memory uri_) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        metadataURI = uri_;
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    /// @notice Set once by the launchpad, in the same transaction that deploys the token.
    function initPair(address pair_) external {
        if (msg.sender != launchpad || pair != address(0)) revert OnlyLaunchpad();
        pair = pair_;
    }

    /// @notice Called once by the launchpad right before it seeds the DEX pool.
    function markGraduated() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        graduated = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && to == pair && pair != address(0) && from != launchpad) {
            revert PairLockedUntilGraduation();
        }
        super._update(from, to, value);
    }
}
