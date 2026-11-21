// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title JustTagAirdrop
/// @notice Pays a list of holders in one transaction. The agent runner uses it for the "Holders" route.
///         A failed transfer to one recipient (a contract that rejects ETH) is skipped and refunded to the sender.
contract JustTagAirdrop {
    event Airdropped(address indexed token, address indexed sender, uint256 total, uint256 recipients);

    error LengthMismatch();
    error ValueMismatch();

    function multisend(address token, address[] calldata to, uint256[] calldata amounts) external payable {
        if (to.length != amounts.length) revert LengthMismatch();
        uint256 total;
        uint256 refund;
        for (uint256 i; i < to.length; ++i) {
            total += amounts[i];
            (bool ok,) = to[i].call{value: amounts[i], gas: 10_000}("");
            if (!ok) refund += amounts[i];
        }
        if (total != msg.value) revert ValueMismatch();
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok);
        }
        emit Airdropped(token, msg.sender, total - refund, to.length);
    }
}
