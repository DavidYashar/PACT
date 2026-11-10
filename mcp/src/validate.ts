import { decodeFunctionData, encodeFunctionData, recoverTransactionAddress, parseTransaction } from "viem";
import { config, type Address } from "./config.js";
import { PERMIT2, UNIVERSAL_ROUTER } from "./swap.js";
import type { Step } from "./intents.js";

/// The only contracts a prepared transaction may target. An intent can never be turned into a
/// transfer to somewhere else, and there is no tool that builds one.
///
/// The swap needs two more targets than the protocol itself, and they are added deliberately:
/// `UNIVERSAL_ROUTER` is the only contract that can execute the v4 route, and `PERMIT2` is how a
/// sell moves the token. Neither widens what an intent can do, because the calldata is re-derived
/// from the step and compared below — an agent still cannot sign anything the planner did not build,
/// and the planner fixes the pool, the recipient and the slippage floor.
export const ALLOWED_TARGETS: Address[] = [
  config.escrow,
  config.names,
  config.wif,
  UNIVERSAL_ROUTER,
  PERMIT2,
];

export function isAllowedTarget(to?: string | null): to is Address {
  if (!to) return false;
  return ALLOWED_TARGETS.some((a) => a.toLowerCase() === to.toLowerCase());
}

/// Deterministic, comparable form. Anything with a different type or value fails the compare.
export function normalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    return value.startsWith("0x") && value.length === 42 ? value.toLowerCase() : value;
  }
  if (Array.isArray(value)) return `[${value.map(normalize).join(",")}]`;
  return String(value);
}

export function sameArgs(a: readonly unknown[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => normalize(value) === b[i]);
}

/// Build one unsigned step: the exact calldata, the nonce, and enough gas to execute it.
export async function buildStep(input: {
  address: Address;
  label: string;
  to: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  nonce: bigint;
}): Promise<Step> {
  const data = encodeFunctionData({
    abi: input.abi,
    functionName: input.functionName,
    args: input.args,
  } as never) as `0x${string}`;

  let gas = 400_000n;
  let maxFeePerGas = 1_000_000_000n;
  let maxPriorityFeePerGas = 0n;
  try {
    const { client } = await import("./chain.js");
    const fees = await client.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  } catch {
    // Fall back to a sane ceiling; the chain rejects anything genuinely too low.
  }

  try {
    const { estimateGas } = await import("./chain.js");
    gas = await estimateGas({ account: input.address, to: input.to, data });
  } catch {
    // Estimation needs the sender to be able to pay. If it fails, hand back a generous
    // ceiling rather than blocking the agent — the chain will reject it if it is really wrong.
  }

  return {
    label: input.label,
    to: input.to,
    data,
    value: (input.value ?? 0n).toString(),
    nonce: input.nonce.toString(),
    gas: gas.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    fn: input.functionName,
    args: input.args.map(normalize),
  };
}

export type VerificationFailure = { index: number; reason: string };

/// The validation matrix. Everything here is checked before a single byte is broadcast.
export async function verifySignedStep(input: {
  signed: `0x${string}`;
  step: Step;
  expectedFrom: Address;
}): Promise<VerificationFailure | null> {
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(input.signed);
  } catch (error) {
    return { index: 0, reason: `not a decodable signed transaction: ${(error as Error).message}` };
  }

  if (tx.chainId !== config.chainId) {
    return { index: 0, reason: `chainId ${tx.chainId} is not ${config.chainId}` };
  }

  if (!isAllowedTarget(tx.to)) {
    return { index: 0, reason: `target ${tx.to ?? "(contract creation)"} is not a PACT contract` };
  }

  if (tx.to!.toLowerCase() !== input.step.to.toLowerCase()) {
    return { index: 0, reason: `target ${tx.to} does not match the prepared step (${input.step.to})` };
  }

  if ((tx.value ?? 0n).toString() !== input.step.value) {
    return { index: 0, reason: `value ${tx.value ?? 0n} does not match the prepared step` };
  }

  if (tx.nonce !== Number(input.step.nonce)) {
    return { index: 0, reason: `nonce ${tx.nonce} does not match the reserved nonce ${input.step.nonce}` };
  }

  if ((tx.data ?? "0x").toLowerCase() !== input.step.data.toLowerCase()) {
    return {
      index: 0,
      reason: "calldata does not match the prepared step — the signature carries a different call",
    };
  }

  let from: Address;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: input.signed } as never);
  } catch (error) {
    return { index: 0, reason: `could not recover the signer: ${(error as Error).message}` };
  }

  if (from.toLowerCase() !== input.expectedFrom.toLowerCase()) {
    return { index: 0, reason: `signed by ${from}, but this intent belongs to ${input.expectedFrom}` };
  }

  return null;
}

/// Human-readable decode of what a step will do, used to build the summary the agent sees
/// before signing. Also the thing the agent should compare against its own intent.
export function describeStep(step: Step): string {
  return `${step.fn}(${step.args.join(", ")})`;
}

export async function expectedCall(
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): Promise<{ fn: string; args: string[] }> {
  return { fn: functionName, args: args.map(normalize) };
}

export { decodeFunctionData, encodeFunctionData };
