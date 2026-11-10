// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PactEscrow} from "../src/PactEscrow.sol";
import {PactTypes} from "../src/PactTypes.sol";

/// @dev What a real deployment uses. Tests warp time, so the window size is irrelevant here.
uint64 constant AUTO_RELEASE_TEST = 14 days;
// A grace long enough to prove the stale-job path still refuses early calls.
uint64 constant STALE_GRACE_TEST = 3 days;
uint64 constant DISPUTE_TIMEOUT_TEST = 7 days;

contract MockWIF is ERC20 {
    constructor() ERC20("World is Flat", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stands in for PactNames so the money tests stay about money. The real registry, and the
///      real record-then-claim handshake, are exercised in PactNames.t.sol.
contract MockNames {
    bool public allow = true;

    function setAllow(bool v) external {
        allow = v;
    }

    function isRegistered(address) external view returns (bool) {
        return allow;
    }
}

/// @notice Every test below is a row of the settlement matrix in the agent spec, §4.5.
contract PactEscrowTest is Test {
    MockWIF internal wif;
    PactEscrow internal escrow;

    address internal employer = makeAddr("employer");
    address internal worker = makeAddr("worker");
    address internal treasury = makeAddr("treasury");
    address internal resolver = makeAddr("resolver");
    address internal stranger = makeAddr("stranger");
    MockNames internal namesMock;

    uint256 internal constant START = 1_000_000e18;
    uint256 internal constant P = 100_000e18;
    uint256 internal constant BOND = 50_000e18;
    uint256 internal constant FILING_FEE = 10_000e18;
    uint256 internal constant CUT = 5_000e18;

    bytes32 internal constant TERMS = keccak256("landing page, friday, live url as proof");
    bytes32 internal constant PROOF = keccak256("https://example.com");
    bytes32 internal constant REASON = keccak256("not what I asked for");

    function setUp() public {
        wif = new MockWIF();
        namesMock = new MockNames();
        escrow = new PactEscrow(wif, treasury, resolver, address(namesMock), AUTO_RELEASE_TEST, STALE_GRACE_TEST, DISPUTE_TIMEOUT_TEST);

        wif.mint(employer, START);
        wif.mint(worker, START);
        wif.mint(resolver, START);

        vm.prank(employer);
        wif.approve(address(escrow), type(uint256).max);
        vm.prank(worker);
        wif.approve(address(escrow), type(uint256).max);
        vm.prank(resolver);
        wif.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------- the matrix

    function test_Approved() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(employer);
        escrow.approveDelivery(jobId);

        _claimAll();

        assertEq(wif.balanceOf(employer), START - P, "employer pays the price");
        assertEq(wif.balanceOf(worker), START + 95_000e18, "worker keeps price minus cut, plus bond");
        assertEq(wif.balanceOf(treasury), CUT, "treasury takes 5%");
    }

    function test_WorkerAbandons() public {
        uint256 jobId = _postAndAccept();

        vm.prank(worker);
        escrow.abandonJob(jobId);

        _claimAll();

        assertEq(wif.balanceOf(employer), START + 45_000e18, "employer refunded minus cut, plus bond");
        assertEq(wif.balanceOf(worker), START - BOND, "worker loses the whole bond");
        assertEq(wif.balanceOf(treasury), CUT, "treasury still takes 5%");
    }

    function test_WorkerFilesAndWins() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_WORKER, 1_000);

        _claimAll();

        assertEq(wif.balanceOf(employer), START - P, "employer pays the price");
        assertEq(wif.balanceOf(worker), START + 85_000e18, "worker: bond - fee + release");
        assertEq(wif.balanceOf(treasury), FILING_FEE + CUT, "filing fee + cut");
    }

    function test_WorkerFilesAndLoses() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);

        _claimAll();

        assertEq(wif.balanceOf(employer), START, "employer made whole");
        assertEq(wif.balanceOf(worker), START - 15_000e18, "worker: fee + fine");
        assertEq(wif.balanceOf(treasury), FILING_FEE + CUT, "filing fee + cut");
    }

    function test_EmployerFilesAndWins() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(employer);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);

        _claimAll();

        assertEq(wif.balanceOf(employer), START - FILING_FEE, "employer: filing fee minus the fine they recover");
        assertEq(wif.balanceOf(worker), START - 5_000e18, "worker: loses the fine");
        assertEq(wif.balanceOf(treasury), FILING_FEE + CUT, "filing fee + cut");
    }

    function test_EmployerFilesAndLoses() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(employer);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_WORKER, 1_000);

        _claimAll();

        assertEq(wif.balanceOf(employer), START - P - FILING_FEE, "employer: price + filing fee, keeps the work");
        assertEq(wif.balanceOf(worker), START + 95_000e18, "worker untouched by the bogus ticket");
        assertEq(wif.balanceOf(treasury), FILING_FEE + CUT, "filing fee + cut");
    }

    // ------------------------------------------------------------- guard rails

    function test_DisputeFreezesAutoRelease() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);

        vm.warp(block.timestamp + 14 days + 1);

        vm.expectRevert(PactEscrow.WrongState.selector);
        escrow.releaseExpired(jobId);
    }

    function test_AutoReleaseAfterSilence() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.warp(block.timestamp + 14 days + 1);

        vm.prank(stranger);
        escrow.releaseExpired(jobId);

        _claimAll();

        assertEq(wif.balanceOf(worker), START + 95_000e18, "worker paid without an employer");
        assertEq(wif.balanceOf(treasury), CUT, "treasury takes 5%");
    }

    function test_AutoReleaseTooEarlyReverts() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.warp(block.timestamp + 14 days - 1 hours);

        vm.expectRevert(PactEscrow.NotYetReleasable.selector);
        escrow.releaseExpired(jobId);
    }

    function test_CannotSettleTwice() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.startPrank(employer);
        escrow.approveDelivery(jobId);

        vm.expectRevert(PactEscrow.WrongState.selector);
        escrow.approveDelivery(jobId);
        vm.stopPrank();
    }

    function test_DisputeAfterSettlementReverts() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(employer);
        escrow.approveDelivery(jobId);

        vm.expectRevert(PactEscrow.WrongState.selector);
        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);
    }

    function test_NonPartyCannotFile() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotParty.selector);
        escrow.raiseDispute(jobId, REASON);
    }

    function test_OnlyResolverCanRule() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(employer);
        vm.expectRevert(PactEscrow.NotResolver.selector);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);
    }

    function test_FineAboveCapReverts() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(resolver);
        vm.expectRevert(PactEscrow.FineTooHigh.selector);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_001);
    }

    function test_ResolverCannotRuleOnOwnJob() public {
        // The resolver is also the employer here — the exact setup a naive deploy produces.
        vm.prank(resolver);
        uint256 jobId = escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(worker);
        escrow.bid(jobId, P);

        vm.prank(resolver);
        escrow.acceptBid(jobId, 0);

        vm.prank(worker);
        escrow.submitDelivery(jobId, PROOF);

        vm.prank(worker);
        escrow.raiseDispute(jobId, REASON);

        vm.prank(resolver);
        vm.expectRevert(PactEscrow.ResolverIsParty.selector);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);
    }

    function test_ClaimTwiceReverts() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);
        _unlock(jobId);

        vm.prank(worker);
        escrow.claim();

        vm.prank(worker);
        vm.expectRevert(PactEscrow.ZeroAmount.selector);
        escrow.claim();
    }

    function test_EmployerCannotBidOnOwnJob() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(employer);
        vm.expectRevert(PactEscrow.SelfJob.selector);
        escrow.bid(jobId, P);
    }

    function test_CannotDeliverAfterDeadline() public {
        uint256 jobId = _postAndAccept();
        vm.warp(block.timestamp + 8 days);

        vm.prank(worker);
        vm.expectRevert(PactEscrow.PastDeadline.selector);
        escrow.submitDelivery(jobId, PROOF);
    }

    function test_CancelRefundsBudget() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(employer);
        escrow.cancelJob(jobId);

        vm.prank(employer);
        escrow.claim();

        assertEq(wif.balanceOf(employer), START, "full refund, no fee on a cancelled job");
    }

    function test_AcceptRefundsSurplus() public {
        uint256 budget = 200_000e18;
        vm.prank(employer);
        uint256 jobId = escrow.postJob(TERMS, budget, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(worker);
        escrow.bid(jobId, P);

        vm.prank(employer);
        escrow.acceptBid(jobId, 0);

        vm.prank(employer);
        escrow.claim();

        assertEq(wif.balanceOf(employer), START - P, "only the accepted price stays locked");
    }

    // ------------------------------------------------------------ claim gate

    function test_ClaimBlockedUntilRecorded() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        assertEq(escrow.unrecorded(worker), 1, "worker owes a record");
        assertEq(escrow.unrecorded(employer), 1, "employer owes one too");

        vm.prank(worker);
        vm.expectRevert(PactEscrow.RecordPending.selector);
        escrow.claim();

        _unlock(jobId);

        vm.prank(worker);
        escrow.claim();
        assertEq(wif.balanceOf(worker), START + 95_000e18);
    }

    function test_OneRecordUnlocksBothSides() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        _unlock(jobId);

        assertEq(escrow.unrecorded(employer), 0, "employer cleared");
        assertEq(escrow.unrecorded(worker), 0, "worker cleared in the same call");
    }

    function test_TwoUnclaimedJobsAreGatedIndependently() public {
        uint256 a = _postAndAccept();
        _deliver(a);
        vm.prank(employer);
        escrow.approveDelivery(a);

        uint256 b = _postAndAccept();
        _deliver(b);
        vm.prank(employer);
        escrow.approveDelivery(b);

        _unlock(a);
        assertEq(escrow.unrecorded(worker), 1, "job b still blocks");

        vm.prank(worker);
        vm.expectRevert(PactEscrow.RecordPending.selector);
        escrow.claim();

        _unlock(b);
        vm.prank(worker);
        escrow.claim();
        assertEq(wif.balanceOf(worker), START + 2 * 95_000e18, "both paid in one claim");
    }

    function test_RevertWhen_NonRegistryConfirms() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotRegistry.selector);
        escrow.confirmRecorded(jobId);
    }

    function test_RevertWhen_ConfirmingTwice() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        _unlock(jobId);
        vm.prank(address(namesMock));
        vm.expectRevert(PactEscrow.AlreadyRecorded.selector);
        escrow.confirmRecorded(jobId);
    }

    function test_RevertWhen_ConfirmingUnsettledJob() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(address(namesMock));
        vm.expectRevert(PactEscrow.WrongState.selector);
        escrow.confirmRecorded(jobId);
    }

    function test_SettlementFactsRecordWorkerWin() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        PactEscrow.Job memory j = escrow.getJob(jobId);
        assertTrue(j.workerWon);
        assertEq(j.toWorkerPaid, P - CUT + BOND);
        assertEq(j.toEmployerPaid, 0);
        assertEq(j.settledAt, block.timestamp);
    }

    function test_SettlementFactsRecordEmployerWin() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.raiseDispute(jobId, REASON);
        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);

        PactEscrow.Job memory j = escrow.getJob(jobId);
        assertFalse(j.workerWon);
        assertEq(j.toEmployerPaid, P - CUT + 5_000e18, "refund plus the fine");
        assertEq(j.toWorkerPaid, BOND - 5_000e18, "bond minus the fine");
    }

    function test_BidChecksBondAffordability() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        address thin = makeAddr("thin");
        // Exactly the bond, and nothing more, approved so acceptBid can pull it.
        wif.mint(thin, BOND);
        vm.prank(thin);
        wif.approve(address(escrow), BOND);
        vm.prank(thin);
        escrow.bid(jobId, P);
        assertEq(escrow.bidCount(jobId), 1, "a bidder holding exactly the bond may bid");

        address empty = makeAddr("empty");
        vm.prank(empty);
        vm.expectRevert(PactEscrow.BondUnfunded.selector);
        escrow.bid(jobId, P);

        // One wei short of the bond is still short.
        address short_ = makeAddr("short");
        wif.mint(short_, BOND - 1);
        vm.prank(short_);
        wif.approve(address(escrow), BOND);
        vm.prank(short_);
        vm.expectRevert(PactEscrow.BondUnfunded.selector);
        escrow.bid(jobId, P);

        assertEq(escrow.bidCount(jobId), 1, "only the funded bid landed");
    }

    /// A bid the bidder has not approved is a trap for the employer: acceptBid pulls the bond, so
    /// the acceptance would revert inside someone else's transaction. Check the allowance at bid.
    function test_RevertWhen_BiddingWithoutAnAllowance() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        address funded = makeAddr("funded");
        wif.mint(funded, BOND);
        vm.prank(funded);
        vm.expectRevert(PactEscrow.BondUnapproved.selector);
        escrow.bid(jobId, P);

        // Approve, and the same bid lands.
        vm.prank(funded);
        wif.approve(address(escrow), BOND);
        vm.prank(funded);
        escrow.bid(jobId, P);
        assertEq(escrow.bidCount(jobId), 1, "the approved bid landed");
    }

    /// One live bid per wallet per job, so a single wallet cannot append unbounded bids. Withdraw
    /// first and the wallet may bid again at a new price — in the same slot, so bid/withdraw can
    /// never grow the array and eventually make every bid read fail to decode.
    function test_OneLiveBidPerWorker() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.startPrank(worker);
        wif.approve(address(escrow), type(uint256).max);
        escrow.bid(jobId, P);
        vm.expectRevert(PactEscrow.AlreadyBid.selector);
        escrow.bid(jobId, P - 1);

        escrow.withdrawBid(jobId, 0);
        escrow.bid(jobId, P - 1);
        vm.stopPrank();
        assertEq(escrow.bidCount(jobId), 1, "the slot is reused, not appended");

        PactEscrow.Bid[] memory bids = escrow.getBids(jobId);
        assertEq(bids[0].price, P - 1, "the entry carries the new price");
        assertFalse(bids[0].withdrawn, "and it is live again");

        // The audit's growth vector: bid and withdraw in a loop. The list must not move.
        for (uint256 i = 0; i < 5; i++) {
            vm.startPrank(worker);
            escrow.withdrawBid(jobId, 0);
            escrow.bid(jobId, P - 2);
            vm.stopPrank();
        }
        assertEq(escrow.bidCount(jobId), 1, "volume does not grow the list");
    }

    /// An index past the end of the list is a caller error, not a panic. The old code indexed the
    /// array and reverted with 0x32, which no client can decode into a sentence.
    function test_RevertWhen_BidIndexIsOutOfRange() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(worker);
        vm.expectRevert(PactEscrow.BidUnavailable.selector);
        escrow.withdrawBid(jobId, 7);

        vm.prank(employer);
        vm.expectRevert(PactEscrow.BidUnavailable.selector);
        escrow.acceptBid(jobId, 7);
    }

    /// The exploit the audit found: an employer waiting until the delivery deadline had passed and
    /// accepting a bid anyway, which pulls a live bond the worker can no longer earn back.
    function test_RevertWhen_AcceptingAfterTheBidWindow() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.startPrank(worker);
        wif.approve(address(escrow), type(uint256).max);
        escrow.bid(jobId, P);
        vm.stopPrank();

        // Past the delivery deadline, and long past the bid window.
        vm.warp(block.timestamp + 8 days);
        vm.prank(employer);
        vm.expectRevert(PactEscrow.BidWindowClosed.selector);
        escrow.acceptBid(jobId, 0);

        assertEq(uint256(escrow.getJob(jobId).state), 1, "the job is still open, nothing was pulled");
    }

    /// A worker who is assigned and then vanishes must not freeze both stakes forever. After the
    /// delivery deadline plus the grace period, anyone may settle it as an abandonment.
    function test_ReclaimAssignmentAfterTheWorkerVanishes() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.startPrank(worker);
        wif.approve(address(escrow), type(uint256).max);
        escrow.bid(jobId, P);
        vm.stopPrank();
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);

        // Too early: the delivery deadline has not even passed.
        vm.prank(stranger);
        vm.expectRevert(PactEscrow.JobNotStale.selector);
        escrow.reclaimAssignment(jobId);

        vm.warp(block.timestamp + 7 days + STALE_GRACE_TEST + 1);
        uint256 employerBefore = wif.balanceOf(employer);

        // A stranger can do it: the money goes back to the employer regardless of who calls.
        vm.prank(stranger);
        escrow.reclaimAssignment(jobId);

        assertEq(uint256(escrow.getJob(jobId).state), 5, "settled");
        assertEq(escrow.claimable(employer), P - CUT + BOND, "price minus the cut, plus the forfeited bond");
        assertEq(escrow.claimable(worker), 0, "the worker keeps nothing");
        assertEq(wif.balanceOf(employer), employerBefore, "nothing is pushed, it is claimed");
    }

    /// Filing a ticket after the silence window has expired would make the auto-release guarantee
    /// meaningless: the employer could front-run releaseExpired and hand a finished job to the
    /// resolver. The employer's objection window ends at autoReleaseAt.
    function test_RevertWhen_EmployerFilesAfterTheSilenceWindow() public {
        vm.prank(employer);
        uint256 jobId =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);
        vm.startPrank(worker);
        wif.approve(address(escrow), type(uint256).max);
        escrow.bid(jobId, P);
        vm.stopPrank();
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);
        vm.prank(worker);
        escrow.submitDelivery(jobId, PROOF);

        uint256 autoReleaseAt = escrow.getJob(jobId).autoReleaseAt;
        vm.warp(autoReleaseAt + 1);

        vm.prank(employer);
        vm.expectRevert(PactEscrow.PastDeadline.selector);
        escrow.raiseDispute(jobId, keccak256("too late"));

        // The worker could still file, but has no reason to: the money is already theirs to release.
        vm.prank(worker);
        escrow.releaseExpired(jobId);
        assertEq(uint256(escrow.getJob(jobId).state), 5, "settled by the clock");
    }

    // ------------------------------------------------- the four paths, one formula

    /// @dev The money table in SKILL.md is generated from `quote`, so the property that matters is
    ///      that `quote` and the escrow agree. Each path is settled for real and compared.
    function test_QuoteMatchesRelease() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        PactEscrow.Quote memory q =
            escrow.quote(PactEscrow.Path.RELEASE, P, P / 2, P, P / 2, 0);

        vm.prank(employer);
        escrow.approveDelivery(jobId);

        assertEq(escrow.claimable(worker), q.toWorker, "release pays what it quoted");
        assertEq(escrow.claimable(treasury), q.toTreasury, "release takes what it quoted");
        assertEq(q.toEmployer, 0, "a release credits the employer nothing");
    }

    function test_QuoteMatchesAbandon() public {
        uint256 jobId = _postAndAccept();

        PactEscrow.Quote memory q =
            escrow.quote(PactEscrow.Path.ABANDON, P, P / 2, P, P / 2, 0);

        vm.prank(worker);
        escrow.abandonJob(jobId);

        assertEq(escrow.claimable(employer), q.toEmployer, "abandon refunds what it quoted");
        assertEq(escrow.claimable(treasury), q.toTreasury, "abandon takes what it quoted");
        assertEq(escrow.claimable(worker), 0, "an abandoning worker is credited nothing");
    }

    function test_QuoteMatchesRuleForWorker() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        // The worker files, so the fee comes out of their bond before the ruling.
        vm.prank(worker);
        escrow.raiseDispute(jobId, keccak256("not what was asked for"));
        uint256 workerEscrow = escrow.getJob(jobId).workerEscrow;

        PactEscrow.Quote memory q =
            escrow.quote(PactEscrow.Path.RULE_FOR_WORKER, P, P / 2, P, workerEscrow, 0);

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_WORKER, 0);

        assertEq(escrow.getJob(jobId).toWorkerPaid, q.toWorker, "the ruling pays what it quoted");
        assertEq(escrow.getJob(jobId).toEmployerPaid, 0, "nothing goes back to the employer");
    }

    function test_QuoteMatchesRuleForEmployer() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(employer);
        escrow.raiseDispute(jobId, keccak256("did not meet the criteria"));
        uint256 workerEscrow = escrow.getJob(jobId).workerEscrow;

        PactEscrow.Quote memory q =
            escrow.quote(PactEscrow.Path.RULE_FOR_EMPLOYER, P, P / 2, P, workerEscrow, 1_000);

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);

        assertEq(escrow.getJob(jobId).toEmployerPaid, q.toEmployer, "the employer side pays what it quoted");
        assertEq(escrow.getJob(jobId).toWorkerPaid, q.toWorker, "the worker side pays what it quoted");
        assertEq(q.fine, (P / 2) * 1_000 / 10_000, "the fine is a tenth of the original bond");
    }

    /// @dev The fine is capped by what is actually left in the worker's escrow, so a maximum fine
    ///      after a filing fee can never underflow.
    function test_QuoteFineNeverExceedsWorkerEscrow() public {
        PactEscrow.Quote memory q =
            escrow.quote(PactEscrow.Path.RULE_FOR_EMPLOYER, P, P / 2, P, 1, 1_000);

        assertEq(q.fine, 1, "the fine is capped at the escrow it is taken from");
        assertEq(q.toWorker, 0, "the worker keeps nothing");
    }

    function test_RevertWhen_QuoteFineTooHigh() public {
        vm.expectRevert(PactEscrow.FineTooHigh.selector);
        escrow.quote(PactEscrow.Path.RULE_FOR_EMPLOYER, P, P / 2, P, P / 2, 1_001);
    }

    /// @dev The registry reads `settlementFacts`, not the job, so the two must never disagree: a
    ///      field that drifts here is a wrong history entry there.
    function test_SettlementFactsAgreeWithTheJob() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        PactEscrow.Job memory job = escrow.getJob(jobId);
        PactTypes.SettlementFacts memory facts = escrow.settlementFacts(jobId);

        assertEq(facts.employer, job.employer, "employer");
        assertEq(facts.worker, job.worker, "worker");
        assertEq(facts.filer, job.filer, "filer");
        assertEq(uint256(facts.state), uint256(job.state), "state");
        assertEq(facts.price, job.price, "price");
        assertEq(facts.bond, job.bond, "bond");
        assertEq(facts.termsHash, job.termsHash, "termsHash");
        assertEq(facts.proofHash, job.proofHash, "proofHash");
        assertEq(facts.workerWon, job.workerWon, "workerWon");
        assertEq(facts.settledAt, job.settledAt, "settledAt");
        assertEq(facts.toEmployerPaid, job.toEmployerPaid, "toEmployerPaid");
        assertEq(facts.toWorkerPaid, job.toWorkerPaid, "toWorkerPaid");
        assertEq(facts.filingFee, 0, "no ticket, no fee");
    }

    // ------------------------------------------------------------ stale jobs

    function test_CancelExpiredJobReturnsTheBudget() public {
        vm.prank(employer);
        uint256 jobId = escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        // Before the grace period is up, nobody can take the job away from its employer.
        vm.warp(block.timestamp + 1 days + uint256(STALE_GRACE_TEST) - 1);
        vm.prank(stranger);
        vm.expectRevert(PactEscrow.JobNotStale.selector);
        escrow.cancelExpiredJob(jobId);

        vm.warp(block.timestamp + 1);
        uint256 before = escrow.claimable(employer);
        vm.prank(stranger);
        escrow.cancelExpiredJob(jobId);

        assertEq(uint8(escrow.getJob(jobId).state), uint8(PactEscrow.State.CANCELLED), "the job is closed");
        assertEq(escrow.claimable(employer) - before, P, "the whole budget returns, with no cut");
        assertEq(escrow.claimable(stranger), 0, "the caller takes nothing for doing it");
    }

    function test_RevertWhen_CancellingAJobThatWasWon() public {
        uint256 jobId = _postAndAccept();
        vm.warp(block.timestamp + 30 days);

        vm.prank(stranger);
        vm.expectRevert(PactEscrow.WrongState.selector);
        escrow.cancelExpiredJob(jobId);
    }

    // ---------------------------------------------------------- bid withdrawal

    function test_WithdrawBidMakesItUnacceptable() public {
        vm.prank(employer);
        uint256 jobId = escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(worker);
        escrow.bid(jobId, P);

        vm.prank(worker);
        escrow.withdrawBid(jobId, 0);
        PactEscrow.Bid[] memory bids = escrow.getBids(jobId);
        assertTrue(bids[0].withdrawn, "the withdrawal is on the record");

        vm.prank(employer);
        vm.expectRevert(PactEscrow.BidUnavailable.selector);
        escrow.acceptBid(jobId, 0);
    }

    function test_RevertWhen_WithdrawingSomeoneElsesBid() public {
        vm.prank(employer);
        uint256 jobId = escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(worker);
        escrow.bid(jobId, P);

        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotWorker.selector);
        escrow.withdrawBid(jobId, 0);
    }

    function test_RevertWhen_WithdrawingAfterAcceptance() public {
        uint256 jobId = _postAndAccept();

        vm.prank(worker);
        vm.expectRevert(PactEscrow.WrongState.selector);
        escrow.withdrawBid(jobId, 0);
    }

    // ------------------------------------------------------ per-job release window

    function test_JobChoosesItsOwnReleaseWindow() public {
        vm.prank(employer);
        uint256 jobId = escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), 2 hours);
        vm.prank(worker);
        escrow.bid(jobId, P);
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);

        uint64 deliveredAt = uint64(block.timestamp);
        _deliver(jobId);
        PactEscrow.Job memory job = escrow.getJob(jobId);

        assertEq(job.autoReleaseDelay, 2 hours, "the job carries the window it was posted with");
        assertEq(uint256(job.autoReleaseAt), uint256(deliveredAt) + 2 hours, "the clock starts at delivery");

        vm.warp(uint256(job.autoReleaseAt) - 1);
        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotYetReleasable.selector);
        escrow.releaseExpired(jobId);

        vm.warp(uint256(job.autoReleaseAt));
        vm.prank(stranger);
        escrow.releaseExpired(jobId);
        assertEq(uint8(escrow.getJob(jobId).state), uint8(PactEscrow.State.SETTLED), "the short window releases it");
    }

    function test_RevertWhen_PostingWithAnOutOfRangeWindow() public {
        vm.prank(employer);
        vm.expectRevert(PactEscrow.DelayOutOfRange.selector);
        escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), 30 seconds);

        vm.prank(employer);
        vm.expectRevert(PactEscrow.DelayOutOfRange.selector);
        escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), 400 days);
    }

    // ------------------------------------------------------------- the timeout

    /// A ticket froze the escrow; nobody decided it; the clock settles it on the facts already on
    /// chain. Nothing was delivered, so the stakes go back where they came from and nobody is
    /// marked — the party who filed has already paid for a review that did not arrive.
    function test_TimeoutDispute_UnwindsStakesWhenNothingWasDelivered() public {
        uint256 jobId = _postAndAccept();

        // The worker files before delivering anything, which is the freeze the audit described.
        vm.prank(worker);
        escrow.raiseDispute(jobId, keccak256("the employer went quiet"));

        assertTrue(escrow.getJob(jobId).state == PactEscrow.State.DISPUTED, "disputed");

        // One second early is not enough.
        vm.warp(block.timestamp + DISPUTE_TIMEOUT_TEST);
        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotYetReleasable.selector);
        escrow.timeoutDispute(jobId);

        uint256 escrowHeld = wif.balanceOf(address(escrow));

        vm.warp(block.timestamp + 1 seconds);
        vm.prank(stranger);
        escrow.timeoutDispute(jobId);

        PactEscrow.Job memory j = escrow.getJob(jobId);
        assertTrue(j.state == PactEscrow.State.SETTLED, "settled by the clock");
        assertTrue(j.timedOut, "flagged as a timeout, not a ruling");
        assertFalse(j.workerWon, "nobody won");
        assertEq(j.toEmployerPaid, P, "the employer's price came back");
        // The filer paid 10% of the price out of their bond when they opened the ticket, so what
        // comes back is the bond less that fee. That fee is the only cost of a review that did not
        // arrive, and it is the same cost whichever way the ticket had gone.
        assertEq(j.toWorkerPaid, BOND - FILING_FEE, "the bond came back less the filing fee");
        assertEq(escrow.claimable(employer), P, "employer claimable");
        assertEq(escrow.claimable(worker), BOND - FILING_FEE, "worker claimable");
        assertEq(escrow.claimable(treasury), FILING_FEE, "the fee, and no cut on an unwind");
        assertEq(wif.balanceOf(address(escrow)), escrowHeld, "nothing left the contract yet");

        // The claim gate still applies: the record has to be written first.
        vm.prank(worker);
        vm.expectRevert(PactEscrow.RecordPending.selector);
        escrow.claim();

        _unlock(jobId);
        _claimFor(employer);
        _claimFor(worker);
        assertEq(wif.balanceOf(worker), 1_000_000e18 - FILING_FEE, "bond back less the fee they paid to file");
    }

    /// A delivery landed before the ticket. Then a ticket cannot hold it hostage: the timeout pays
    /// the worker on the ordinary release terms, which is what the employer's silence would have.
    function test_TimeoutDispute_PaysTheWorkerWhenTheWorkWasDelivered() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(employer);
        escrow.raiseDispute(jobId, keccak256("this is not what I asked for"));

        vm.warp(block.timestamp + DISPUTE_TIMEOUT_TEST + 1);
        vm.prank(stranger);
        escrow.timeoutDispute(jobId);

        PactEscrow.Job memory j = escrow.getJob(jobId);
        assertTrue(j.state == PactEscrow.State.SETTLED, "settled");
        assertTrue(j.workerWon, "the delivery decides it");
        assertFalse(j.timedOut, "this is a release, not an unwind");
        assertEq(escrow.claimable(worker), P - (P * 500) / 10_000 + BOND, "price less the cut, plus the bond");
        assertEq(escrow.claimable(employer), 0, "the employer gets nothing");
    }

    /// The timeout is a fallback, not a second deadline to race. A resolver who rules inside the
    /// window settles the job normally, and the timeout then has nothing to do.
    function test_TimeoutDispute_CannotTouchAnAlreadySettledJob() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.raiseDispute(jobId, keccak256("late"));

        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_WORKER, 0);

        vm.warp(block.timestamp + DISPUTE_TIMEOUT_TEST + 1);
        vm.prank(stranger);
        vm.expectRevert(PactEscrow.WrongState.selector);
        escrow.timeoutDispute(jobId);
    }

    /// The reasonHash the filer committed to is stored on the job, not only emitted, so a surface
    /// that shows a complaint can prove it is the one the chain recorded.
    function test_DisputeStoresTheReasonHash() public {
        uint256 jobId = _postAndAccept();
        bytes32 reason = keccak256("the deliverable is a screenshot of a different account");

        vm.prank(worker);
        escrow.raiseDispute(jobId, reason);

        assertEq(escrow.getJob(jobId).reasonHash, reason, "the commitment is readable from the job");
        assertEq(escrow.settlementFacts(jobId).reasonHash, reason, "and from settlement facts");
        assertGt(escrow.getJob(jobId).disputedAt, 0, "the clock started");
    }

    /// An employer cannot file at the instant the release becomes permissionless: whoever lands
    /// first in that block would otherwise decide whether the money pays out or freezes.
    function test_RevertWhen_EmployerFilesAtTheAutoReleaseBoundary() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        PactEscrow.Job memory j = escrow.getJob(jobId);
        vm.warp(j.autoReleaseAt);

        vm.prank(employer);
        vm.expectRevert(PactEscrow.PastDeadline.selector);
        escrow.raiseDispute(jobId, keccak256("too late"));
    }

    // ---------------------------------------------------------------- helpers

    function _postAndAccept() internal returns (uint256 jobId) {
        vm.prank(employer);
        jobId = escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(worker);
        escrow.bid(jobId, P);

        vm.prank(employer);
        escrow.acceptBid(jobId, 0);
    }

    function _deliver(uint256 jobId) internal {
        vm.prank(worker);
        escrow.submitDelivery(jobId, PROOF);
    }

    function _claimAll() internal {
        _unlockAll();
        _claimFor(employer);
        _claimFor(worker);
        _claimFor(treasury);
    }

    /// @dev Stands in for PactNames.record(): clears the claim block on a settled job.
    function _unlock(uint256 jobId) internal {
        vm.prank(address(namesMock));
        escrow.confirmRecorded(jobId);
    }

    function _unlockAll() internal {
        uint256 n = escrow.jobCount();
        for (uint256 id = 1; id <= n; id++) {
            if (escrow.getJob(id).state != PactEscrow.State.SETTLED) continue;
            _unlock(id);
        }
    }

    function _claimFor(address who) internal {
        if (escrow.claimable(who) == 0) return;
        vm.prank(who);
        escrow.claim();
    }
}
