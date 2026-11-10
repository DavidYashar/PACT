import { keccak256, toHex } from "viem";

export type Terms = {
  title: string;
  description: string;
  criteria: string;
  proofSpec: string;
  category: string;
  /// Optional commitment to the exact deliverable digest. Included in the hash only when present,
  /// so every job posted before this existed still re-hashes to the same value.
  expectedProofHash?: `0x${string}`;
};

/// The single definition of how a job's terms become the hash stored on-chain. Used by
/// the posting page and re-run by the server so the database cannot accept text that
/// does not match the value the employer committed.
export function termsDigest(terms: Terms): `0x${string}` {
  return keccak256(
    toHex(
      JSON.stringify({
        title: terms.title,
        description: terms.description,
        criteria: terms.criteria,
        proofSpec: terms.proofSpec,
        category: terms.category,
        ...(terms.expectedProofHash ? { expectedProofHash: terms.expectedProofHash } : {}),
      }),
    ),
  );
}
