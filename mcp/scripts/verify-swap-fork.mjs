// Proves the swap encoder against the real pool, on a fork of mainnet, before any real money moves.
//
// Every number asserted here is read from the fork. The encoder used is the one the app and the MCP
// ship — `dist/swap.js`, compiled from `src/swap.ts` — so a passing run means the exact code path a
// user takes is correct, not a re-implementation of it.
//
//   node scripts/rpc-proxy.mjs 8547 https://rpc.mainnet.chain.robinhood.com
//   anvil --fork-url http://127.0.0.1:8547 --port 8546
//   node scripts/verify-swap-fork.mjs
//
// The proxy is not optional: the chain's public RPC answers 403 to a client that sends no
// User-Agent, and anvil cannot send one.
//
// It is deliberately not part of `npm test`: it needs a forked node and it spends nothing, but it is
// slow, so it runs on demand and after any change to the encoder.

import { createPublicClient, createWalletClient, http, parseAbi, formatEther, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  PERMIT2,
  PERMIT2_ABI,
  ERC20_ABI,
  UNIVERSAL_ROUTER,
  quoteExactIn,
  encodeSwap,
  poolFor,
  withSlippage,
} from "../dist/swap.js";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
const CHAIN_ID = 4663;

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain (fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const pub = createPublicClient({ chain, transport: http(RPC) });
const pool = poolFor(CHAIN_ID);

/// A wallet that actually holds WIF on mainnet, impersonated on the fork to fund the test. Nothing
/// is signed with its key; the fork simply pretends to be it.
const WIF_WHALE = "0x3ac7b9e87d5443e1df7a950b339e34999770de28";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

const wifBal = (who) => pub.readContract({ address: pool.token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] });
const ethBal = (who) => pub.getBalance({ address: who });

const mine = async () => {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }),
  });
};

const setBalance = async (address, wei) => {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, `0x${wei.toString(16)}`] }),
  });
};

const impersonate = async (address, on) => {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: on ? "anvil_impersonateAccount" : "anvil_stopImpersonatingAccount", params: [address] }),
  });
};

