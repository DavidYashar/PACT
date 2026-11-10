// Regenerate mcp/src/abi.ts from the compiled contracts. The ABI is a snapshot of a moving
// contract; hand-editing it means the server silently calls functions that no longer exist.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "contracts", "out");
const pick = (name) => JSON.parse(readFileSync(join(out, name), "utf8")).abi;
const escrow = pick("PactEscrow.sol/PactEscrow.json");
const names = pick("PactNames.sol/PactNames.json");
const wif = pick("MockWIF.sol/MockWIF.json");

const header = "// generated from contracts/out - do not hand-edit; run node scripts/gen-abi.mjs\n\n";
writeFileSync(
  join(here, "..", "src", "abi.ts"),
  header +
    `export const escrowAbi = ${JSON.stringify(escrow)} as const;\n\n` +
    `export const namesAbi = ${JSON.stringify(names)} as const;\n\n` +
    `export const wifAbi = ${JSON.stringify(wif)} as const;\n`,
);

const has = (list, name) => list.some((entry) => entry.type === "function" && entry.name === name);
console.log("escrow functions:", escrow.filter((e) => e.type === "function").length);
console.log("autoReleaseDelay present:", has(escrow, "autoReleaseDelay"));
console.log("AUTO_RELEASE_DELAY removed:", !has(escrow, "AUTO_RELEASE_DELAY"));
console.log("escrow errors:", escrow.filter((e) => e.type === "error").length);
