// Deploy the CrossVmCaller probe contract (needs an UNSCOPED window:
// scoped windows refuse contract creation). Writes research/caller.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvmClient, deployContract, evmAccountFromPrivateKey } from "@qorechain/evm";
import { crossVmCallerAbi, crossVmCallerBytecode } from "./CrossVmCaller.artifact.ts";

const privateKey = process.env.QORE_EVM_PRIVATE_KEY;
if (!privateKey) throw new Error("QORE_EVM_PRIVATE_KEY not set (run with --env-file=.env)");

const client = await createEvmClient({ endpoints: { evmRpc: "https://evm-testnet.qore.host" } });
const chainId = await client.getChainId();
if (chainId !== 9800) throw new Error(`Refusing: chain id ${chainId}, expected testnet 9800`);
const account = evmAccountFromPrivateKey(privateKey);
const wallet = client.getWalletClient(account);
console.log("deployer:", account.address);
const hash = await deployContract(wallet, { abi: crossVmCallerAbi, bytecode: crossVmCallerBytecode, args: [] });
console.log("deploy tx:", hash);
const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
console.log("contract:", receipt.contractAddress, "| status:", receipt.status, "| gas:", receipt.gasUsed);
const dir = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(dir, "caller.json"), JSON.stringify({ contract: receipt.contractAddress, deployTx: hash }, null, 2) + "\n");
console.log("Wrote research/caller.json");
