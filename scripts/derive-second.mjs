/** Derive the index-1 account from the deployer mnemonic (addresses only). */
import { deriveUnifiedAccount } from "@qorechain/sdk";
import * as sdk from "@qorechain/sdk";

console.log("SDK exports (msg/bank/send):", Object.keys(sdk).filter((k) => /Send|Bank|Msg/i.test(k)).join(", "));
const mnemonic = process.env.QORE_MNEMONIC?.trim();
if (!mnemonic) throw new Error("QORE_MNEMONIC missing");
for (const i of [0, 1]) {
  const a = await deriveUnifiedAccount(mnemonic, i);
  console.log(`index ${i}: evm ${a.evm} cosmos ${a.cosmos}`);
}
