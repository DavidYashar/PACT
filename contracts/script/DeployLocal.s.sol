// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PactEscrow} from "../src/PactEscrow.sol";
import {PactNames} from "../src/PactNames.sol";
import {MockWIF} from "../src/MockWIF.sol";

/// @notice Local end-to-end run: mock token, escrow, and a few funded actors.
///
///   anvil
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Anvil's first two default keys become the employer and the worker.
contract DeployLocal is Script {
    address constant EMPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant WORKER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant TREASURY = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address constant RESOLVER = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    uint256 constant SEED = 1_000_000e18;

    function run() external returns (MockWIF wif, PactNames names, PactEscrow escrow) {
        vm.startBroadcast();

        wif = new MockWIF();
        names = new PactNames();
        escrow = new PactEscrow(wif, TREASURY, RESOLVER, address(names), 14 days, 3 days, 7 days);
        names.setEscrow(address(escrow));

        wif.mint(EMPLOYER, SEED);
        wif.mint(WORKER, SEED);
        wif.mint(TREASURY, 0);
        wif.mint(RESOLVER, SEED);

        vm.stopBroadcast();

        console.log("WIF       ", address(wif));
        console.log("PactNames ", address(names));
        console.log("PactEscrow", address(escrow));
        console.log("employer ", EMPLOYER);
        console.log("worker   ", WORKER);
        console.log("treasury ", TREASURY);
        console.log("resolver ", RESOLVER);
    }
}
