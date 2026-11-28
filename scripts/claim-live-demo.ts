/**
 * claim-live-demo.ts - claim the vested amount of schedule #3 ("live-demo",
 * the 50,000 QVEST schedule, mnemonic index 2) AFTER its cliff ended.
 *
 * The cliff ended 2026-11-22T21:31:58Z (23 Nov 2026 04:31 WIB); the
 * schedule vests linearly over its 30-day duration, so claimable() grows
 * with time (~19,290 base units per second). This script claims whatever
 * has vested so far (~9,746 QVEST at run time) and proves the post-cliff
 * claim path works end to end: the contract releases QVEST to the
 * beneficiary AND atomically raises the beneficiary's allowance on the
 * Native WDT contract via the cross-VM precompile (0x...0901).
 *
 * This is the post-cliff twin of scripts/precliff-claim.ts (same
 * beneficiary, same claim() call, same verification pattern) — the
 * pre-cliff attempt reverted with "nothing claimable", proving the cliff
 * is enforced; this one must SUCCEED, proving the cliff releases.
 *
 * Safety guards — the script aborts (no broadcast) unless ALL hold:
 *   - chain id is 9800 (Diana testnet),
 *   - the derived beneficiary is exactly the schedule #3 beneficiary,
 *   - the schedule exists and claimed == 0 (first claim of this schedule),
 *   - now >= cliff end (the cliff has passed),
 *   - claimable() > 0,
 *   - the eth_call simulation SUCCEEDS and returns an amount >= claimable.
 *
 * The broadcast uses explicit gas (2,000,000). The 800,000 that
 * precliff-claim.ts used was never tested for a full claim — the pre-cliff
 * attempt reverted early ("nothing claimable") — and the full cross-VM
 * claim path needs ~1,436,974 gas (measured 29 Nov 2026; a first attempt
 * at 800,000 reverted out of gas). 2,000,000 clears the estimate with
 * headroom while staying under the 3,000,000 per-tx window sizing.
 * The simulation below uses the SAME gas limit as the broadcast, so a
 * simulation pass actually proves the broadcast will fit.
 *
 * Verification after the receipt (claimable grows ~19,290 base units per
 * second, so the claimed delta may exceed the pre-read claimable by the
 * few seconds between the read and execution — a drift under 1 QVEST is
 * accepted and reported):
 *   - claimedAfter == claimedBefore + claimedDelta, claimedDelta >= claimable,
 *   - totalLocked decreased by exactly the claimed delta,
 *   - the beneficiary's QVEST balance increased by exactly the claimed delta,
 *   - the Native allowance equals claimedAfter (allowance == claimed invariant).
 *
 * Records everything in deployments/claim-schedule3.json + a step in
 * deployments/usage.json.
 *
 * Run ONCE, with a live EVM window for the beneficiary (see
 * scripts/precliff-setup.ts — it is idempotent, re-run it to refresh the
 * window):
 *   npx tsx --env-file=.env scripts/precliff-setup.ts
 *   npx tsx --env-file=.env scripts/claim-live-demo.ts
 *
 * Nothing in this script prints the mnemonic or any private key — only
 * addresses, state, and transaction hashes.
 */
