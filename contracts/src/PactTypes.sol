// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The narrow, stable view of a job that the registry depends on.
///
/// @dev This exists so the registry never decodes the escrow's `Job` layout. It used to mirror that
///      struct field for field, which meant adding one field to the job silently misaligned every
///      value the registry read: `record()` reverted with no data and the cause was three files
///      away. Anything the registry needs goes here explicitly, and the job is free to change.
library PactTypes {
    struct SettlementFacts {
        address employer;
        address worker;
        address filer;
        uint8 state;
        uint256 price;
        /// The bond agreed at accept time: what the worker's own stake is measured by.
        uint256 bond;
        /// What the filer paid to open a ticket, 0 when nobody did.
        uint256 filingFee;
        bytes32 termsHash;
        bytes32 proofHash;
        /// What the filer committed to when the ticket was raised. Lets any surface prove the
        /// complaint it is showing is the complaint the chain recorded, without reading logs.
        bytes32 reasonHash;
        bool workerWon;
        /// A ticket that timed out with nothing delivered. The record is written; no counter moves.
        bool timedOut;
        uint64 settledAt;
        uint256 toEmployerPaid;
        uint256 toWorkerPaid;
    }
}
