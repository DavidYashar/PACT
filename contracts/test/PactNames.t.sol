// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PactEscrow} from "../src/PactEscrow.sol";
import {PactNames, IPactEscrow} from "../src/PactNames.sol";

/// @dev What a real deployment uses. Tests warp time, so the window size is irrelevant here.
uint64 constant AUTO_RELEASE_TEST = 14 days;
// Grace before an unanswered job can be reclaimed; the tests warp past it explicitly.
uint64 constant STALE_GRACE_TEST = 3 days;
uint64 constant DISPUTE_TIMEOUT_TEST = 7 days;

contract MockWIF is ERC20 {
    constructor() ERC20("World is Flat", "WIF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Identity, points, and the record-then-claim handshake between the two contracts.
contract PactNamesTest is Test {
    MockWIF internal wif;
    PactEscrow internal escrow;
    PactNames internal names;

    address internal employer = makeAddr("employer");
    address internal worker = makeAddr("worker");
    address internal treasury = makeAddr("treasury");
    address internal resolver = makeAddr("resolver");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant START = 1_000_000e18;
    uint256 internal constant P = 100_000e18;
    uint256 internal constant BOND = 50_000e18;
    uint256 internal constant CUT = 5_000e18;
    uint256 internal constant FINE = 5_000e18;
    /// The filing fee the worker's bond pays when they open the ticket: 10% of the price.
    uint256 internal constant FEE = 10_000e18;

    bytes32 internal constant TERMS = keccak256("1000 followers, friday, screenshot as proof");
    bytes32 internal constant PROOF = keccak256("https://example.com/screenshot.png");
    bytes32 internal constant REASON = keccak256("not the audience I asked for");

    function setUp() public {
        wif = new MockWIF();
        names = new PactNames();
        escrow = new PactEscrow(wif, treasury, resolver, address(names), AUTO_RELEASE_TEST, STALE_GRACE_TEST, DISPUTE_TIMEOUT_TEST);
        names.setEscrow(address(escrow));

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

    // ------------------------------------------------------------- identity

    function test_Register() public {
        vm.prank(employer);
        names.register("BigShopper", PactNames.Kind.HUMAN);

        assertEq(names.nameOf(employer), "bigshopper", "lowercased");
        assertEq(names.ownerOfName("bigshopper"), employer);
        assertEq(uint8(names.profileOf(employer).kind), uint8(PactNames.Kind.HUMAN));
        assertEq(names.profileOf(employer).registeredAt, block.timestamp);
    }

    function test_RevertWhen_NameTaken() public {
        vm.prank(employer);
        names.register("yasha", PactNames.Kind.HUMAN);

        vm.prank(worker);
        vm.expectRevert(PactNames.NameTaken.selector);
        names.register("YASHA", PactNames.Kind.AI);
    }

    function test_RevertWhen_AlreadyRegistered() public {
        vm.startPrank(employer);
        names.register("first", PactNames.Kind.HUMAN);
        vm.expectRevert(PactNames.AlreadyRegistered.selector);
        names.register("second", PactNames.Kind.HUMAN);
        vm.stopPrank();
    }

    function test_RevertWhen_NameReserved() public {
        vm.prank(employer);
        vm.expectRevert(PactNames.NameReserved.selector);
        names.register("Pact", PactNames.Kind.AI);
    }

    function test_RevertWhen_BadCharacter() public {
        vm.prank(employer);
        vm.expectRevert(PactNames.BadCharacter.selector);
        names.register("yasha!", PactNames.Kind.HUMAN);
    }

    function test_RegisterFor_GaslessWallet() public {
        uint256 pk = 0xB0B;
        address fresh = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = names.registerDigest(fresh, "bob", PactNames.Kind.HUMAN, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        vm.prank(stranger);
        names.registerFor(fresh, "bob", PactNames.Kind.HUMAN, deadline, abi.encodePacked(r, s, v));

        assertEq(names.ownerOfName("bob"), fresh);
    }

    function test_RevertWhen_RegisterForWrongOwner() public {
        uint256 pk = 0xB0B;
        address fresh = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 digest = names.registerDigest(fresh, "bob", PactNames.Kind.HUMAN, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);

        vm.prank(stranger);
        vm.expectRevert(PactNames.BadSignature.selector);
        names.registerFor(fresh, "bob", PactNames.Kind.HUMAN, deadline, abi.encodePacked(r, s, v));
    }

    // -------------------------------------------------------------- setting

    /// @dev The registry is bound to one escrow for life. Two consequences worth pinning: a second
    ///      binding is refused, and because `escrow` is what namespaces the records, a redeployed
    ///      escrow starting its ids at 1 can never collide with an older deployment's records.
    function test_RegistryIsBoundToOneEscrow() public {
        uint256 jobId = _approved();
        vm.prank(worker);
        names.record(jobId);
        assertTrue(names.recorded(jobId));

        // A fresh deployment starts its ids at 1 again.
        PactEscrow second = new PactEscrow(wif, treasury, resolver, address(names), AUTO_RELEASE_TEST, STALE_GRACE_TEST, DISPUTE_TIMEOUT_TEST);

        // Re-pointing the registry is what used to let a deployer forge history, so it is refused.
        vm.expectRevert(PactNames.EscrowAlreadySet.selector);
        names.setEscrow(address(second));

        assertEq(names.escrow(), address(escrow), "the registry still points at its own escrow");
        assertTrue(names.recordOf(jobId).workerWon, "the record it wrote is untouched");
    }

    /// @dev A brand-new registry bound to a brand-new escrow starts empty, and its job 1 is its own.
    function test_FreshPairStartsItsOwnHistory() public {
        PactNames freshNames = new PactNames();
        PactEscrow freshEscrow = new PactEscrow(wif, treasury, resolver, address(freshNames), AUTO_RELEASE_TEST, STALE_GRACE_TEST, DISPUTE_TIMEOUT_TEST);
        freshNames.setEscrow(address(freshEscrow));

        assertFalse(freshNames.recorded(1), "a new registry has no record for job 1");
        assertEq(uint256(freshNames.profileOf(worker).jobsDone), 0, "and no counters inherited");
        assertEq(uint256(names.profileOf(worker).jobsDone) >= 0, true, "the old registry is unaffected");
    }

    function test_RevertWhen_NonDeployerSetsEscrow() public {
        PactNames fresh = new PactNames();

        vm.prank(stranger);
        vm.expectRevert(PactNames.NotDeployer.selector);
        fresh.setEscrow(address(escrow));
    }

    // ------------------------------------------------------- worker wins

    function test_Record_WorkerWinCreditsBothSides() public {
        uint256 jobId = _approved();

        vm.prank(worker);
        names.record(jobId);

        PactNames.Record memory r = names.recordOf(jobId);
        assertEq(r.jobId, jobId);
        assertEq(r.employer, employer);
        assertEq(r.worker, worker);
        assertEq(r.termsHash, TERMS);
        assertEq(r.proofHash, PROOF);
        assertFalse(r.hadTicket);
        assertTrue(r.workerWon);
        assertEq(r.paidToWorker, P - CUT + BOND);
        assertEq(r.spentByEmployer, P);
        assertEq(r.recordedBy, worker);

        PactNames.Profile memory w = names.profileOf(worker);
        assertEq(w.jobsDone, 1);
        assertEq(w.earnedAsWorker, P - CUT, "net gain, bond returned is not income");
        assertEq(w.tickets, 0);

        PactNames.Profile memory e = names.profileOf(employer);
        assertEq(e.jobsPosted, 1);
        assertEq(e.spentAsEmployer, P);
        assertEq(e.jobsDone, 0);

        assertEq(names.historyOf(worker).length, 1);
        assertEq(names.historyOf(employer).length, 1);
        assertEq(names.historyOf(worker)[0], jobId);
    }

    function test_Record_UnlocksClaimForBothSides() public {
        uint256 jobId = _approved();

        vm.prank(worker);
        vm.expectRevert(PactEscrow.RecordPending.selector);
        escrow.claim();

        vm.prank(worker);
        names.record(jobId);

        assertEq(escrow.unrecorded(employer), 0);
        assertEq(escrow.unrecorded(worker), 0);

        vm.prank(worker);
        escrow.claim();
        assertEq(wif.balanceOf(worker), START + 95_000e18);
    }

    function test_Record_EmployerCanRecordForAbsentWorker() public {
        uint256 jobId = _approved();

        // The worker never shows up. The employer pays the gas and unlocks both claims.
        vm.prank(employer);
        names.record(jobId);

        assertEq(names.recordOf(jobId).recordedBy, employer);

        vm.prank(worker);
        escrow.claim();
        assertEq(wif.balanceOf(worker), START + 95_000e18, "worker still gets paid");
    }

    /// Dust settles but does not count. Without this, two colluding wallets settle unlimited wei
    /// jobs for gas alone and top every board on raw counters.
    function test_DustJobSettlesButMovesNoCounter() public {
        _ensureNames();
        // A price below the floor: the platform cut and the filing fee both round to zero here,
        // which is exactly why it must not buy rank.
        vm.prank(employer);
        uint256 jobId = escrow.postJob(TERMS, 2, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);
        vm.prank(worker);
        escrow.bid(jobId, 2);
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);
        vm.prank(worker);
        escrow.submitDelivery(jobId, PROOF);
        vm.prank(employer);
        escrow.approveDelivery(jobId);

        vm.prank(worker);
        names.record(jobId);

        assertTrue(names.recorded(jobId), "the job is still inscribed");
        assertEq(names.historyLength(worker), 0, "no history entry");
        assertEq(names.profileOf(worker).jobsDone, 0, "no count");
        assertEq(names.profileOf(employer).jobsPosted, 0, "no count");

        // The money still settles: the claim block was cleared.
        vm.prank(worker);
        escrow.claim();
    }

    /// The floor is 100 WIF exactly, and it is a floor rather than a band: one wei below buys no
    /// rank, the floor itself counts, and there is no ceiling — the escrow caps a budget only by
    /// what a wallet holds, so a large job must count exactly once, like any other.
    function test_CountedFloorIsOneHundredWifAndHasNoCeiling() public {
        assertEq(names.MIN_COUNTED_PRICE(), 100e18, "the floor is 100 WIF, in wei");

        _settleAt(100e18 - 1);
        assertEq(names.profileOf(worker).jobsDone, 0, "one wei under the floor buys no rank");
        assertEq(names.profileOf(employer).jobsPosted, 0, "no rank on the other side either");
        assertEq(names.historyLength(worker), 0, "and no history entry");

        _settleAt(100e18);
        assertEq(names.profileOf(worker).jobsDone, 1, "the floor itself counts");
        assertEq(names.profileOf(employer).jobsPosted, 1);
        assertEq(names.historyLength(worker), 1, "and it enters the history");

        _settleAt(900_000e18);
        assertEq(names.profileOf(worker).jobsDone, 2, "a very large job counts too");
        assertEq(names.historyLength(worker), 2, "once, like any other");
        assertEq(names.profileOf(worker).earnedAsWorker, 95e18 + 855_000e18, "paid in full, net of the cut");
    }

    /// Post, accept, deliver, approve, record — the whole path at an arbitrary price.
    function _settleAt(uint256 price) internal returns (uint256 jobId) {
        _ensureNames();

        vm.prank(employer);
        jobId = escrow.postJob(TERMS, price, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);
        vm.prank(worker);
        escrow.bid(jobId, price);
        vm.prank(employer);
        escrow.acceptBid(jobId, 0);
        vm.prank(worker);
        escrow.submitDelivery(jobId, PROOF);
        vm.prank(employer);
        escrow.approveDelivery(jobId);
        vm.prank(worker);
        names.record(jobId);
    }

    /// A ticket nobody decided settles by the clock. The record must still be written — the job has
    /// to stay auditable and the claim gate has to clear — but no counter may move, because nobody
    /// was ruled against.
    function test_TimedOutTicketIsRecordedButMarksNobody() public {
        _ensureNames();
        uint256 jobId = _postAndAccept();

        vm.prank(worker);
        escrow.raiseDispute(jobId, keccak256("nobody is answering"));

        vm.warp(block.timestamp + DISPUTE_TIMEOUT_TEST + 1);
        vm.prank(stranger);
        escrow.timeoutDispute(jobId);

        vm.prank(employer);
        names.record(jobId);

        assertTrue(names.recorded(jobId), "the job is inscribed");
        assertEq(names.historyLength(worker), 0, "no history entry for a timeout");
        assertEq(names.historyLength(employer), 0, "on either side");
        assertEq(names.profileOf(worker).abandoned, 0, "the worker is not marked as walking away");
        assertEq(names.profileOf(worker).ticketsLost, 0, "and does not lose a ticket they never lost");
        assertEq(names.profileOf(employer).ticketsWon, 0, "nor does the employer win one");
        assertEq(names.profileOf(worker).feesPaid, FEE, "the filer's fee is still on the record");
        assertEq(names.profileOf(employer).feesPaid, 0, "and not on the party that did not file");

        // The money is claimable, which is the part that matters most.
        vm.prank(worker);
        escrow.claim();
        vm.prank(employer);
        escrow.claim();
    }

    function test_TwoJobsStoredIndependently() public {        uint256 a = _approved();
        uint256 b = _approved();

        vm.prank(worker);
        names.record(a);
        vm.prank(employer);
        names.record(b);

        uint256[] memory h = names.historyOf(worker);
        assertEq(h.length, 2);
        assertEq(h[0], a);
        assertEq(h[1], b);

        assertEq(names.profileOf(worker).jobsDone, 2);
        assertEq(names.profileOf(worker).earnedAsWorker, 2 * (P - CUT));
        assertEq(names.profileOf(employer).jobsPosted, 2);
        assertEq(names.profileOf(employer).spentAsEmployer, 2 * P);

        vm.prank(worker);
        escrow.claim();
        assertEq(wif.balanceOf(worker), START + 2 * 95_000e18);
    }

    // ------------------------------------------------------ employer wins

    function test_Record_EmployerWinCountsTicketButNotWork() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.raiseDispute(jobId, REASON);
        vm.prank(resolver);
        escrow.resolveDispute(jobId, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);

        vm.prank(employer);
        names.record(jobId);

        PactNames.Record memory r = names.recordOf(jobId);
        assertTrue(r.hadTicket);
        assertFalse(r.workerWon);
        assertEq(r.paidToWorker, BOND - FINE);
        assertEq(r.spentByEmployer, 0, "a refunded job is not hiring spend");

        PactNames.Profile memory w = names.profileOf(worker);
        assertEq(w.jobsDone, 0, "not counted as work done");
        assertEq(w.earnedAsWorker, 0);
        assertEq(w.tickets, 1);

        assertEq(names.profileOf(employer).tickets, 1);
        assertEq(names.profileOf(employer).spentAsEmployer, 0);
        assertEq(names.profileOf(employer).jobsPosted, 1);
    }

    function test_Record_AbandonedJobCountsAsLoss() public {
        uint256 jobId = _postAndAccept();
        vm.prank(worker);
        escrow.abandonJob(jobId);

        vm.prank(employer);
        names.record(jobId);

        PactNames.Record memory r = names.recordOf(jobId);
        assertFalse(r.workerWon);
        assertEq(r.paidToWorker, 0);
        assertEq(names.profileOf(worker).jobsDone, 0);
        assertEq(names.profileOf(worker).tickets, 0);
        assertEq(names.profileOf(employer).spentAsEmployer, 0);
    }

    // ------------------------------------------------- scoreboard counters

    /// @dev A lost ticket must be visible as a loss on both sides, and separately from an
    ///      abandonment: one is a ruling, the other is walking away.
    function test_Profile_SplitsTicketOutcomesBySide() public {
        uint256 lost = _postAndAccept();
        _deliver(lost);
        vm.prank(employer);
        escrow.raiseDispute(lost, REASON);
        vm.prank(resolver);
        escrow.resolveDispute(lost, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);
        vm.prank(employer);
        names.record(lost);

        uint256 won = _postAndAccept();
        _deliver(won);
        vm.prank(worker);
        escrow.raiseDispute(won, REASON);
        vm.prank(resolver);
        escrow.resolveDispute(won, PactEscrow.Ruling.FAVOR_WORKER, 0);
        vm.prank(worker);
        names.record(won);

        PactNames.Profile memory w = names.profileOf(worker);
        PactNames.Profile memory e = names.profileOf(employer);

        assertEq(w.ticketsWon, 1, "the worker won one");
        assertEq(w.ticketsLost, 1, "and lost one");
        assertEq(e.ticketsWon, 1, "the employer won one");
        assertEq(e.ticketsLost, 1, "and lost one");
        assertEq(w.abandoned, 0, "a lost ticket is not an abandonment");
        assertEq(w.jobsDone, 1, "only the won job counts as done");
    }

    function test_Profile_AbandonmentIsSeparateFromALostTicket() public {
        uint256 jobId = _postAndAccept();
        vm.prank(worker);
        escrow.abandonJob(jobId);
        vm.prank(worker);
        names.record(jobId);

        assertEq(names.profileOf(worker).abandoned, 1, "the walk-away is counted");
        assertEq(names.profileOf(worker).ticketsWon, 0);
        assertEq(names.profileOf(worker).ticketsLost, 0, "nobody filed anything");
        assertEq(names.profileOf(worker).jobsDone, 0);
    }

    /// @dev WIF totals are gross on purpose, so a leaderboard can be checked against the token.
    ///      Worker net = received - bonded; employer net = staked - received.
    function test_Profile_TracksTheWifThatActuallyMoved() public {
        uint256 approved = _approved();
        vm.prank(worker);
        names.record(approved);

        uint256 lostJob = _postAndAccept();
        _deliver(lostJob);
        vm.prank(employer);
        escrow.raiseDispute(lostJob, REASON);
        vm.prank(resolver);
        escrow.resolveDispute(lostJob, PactEscrow.Ruling.FAVOR_EMPLOYER, 1_000);
        vm.prank(employer);
        names.record(lostJob);

        PactNames.Profile memory w = names.profileOf(worker);
        PactNames.Profile memory e = names.profileOf(employer);

        // Approved job: worker is credited price - cut + bond.
        uint256 approvedCredit = P - CUT + BOND;
        // The employer filed this one, so the worker's escrow was untouched and only the fine came
        // off it. Had the worker filed, the fee would already have been taken from their bond.
        uint256 lostCredit = BOND - FINE;

        assertEq(w.receivedAsWorker, approvedCredit + lostCredit, "every credit the worker got");
        assertEq(w.bondedAsWorker, 2 * BOND, "both bonds were staked");
        assertEq(e.stakedAsEmployer, 2 * P, "both prices were locked");
        assertEq(e.receivedAsEmployer, P - CUT + FINE, "only the refunded job came back");
        assertEq(e.feesPaid, FEE, "the employer paid the fee to open the ticket");

        // Gross minus stake is the net, and it is checkable against the token balances.
        assertEq(w.receivedAsWorker - w.bondedAsWorker, approvedCredit + lostCredit - 2 * BOND, "net worker income");
        assertEq(
            e.stakedAsEmployer + e.feesPaid - e.receivedAsEmployer,
            2 * P + FEE - (P - CUT + FINE),
            "net employer outflow, fee included"
        );
    }

    // ---------------------------------------------------------------- guards

    function test_RevertWhen_PostingWithoutUsername() public {
        // The escrow asks the registry before it will create a record.
        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotRegistered.selector);
        escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);
    }

    function test_RevertWhen_BiddingWithoutUsername() public {
        uint256 jobId = _postAndAccept();

        // A second job, bid on by a wallet that never registered.
        vm.prank(employer);
        uint256 other =
            escrow.postJob(TERMS, P, uint64(block.timestamp + 1 days), uint64(block.timestamp + 7 days), AUTO_RELEASE_TEST);

        vm.prank(stranger);
        vm.expectRevert(PactEscrow.NotRegistered.selector);
        escrow.bid(other, P);

        assertEq(escrow.bidCount(other), 0, "nothing was recorded");
        assertTrue(jobId > 0);
    }

    function test_RevertWhen_DoubleRecord() public {
        uint256 jobId = _approved();

        vm.prank(worker);
        names.record(jobId);

        vm.prank(employer);
        vm.expectRevert(PactNames.AlreadyRecorded.selector);
        names.record(jobId);
    }

    function test_RevertWhen_NonPartyRecords() public {
        uint256 jobId = _approved();

        vm.prank(stranger);
        vm.expectRevert(PactNames.NotParty.selector);
        names.record(jobId);
    }

    function test_RevertWhen_RecordingUnsettled() public {
        uint256 jobId = _postAndAccept();
        _deliver(jobId);

        vm.prank(worker);
        vm.expectRevert(PactNames.NotSettled.selector);
        names.record(jobId);
    }

    function test_RevertWhen_RecordingUnknownJob() public {
        vm.prank(worker);
        vm.expectRevert(PactNames.UnknownJob.selector);
        names.record(999);
    }

    // --------------------------------------------------------------- helpers

    function _postAndAccept() internal returns (uint256 jobId) {
        _ensureNames();

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

    /// @dev The escrow refuses a wallet with no username, so every job in these tests needs both
    ///      sides registered first. Idempotent, because a test may post more than one job.
    function _ensureNames() internal {
        if (!names.isRegistered(employer)) {
            vm.prank(employer);
            names.register("employer", PactNames.Kind.HUMAN);
        }
        if (!names.isRegistered(worker)) {
            vm.prank(worker);
            names.register("workerai", PactNames.Kind.AI);
        }
    }

    function _approved() internal returns (uint256 jobId) {
        jobId = _postAndAccept();
        _deliver(jobId);
        vm.prank(employer);
        escrow.approveDelivery(jobId);
    }
}
