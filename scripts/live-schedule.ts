/**
 * live-schedule.ts - create ONE additional vesting schedule on the Diana
 * testnet so the demo keeps showing live locked funds through judging.
 *
 * The original three schedules are all fully claimed (totalLocked = 0), so a
 * judge opening the demo would see an empty vesting state. This schedule
 * (50,000 QVEST, 7-day cliff, 30-day duration) stays locked and unclaimed;
 * it is a real on-chain schedule created with the same tested createVesting
 * path, and it is recorded in deployments/usage.json + the README.
 *
 * The beneficiary is a fresh address (mnemonic address index 2): the
 * contract allows one schedule per beneficiary and both earlier
 * beneficiaries already have (completed) schedules, so a new beneficiary
 * is required. It never transacts; the schedule simply stays locked.
 *
 * Needs a live EVM window for the deployer: run `npm run window open` first.
 *
 * Run: npx tsx --env-file=.env scripts/live-schedule.ts
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { mnemonicToAccount } from "viem/accounts";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

const TESTNET_CHAIN_ID = 9800;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing env ${name}`);
  return value;
}

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const mnemonic = requireEnv("QORE_MNEMONIC");

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const deployment = JSON.parse(
    fs.readFileSync(path.resolve(dir, "..", "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`wrong chain id ${chainId}`);
  const deployer = evmAccountFromPrivateKey(privateKey);
  const beneficiary = mnemonicToAccount(mnemonic, { addressIndex: 2 });
  const deployerWallet = client.getWalletClient(deployer);

  const totalLockedBefore = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  console.log(`contract: ${contract}`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`beneficiary (fresh, index 2): ${beneficiary.address}`);
  console.log(`totalLocked before: ${totalLockedBefore.toString()} base units`);

  const amount = 50_000n * 10n ** 6n;
  const now = Math.floor(Date.now() / 1000);
  const cliff = 7 * 24 * 3600; // 7 days
  const duration = 30 * 24 * 3600; // 30 days
  console.log(`\nCreating schedule: 50,000 QVEST, cliff 7d, duration 30d…`);
  const tx = await writeContract(deployerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "createVesting",
    args: [beneficiary.address, amount, BigInt(now), BigInt(cliff), BigInt(duration)],
    account: deployerWallet.account ?? null, chain: deployerWallet.chain,
  });
  await client.publicClient.waitForTransactionReceipt({ hash: tx });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, tx);
  console.log(`evmTx: ${tx}`);
  console.log(`cosmosTx: ${cosmos.cosmosHash}`);

  const totalLockedAfter = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  const sched = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "schedules", args: [beneficiary.address],
  })) as [bigint, bigint, bigint, bigint, bigint, boolean];
  console.log(`totalLocked after: ${totalLockedAfter.toString()} base units`);
  console.log(`schedule: total=${sched[0]} claimed=${sched[1]} start=${sched[2]} cliff=${sched[3]} duration=${sched[4]} exists=${sched[5]}`);
  if (totalLockedAfter !== totalLockedBefore + amount) throw new Error("totalLocked mismatch");
  if (!sched[5] || sched[0] !== amount) throw new Error("schedule verification failed");

  const usagePath = path.resolve(dir, "..", "deployments", "usage.json");
  const usage = JSON.parse(fs.readFileSync(usagePath, "utf8")) as {
    steps: Array<Record<string, unknown>>;
  };
  usage.steps.push({
    action: "createVesting",
    note: "Live demo state: keeps the demo showing locked funds through judging. Stays locked and unclaimed.",
    beneficiary: beneficiary.address,
    amount: amount.toString(),
    start: now,
    cliff,
    duration,
    evmTx: tx,
    cosmosTx: cosmos.cosmosHash,
  });
  fs.writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`);
  console.log("\nRecorded in deployments/usage.json. VERIFIED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
