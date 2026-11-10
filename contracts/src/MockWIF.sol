// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local stand-in for $WIF, used by the tests and by a local anvil deployment. Open mint,
///         18 decimals, plain ERC-20. Never deployed to mainnet: the real token is at a fixed address.
contract MockWIF is ERC20 {
    constructor() ERC20("World is Flat (test)", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
