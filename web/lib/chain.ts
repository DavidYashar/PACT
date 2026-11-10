import { defineChain } from "viem";

/// Robinhood Chain. ETH is the gas token; ~250ms blocks; FCFS sequencer, no priority fee.
/// This is the chain PACT is deployed on, and the only network the app targets.
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/// Local anvil, for running the whole app offline against a fresh deployment. Not a second network
/// in any product sense: same code paths, same contracts, a node on this machine.
export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

/// The chain the app talks to. `NEXT_PUBLIC_CHAIN=local` moves the whole UI to anvil; anything else
/// is mainnet, which is what production runs and what every link in the UI should point at.
export const activeChain = process.env.NEXT_PUBLIC_CHAIN === "local" ? anvil : robinhood;

export const WIF_ADDRESS = (process.env.NEXT_PUBLIC_WIF_ADDRESS ??
  "0x5173b8eA6923c2d40267890D45C46a3480954773") as `0x${string}`;

/// The deployed escrow and registry. There is no testnet default to fall back to: an unset value is
/// the zero address, and a read against it fails rather than answering from somewhere else.
export const ESCROW_ADDRESS = (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

/// Identity + points. Deliberately separate from the escrow so it survives escrow upgrades.
export const NAMES_ADDRESS = (process.env.NEXT_PUBLIC_NAMES_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export const EXPLORER = activeChain.blockExplorers?.default.url;

/// Where logs are read from.
///
/// Not every endpoint serves `eth_getLogs` — the Alchemy app used for ordinary reads answers it with
/// a JSON-RPC error, and the talent board is the one screen that needs logs (the registry keeps a
/// mapping, so its `UsernameRegistered` events are the only way to ask "who exists"). Reads stay on
/// the configured RPC; logs get their own, defaulting to the chain's public endpoint, which does
/// serve them but is rate limited.
///
/// Server-only on purpose. A `NEXT_PUBLIC_*` value is inlined into the browser bundle, so a billed
/// RPC key read from one is a published credential. `LOGS_RPC_URL` and `RPC_URL` have no public
/// variant; the browser uses the chain's default endpoint above.
export const LOGS_RPC_URL =
  process.env.LOGS_RPC_URL ??
  (activeChain.id === robinhood.id ? "https://rpc.mainnet.chain.robinhood.com" : "http://127.0.0.1:8545");

/// Blockscout tabs. A transaction's evidence is in its logs, and the address tab is where
/// every record written by the registry is listed, so links into the explorer open there.
export const TAB_LOGS = "?tab=logs";

export function txUrl(hash: string, tab?: string) {
  return EXPLORER ? `${EXPLORER}/tx/${hash}${tab ?? ""}` : undefined;
}

export function addressUrl(address: string, tab?: string) {
  return EXPLORER ? `${EXPLORER}/address/${address}${tab ?? ""}` : undefined;
}
