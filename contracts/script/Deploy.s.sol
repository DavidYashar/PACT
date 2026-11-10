// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PactEscrow} from "../src/PactEscrow.sol";
import {PactNames} from "../src/PactNames.sol";

/// @notice Deploy to Robinhood Chain (4663). WIF is fixed; treasury and resolver come from env.
///
///   TREASURY=0x... RESOLVER=0x... PRIVATE_KEY=0x... \
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
contract Deploy is Script {
    address internal constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    uint256 internal constant MAINNET_CHAIN_ID = 4663;

    function run() external returns (PactNames names, PactEscrow escrow) {
        /// Asserted, not trusted. A `--rpc-url` left over from another session would otherwise
        /// deploy a mainnet-shaped escrow on a chain where that WIF address means something else —
        /// or a mintable test token that would make the bond free to manufacture.
        require(block.chainid == MAINNET_CHAIN_ID, "not Robinhood Chain mainnet: check --rpc-url");

        address treasury = vm.envAddress("TREASURY");
        address resolver = vm.envAddress("RESOLVER");
        require(treasury != address(0), "TREASURY is empty");
        require(resolver != address(0), "RESOLVER is empty");
        require(treasury != resolver, "treasury and resolver must be different wallets");
        require(IERC20(WIF).totalSupply() > 0, "no WIF at the expected address on this chain");

        /// The deployer pays gas, so it must be a third wallet. If it is either of the other two,
        /// one key ends up collecting the fee, judging tickets *and* signing this deployment, and
        /// the separation of roles that makes the fee credible is gone before the first job exists.
        address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));
        require(deployer != treasury, "the deployer is the treasury: use a separate wallet");
        require(deployer != resolver, "the deployer is the resolver: use a separate wallet");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        // Registry first, then the escrow that points at it, then the one-time back-pointer.
        names = new PactNames();
        escrow = new PactEscrow(IERC20(WIF), treasury, resolver, address(names), 14 days, 3 days, 30 days);
        names.setEscrow(address(escrow));
        vm.stopBroadcast();

        console.log("");
        console.log("chain id      ", block.chainid);
        console.log("PactNames     ", address(names));
        console.log("PactEscrow    ", address(escrow));
        console.log("WIF           ", WIF);
        console.log("deployer      ", deployer);
        console.log("treasury      ", treasury);
        console.log("resolver      ", resolver);
        console.log("auto-release  ", "14 days (default; each job carries its own)");
        console.log("stale grace   ", "3 days");
        console.log("ticket timeout", "30 days");
        console.log("counted floor ", PactNames(address(names)).MIN_COUNTED_PRICE(), "wei (100 WIF)");
        console.log("");
        console.log("constructor args for verification:");
        console.log("  wif, treasury, resolver, names, 1209600, 259200, 2592000");
    }
}
