/// Wallets surface a failed gas estimate as "not enough ETH", which is misleading when
/// the real cause is a contract revert. Translate the ones a user can actually hit.
export function friendlyError(message: string): string {
  const first = message.split("\n")[0];

  if (/ERC20InsufficientAllowance|insufficient allowance/i.test(message)) {
    return "This needs a WIF allowance first. Approve the amount in the step above, then retry — it is not a gas problem.";
  }
  /// The bond revert names the worker, so an employer reading it thinks their own wallet
  /// is at fault. Say whose balance is actually short.
  if (/ERC20InsufficientBalance|0xe450d38c|transfer amount exceeds balance/i.test(message)) {
    return "The worker's wallet does not hold enough WIF to cover the bond this action pulls. Nothing is wrong with your wallet or your gas — the bidder has to top up and approve the bond first.";
  }
  if (/ResolverIsParty/.test(message)) {
    return "The contract forbids the resolver from ruling on a job it is a party to. This ticket has to be decided by another wallet, or the resolver role has to move.";
  }
  if (/NotResolver/.test(message)) {
    return "This wallet is not the resolver any more — the role was transferred at some point. Reload to pick up the current one.";
  }
  if (/PastDeadline/.test(message)) {
    return "The delivery deadline has passed, so this action is no longer allowed.";
  }
  if (/RecordPending/.test(message)) {
    return "This wallet still owes a record for a settled job. Record the finished work first — that is what unlocks the claim.";
  }
  /// Refused at bid time so an employer never eats the revert on someone else's empty wallet.
  if (/BondUnfunded/.test(message)) {
    return "This wallet does not hold enough WIF to cover the bond for that price. A bid only counts once the money is there — top up, then bid again.";
  }
  if (/NotRegistered/.test(message)) {
    return "This wallet has no username yet. Choose one on the account page first — posting and bidding both require it.";
  }
  if (/AlreadyRecorded/.test(message)) {
    return "This job has already been recorded. Nothing more to do — reload to see it.";
  }
  if (/NotParty/.test(message)) {
    return "Only the employer or the worker on this job can record it.";
  }
  if (/NameTaken/.test(message)) {
    return "That username is already taken. Pick another.";
  }
  if (/NameReserved/.test(message)) {
    return "That name is reserved by the platform. Pick another.";
  }
  if (/NameTooShort|NameTooLong|BadCharacter/.test(message)) {
    return "Usernames are 3–20 characters: letters, numbers and underscore only.";
  }
  if (/AlreadyRegistered/.test(message)) {
    return "This wallet already has a username. Usernames are permanent.";
  }
  if (/WrongState/.test(message)) {
    return "This job has already moved on — reload the page to see its current state.";
  }
  if (/user rejected|User denied/i.test(message)) {
    return "Rejected in the wallet.";
  }

  return first;
}
