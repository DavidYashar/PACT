// Regenerate the web's copy of the ABIs from the compiled contracts. The web had its own
// snapshot, which drifted from the escrow exactly once before (a missing constructor argument).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "contracts", "out");
const pick = (name) => JSON.parse(readFileSync(join(out, name), "utf8")).abi;

const escrow = pick("PactEscrow.sol/PactEscrow.json");
const names = pick("PactNames.sol/PactNames.json");

const body = `// generated from contracts/out by mcp/scripts/gen-web-abi.mjs - do not hand-edit
//
// The web app shares the escrow ABI with the MCP server's generator so the two cannot disagree
// about a signature. A stale copy here once built calldata with a missing constructor argument.

export const pactAbi = ${JSON.stringify(escrow)} as const;

export const namesAbi = ${JSON.stringify(names)} as const;
`;

writeFileSync(join(here, "..", "..", "web", "lib", "abi.ts"), body);
console.log("escrow functions:", escrow.filter((e) => e.type === "function").length);
console.log("names functions :", names.filter((e) => e.type === "function").length);
console.log("postJob args    :", JSON.stringify(escrow.find((e) => e.name === "postJob").inputs.map((i) => i.name)));
