import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { anvil, robinhood } from "./chain";

const active = process.env.NEXT_PUBLIC_CHAIN === "local" ? anvil : robinhood;

/// The active chain has to be first: wagmi reads chains[0] for chain-less calls.
const chains = [active, robinhood, anvil].filter(
  (chain, i, all) => all.findIndex((c) => c.id === chain.id) === i,
) as unknown as readonly [typeof active, ...(typeof active)[]];

/// One injected connector entry point. EIP-6963 discovery is on by default, so wagmi
/// announces itself and every installed wallet answers — MetaMask, Rabby, Brave,
/// Coinbase, Phantom, and anything else implementing the standard. Each announced
/// wallet arrives as its own connector with a name and an icon.
export const config = createConfig({
  chains,
  connectors: [injected()],
  transports: {
    [robinhood.id]: http(),
    [anvil.id]: http("http://127.0.0.1:8545"),
  },
  multiInjectedProviderDiscovery: true,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
