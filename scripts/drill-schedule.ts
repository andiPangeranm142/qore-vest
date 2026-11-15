/**
 * drill-schedule.ts - create a vesting schedule for the Q-Day Drill
 * beneficiary account on the Diana testnet.
 *
 * The drill beneficiary (a fresh sacrificial account, see
 * ../drill-wallet.json) gets a 10,000 QVEST schedule with no cliff and a
 * 7-day duration, starting now. On drill day (18 Nov 2026) the beneficiary
 * claims the vested portion via scripts/drill-claim.ts, proving the
 * project still works while the schedule bounds what the leaked ECDSA key
 * alone can take.
 *
 * The beneficiary address is read from ../drill-wallet.json (single source
 * of truth) — never hardcode it here.
 *
 * Needs a live EVM window for the owner (deployer): run
 * `npm run window open` first (repo .env).
 *
 * Run: npx tsx --env-file=.env scripts/drill-schedule.ts
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
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

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const deployment = JSON.parse(
    fs.readFileSync(path.resolve(dir, "..", "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;
  const drillWallet = JSON.parse(
    fs.readFileSync(path.resolve(dir, "..", "..", "drill-wallet.json"), "utf8"),
  ) as { evmAddress: Address; cosmosAddress: string };
  const beneficiary = drillWallet.evmAddress;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`wrong chain id ${chainId}`);
  const owner = evmAccountFromPrivateKey(privateKey);
  const ownerWallet = client.getWalletClient(owner);

  const totalLockedBefore = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  console.log(`contract: ${contract}`);
  console.log(`owner: ${owner.address}`);
  console.log(`beneficiary (drill): ${beneficiary} (${drillWallet.cosmosAddress})`);
  console.log(`totalLocked before: ${totalLockedBefore.toString()} base units`);

  const amount = 10_000n * 10n ** 6n;
  const now = Math.floor(Date.now() / 1000);
  const cliff = 0;
  const duration = 7 * 24 * 3600; // 7 days
  console.log(`\nCreating drill schedule: 10,000 QVEST, cliff 0, duration 7d…`);
  const tx = await writeContract(ownerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "createVesting",
    args: [beneficiary, amount, BigInt(now), BigInt(cliff), BigInt(duration)],
    account: ownerWallet.account ?? null, chain: ownerWallet.chain,
  });
  await client.publicClient.waitForTransactionReceipt({ hash: tx });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, tx);
  console.log(`evmTx: ${tx}`);
  console.log(`cosmosTx: ${cosmos.cosmosHash}`);

  const totalLockedAfter = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  const sched = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "schedules", args: [beneficiary],
  })) as [bigint, bigint, bigint, bigint, bigint, boolean];
  console.log(`totalLocked after: ${totalLockedAfter.toString()} base units`);
  console.log(`schedule: total=${sched[0]} claimed=${sched[1]} start=${sched[2]} cliff=${sched[3]} duration=${sched[4]} exists=${sched[5]}`);
  if (totalLockedAfter !== totalLockedBefore + amount) throw new Error("totalLocked mismatch");
  if (!sched[5] || sched[0] !== amount) throw new Error("schedule verification failed");
  console.log("\nVERIFIED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
