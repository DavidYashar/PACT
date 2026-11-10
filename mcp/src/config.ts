/// Everything the server needs to know, and nothing it does not.
///
/// The MCP server holds no keys. Every write is prepared here and signed by the agent that
/// owns the wallet, so the only secrets in scope are the database URL and the RPC endpoint.

import { getAddress } from "viem";

export type Address = `0x${string}`;

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/// A mistyped checksum in an address silently reads as a zero balance, which turns a config
/// error into a wrong answer. Validate at boot so the server refuses to start instead.
function address(name: string, fallback?: string): Address {
  const raw = required(name, fallback);
  try {
    return getAddress(raw) as Address;
  } catch {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
}

/// One chain. PACT is deployed once, on Robinhood Chain mainnet, and the server refuses to guess:
/// an address that is missing is a boot failure, not a fallback to some other deployment. The
/// testnet this ran on during the build is gone from the code, not merely unset.
const NETWORK = {
  id: 4663,
  name: "Robinhood Chain",
  rpc: "https://robinhood-rpc.publicnode.com",
  explorer: "https://robinhoodchain.blockscout.com",
} as const;

/// Where the escrow was deployed. Reading a job's events needs a start point, and scanning from
/// genesis is not an option on a chain that produces four blocks a second. Events cannot exist
/// before the deploy, so a value that is too low only costs time and a value that is too high costs
/// an empty list — neither can invent a wrong answer.
const DEPLOY_BLOCK = 110_690_230n;

export const config = {
  chainId: NETWORK.id,
  chainName: NETWORK.name,
  rpcUrl: process.env.PACT_RPC_URL ?? NETWORK.rpc,
  explorer: NETWORK.explorer,

  escrow: address("PACT_ESCROW_ADDRESS"),
  names: address("PACT_NAMES_ADDRESS"),
  /// The token the escrow holds. A chain has one, and reading the wrong one is silent — a call to an
  /// address with no code returns nothing rather than failing — so this is a constant, not a guess.
  wif: address("PACT_WIF_ADDRESS", "0x5173b8eA6923c2d40267890D45C46a3480954773"),

  escrowDeployBlock: BigInt(process.env.PACT_ESCROW_DEPLOY_BLOCK ?? DEPLOY_BLOCK.toString()),

  /// The intent ledger is the only state this server owns. The DSN is deployment-specific,
  /// so it comes from the environment rather than from source. See .env.example.
  databaseUrl: required("DATABASE_URL"),

  port: Number(process.env.PORT ?? 8787),

  /// How long a prepared intent stays redeemable. Long enough for a model to sign, short
  /// enough that a reserved nonce is not lost for ever if it changes its mind.
  intentTtlSeconds: Number(process.env.PACT_INTENT_TTL_SECONDS ?? 180),
} as const;

export const BPS = 10_000n;
export const BOND_BPS = 5_000n;
export const FILING_FEE_BPS = 1_000n;
export const PLATFORM_FEE_BPS = 500n;

export const State = {
  NONE: 0,
  OPEN: 1,
  ASSIGNED: 2,
  DELIVERED: 3,
  DISPUTED: 4,
  SETTLED: 5,
  CANCELLED: 6,
} as const;

export const STATE_NAME: Record<number, string> = {
  0: "NONE",
  1: "OPEN",
  2: "ASSIGNED",
  3: "DELIVERED",
  4: "DISPUTED",
  5: "SETTLED",
  6: "CANCELLED",
};
