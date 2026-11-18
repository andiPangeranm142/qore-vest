// Read-only on-chain state check for the schedule #4 beneficiary (index 2).
// Prints addresses, balances, schedule, PQC + window status. No keys printed.
import { createEvmClient, readContract, evmWindowStatus } from "@qorechain/evm";
import { deriveUnifiedAccount, fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";

const REST = "https://api-testnet.qore.host";
const RPC_URL = "https://evm-testnet.qore.host";
const CONTRACT = "0x67e4862c388a5ead666f5ac340fe9ef2fc1f8f68" as const;

const m = process.env.QORE_MNEMONIC?.trim();
if (!m) throw new Error("QORE_MNEMONIC missing");
const ben = await deriveUnifiedAccount(m, 2);
console.log(`beneficiary: ${ben.evm} (${ben.cosmos})`);

const client = await createEvmClient({ endpoints: { evmRpc: RPC_URL } });
const sched = (await readContract(client.publicClient, {
  address: CONTRACT, abi: qoreVestAbi, functionName: "schedules", args: [ben.evm],
})) as [bigint, bigint, bigint, bigint, bigint, boolean];
const claimable = (await readContract(client.publicClient, {
  address: CONTRACT, abi: qoreVestAbi, functionName: "claimable", args: [ben.evm],
})) as bigint;
const vested = (await readContract(client.publicClient, {
  address: CONTRACT, abi: qoreVestAbi, functionName: "vested", args: [ben.evm],
})) as bigint;
const totalLocked = (await readContract(client.publicClient, {
  address: CONTRACT, abi: qoreVestAbi, functionName: "totalLocked",
})) as bigint;
const contractBal = (await readContract(client.publicClient, {
  address: CONTRACT, abi: qoreVestAbi, functionName: "balanceOf", args: [CONTRACT],
})) as bigint;
const block = await client.publicClient.getBlock();
console.log(`chain block: ${block.number}, timestamp: ${block.timestamp} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);
console.log(`schedule: total=${sched[0]} claimed=${sched[1]} start=${sched[2]} cliff=${sched[3]} duration=${sched[4]} exists=${sched[5]}`);
console.log(`cliff ends: ${Number(sched[2]) + Number(sched[3])} (${new Date((Number(sched[2]) + Number(sched[3])) * 1000).toISOString()})`);
console.log(`vested=${vested} claimable=${claimable} (base units, 6 decimals)`);
console.log(`totalLocked=${totalLocked} contractBalance=${contractBal}`);

const accRes = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${ben.cosmos}`);
console.log(`cosmos account: HTTP ${accRes.status}${accRes.status === 404 ? " (does not exist yet)" : ""}`);
const balRes = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${ben.cosmos}`);
const bal = (await balRes.json()) as { balances: Array<{ denom: string; amount: string }> };
console.log(`QOR balances: ${JSON.stringify(bal.balances)}`);
const pqc = await fetchPqcStatus({ rest: REST, address: ben.cosmos });
console.log(`PQC registered: ${pqc.registered}${pqc.registered ? ` (is this key: ${isRegisteredPqcKey(pqc, ben.pqc.publicKey)})` : ""}`);
const w = await evmWindowStatus({ rest: REST, address: ben.cosmos });
console.log(`window: found=${w.found} live=${w.live} remainingBlocks=${w.remainingBlocks} remainingTxs=${w.remainingTxs} remainingValue=${w.remainingValue}`);
