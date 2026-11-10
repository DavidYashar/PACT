// GENERATED FILE — do not edit.
// Source: mcp/src/swap.ts, copied by mcp/scripts/gen-swap.mjs so the browser and the MCP server
// encode the same route. Both call the Uniswap v4 Universal Router with the same action bytes;
// a divergence between them would be a transaction that reverts on one side only.
/// Buying and selling $WIF against the Uniswap v4 pool, encoded locally.
///
/// Why local encoding rather than a widget or the Uniswap Trade API: every number here is then
/// derived from and checkable against the chain. The quote comes from `V4Quoter`, the route is the
/// canonical Universal Router, and the calldata is built from the *verified* pool key.
///
/// The pool key is the one detail that silently breaks a hand-built swap: this pool is registered
/// with `fee = 0` and takes its 1% in the hook, so quoting with `DYNAMIC_FEE_FLAG (0x800000)` reverts
/// even though the pool is described as "dynamic". Measured on chain, not assumed.
///
/// Nothing here holds a token or names a recipient the caller chooses: the recipient is always the
/// account that signs, which is the same rule the ruling path follows.

import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

export const UNIVERSAL_ROUTER: Address = "0x204FAca1764B154221e35c0d20aBb3c525710498";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const V4_QUOTER: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/// Universal Router command bytes.
const CMD_V4_SWAP = "10" as Hex;
/// v4-periphery action bytes.
const ACT_SWAP_EXACT_IN_SINGLE = "06";
const ACT_SETTLE_ALL = "0c";
const ACT_TAKE_ALL = "0f";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type Pool = {
  key: PoolKey;
  /// The token that is not the chain's native currency.
  token: Address;
  symbol: string;
  decimals: number;
};

const WIF_MAINNET: Address = "0x5173b8eA6923c2d40267890D45C46a3480954773";

/// A pool is a deployment fact, so it is looked up by chain id rather than assumed. On a chain with
/// no entry there is nothing to trade against and every caller must say so plainly.
export const POOLS: Record<number, Pool | undefined> = {
  4663: {
    key: {
      currency0: NATIVE,
      currency1: WIF_MAINNET,
      fee: 0,
      tickSpacing: 200,
      hooks: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
    },
    token: WIF_MAINNET,
    symbol: "WIF",
    decimals: 18,
  },
};

export function poolFor(chainId: number): Pool {
  const pool = POOLS[chainId];
  if (!pool) {
    throw new Error(
      `there is no WIF pool on chain ${chainId}. The swap only exists on Robinhood Chain mainnet (4663).`,
    );
  }
  return pool;
}

export const POOL_KEY_TUPLE = {
  type: "tuple",
  name: "poolKey",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable returns (bytes[] memory)",
]);

const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export { PERMIT2_ABI, ERC20_ABI, ROUTER_ABI, QUOTER_ABI };

export type Quote = { amountOut: bigint; gasEstimate: bigint };

type ReadClient = {
  call: (args: { to: Address; data: Hex }) => Promise<{ data?: Hex | undefined }>;
};

/// Ask the pool what it would pay. `quoteExactInputSingle` is not a view function (it runs a real
/// swap inside an unlock), so it is called through `eth_call` directly rather than `readContract`.
export async function quoteExactIn(
  client: ReadClient,
  pool: Pool,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<Quote> {
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: pool.key,
        zeroForOne,
        exactAmount: amountIn,
        hookData: "0x",
      },
    ],
  });

  const result = await client.call({ to: V4_QUOTER, data });
  if (!result.data) throw new Error("the quoter returned nothing");

  const [amountOut, gasEstimate] = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: result.data,
  }) as readonly [bigint, bigint];

  return { amountOut, gasEstimate };
}

export type SwapPlanArgs = {
  pool: Pool;
  /// true = pay the native currency and receive the token; false = the reverse.
  zeroForOne: boolean;
  amountIn: bigint;
  /// Floor on what comes back. Computed from the quote and the caller's slippage tolerance.
  amountOutMinimum: bigint;
  /// There is no recipient field here on purpose. The take action pays whoever called the router,
  /// so the output can only reach the wallet that signs. Nothing to pass, nothing to get wrong —
  /// the same rule the ruling path follows: no address argument, anywhere.
  /// Unix seconds. Short: a swap that lands minutes later is not the swap the user approved.
  deadline: bigint;
};

export type Transaction = { to: Address; data: Hex; value: bigint };

export type SwapCall = Transaction & {
  /// The parts of the call, so a verifier can re-derive the calldata from the intent rather than
  /// trusting a blob. `pact_submit` compares the signed transaction against these.
  commands: Hex;
  inputs: Hex[];
  deadline: bigint;
};

/// The Universal Router call: one command (`V4_SWAP`) carrying three actions — swap, settle the
/// input currency, take the output currency. That is the whole route; there is no path to a
/// different pool, and the recipient cannot be redirected.
export function encodeSwap(args: SwapPlanArgs): SwapCall {
  const { pool, zeroForOne, amountIn, amountOutMinimum, deadline } = args;

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          POOL_KEY_TUPLE,
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: pool.key,
        zeroForOne,
        amountIn,
        amountOutMinimum,
        hookData: "0x" as Hex,
      },
    ],
  );

  const currencyIn = zeroForOne ? pool.key.currency0 : pool.key.currency1;
  const currencyOut = zeroForOne ? pool.key.currency1 : pool.key.currency0;

  const settleParams = encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "currency", type: "address" }, { name: "maxAmount", type: "uint256" }] }],
    [{ currency: currencyIn, maxAmount: amountIn }],
  );

  const takeParams = encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "currency", type: "address" }, { name: "minAmount", type: "uint256" }] }],
    [{ currency: currencyOut, minAmount: amountOutMinimum }],
  );

  const actions = `0x${ACT_SWAP_EXACT_IN_SINGLE}${ACT_SETTLE_ALL}${ACT_TAKE_ALL}` as Hex;

  const v4Input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]],
  );

  const commands = `0x${CMD_V4_SWAP}` as Hex;
  const inputs = [v4Input];
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "execute",
    args: [commands, inputs, deadline],
  });

  return { to: UNIVERSAL_ROUTER, data, value: zeroForOne ? amountIn : 0n, commands, inputs, deadline };
}

/// Applies a slippage tolerance to a quote, downward only.
export function withSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 2_000) throw new Error("slippage must be between 0 and 2000 bps");
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/// Permit2 expiry for a sell allowance: long enough for the transaction to land, short enough that
/// a forgotten approval is not standing for ever.
export function permitExpiry(nowSeconds: number): number {
  return nowSeconds + 30 * 60;
}