import {
  createEvmClient,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { addressesFrom20, deriveUnifiedAccount } from "@qorechain/sdk";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { mnemonicToAccount } from "viem/accounts";
import { encodeFunctionData, type Address } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

const TESTNET_CHAIN_ID = 9800;
const RPC = "https://rpc-testnet.qore.host";
const BENEFICIARY = "0x0a9f2f8fac9e286d140f9c115d8c4dd28904507b";
/** Vesting drift accepted between the claimable read and execution (1 QVEST). */
const DRIFT_TOLERANCE = 1_000_000n;

type Schedule = [bigint, bigint, bigint, bigint, bigint, boolean];

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("QORE_MNEMONIC missing in .env");

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const deployment = JSON.parse(
    fs.readFileSync(path.resolve(dir, "..", "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address; nativeTarget: string };
  const contract = deployment.contract;
  const wdt = deployment.nativeTarget;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`wrong chain id ${chainId}`);

  const beneficiary = mnemonicToAccount(mnemonic, { addressIndex: 2 });
  const unified = await deriveUnifiedAccount(mnemonic, 2);
  if (beneficiary.address.toLowerCase() !== BENEFICIARY) {
    throw new Error(`index-2 derivation mismatch: ${beneficiary.address} — refusing to continue`);
  }
  const beneficiaryBech32 = unified.cosmos;
  const contractNative = addressesFrom20(Buffer.from(contract.slice(2), "hex")).cosmos;
  const beneficiaryWallet = client.getWalletClient(beneficiary);

  const cw = await CosmWasmClient.connect(RPC);
  async function nativeAllowance(spender: string): Promise<bigint> {
    const res = (await cw.queryContractSmart(wdt, {
      allowance: { owner: contractNative, spender },
    })) as { allowance: string };
    return BigInt(res.allowance);
  }
  async function scheduleOf(addr: Address): Promise<Schedule> {
    return (await readContract(client.publicClient, {
      address: contract, abi: qoreVestAbi, functionName: "schedules", args: [addr],
    })) as Schedule;
  }

  // --- Before-state -------------------------------------------------------
  const schedBefore = await scheduleOf(beneficiary.address);
  const claimable = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "claimable", args: [beneficiary.address],
  })) as bigint;
  const totalLockedBefore = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  const balBefore = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "balanceOf", args: [beneficiary.address],
  })) as bigint;
  const allowBefore = await nativeAllowance(beneficiaryBech32);
  const blockNow = await client.publicClient.getBlock();
  const cliffEnd = schedBefore[2] + schedBefore[3];

  console.log(`contract: ${contract}`);
  console.log(`beneficiary: ${beneficiary.address} (${beneficiaryBech32})`);
  console.log(`schedule: total=${schedBefore[0]} claimed=${schedBefore[1]} start=${schedBefore[2]} cliff=${schedBefore[3]} duration=${schedBefore[4]} exists=${schedBefore[5]}`);
  console.log(`cliff ends: ${cliffEnd} (${new Date(Number(cliffEnd) * 1000).toISOString()}); now: ${blockNow.timestamp} (${new Date(Number(blockNow.timestamp) * 1000).toISOString()})`);
  console.log(`claimable=${claimable} totalLocked=${totalLockedBefore} qvestBalance=${balBefore} nativeAllowance=${allowBefore}`);

  if (!schedBefore[5]) throw new Error("no schedule for the beneficiary — refusing to continue");
  if (schedBefore[1] !== 0n) throw new Error(`schedule already claimed (${schedBefore[1]}) — refusing to continue`);
  if (blockNow.timestamp < cliffEnd) throw new Error("cliff has NOT ended yet — this claim is only valid post-cliff");
  if (claimable === 0n) throw new Error("claimable is 0 — nothing to claim; refusing to broadcast");

  // --- Simulation: eth_call must SUCCEED ----------------------------------
  console.log("\nSimulating claim() via eth_call (expecting success)…");
  const sim = (await client.publicClient.call({
    account: beneficiary.address,
    to: contract,
    gas: 2_000_000n,
    data: encodeFunctionData({ abi: qoreVestAbi, functionName: "claim", args: [beneficiaryBech32] }),
  })) as { data?: string };
  // The call returns the claimed amount (uint256, 32-byte big-endian).
  const simAmount = sim.data ? BigInt(sim.data) : 0n;
  console.log(`simulation returned amount=${simAmount}`);
  if (simAmount < claimable) {
    throw new Error(`simulation amount ${simAmount} is below claimable ${claimable} — refusing to broadcast`);
  }
  if (simAmount - claimable > DRIFT_TOLERANCE) {
    throw new Error(`simulation amount ${simAmount} exceeds claimable ${claimable} by more than the drift tolerance — refusing to broadcast`);
  }

  // --- Broadcast (explicit gas, same as the pre-cliff attempt) ------------
  console.log("\nBroadcasting the post-cliff claim…");
  const tx = await writeContract(beneficiaryWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [beneficiaryBech32],
    account: beneficiaryWallet.account ?? null, chain: beneficiaryWallet.chain,
    gas: 2_000_000n,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: tx });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, tx);
  console.log(`evmTx: ${tx}`);
  console.log(`cosmosTx: ${cosmos.cosmosHash}`);
  console.log(`receipt: status=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`claim reverted: ${tx}`);

  // --- After-state: verify the invariants ---------------------------------
  const schedAfter = await scheduleOf(beneficiary.address);
  const totalLockedAfter = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  const balAfter = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "balanceOf", args: [beneficiary.address],
  })) as bigint;
  const allowAfter = await nativeAllowance(beneficiaryBech32);
  const claimedDelta = schedAfter[1] - schedBefore[1];
  const drift = claimedDelta - claimable;
  const checks = {
    claimedDeltaAtLeastClaimable: claimedDelta >= claimable,
    driftWithinTolerance: drift >= 0n && drift <= DRIFT_TOLERANCE,
    totalLockedDecreasedByDelta: totalLockedAfter === totalLockedBefore - claimedDelta,
    balanceIncreasedByDelta: balAfter === balBefore + claimedDelta,
    allowanceEqualsClaimed: allowAfter === schedAfter[1],
  };
  console.log(`after: claimed=${schedAfter[1]} (delta=${claimedDelta}, drift vs pre-read claimable=${drift}) totalLocked=${totalLockedAfter} qvestBalance=${balAfter} nativeAllowance=${allowAfter}`);
  console.log(`checks: ${JSON.stringify(Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v])))}`);
  const allOk = Object.values(checks).every(Boolean);
  if (!allOk) throw new Error("POST-CLAIM INVARIANT CHECK FAILED — investigate before publishing this evidence");

  // --- Record --------------------------------------------------------------
  const amountQvest = (Number(claimedDelta) / 1e6).toFixed(6);
  const record = {
    project: "qore-vest",
    action: "claim (live-demo schedule #3, post-cliff)",
    network: "qorechain-diana",
    chainId: TESTNET_CHAIN_ID,
    contract,
    beneficiary: beneficiary.address,
    beneficiaryNative: beneficiaryBech32,
    schedule: {
      index: 3,
      label: "live-demo",
      total: schedBefore[0].toString(),
      claimedBefore: schedBefore[1].toString(),
      claimedAfter: schedAfter[1].toString(),
      start: Number(schedBefore[2]),
      cliffSeconds: Number(schedBefore[3]),
      durationSeconds: Number(schedBefore[4]),
      cliffEndsAt: new Date(Number(cliffEnd) * 1000).toISOString(),
    },
    claimableBefore: claimable.toString(),
    simulatedAmount: simAmount.toString(),
    amountBaseUnits: claimedDelta.toString(),
    amountQvest,
    driftBaseUnits: drift.toString(),
    totalLockedBefore: totalLockedBefore.toString(),
    totalLockedAfter: totalLockedAfter.toString(),
    qvestBalanceBefore: balBefore.toString(),
    qvestBalanceAfter: balAfter.toString(),
    nativeAllowanceBefore: allowBefore.toString(),
    nativeAllowanceAfter: allowAfter.toString(),
    evmTx: tx,
    cosmosTx: cosmos.cosmosHash,
    block: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    receiptStatus: receipt.status,
    invariantsVerified: checks,
    explorerTx: `https://explore.qore.network/tx/${cosmos.cosmosHash}`,
    note: "Post-cliff claim of the vested amount: the contract released QVEST to the beneficiary and atomically raised the beneficiary's allowance on the Native WDT contract via the cross-VM precompile (allowance == claimed). Twin of the pre-cliff rejection (deployments/precliff-rejection.json), which proved the cliff is enforced; this proves the cliff releases.",
    ranAt: new Date().toISOString(),
  };
  const recordPath = path.resolve(dir, "..", "deployments", "claim-schedule3.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nRecorded in deployments/claim-schedule3.json`);

  const usagePath = path.resolve(dir, "..", "deployments", "usage.json");
  const usage = JSON.parse(fs.readFileSync(usagePath, "utf8")) as { steps: Array<Record<string, unknown>> };
  usage.steps.push({
    action: "claim (live-demo schedule #3, post-cliff)",
    note: `Post-cliff claim of the vested ${amountQvest} QVEST from the 50,000 QVEST live-demo schedule: released on chain and the Native allowance rose to match the claimed total (allowance == claimed). The cliff that rejected the pre-cliff attempt now releases.`,
    beneficiary: beneficiary.address,
    amountQvest,
    amountBaseUnits: claimedDelta.toString(),
    status: receipt.status,
    evmTx: tx,
    cosmosTx: cosmos.cosmosHash,
  });
  fs.writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`);
  console.log("Appended to deployments/usage.json (re-run gen-evidence.mjs to refresh src/evidence.ts).");
  console.log(`\nLIVE-DEMO CLAIM VERIFIED: ${amountQvest} QVEST claimed; totalLocked now ${totalLockedAfter}; Native allowance ${allowAfter}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
