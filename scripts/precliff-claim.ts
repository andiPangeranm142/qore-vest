/**
 * precliff-claim.ts - ONE pre-cliff claim attempt from the schedule #4
 * beneficiary (mnemonic index 2), EXPECTED TO REVERT on chain.
 *
 * The schedule (50,000 QVEST, 7-day cliff, 30-day duration, created 16 Nov
 * 2026) is still inside its cliff, so claimable() is 0 and claim() must
 * revert with "nothing claimable". That on-chain revert IS the evidence:
 * the cliff is enforced by the contract, not by the UI.
 *
 * Safety guards — the script aborts (no broadcast) unless ALL hold:
 *   - chain id is 9800 (Diana testnet),
 *   - the derived beneficiary is exactly the schedule #4 beneficiary,
 *   - the schedule exists, claimed == 0, and now < cliff end,
 *   - claimable() == 0,
 *   - the eth_call simulation reverts with "nothing claimable".
 *
 * The broadcast uses explicit gas (800,000) so the reverting transaction
 * actually lands on chain instead of failing gas estimation. After the
 * receipt, the script verifies the vesting state is unchanged (claimed
 * still 0, totalLocked unchanged, no QVEST moved, Native allowance
 * unchanged) and records everything in
 * deployments/precliff-rejection.json + a step in deployments/usage.json.
 *
 * Run ONCE, with a live EVM window for the beneficiary (see
 * scripts/precliff-setup.ts):
 *   npx tsx --env-file=.env scripts/precliff-claim.ts
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
const EXPECTED_REVERT = "nothing claimable";

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
  if (blockNow.timestamp >= cliffEnd) throw new Error("cliff has already ended — this attempt is only valid pre-cliff");
  if (claimable !== 0n) throw new Error(`claimable is ${claimable}, not 0 — refusing to broadcast a claim that could succeed`);

  // --- Simulation: eth_call must revert with "nothing claimable" ----------
  console.log(`\nSimulating claim() via eth_call (expecting revert "${EXPECTED_REVERT}")…`);
  let simError = "";
  try {
    await client.publicClient.call({
      account: beneficiary.address,
      to: contract,
      data: encodeFunctionData({ abi: qoreVestAbi, functionName: "claim", args: [beneficiaryBech32] }),
    });
    throw new Error("simulation SUCCEEDED — the claim would not revert; refusing to broadcast");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("simulation SUCCEEDED")) throw err;
    simError = err instanceof Error ? err.message : String(err);
  }
  if (!simError.toLowerCase().includes(EXPECTED_REVERT)) {
    throw new Error(`simulation reverted with an UNEXPECTED reason: ${simError.slice(0, 300)} — refusing to broadcast`);
  }
  console.log(`simulation reverted as expected ("${EXPECTED_REVERT}")`);

  // --- Broadcast (explicit gas so the reverting tx lands on chain) --------
  console.log("\nBroadcasting the pre-cliff claim (expected to revert on chain)…");
  const tx = await writeContract(beneficiaryWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [beneficiaryBech32],
    account: beneficiaryWallet.account ?? null, chain: beneficiaryWallet.chain,
    gas: 800_000n,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: tx });
  const cosmos = await cosmosHashForEvmTx(client.publicClient, tx);
  console.log(`evmTx: ${tx}`);
  console.log(`cosmosTx: ${cosmos.cosmosHash}`);
  console.log(`receipt: status=${receipt.status} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
  if (receipt.status !== "reverted") throw new Error(`expected the pre-cliff claim to revert; got status ${receipt.status}`);

  // --- After-state: nothing must have changed -----------------------------
  const schedAfter = await scheduleOf(beneficiary.address);
  const totalLockedAfter = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "totalLocked",
  })) as bigint;
  const balAfter = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "balanceOf", args: [beneficiary.address],
  })) as bigint;
  const allowAfter = await nativeAllowance(beneficiaryBech32);
  const unchanged =
    schedAfter[1] === schedBefore[1] &&
    totalLockedAfter === totalLockedBefore &&
    balAfter === balBefore &&
    allowAfter === allowBefore;
  console.log(`after: claimed=${schedAfter[1]} totalLocked=${totalLockedAfter} qvestBalance=${balAfter} nativeAllowance=${allowAfter}`);
  console.log(`state unchanged: ${unchanged}`);
  if (!unchanged) throw new Error("STATE CHANGED after the reverted claim — investigate before publishing this evidence");

  // --- Record --------------------------------------------------------------
  const record = {
    network: "qorechain-diana",
    chainId: TESTNET_CHAIN_ID,
    contract,
    action: "claim (pre-cliff rejection)",
    beneficiary: beneficiary.address,
    beneficiaryNative: beneficiaryBech32,
    schedule: {
      total: schedBefore[0].toString(),
      claimed: schedBefore[1].toString(),
      start: Number(schedBefore[2]),
      cliffSeconds: Number(schedBefore[3]),
      durationSeconds: Number(schedBefore[4]),
      cliffEndsAt: new Date(Number(cliffEnd) * 1000).toISOString(),
    },
    simulation: { reverted: true, reason: EXPECTED_REVERT },
    evmTx: tx,
    cosmosTx: cosmos.cosmosHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    receiptStatus: receipt.status,
    stateUnchanged: unchanged,
    explorerTx: `https://explore.qore.network/tx/${cosmos.cosmosHash}`,
    ranAt: new Date().toISOString(),
  };
  const recordPath = path.resolve(dir, "..", "deployments", "precliff-rejection.json");
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nRecorded in deployments/precliff-rejection.json`);

  const usagePath = path.resolve(dir, "..", "deployments", "usage.json");
  const usage = JSON.parse(fs.readFileSync(usagePath, "utf8")) as { steps: Array<Record<string, unknown>> };
  usage.steps.push({
    action: "claim (pre-cliff rejection)",
    note: "Pre-cliff claim attempt on the live 50,000 QVEST schedule: reverted on chain with 'nothing claimable' — the cliff is enforced by the contract. State unchanged; the funds stay locked.",
    beneficiary: beneficiary.address,
    status: receipt.status,
    stateUnchanged: unchanged,
    evmTx: tx,
    cosmosTx: cosmos.cosmosHash,
  });
  fs.writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`);
  console.log("Appended to deployments/usage.json (re-run gen-evidence.mjs to refresh src/evidence.ts).");
  console.log("\nPRE-CLIFF REJECTION VERIFIED: the cliff is enforced on chain; the 50,000 QVEST stays locked.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
