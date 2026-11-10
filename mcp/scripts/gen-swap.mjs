// Generates `web/lib/swap.ts` from `mcp/src/swap.ts`.
//
// The swap route has to be byte-identical in the browser and in the MCP server — a different action
// byte on either side is a lost transaction — so it is written once and copied, exactly like the
// escrow ABI. Run this whenever `src/swap.ts` changes; `npm run abi` does it automatically.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "src", "swap.ts");
const target = join(here, "..", "..", "web", "lib", "swap.ts");

const body = readFileSync(source, "utf8");
const header = [
  "// GENERATED FILE — do not edit.",
  "// Source: mcp/src/swap.ts, copied by mcp/scripts/gen-swap.mjs so the browser and the MCP server",
  "// encode the same route. Both call the Uniswap v4 Universal Router with the same action bytes;",
  "// a divergence between them would be a transaction that reverts on one side only.",
  "",
].join("\n");

writeFileSync(target, header + body, "utf8");
console.log(`swap module copied to ${target} (${body.split("\n").length} lines)`);