async function main() {
  const block = await pub.getBlockNumber();
  console.log(`fork of chain ${CHAIN_ID} at block ${block}`);
  console.log(`pool ${pool.key.currency0 === "0x0000000000000000000000000000000000000000" ? "ETH" : pool.key.currency0} / ${pool.symbol}, fee ${pool.key.fee}, tick spacing ${pool.key.tickSpacing}\n`);

  const trader = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account: trader, chain, transport: http(RPC) });
  await setBalance(trader.address, 10n ** 19n); // 10 ETH on the fork
  await mine();
  check("the test wallet is funded on the fork", (await ethBal(trader.address)) === 10n ** 19n);

  // ---------------------------------------------------------------- quote sanity
  const oneEth = 10n ** 18n;
  const buyQuote = await quoteExactIn(pub, pool, true, oneEth);
  console.log(`\nquote: 1 ETH -> ${formatUnits(buyQuote.amountOut, 18)} WIF (gas estimate ${buyQuote.gasEstimate})`);
  check("the quoter answers for this pool key", buyQuote.amountOut > 0n);

  const sellQuote = await quoteExactIn(pub, pool, false, 10n ** 21n);
  console.log(`quote: 1000 WIF -> ${formatEther(sellQuote.amountOut)} ETH`);
  check("the reverse direction quotes too", sellQuote.amountOut > 0n);

  // ---------------------------------------------------------------- a real buy
  const buyIn = 10n ** 16n; // 0.01 ETH
  const buy = await quoteExactIn(pub, pool, true, buyIn);
  const buyTx = encodeSwap({
    pool,
    zeroForOne: true,
    amountIn: buyIn,
    amountOutMinimum: withSlippage(buy.amountOut, 100),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  });

  const wifBefore = await wifBal(trader.address);
  const ethBefore = await ethBal(trader.address);
  const buyHash = await wallet.sendTransaction({ to: buyTx.to, data: buyTx.data, value: buyTx.value, gas: 900_000n });
  const buyReceipt = await pub.waitForTransactionReceipt({ hash: buyHash });
  const wifAfter = await wifBal(trader.address);
  const ethAfter = await ethBal(trader.address);

  console.log(`\nbuy  0.01 ETH for ${formatUnits(wifAfter - wifBefore, 18)} WIF  (tx ${buyHash.slice(0, 12)}…)`);
  check("the buy transaction succeeded", buyReceipt.status === "success");
  check("WIF arrived in the wallet", wifAfter - wifBefore > 0n, `${formatUnits(wifAfter - wifBefore, 18)} WIF`);
  check("the delivered amount met the floor we set", wifAfter - wifBefore >= withSlippage(buy.amountOut, 100));
  check("only the input plus gas left the wallet", ethBefore - ethAfter <= buyIn + 2_000_000_000_000_000n);

  // ---------------------------------------------------------------- a real sell
  // Fund the seller from a real holder on the fork, then take the same path a user takes: ERC-20
  // approval to Permit2, Permit2 approval to the router, then the swap.
  await impersonate(WIF_WHALE, true);
  await setBalance(WIF_WHALE, 10n ** 19n);
  const whale = createWalletClient({ account: WIF_WHALE, chain, transport: http(RPC) });
  const transfer = await whale.writeContract({
    address: pool.token,
    abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
    functionName: "transfer",
    args: [trader.address, 10n ** 21n],
  });
  await pub.waitForTransactionReceipt({ hash: transfer });
  await impersonate(WIF_WHALE, false);

  const sellIn = 10n ** 21n; // 1000 WIF
  const held = await wifBal(trader.address);
  check("the seller holds WIF on the fork", held >= sellIn, `${formatUnits(held, 18)} WIF`);

  const approveToken = await wallet.writeContract({
    address: pool.token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [PERMIT2, sellIn],
  });
  await pub.waitForTransactionReceipt({ hash: approveToken });

  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const approvePermit2 = await wallet.writeContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "approve",
    args: [pool.token, UNIVERSAL_ROUTER, sellIn, expiry],
  });
  await pub.waitForTransactionReceipt({ hash: approvePermit2 });

  const sellQuoteNow = await quoteExactIn(pub, pool, false, sellIn);
  const sellTx = encodeSwap({
    pool,
    zeroForOne: false,
    amountIn: sellIn,
    amountOutMinimum: withSlippage(sellQuoteNow.amountOut, 100),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  });

  const wifBeforeSell = await wifBal(trader.address);
  const ethBeforeSell = await ethBal(trader.address);
  const sellHash = await wallet.sendTransaction({ to: sellTx.to, data: sellTx.data, value: 0n, gas: 900_000n });
  const sellReceipt = await pub.waitForTransactionReceipt({ hash: sellHash });
  const wifAfterSell = await wifBal(trader.address);
  const ethAfterSell = await ethBal(trader.address);

  const gasCost = sellReceipt.gasUsed * (sellReceipt.effectiveGasPrice ?? 0n);
  console.log(`\nsell quote was ${formatEther(sellQuoteNow.amountOut)} ETH, floor ${formatEther(withSlippage(sellQuoteNow.amountOut, 100))} ETH`);
  console.log(`sell received ${formatEther(ethAfterSell - ethBeforeSell)} ETH net of ${formatEther(gasCost)} ETH gas  (tx ${sellHash.slice(0, 12)}…)`);
  check("the sell transaction succeeded", sellReceipt.status === "success");
  check("WIF left the wallet", wifBeforeSell - wifAfterSell === sellIn, `${formatUnits(wifBeforeSell - wifAfterSell, 18)} WIF`);
  check("ETH arrived", ethAfterSell - ethBeforeSell > 0n, `${formatEther(ethAfterSell - ethBeforeSell)} ETH`);
  check("the ETH received met the floor we set", ethAfterSell - ethBeforeSell + gasCost >= withSlippage(sellQuoteNow.amountOut, 100));

  // ---------------------------------------------------------------- the guard
  let refused = false;
  try {
    poolFor(1); // any chain without an entry in POOLS
  } catch {
    refused = true;
  }
  check("a chain with no pool is refused with a reason", refused);

  console.log(failures === 0 ? "\nall swap checks passed" : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("\nswap verification aborted:", error?.shortMessage ?? error?.message ?? error);
  process.exitCode = 1;
});
