// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PactTypes} from "./PactTypes.sol";

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice The slice of PactEscrow this registry reads. Declared here, field for field, so the
///         registry can never be deployed against a layout it does not understand.
interface IPactEscrow {
    function settlementFacts(uint256 jobId) external view returns (PactTypes.SettlementFacts memory);

    function confirmRecorded(uint256 jobId) external;
}

/// @title PactNames
/// @notice Identity and the permanent record of settled work.
///
/// @dev Deliberately holds no money and no job lifecycle, so it can outlive any escrow upgrade.
///      Every number written here is read back off the escrow and can only be written once per
///      job id, so this contract is an index of facts rather than a place to make claims.
///
///      Recording is what unlocks money: the escrow refuses claim() until it has been told the
///      job is inscribed. Either party may pay to record, which is what lets one side step in
///      when the other has walked away.
contract PactNames is EIP712 {
    uint8 private constant STATE_SETTLED = 5;

    /// @notice The smallest price that earns a place in a profile. A job below it settles and is
    ///         recorded, but moves no counter and enters no history, so "settled a job" always
    ///         means "settled a job worth settling". Below this, an attacker paid only gas.
    /// @dev    100 WIF, in token units — no decimals of the token are negotiated here, this is
    ///         100 × 10^18 wei of an 18-decimal ERC-20. There is no upper bound: a job at or above
    ///         this counts for exactly what it is worth, however large, and the escrow itself puts
    ///         no ceiling on a budget or a price. The floor exists to make rank cost real value to
    ///         manufacture, so it is a floor on sincerity, not a band.
    uint256 public constant MIN_COUNTED_PRICE = 100e18;

    bytes32 private constant REGISTER_TYPEHASH =
        keccak256("Register(string name,uint8 kind,address owner,uint256 deadline)");

    /// @notice Whether a username belongs to a person or to an AI agent.
    enum Kind {
        HUMAN,
        AI
    }

    struct Profile {
        string name;
        Kind kind;
        uint64 registeredAt;
        uint32 jobsPosted;
        uint32 jobsDone;
        uint32 tickets;
        uint256 spentAsEmployer;
        uint256 earnedAsWorker;
        /// Everything a scoreboard needs, written once per settled job so a leaderboard is one read
        /// per account instead of a scan of every job. These are counts of finished things, never
        /// judgments: the escrow decides who won, and this only tallies it.
        ///
        /// Tickets are split by outcome because a worker who loses one should rank below a worker
        /// who wins one, and the same for an employer. `abandoned` is separate from a lost ticket:
        /// walking away forfeits the whole bond without anyone having to complain.
        uint32 ticketsWon;
        uint32 ticketsLost;
        uint32 abandoned;
        /// WIF that actually moved, gross, so the numbers can be checked against the token rather
        /// than trusted. Net figures are these minus the stake the same side put up:
        /// worker net = receivedAsWorker - bondedAsWorker.
        uint256 receivedAsWorker;
        uint256 bondedAsWorker;
        uint256 stakedAsEmployer;
        uint256 receivedAsEmployer;
        /// Ticket fees this address paid to open a complaint. Separate from the price: an employer
        /// pays it in new WIF, so it is real spend that the staked/received pair cannot see.
        uint256 feesPaid;
    }

    /// @notice One settled job, frozen at the moment it was inscribed. Hashes only — the terms and
    ///         deliverable text are destroyed once this exists.
    struct Record {
        uint256 jobId;
        address employer;
        address worker;
        bytes32 termsHash;
        bytes32 proofHash;
        bool hadTicket;
        bool workerWon;
        uint256 paidToWorker;
        uint256 spentByEmployer;
        uint64 settledAt;
        address recordedBy;
    }

    address public immutable deployer;

    /// @notice Set once, right after the escrow is deployed. See setEscrow.
    address public escrow;

    /// @notice Normalised name => owner. Zero address means available.
    mapping(string => address) public ownerOfName;

    mapping(address => Profile) private _profiles;
    /// @dev Escrow => job id => record. Namespaced on purpose: a redeployed escrow restarts its
    ///      ids at 1, and without this a new job #1 would look already recorded.
    mapping(address => mapping(uint256 => Record)) private _records;
    mapping(address => mapping(uint256 => bool)) private _recorded;
    mapping(address => uint256[]) private _history;

    event UsernameRegistered(address indexed owner, string name, Kind kind);
    event KindUpdated(address indexed owner, Kind kind);
    event JobRecorded(uint256 indexed jobId, address indexed employer, address indexed worker, address recordedBy);
    event EscrowSet(address escrow);

    error AlreadyRegistered();
    error NotRegistered();
    error NameTaken();
    error NameTooShort();
    error NameTooLong();
    error BadCharacter();
    error NameReserved();
    error UnknownJob();
    error NotSettled();
    error NotParty();
    error AlreadyRecorded();
    error EscrowNotSet();
    error EscrowAlreadySet();
    error NotDeployer();
    error ZeroAddress();
    error DeadlinePassed();
    error BadSignature();

    constructor() EIP712("PactNames", "1") {
        deployer = msg.sender;
    }

    /// @notice Point at the live escrow. Callable by the deployer at any time: a new escrow
    ///         simply starts a fresh id space, and every record already written stays exactly
    ///         where it is, keyed by the escrow that produced it.
    /// @notice Bind the registry to its escrow, once.
    ///
    /// @dev One-shot on purpose. This used to be repeatable by the deployer, which meant the
    ///      deployer could point the registry at an escrow that answers `settlementFacts` with
    ///      invented jobs and then call `record` to write them into anyone's history. That was
    ///      cosmetic while the registry was a name service; it is a way to forge reputation now
    ///      that a profile decides who wins a bid. After this call the registry has no admin.
    function setEscrow(address next) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (next == address(0)) revert ZeroAddress();
        if (escrow != address(0)) revert EscrowAlreadySet();

        escrow = next;
        emit EscrowSet(next);
    }

    // --------------------------------------------------------------- register

    /// @notice Claim a username from the calling wallet. The transaction signature is the proof.
    function register(string calldata name, Kind kind) external {
        _register(msg.sender, name, kind);
    }

    /// @notice Claim a username on behalf of `owner`, who signed an EIP-712 message instead of
    ///         paying gas. Anything holding the signature may relay it, so a wallet with a zero
    ///         balance can take a name on its first visit.
    function registerFor(
        address owner,
        string calldata name,
        Kind kind,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert DeadlinePassed();
        if (_profiles[owner].registeredAt != 0) revert AlreadyRegistered();

        // SignatureChecker covers plain EOAs and ERC-1271 smart accounts alike, so a 4337 or 7702
        // wallet registers without a second code path.
        if (!SignatureChecker.isValidSignatureNow(owner, _digest(owner, name, kind, deadline), signature)) {
            revert BadSignature();
        }

        _register(owner, name, kind);
    }

    /// @notice Flip the human/AI flag. Under-claiming is always safe to correct.
    function setKind(Kind kind) external {
        Profile storage p = _profiles[msg.sender];
        if (p.registeredAt == 0) revert NotRegistered();

        p.kind = kind;
        emit KindUpdated(msg.sender, kind);
    }

    // ---------------------------------------------------------------- record

    /// @notice Inscribe one settled job and credit both parties. Either party may call it; the
    ///         second call reverts, so a job can never be counted twice.
    ///
    /// @dev Reading the escrow means none of this can be invented by the caller. It also clears
    ///      the escrow's claim block for both sides in the same transaction.
    function record(uint256 jobId) external {
        address esc = escrow;
        if (esc == address(0)) revert EscrowNotSet();
        if (_recorded[esc][jobId]) revert AlreadyRecorded();

        PactTypes.SettlementFacts memory j = IPactEscrow(esc).settlementFacts(jobId);
        if (j.employer == address(0)) revert UnknownJob();
        if (j.state != STATE_SETTLED) revert NotSettled();
        if (msg.sender != j.employer && msg.sender != j.worker) revert NotParty();

        bool hadTicket = j.filer != address(0);

        _recorded[esc][jobId] = true;
        _records[esc][jobId] = Record({
            jobId: jobId,
            employer: j.employer,
            worker: j.worker,
            termsHash: j.termsHash,
            proofHash: j.proofHash,
            hadTicket: hadTicket,
            workerWon: j.workerWon,
            paidToWorker: j.toWorkerPaid,
            spentByEmployer: j.workerWon ? j.price : 0,
            settledAt: j.settledAt,
            recordedBy: msg.sender
        });

        // Both sides point at the same job id, so one transaction writes both histories.
        //
        // Dust is settled but not counted. Every counter here feeds a board or an agent tool, and
        // a job priced in wei costs its pair nothing: no platform cut, no filing fee, no real
        // capital. Counting it would let two wallets farm `jobsDone`, `settledJobs` and the whole
        // ranking for gas alone. Below the floor the record is still written and `confirmRecorded`
        // still runs, so the money settles and claims unblock; only the reputation is withheld.
        //
        // A ticket that timed out is the same case for a different reason: nobody decided it, so
        // nobody is marked. Writing it as a loss would punish whichever party the clock happened to
        // strand. The record still lands, so the job is still auditable and the claim still clears.
        if (j.price < MIN_COUNTED_PRICE || j.timedOut) {
            /// The fee is money that actually left a wallet, so it is recorded even here. The
            /// counters are not: nobody won and nobody lost.
            if (hadTicket && j.filingFee > 0) _profiles[j.filer].feesPaid += j.filingFee;
            IPactEscrow(esc).confirmRecorded(jobId);
            emit JobRecorded(jobId, j.employer, j.worker, msg.sender);
            return;
        }

        _history[j.employer].push(jobId);
        _history[j.worker].push(jobId);

        Profile storage e = _profiles[j.employer];
        Profile storage w = _profiles[j.worker];

        e.jobsPosted += 1;
        e.stakedAsEmployer += j.price;
        e.receivedAsEmployer += j.toEmployerPaid;

        w.bondedAsWorker += j.bond;
        w.receivedAsWorker += j.toWorkerPaid;

        if (hadTicket) {
            e.tickets += 1;
            w.tickets += 1;
            _profiles[j.filer].feesPaid += j.filingFee;
            /// One ruling, two perspectives: whoever's side prevailed takes the win.
            if (j.workerWon) {
                w.ticketsWon += 1;
                e.ticketsLost += 1;
            } else {
                e.ticketsWon += 1;
                w.ticketsLost += 1;
            }
        } else if (!j.workerWon) {
            /// Settled against the worker with no ticket and nothing paid out: they walked away.
            w.abandoned += 1;
        }

        if (j.workerWon) {
            e.spentAsEmployer += j.price;
            w.jobsDone += 1;
            // Net gain: the returned bond is not income, and a self-filed ticket was a cost.
            w.earnedAsWorker += j.toWorkerPaid - j.bond;
        }

        IPactEscrow(esc).confirmRecorded(jobId);

        emit JobRecorded(jobId, j.employer, j.worker, msg.sender);
    }

    // ------------------------------------------------------------------ view

    function profileOf(address who) external view returns (Profile memory) {
        return _profiles[who];
    }

    function nameOf(address who) external view returns (string memory) {
        return _profiles[who].name;
    }

    function recordOf(uint256 jobId) external view returns (Record memory) {
        return _records[escrow][jobId];
    }

    /// @notice Has this job, on the live escrow, been inscribed? Read by the UI and by nothing else.
    function recorded(uint256 jobId) external view returns (bool) {
        return _recorded[escrow][jobId];
    }

    /// @notice The same two answers for any escrow, so records written by a previous deployment
    ///         stay reachable after an upgrade.
    function recordOfAt(address escrow_, uint256 jobId) external view returns (Record memory) {
        return _records[escrow_][jobId];
    }

    function recordedFor(address escrow_, uint256 jobId) external view returns (bool) {
        return _recorded[escrow_][jobId];
    }

    /// @notice The check the escrow makes before it lets a wallet post a job or place a bid.
    ///         Deliberately one slot wide: the escrow calls this on every post and every bid.
    function isRegistered(address who) external view returns (bool) {
        return _profiles[who].registeredAt != 0;
    }

    function historyOf(address who) external view returns (uint256[] memory) {
        return _history[who];
    }

    function historyLength(address who) external view returns (uint256) {
        return _history[who].length;
    }

    /// @notice The digest to sign for `registerFor`, so the frontend never reimplements the hash.
    function registerDigest(address owner, string calldata name, Kind kind, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _digest(owner, name, kind, deadline);
    }

    // -------------------------------------------------------------- internal

    function _digest(address owner, string calldata name, Kind kind, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(REGISTER_TYPEHASH, keccak256(bytes(name)), kind, owner, deadline))
        );
    }

    function _register(address owner, string calldata name, Kind kind) private {
        if (_profiles[owner].registeredAt != 0) revert AlreadyRegistered();

        string memory normalized = _normalize(name);
        if (_isReserved(normalized)) revert NameReserved();
        if (ownerOfName[normalized] != address(0)) revert NameTaken();

        ownerOfName[normalized] = owner;

        // Only identity fields are written. Any points already earned before registering survive.
        Profile storage p = _profiles[owner];
        p.name = normalized;
        p.kind = kind;
        p.registeredAt = uint64(block.timestamp);

        emit UsernameRegistered(owner, normalized, kind);
    }

    /// @dev Lowercased, so "Yasha" and "yasha" are the same name and the same owner.
    function _normalize(string calldata name) private pure returns (string memory) {
        bytes memory raw = bytes(name);
        uint256 len = raw.length;
        if (len < 3) revert NameTooShort();
        if (len > 20) revert NameTooLong();

        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            uint8 c = uint8(raw[i]);
            if (c >= 0x41 && c <= 0x5A) {
                out[i] = bytes1(c + 32);
            } else if (c == 0x5F || (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7A)) {
                out[i] = bytes1(c);
            } else {
                revert BadCharacter();
            }
        }
        return string(out);
    }

    /// @dev Kept short on purpose. Names that read like platform authority are the cheapest
    ///      phishing primitive in a reputation market, so they are not registrable at all.
    function _isReserved(string memory normalized) private pure returns (bool) {
        bytes32 h = keccak256(bytes(normalized));
        return h == keccak256(bytes("pact")) || h == keccak256(bytes("admin"))
            || h == keccak256(bytes("treasury")) || h == keccak256(bytes("resolver"))
            || h == keccak256(bytes("support")) || h == keccak256(bytes("official"));
    }
}
