// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PactTypes} from "./PactTypes.sol";

/// @notice The one question the escrow asks the name registry before it lets anyone in.
interface IPactNames {
    function isRegistered(address who) external view returns (bool);
}

/// @title PactEscrow
/// @notice Work escrowed in WIF. The employer escrows the full price, the worker escrows half of it.
///         On delivery the employer releases, or a ticket decides. The resolver can only move money
///         between the two parties already in the job — it can never name a recipient.
contract PactEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @notice Worker bond, as a fraction of the agreed price.
    uint16 public constant BOND_BPS = 5_000;
    /// @notice Ticket filing fee, as a fraction of the agreed price.
    uint16 public constant FILING_FEE_BPS = 1_000;
    /// @notice Platform cut, as a fraction of the agreed price. Charged once, on any release.
    uint16 public constant PLATFORM_FEE_BPS = 500;
    /// @notice Ceiling on the fine applied to a worker who loses a ticket.
    uint16 public constant LOSS_FINE_BPS = 1_000;
    /// @notice Bounds on the per-job auto-release window. A zero window would let anyone release a
    /// delivery instantly; more than a year is a footgun rather than a product.
    uint64 public constant MIN_AUTO_RELEASE = 1 minutes;
    uint64 public constant MAX_AUTO_RELEASE = 365 days;
    /// @notice Bounds on how long an open job may sit past its bid deadline before anyone can
    /// cancel it and return the employer's money.
    uint64 public constant MAX_STALE_GRACE = 365 days;
    /// @notice Bounds on how long a ticket may sit undecided. Five minutes is the floor because a
    ///         review that expires sooner is not a review; a year is the ceiling because it is the
    ///         same as having no timeout at all.
    uint64 public constant MIN_DISPUTE_TIMEOUT = 5 minutes;
    uint64 public constant MAX_DISPUTE_TIMEOUT = 365 days;

    /// How long an employer has to stay silent after a delivery before anyone may release the
    /// money to the worker. The default for jobs that do not name their own; each job carries the
    /// window its employer committed to at posting time.
    uint64 public immutable defaultAutoReleaseDelay;
    /// @notice How long after `bidDeadline` an unanswered job may hold escrow before anyone can
    /// return it. Immutable: a mutable grace period would let an operator strand or free funds by
    /// changing it under a live job.
    uint64 public immutable staleJobGrace;

    /// @notice How long a ticket may sit undecided before anyone may settle it on the terms the
    ///         chain already implies. Without it `DISPUTED` is an absorbing state: the resolver is
    ///         the only exit, so either party can freeze both stakes indefinitely by filing, and a
    ///         lost resolver key strands every open ticket for ever.
    uint64 public immutable disputeTimeout;

    enum State {
        NONE,
        OPEN,
        ASSIGNED,
        DELIVERED,
        DISPUTED,
        SETTLED,
        CANCELLED
    }

    enum Ruling {
        FAVOR_WORKER,
        FAVOR_EMPLOYER
    }

    /// @notice Every way money can leave escrow. Used only by `quote`.
    enum Path {
        RELEASE,
        ABANDON,
        RULE_FOR_WORKER,
        RULE_FOR_EMPLOYER
    }

    /// @notice The exact result of settling a job. `fine` is what the loser forfeited from their
    /// own stake; `toTreasury` is the platform cut and never includes the filing fee, which was
    /// taken when the ticket was raised.
    struct Quote {
        uint256 toEmployer;
        uint256 toWorker;
        uint256 toTreasury;
        uint256 fine;
    }

    struct Bid {
        address worker;
        uint256 price;
        bool accepted;
        bool withdrawn;
    }

    struct Job {
        address employer;
        address worker;
        address filer;
        State state;
        uint256 budget;
        uint256 price;
        uint256 bond;
        uint256 employerEscrow;
        uint256 workerEscrow;
        uint64 bidDeadline;
        uint64 deliveryDeadline;
        uint64 autoReleaseAt;
        /// The window this job committed to at posting time, not the contract default.
        uint64 autoReleaseDelay;
        /// When the open ticket was filed, so it can time out.
        uint64 disputedAt;
        /// What the filer committed to. Stored, not only emitted, so any surface that shows a
        /// complaint can prove the text it is showing is the text the chain recorded.
        bytes32 reasonHash;
        bytes32 termsHash;
        bytes32 proofHash;
        // Settlement facts, written once. The registry reads these instead of recomputing them,
        // which is the only way an employer-favoured ticket can report an exact payout.
        bool workerWon;
        /// True when the ticket timed out with nothing delivered and the stakes were unwound. The
        /// registry writes the record but moves no counter: nobody won, so nobody is marked.
        bool timedOut;
        uint64 settledAt;
        uint256 toEmployerPaid;
        uint256 toWorkerPaid;
    }

    IERC20 public immutable wif;
    address public immutable treasury;
    /// @notice The only address allowed to confirm that a settled job has been recorded.
    address public immutable names;
    address public resolver;
    uint256 public jobCount;

    mapping(uint256 => Job) private _jobs;
    mapping(uint256 => Bid[]) private _bids;
    /// @notice One live bid per wallet per job. Without this a single funded wallet can append
    ///         unbounded bids and make `getBids` a memory hazard for every client that reads it.
    /// @notice The slot a wallet's bid occupies, 1-based. Zero means it has never bid here.
    mapping(uint256 => mapping(address => uint256)) private _bidSlot;
    mapping(uint256 => mapping(address => bool)) private _hasLiveBid;
    mapping(address => uint256) public claimable;

    /// @notice Settled jobs this account still owes a record for. Blocks claim() until cleared.
    mapping(address => uint256) public unrecorded;
    mapping(uint256 => bool) public recordCleared;

    event JobPosted(uint256 indexed jobId, address indexed employer, uint256 budget, bytes32 termsHash);
    event JobCancelled(uint256 indexed jobId);
    event JobExpired(uint256 indexed jobId, address indexed employer, uint256 refund);
    event BidPlaced(uint256 indexed jobId, address indexed worker, uint256 price);
    event BidWithdrawn(uint256 indexed jobId, address indexed worker, uint256 bidIndex);
    event BidAccepted(uint256 indexed jobId, address indexed worker, uint256 price, uint256 bond);
    event Delivered(uint256 indexed jobId, bytes32 proofHash, uint64 autoReleaseAt);
    event DeliveryApproved(uint256 indexed jobId, uint256 toWorker, uint256 toTreasury);
    event JobAbandoned(uint256 indexed jobId, uint256 toEmployer, uint256 toTreasury);
    event DisputeRaised(uint256 indexed jobId, address indexed filer, uint256 filingFee, bytes32 reasonHash);
    event DisputeTimedOut(uint256 indexed jobId, uint256 toEmployer, uint256 toWorker);
    event DisputeResolved(
        uint256 indexed jobId,
        Ruling ruling,
        uint256 toEmployer,
        uint256 toWorker,
        uint256 toTreasury,
        uint256 fine
    );
    event Claimed(address indexed account, uint256 amount);
    event RecordCleared(uint256 indexed jobId, address indexed employer, address indexed worker);
    event ResolverChanged(address indexed previousResolver, address indexed newResolver);

    error NotEmployer();
    error NotWorker();
    error NotParty();
    error NotResolver();
    error WrongState();
    error BidWindowClosed();
    error PastDeadline();
    error NotYetReleasable();
    error ZeroAmount();
    error PriceTooHigh();
    error BadDeadline();
    error SelfJob();
    error BidUnavailable();
    error FineTooHigh();
    error ResolverIsParty();
    error NotRegistry();
    error RecordPending();
    error AlreadyRecorded();
    error NotRegistered();
    error BondUnfunded();
    error BondUnapproved();
    error AlreadyBid();
    error DelayOutOfRange();
    error JobNotStale();

    constructor(
        IERC20 wif_,
        address treasury_,
        address resolver_,
        address names_,
        uint64 autoReleaseDelay_,
        uint64 staleJobGrace_,
        uint64 disputeTimeout_
    ) {
        if (
            address(wif_) == address(0) || treasury_ == address(0) || resolver_ == address(0)
                || names_ == address(0)
        ) revert ZeroAmount();
        /// A deployment may run a short window so the path can be exercised; production runs days. Both bounds
        /// exist because a zero window would let anyone release instantly, and anything beyond a
        /// year is a footgun rather than a product.
        if (autoReleaseDelay_ < MIN_AUTO_RELEASE || autoReleaseDelay_ > MAX_AUTO_RELEASE) {
            revert DelayOutOfRange();
        }
        if (staleJobGrace_ > MAX_STALE_GRACE) revert DelayOutOfRange();
        /// The ticket timeout is a deployment decision for the same reason the silence window is:
        /// a test deployment needs to watch it fire, production needs a month.
        if (disputeTimeout_ < MIN_DISPUTE_TIMEOUT || disputeTimeout_ > MAX_DISPUTE_TIMEOUT) {
            revert DelayOutOfRange();
        }
        wif = wif_;
        treasury = treasury_;
        resolver = resolver_;
        names = names_;
        defaultAutoReleaseDelay = autoReleaseDelay_;
        staleJobGrace = staleJobGrace_;
        disputeTimeout = disputeTimeout_;
    }

    // ---------------------------------------------------------------- employer

    /// @notice Post a job and escrow the full budget. Terms are hashed and immutable.
    ///        `autoReleaseDelay_` is this job's own silence window — the employer picks it at
    ///        posting time so bidders can price it, rather than inheriting a global default.
    function postJob(
        bytes32 termsHash,
        uint256 budget,
        uint64 bidDeadline,
        uint64 deliveryDeadline,
        uint64 autoReleaseDelay_
    ) external nonReentrant returns (uint256 jobId) {
        if (budget == 0) revert ZeroAmount();
        if (bidDeadline <= block.timestamp || deliveryDeadline <= bidDeadline) revert BadDeadline();
        if (autoReleaseDelay_ < MIN_AUTO_RELEASE || autoReleaseDelay_ > MAX_AUTO_RELEASE) {
            revert DelayOutOfRange();
        }
        // A wallet must own a permanent username before it can create a record.
        if (!IPactNames(names).isRegistered(msg.sender)) revert NotRegistered();

        jobId = ++jobCount;

        Job storage job = _jobs[jobId];
        job.employer = msg.sender;
        job.state = State.OPEN;
        job.budget = budget;
        job.bidDeadline = bidDeadline;
        job.deliveryDeadline = deliveryDeadline;
        job.autoReleaseDelay = autoReleaseDelay_;
        job.termsHash = termsHash;

        wif.safeTransferFrom(msg.sender, address(this), budget);

        emit JobPosted(jobId, msg.sender, budget, termsHash);
    }

    /// @notice Cancel an open job. Only possible before a bid is accepted.
    function cancelJob(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.employer) revert NotEmployer();
        if (job.state != State.OPEN) revert WrongState();

        job.state = State.CANCELLED;
        claimable[job.employer] += job.budget;

        emit JobCancelled(jobId);
    }

    /// @notice Reclaim an open job that nobody won, after its bid window closed and the grace
    ///         period passed. Open to anyone, because the employer who would have to call
    ///         `cancelJob` is exactly the party that went missing; the money always returns to
    ///         them, so a stranger calling this is doing them a favour, not taking anything.
    function cancelExpiredJob(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.OPEN) revert WrongState();
        if (block.timestamp < uint256(job.bidDeadline) + staleJobGrace) revert JobNotStale();

        job.state = State.CANCELLED;
        claimable[job.employer] += job.budget;

        emit JobExpired(jobId, job.employer, job.budget);
    }

    /// @notice Take a bid back. Free, and only while the job is still open: once an employer
    ///         accepts, the price and the bond are locked and the bid stops being an offer.
    function withdrawBid(uint256 jobId, uint256 bidIndex) external {
        Job storage job = _jobs[jobId];
        if (job.state != State.OPEN) revert WrongState();
        if (bidIndex >= _bids[jobId].length) revert BidUnavailable();

        Bid storage b = _bids[jobId][bidIndex];
        if (b.worker != msg.sender) revert NotWorker();
        if (b.accepted || b.withdrawn) revert BidUnavailable();

        b.withdrawn = true;
        _hasLiveBid[jobId][msg.sender] = false;

        emit BidWithdrawn(jobId, msg.sender, bidIndex);
    }

    /// @notice Accept a bid. Locks the price and pulls the worker's bond in the same transaction.
    /// @dev    Acceptance is bounded by `bidDeadline`. Without that bound an employer could wait
    ///         until the delivery deadline had passed and accept a bid anyway: the bond is pulled,
    ///         and `submitDelivery` then reverts `PastDeadline`, so the worker's only exits are
    ///         forfeiting the bond or paying a filing fee. `postJob` already guarantees
    ///         `deliveryDeadline > bidDeadline`, so accepting inside the window always leaves the
    ///         bidder at least the window they priced against.
    function acceptBid(uint256 jobId, uint256 bidIndex) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.employer) revert NotEmployer();
        if (job.state != State.OPEN) revert WrongState();
        if (block.timestamp >= job.bidDeadline) revert BidWindowClosed();
        if (bidIndex >= _bids[jobId].length) revert BidUnavailable();

        Bid storage b = _bids[jobId][bidIndex];
        if (b.worker == address(0) || b.accepted || b.withdrawn) revert BidUnavailable();

        uint256 price = b.price;
        uint256 bond = (price * BOND_BPS) / BPS;
        if (bond == 0) revert ZeroAmount();

        b.accepted = true;

        job.state = State.ASSIGNED;
        job.worker = b.worker;
        job.price = price;
        job.bond = bond;
        job.employerEscrow = price;
        job.workerEscrow = bond;

        uint256 surplus = job.budget - price;
        if (surplus > 0) claimable[job.employer] += surplus;

        wif.safeTransferFrom(b.worker, address(this), bond);

        emit BidAccepted(jobId, b.worker, price, bond);
    }

    /// @notice Release both stakes once the worker has delivered.
    function approveDelivery(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.employer) revert NotEmployer();
        if (job.state != State.DELIVERED) revert WrongState();

        (uint256 toWorker, uint256 cut) = _releaseToWorker(job);

        emit DeliveryApproved(jobId, toWorker, cut);
    }

    // ------------------------------------------------------------------ worker

    function bid(uint256 jobId, uint256 price) external {
        Job storage job = _jobs[jobId];
        if (job.state != State.OPEN) revert WrongState();
        if (block.timestamp >= job.bidDeadline) revert BidWindowClosed();
        if (msg.sender == job.employer) revert SelfJob();
        if (price == 0 || price > job.budget) revert PriceTooHigh();
        // Same rule on the worker side: a bid is the start of a record, so it needs a name.
        if (!IPactNames(names).isRegistered(msg.sender)) revert NotRegistered();

        // A bid the bidder cannot fund is a trap for the employer: acceptBid pulls the bond in
        // the same transaction, so the employer's own transaction would revert on someone else's
        // empty wallet. Require the money to be there, and approved, before the bid counts.
        uint256 bond = (price * BOND_BPS) / BPS;
        if (bond == 0) revert ZeroAmount();
        if (wif.balanceOf(msg.sender) < bond) revert BondUnfunded();
        if (wif.allowance(msg.sender, address(this)) < bond) revert BondUnapproved();

        // One live bid per wallet per job, and one slot per wallet: a wallet that withdraws and
        // bids again overwrites its own entry instead of appending. Without that, bid/withdraw in
        // a loop grows the array without bound and every read of the bid list eventually fails to
        // decode — a denial of every surface that reads bids, for the price of gas.
        if (_hasLiveBid[jobId][msg.sender]) revert AlreadyBid();
        _hasLiveBid[jobId][msg.sender] = true;

        uint256 slot = _bidSlot[jobId][msg.sender];
        if (slot == 0) {
            _bids[jobId].push(Bid({worker: msg.sender, price: price, accepted: false, withdrawn: false}));
            _bidSlot[jobId][msg.sender] = _bids[jobId].length;
        } else {
            Bid storage again = _bids[jobId][slot - 1];
            again.price = price;
            again.accepted = false;
            again.withdrawn = false;
        }

        emit BidPlaced(jobId, msg.sender, price);
    }

    /// @notice Commit proof before the deadline. Starts the 14-day auto-release clock.
    function submitDelivery(uint256 jobId, bytes32 proofHash) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.state != State.ASSIGNED) revert WrongState();
        if (block.timestamp > job.deliveryDeadline) revert PastDeadline();
        if (proofHash == bytes32(0)) revert ZeroAmount();

        job.state = State.DELIVERED;
        job.proofHash = proofHash;
        job.autoReleaseAt = uint64(block.timestamp) + job.autoReleaseDelay;

        emit Delivered(jobId, proofHash, job.autoReleaseAt);
    }

    /// @notice Walk away. The whole bond goes to the employer, the price is refunded.
    function abandonJob(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.worker) revert NotWorker();
        if (job.state != State.ASSIGNED) revert WrongState();

        Quote memory q = quote(Path.ABANDON, job.price, job.bond, job.employerEscrow, job.workerEscrow, 0);

        _markSettled(job, false, q.toEmployer, 0);
        claimable[job.employer] += q.toEmployer;
        claimable[treasury] += q.toTreasury;

        emit JobAbandoned(jobId, q.toEmployer, q.toTreasury);
    }

    /// @notice Reclaim an assignment whose worker never delivered. After `deliveryDeadline` and the
    ///         grace period anyone may settle it exactly as an abandonment: the bond goes to the
    ///         employer, the price is refunded, the worker keeps nothing.
    /// @dev    Without this, a worker who is assigned and then vanishes freezes both stakes. The
    ///         employer's only exit was to buy a ticket for 10% of the price to recover their own
    ///         money. `raiseDispute` still works until this fires, so a worker who intends to
    ///         deliver late can open a ticket instead and keep the decision with the resolver.
    function reclaimAssignment(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.ASSIGNED) revert WrongState();
        if (block.timestamp <= uint256(job.deliveryDeadline) + staleJobGrace) revert JobNotStale();

        Quote memory q = quote(Path.ABANDON, job.price, job.bond, job.employerEscrow, job.workerEscrow, 0);

        _markSettled(job, false, q.toEmployer, 0);
        claimable[job.employer] += q.toEmployer;
        claimable[treasury] += q.toTreasury;

        emit JobAbandoned(jobId, q.toEmployer, q.toTreasury);
    }

    // ----------------------------------------------------------------- payouts

    /// @notice Anyone may release once the job's own silence window has passed, so an employer who
    ///         disappears cannot freeze the money.
    function releaseExpired(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.DELIVERED) revert WrongState();
        if (block.timestamp < job.autoReleaseAt) revert NotYetReleasable();

        (uint256 toWorker, uint256 cut) = _releaseToWorker(job);

        emit DeliveryApproved(jobId, toWorker, cut);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        // A worker with two unclaimed jobs gets one aggregate transfer, so the gate has to be
        // "everything is recorded", not "this job is recorded".
        if (unrecorded[msg.sender] != 0) revert RecordPending();

        amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();
        claimable[msg.sender] = 0;

        wif.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------- disputes

    /// @notice Freeze both escrows and open a ticket. The fee is charged to whoever files.
    ///         An employer pays it as new WIF so a bogus ticket can never eat into the worker's
    ///         payment; a worker has it taken from their bond so they are never priced out.
    function raiseDispute(uint256 jobId, bytes32 reasonHash) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.ASSIGNED && job.state != State.DELIVERED) revert WrongState();
        if (msg.sender != job.employer && msg.sender != job.worker) revert NotParty();

        /// Once the auto-release window has passed on a delivered job, the employer's time to
        /// object is over. Without this bound the silence window meant nothing: an employer could
        /// file a ticket after it expired, or front-run `releaseExpired` in the mempool, and turn
        /// a completed job into a resolver decision. The worker has no such limit, because a
        /// worker never benefits from a ticket on their own delivered job.
        ///
        /// `>=`, not `>`: at exactly `autoReleaseAt` the release is already permissionless, so
        /// allowing a ticket in the same second would let whoever lands first in the block decide
        /// whether the money pays out or freezes.
        if (
            job.state == State.DELIVERED && msg.sender == job.employer
                && block.timestamp >= job.autoReleaseAt
        ) {
            revert PastDeadline();
        }

        uint256 fee = (job.price * FILING_FEE_BPS) / BPS;

        if (msg.sender == job.employer) {
            wif.safeTransferFrom(msg.sender, address(this), fee);
        } else {
            if (job.workerEscrow < fee) revert ZeroAmount();
            job.workerEscrow -= fee;
        }
        claimable[treasury] += fee;

        job.state = State.DISPUTED;
        job.filer = msg.sender;
        job.disputedAt = uint64(block.timestamp);
        job.reasonHash = reasonHash;

        emit DisputeRaised(jobId, msg.sender, fee, reasonHash);
    }

    /// @notice Settle a ticket nobody decided, once `disputeTimeout` has passed.
    ///
    /// Two outcomes, both decided by facts already on chain rather than by anyone's judgement:
    ///
    /// - **A delivery was committed** before the ticket. The work landed before the deadline, so
    ///   the money releases to the worker on the ordinary release terms. This is the same outcome
    ///   the employer's silence would have produced, which is the whole point: a ticket cannot be
    ///   used to hold a completed job hostage.
    /// - **Nothing was delivered.** The stakes are unwound — the employer's escrow back to the
    ///   employer, the worker's bond back to the worker, no platform cut either way. Nobody is
    ///   ruled against, because nobody was ruled against. The party who filed has already paid the
    ///   filing fee, which is the cost of the review they asked for and did not get in time.
    ///
    /// @dev Permissionless: the party who benefits from a decision should not be the only one who
    ///      can trigger it, and a lost resolver key must not strand money for ever.
    function timeoutDispute(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.DISPUTED) revert WrongState();
        if (block.timestamp <= uint256(job.disputedAt) + disputeTimeout) revert NotYetReleasable();

        if (job.proofHash != bytes32(0)) {
            (uint256 toWorker, uint256 cut) = _releaseToWorker(job);
            emit DeliveryApproved(jobId, toWorker, cut);
            return;
        }

        uint256 toEmployer = job.employerEscrow;
        uint256 toWorkerStake = job.workerEscrow;

        job.timedOut = true;
        _markSettled(job, false, toEmployer, toWorkerStake);
        if (toEmployer > 0) claimable[job.employer] += toEmployer;
        if (toWorkerStake > 0) claimable[job.worker] += toWorkerStake;

        emit DisputeTimedOut(jobId, toEmployer, toWorkerStake);
    }

    /// @notice Decide a ticket. Bounded: the resolver chooses a side and a fine size, nothing else.
    ///         No address parameter exists, so no ruling can pay the resolver.
    function resolveDispute(uint256 jobId, Ruling ruling, uint16 fineBps) external nonReentrant {
        if (msg.sender != resolver) revert NotResolver();

        Job storage job = _jobs[jobId];
        if (job.state != State.DISPUTED) revert WrongState();
        if (fineBps > LOSS_FINE_BPS) revert FineTooHigh();
        // The resolver must not be able to rule on a job it is party to.
        if (msg.sender == job.employer || msg.sender == job.worker) revert ResolverIsParty();

        Quote memory q = quote(
            ruling == Ruling.FAVOR_WORKER ? Path.RULE_FOR_WORKER : Path.RULE_FOR_EMPLOYER,
            job.price,
            job.bond,
            job.employerEscrow,
            job.workerEscrow,
            fineBps
        );

        bool workerWon = ruling == Ruling.FAVOR_WORKER;

        _markSettled(job, workerWon, q.toEmployer, q.toWorker);
        if (q.toEmployer > 0) claimable[job.employer] += q.toEmployer;
        if (q.toWorker > 0) claimable[job.worker] += q.toWorker;
        claimable[treasury] += q.toTreasury;

        emit DisputeResolved(jobId, ruling, q.toEmployer, q.toWorker, q.toTreasury, q.fine);
    }

    // -------------------------------------------------------------- recording

    /// @notice Called by the registry once the settled job has been written into the history.
    ///         Clears both parties in one transaction, so whoever pays to record unlocks both
    ///         claims — that is what lets either side step in when the other is absent.
    function confirmRecorded(uint256 jobId) external {
        if (msg.sender != names) revert NotRegistry();
        if (recordCleared[jobId]) revert AlreadyRecorded();

        Job storage job = _jobs[jobId];
        if (job.state != State.SETTLED) revert WrongState();

        recordCleared[jobId] = true;
        if (unrecorded[job.employer] > 0) unrecorded[job.employer] -= 1;
        if (job.worker != address(0) && unrecorded[job.worker] > 0) unrecorded[job.worker] -= 1;

        emit RecordCleared(jobId, job.employer, job.worker);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Hand the resolver role over. Cannot reach escrow, so it is not a theft vector.
    function transferResolver(address next) external {
        if (msg.sender != resolver) revert NotResolver();
        if (next == address(0)) revert ZeroAmount();

        emit ResolverChanged(resolver, next);
        resolver = next;
    }

    // ------------------------------------------------------------------- view

    /// @notice What a settled job did, for the registry and for anything else that needs the
    ///         settlement without the whole job. Narrow on purpose: the registry depends on this
    ///         shape and nothing else, so the job layout stays free to change.
    ///
    /// @dev A struct rather than a tuple of thirteen values, because a thirteen-value return pushed
    ///      the compiler past its stack limit. The ABI encoding is identical.
    function settlementFacts(uint256 jobId) external view returns (PactTypes.SettlementFacts memory facts) {
        Job storage job = _jobs[jobId];
        facts.employer = job.employer;
        facts.worker = job.worker;
        facts.filer = job.filer;
        facts.state = uint8(job.state);
        facts.price = job.price;
        facts.bond = job.bond;
        facts.filingFee = job.filer == address(0) ? 0 : (job.price * FILING_FEE_BPS) / BPS;
        facts.termsHash = job.termsHash;
        facts.proofHash = job.proofHash;
        facts.reasonHash = job.reasonHash;
        facts.workerWon = job.workerWon;
        facts.timedOut = job.timedOut;
        facts.settledAt = job.settledAt;
        facts.toEmployerPaid = job.toEmployerPaid;
        facts.toWorkerPaid = job.toWorkerPaid;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function getBids(uint256 jobId) external view returns (Bid[] memory) {
        return _bids[jobId];
    }

    function bidCount(uint256 jobId) external view returns (uint256) {
        return _bids[jobId].length;
    }

    // --------------------------------------------------------------- internal

    function _cut(uint256 price) private pure returns (uint256) {
        return (price * PLATFORM_FEE_BPS) / BPS;
    }

    /// @dev Records what actually happened, once, and blocks both parties until it is inscribed.
    function _markSettled(Job storage job, bool workerWon, uint256 toEmployer, uint256 toWorker) private {
        job.state = State.SETTLED;
        job.workerWon = workerWon;
        job.settledAt = uint64(block.timestamp);
        job.toEmployerPaid = toEmployer;
        job.toWorkerPaid = toWorker;

        unrecorded[job.employer] += 1;
        unrecorded[job.worker] += 1;
    }

    /// @dev The single implementation of the settlement maths. Every path below calls it, so the
    /// numbers a caller reads from `quote` are produced by the same code that moves the money —
    /// a documented table can no longer drift from the escrow without this function changing.
    function quote(
        Path path,
        uint256 price,
        uint256 bond,
        uint256 employerEscrow,
        uint256 workerEscrow,
        uint16 fineBps
    ) public pure returns (Quote memory q) {
        if (fineBps > LOSS_FINE_BPS) revert FineTooHigh();

        uint256 cut = (price * PLATFORM_FEE_BPS) / BPS;
        q.toTreasury = cut;

        if (path == Path.RELEASE || path == Path.RULE_FOR_WORKER) {
            q.toWorker = employerEscrow - cut + workerEscrow;
        } else if (path == Path.ABANDON) {
            q.toEmployer = employerEscrow - cut + workerEscrow;
        } else {
            /// The fine is a share of the *original* bond, not of whatever is left of the worker's
            /// escrow after a filing fee, and it can never take more than that escrow holds.
            uint256 fine = (bond * fineBps) / BPS;
            if (fine > workerEscrow) fine = workerEscrow;

            q.fine = fine;
            q.toEmployer = employerEscrow - cut + fine;
            q.toWorker = workerEscrow - fine;
        }
    }

    function _releaseToWorker(Job storage job) private returns (uint256 toWorker, uint256 cut) {
        Quote memory q = quote(Path.RELEASE, job.price, job.bond, job.employerEscrow, job.workerEscrow, 0);

        _markSettled(job, true, 0, q.toWorker);
        claimable[job.worker] += q.toWorker;
        claimable[treasury] += q.toTreasury;

        return (q.toWorker, q.toTreasury);
    }
}
