// Derive the deployer EVM private key from ../deployer.json (OUTSIDE the repo)
// and write .env (mode 600). NEVER prints the mnemonic or the private key —
// only whether the derived addresses match deployer.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { mnemonicToAccount } from "viem/accounts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const deployer = JSON.parse(fs.readFileSync(path.resolve(dir, "..", "..", "deployer.json"), "utf8"));
if (!deployer.mnemonic || !deployer.evm || !deployer.cosmos) {
  throw new Error("deployer.json must have {mnemonic, evm, cosmos}");
}
const acc = await deriveUnifiedAccount(deployer.mnemonic, 0);
const evmMatch = acc.evm.toLowerCase() === deployer.evm.toLowerCase();
const cosmosMatch = acc.cosmos === deployer.cosmos;
console.log("SDK derived EVM matches deployer.json:", evmMatch);
console.log("SDK derived Cosmos matches deployer.json:", cosmosMatch);
if (!evmMatch || !cosmosMatch) throw new Error("Derived addresses do not match deployer.json — aborting");

const viemAcc = mnemonicToAccount(deployer.mnemonic, { accountIndex: 0 });
const viemMatch = viemAcc.address.toLowerCase() === deployer.evm.toLowerCase();
console.log("viem derived EVM matches deployer.json:", viemMatch);
if (!viemMatch) throw new Error("viem derivation mismatch — aborting");

// The SDK account carries the 0x-prefixed secp256k1 private key as a string.
const pk = acc.privateKey;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("Could not obtain the EVM private key from the SDK account");

const env = [
  "# QoreVest deployer (qorechain-diana testnet). NEVER COMMIT THIS FILE.",
  "QORE_EVM_RPC_URL=https://evm-testnet.qore.host",
  `QORE_EVM_PRIVATE_KEY=${pk}`,
  `QORE_MNEMONIC=${deployer.mnemonic}`,
  "QORE_NETWORK=testnet",
  "QORE_WINDOW_BLOCKS=1200",
  "QORE_WINDOW_TXS=10",
  "",
].join("\n");
const envPath = path.resolve(dir, "..", ".env");
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log("Wrote .env (mode 600). Addresses verified; no secrets printed.");
