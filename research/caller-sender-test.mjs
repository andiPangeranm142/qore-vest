// Sender test: call grantAllowance THROUGH the deployed CrossVmCaller
// contract, then read the allowance back under BOTH candidate owners
// (the contract's mapped address and the deployer EOA) to learn who the
// Native contract saw as the sender for a contract-mediated call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { createEvmClient, evmAccountFromPrivateKey, writeContract } from "@qorechain/evm";
import { addressesFrom20 } from "@qorechain/sdk";
import { crossVmCallerAbi } from "./CrossVmCaller.artifact.ts";

const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const DEPLOYER_COSMOS = "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny";
const SPENDER = addressesFrom20(new Uint8Array([...Array(19).fill(0), 1])).cosmos; // qor1qqqq...p67rf0d
const AMOUNT = "2000"; // distinct from the earlier EOA test (1000)

const privateKey = process.env.QORE_EVM_PRIVATE_KEY;
if (!privateKey) throw new Error("QORE_EVM_PRIVATE_KEY not set (run with --env-file=.env)");
const dir = path.dirname(fileURLToPath(import.meta.url));
const { contract } = JSON.parse(fs.readFileSync(path.join(dir, "caller.json"), "utf8"));
const contractCosmos = addressesFrom20(Buffer.from(contract.slice(2), "hex")).cosmos;
console.log("contract EVM:", contract);
console.log("contract mapped Native address:", contractCosmos);
console.log("spender:", SPENDER);

const client = await createEvmClient({ endpoints: { evmRpc: "https://evm-testnet.qore.host" } });
const account = evmAccountFromPrivateKey(privateKey);
const wallet = client.getWalletClient(account);
const cw = await CosmWasmClient.connect("https://rpc-testnet.qore.host");

async function allowance(owner) {
  return cw.queryContractSmart(WDT, { allowance: { owner, spender: SPENDER } });
}
console.log("allowance BEFORE (owner=contract):", JSON.stringify(await allowance(contractCosmos)));
console.log("allowance BEFORE (owner=deployer):", JSON.stringify(await allowance(DEPLOYER_COSMOS)));

console.log("calling grantAllowance through the contract…");
const hash = await writeContract(wallet, {
  address: contract,
  abi: crossVmCallerAbi,
  functionName: "grantAllowance",
  args: [SPENDER, AMOUNT],
  account: wallet.account ?? null,
  chain: wallet.chain,
});
console.log("tx hash:", hash);
const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
console.log("receipt status:", receipt.status, "| gas used:", receipt.gasUsed);
await new Promise((r) => setTimeout(r, 5000));
const afterContract = await allowance(contractCosmos);
const afterDeployer = await allowance(DEPLOYER_COSMOS);
console.log("allowance AFTER (owner=contract):", JSON.stringify(afterContract));
console.log("allowance AFTER (owner=deployer):", JSON.stringify(afterDeployer));
cw.disconnect();
if (afterContract.allowance === AMOUNT) console.log("CONCLUSION: sender = THE CONTRACT (immediate caller).");
else if (afterDeployer.allowance === "3000") console.log("CONCLUSION: sender = THE TX ORIGIN (deployer EOA).");
else console.log("CONCLUSION: unclear — inspect the allowances above.");
