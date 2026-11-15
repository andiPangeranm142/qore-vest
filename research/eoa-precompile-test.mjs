// DECISIVE TEST: a real EVM tx from the deployer EOA to the cross-VM
// precompile (0x0901), calling cw20 `increase_allowance` on the WDT contract.
// Then read the allowance back on the Native side to learn who the
// CosmWasm contract saw as the sender (the EOA's mapped address?).
// Harmless: the sender holds 0 WDT, so the allowance can never be spent.
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { createEvmClient, evmAccountFromPrivateKey } from "@qorechain/evm";
import { addressesFrom20 } from "@qorechain/sdk";
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";

const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const DEPLOYER_COSMOS = "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny";
// Spender must differ from the sender (cw20 refuses self-allowance).
// Use the mapped address of 0x0000...0001 as a fixed, harmless test spender.
const SPENDER = addressesFrom20(new Uint8Array([...Array(19).fill(0), 1])).cosmos;

const privateKey = process.env.QORE_EVM_PRIVATE_KEY;
if (!privateKey) throw new Error("QORE_EVM_PRIVATE_KEY not set (run with --env-file=.env)");

const client = await createEvmClient({ endpoints: { evmRpc: "https://evm-testnet.qore.host" } });
const account = evmAccountFromPrivateKey(privateKey);
console.log("sender:", account.address);
const wallet = client.getWalletClient(account);

// Allowance BEFORE.
const cw = await CosmWasmClient.connect("https://rpc-testnet.qore.host");
console.log("test spender:", SPENDER);
const before = await cw.queryContractSmart(WDT, { allowance: { owner: DEPLOYER_COSMOS, spender: SPENDER } });
console.log("allowance BEFORE:", JSON.stringify(before));

// Send the cross-VM call as a real EVM tx.
const msg = JSON.stringify({ increase_allowance: { spender: SPENDER, amount: "1000" } });
const data = encodeCrossVmCalldata({ contract: WDT, msg });
console.log("sending EVM tx to precompile", CROSS_VM_PRECOMPILE, "…");
const hash = await wallet.sendTransaction({ to: CROSS_VM_PRECOMPILE, data });
console.log("EVM tx hash:", hash);
const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
console.log("receipt status:", receipt.status, "| block:", receipt.blockNumber, "| gas used:", receipt.gasUsed);

// Allowance AFTER.
await new Promise((r) => setTimeout(r, 5000));
const after = await cw.queryContractSmart(WDT, { allowance: { owner: DEPLOYER_COSMOS, spender: SPENDER } });
console.log("allowance AFTER:", JSON.stringify(after));
cw.disconnect();

if (after.allowance === "1000") {
  console.log("CONCLUSION: state-changing cross-VM call WORKED; sender seen by cw20 = the EOA deployer (mapped address).");
} else {
  console.log("CONCLUSION: allowance did not change as expected — sender mapping unclear, investigate.");
}
