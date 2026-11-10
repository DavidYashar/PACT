// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PactEscrow} from "../src/PactEscrow.sol";
import {PactNames} from "../src/PactNames.sol";

/// @notice The real $WIF, on the real chain, against a freshly deployed escrow.
///
/// Everything else in the suite runs on `MockWIF`, which we wrote ourselves — so it proves our
/// logic and nothing about the token we are actually paid in. This file exists to close that gap:
/// it forks Robinhood Chain mainnet (4663), funds both sides with the real token taken from a
/// real holder, and walks a whole job through to a claim.
///
///   MAINNET_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
///     forge test --match-contract MainnetTokenFork -vv
///
/// Skips itself when no RPC is configured, so it never breaks a plain `forge test`.
///
/// What the token turned out to be, read off its bytecode before this test was written: eighteen
/// dispatch entries — the nine ERC-20 functions, `burn`, `burnFrom`, and seven read-only metadata
/// views for the launchpad that minted it (`launchFactory`, `deployer`, `curve`, `socials`,
/// `description`, `logo`, `getTokenInfo`). No owner, no mint, no pause, no blacklist, no fee, no
/// permit, no upgrade path. The tests below assert the parts PACT actually depends on.
contract MainnetTokenFork is Test {
    IERC20 constant WIF = IERC20(0x5173b8eA6923c2d40267890D45C46a3480954773);

    /// The Uniswap v4 PoolManager holds the WIF side of the only pool. Using a real holder means
    /// the funding step is a real transfer of real tokens, not a storage write.
    address constant REAL_HOLDER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    uint256 constant PRICE = 1_000e18;
    uint256 constant BOND = 500e18;
    uint256 constant CUT = 50e18;

    PactEscrow escrow;
    PactNames names;

    address employer = makeAddr("mainnet-employer");
    address worker = makeAddr("mainnet-worker");
    address treasury = makeAddr("mainnet-treasury");
    address resolver = makeAddr("mainnet-resolver");

    /// @dev The happy path, end to end, with the token that will settle real money.
    function test_Mainnet_HappyPathWithTheRealToken() public {
        _fork();
        _deploy();

        // Real tokens out of a real holder, so the escrow is holding the same asset the pool is.
        _fund(employer, 10_000e18);
        _fund(worker, 10_000e18);

        vm.prank(employer);
        WIF.approve(address(escrow), type(uint256).max);
        vm.prank(worker);
        WIF.approve(address(escrow), type(uint256).max);

        vm.prank(employer);
        names.register("forkemployer", PactNames.Kind.HUMAN);
        vm.prank(worker);
        names.register("forkworker", PactNames.Kind.AI);

        uint256 escrowBefore = WIF.balanceOf(address(escrow));

        uint256 jobId;
        {
            vm.prank(employer);
            jobId = escrow.postJob(
                keccak256("a job paid in the real token"),
                PRICE,
                uint64(block.timestamp + 1 hours),
                uint64(block.timestamp + 2 days),
                14 days
            );
        }
        // The budget landed whole: a fee-on-transfer token would already be short here.
        assertEq(WIF.balanceOf(address(escrow)) - escrowBefore, PRICE, "the budget arrived whole");

        vm.prank(worker);
        escrow.bid(jobId, PRICE);
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);

        // Both stakes, exactly, in custody.
        assertEq(
            WIF.balanceOf(address(escrow)) - escrowBefore, PRICE + BOND, "both stakes arrived whole"
        );

        vm.prank(worker);
        escrow.submitDelivery(jobId, keccak256("the deliverable"));
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        vm.prank(worker);
        names.record(jobId);

        uint256 workerBefore = WIF.balanceOf(worker);
        vm.prank(worker);
        escrow.claim();

        // 1,000 - 50 cut + 500 bond. If the token took a fee on the way out, this is short.
        assertEq(WIF.balanceOf(worker) - workerBefore, 1_450e18, "the worker was paid in full");
        // What is left in the escrow is exactly the platform cut, already owed to the treasury and
        // not yet withdrawn. Its own `claim` is the only thing that moves it.
        assertEq(WIF.balanceOf(address(escrow)) - escrowBefore, CUT, "only the cut remains");
        assertEq(escrow.claimable(treasury), CUT, "and it is owed to the treasury");
        assertEq(names.profileOf(worker).earnedAsWorker, 950e18, "the record agrees");
    }

    /// @dev A ticket, ruling for the employer, settled in the real token. This is the direction
    ///      that pays a refund rather than a wage, so it exercises `safeTransfer` on the other path.
    function test_Mainnet_TicketRuledForTheEmployer() public {
        _fork();
        _deploy();

        _fund(employer, 10_000e18);
        _fund(worker, 10_000e18);

        vm.prank(employer);
        WIF.approve(address(escrow), type(uint256).max);
        vm.prank(worker);
        WIF.approve(address(escrow), type(uint256).max);

        vm.prank(employer);
        names.register("forkemployer2", PactNames.Kind.HUMAN);
        vm.prank(worker);
        names.register("forkworker2", PactNames.Kind.AI);

        uint256 jobId;
        {
            vm.prank(employer);
            jobId = escrow.postJob(
                keccak256("a job that ends in a ticket"),
                PRICE,
                uint64(block.timestamp + 1 hours),
                uint64(block.timestamp + 2 days),
                14 days
            );
        }
        vm.prank(worker);
        escrow.bid(jobId, PRICE);
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);
        vm.prank(worker);
        escrow.submitDelivery(jobId, keccak256("something that does not match"));

        vm.prank(employer);
        escrow.raiseDispute(jobId, keccak256("this is not what the criteria asked for"));
        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);

        vm.prank(employer);
        names.record(jobId);

        uint256 employerBefore = WIF.balanceOf(employer);
        vm.prank(employer);
        escrow.claim();

        // Paid out: the price 1,000 less the 5% cut (950), plus the 50 fine taken off the bond.
        // Against the 1,100 it spent (price + 100 filing fee) that is a net 100, exactly the row in
        // the §4.5 matrix that says "employer files, wins: −10,000" on a 100,000 job.
        assertEq(WIF.balanceOf(employer) - employerBefore, 1_000e18, "refund and fine arrived whole");
        assertEq(escrow.claimable(worker), 450e18, "the worker keeps the bond less the fine");
        assertEq(escrow.claimable(treasury), 150e18, "the fee plus the cut, and nothing else");
    }

    /// @dev The three ERC-20 behaviours PACT silently relies on. If any of these were different,
    ///      the escrow would still compile and would quietly mis-account.
    function test_Mainnet_TheTokenSemanticsTheEscrowReliesOn() public {
        _fork();
        _deploy();
        _fund(employer, 10_000e18);

        assertEq(IERC20Metadata(address(WIF)).decimals(), 18, "18 decimals");
        assertEq(WIF.totalSupply() > 0, true, "the token exists");

        // 1. transfer and transferFrom answer `true` rather than reverting silently.
        vm.prank(employer);
        assertTrue(WIF.transfer(worker, 1e18), "transfer returns true");
        assertEq(WIF.balanceOf(worker), 1e18, "the recipient gets exactly what was sent");

        // 2. transferFrom decrements the allowance by exactly the amount pulled.
        vm.prank(employer);
        WIF.approve(address(escrow), 100e18);
        assertEq(WIF.allowance(employer, address(escrow)), 100e18, "allowance set");
        vm.prank(address(escrow));
        WIF.transferFrom(employer, address(escrow), 40e18);
        assertEq(WIF.allowance(employer, address(escrow)), 60e18, "allowance decremented exactly");
        assertEq(WIF.balanceOf(address(escrow)), 40e18, "and the amount arrived whole");

        // 3. approve over an existing non-zero allowance is allowed (not USDT-style), so a second
        //    bond top-up from the same wallet does not revert.
        vm.prank(employer);
        WIF.approve(address(escrow), 500e18);
        assertEq(WIF.allowance(employer, address(escrow)), 500e18, "approve over non-zero works");
    }

    /// @dev There is no privileged surface on the token. Recorded as a test because it is the
    ///      reason a compromise of the launchpad or the deployer wallet cannot mint into a job or
    ///      freeze an escrow mid-flight.
    function test_Mainnet_NoAdminSurface() public {
        _fork();
        _deploy();

        string[5] memory absent = [
            "owner()",
            "mint(address,uint256)",
            "pause()",
            "blacklist(address)",
            "setFee(uint256)"
        ];
        for (uint256 i = 0; i < absent.length; i++) {
            (bool ok,) = address(WIF).call(abi.encodeWithSignature(absent[i], address(this), uint256(0)));
            assertFalse(ok, string.concat("the token has no ", absent[i]));
        }
    }

    // ------------------------------------------------------------------------------------------

    function _fork() internal {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pinned = vm.envOr("MAINNET_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);

        require(block.chainid == 4663, "not Robinhood Chain mainnet");
        require(address(WIF).code.length > 0, "no WIF at that address on this chain");
    }

    function _deploy() internal {
        names = new PactNames();
        escrow = new PactEscrow(WIF, treasury, resolver, address(names), 14 days, 300, 30 days);
        names.setEscrow(address(escrow));
    }

    /// @dev A real transfer from a real holder. `deal` would be faster and would prove less.
    function _fund(address to, uint256 amount) internal {
        vm.prank(REAL_HOLDER);
        assertTrue(WIF.transfer(to, amount), "funding transfer");
        assertEq(WIF.balanceOf(to), amount, "funded with real tokens");
    }
}
