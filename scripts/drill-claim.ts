/**
 * drill-claim.ts - Q-Day Drill day claim for the QoreVest drill beneficiary.
 *
 * DO NOT RUN BEFORE 18 NOV 2026. This script is executed once by the
 * drill-day cron, inside the drill window (18 Nov 00:00-23:59 UTC).
 *
 * The drill beneficiary (a fresh sacrificial account, see
 * ../drill-wallet.json) holds a 10,000 QVEST schedule (no cliff, 7-day
 * duration, created 16 Nov 2026 by scripts/drill-schedule.ts). This script
 * claims whatever has vested by drill day (~3,000 QVEST at 08:00 WIB),
 * proving the project still works. The claim is schedule-bounded: even
 * with the leaked ECDSA key, the attacker bot can take at most the vested
 * amount — never the unvested remainder, never another beneficiary's
 * schedule, and never the owner-only functions.
 *
 * Preconditions (done by the cron, in order):
 *   1. Top up the drill account from the deployer if its QOR balance is
 *      too low for gas (the attacker bot may have drained it).
 *   2. Open a live EVM window for the beneficiary:
 *        npx tsx --env-file=../.env.drill scripts/window.ts open
 *   3. Run this script:
 *        npx tsx --env-file=../.env.drill scripts/drill-claim.ts
 *   4. Submit the printed cosmosTx hash on the QoreVest project page.
 *
 * If claimable is 0 (e.g. the attacker bot claimed seconds earlier),
 * this script exits non-zero with a clear message — the cron should then
 * fall back to a plain self-transfer from the drill account as the drill
 * proof transaction instead.
 *
 * Run: npx tsx --env-file=../.env.drill scripts/drill-claim.ts
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { addressesFrom20 } from "@qorechain/sdk";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

const TESTNET_CHAIN_ID = 9800;
const RPC = "https://rpc-testnet.qore.host";

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
  ) as { contract: Address; nativeTarget: string };
  const contract = deployment.contract;
  const wdt = deployment.nativeTarget;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`wrong chain id ${chainId}`);
  const beneficiary = evmAccountFromPrivateKey(privateKey);
  const beneficiaryWallet = client.getWalletClient(beneficiary);
  const beneficiaryBech32 = addressesFrom20(Buffer.from(beneficiary.address.slice(2), "hex")).cosmos;
  const contractNative = addressesFrom20(Buffer.from(contract.slice(2), "hex")).cosmos;

  const cw = await CosmWasmClient.connect(RPC);
  async function nativeAllowance(spender: string): Promise<bigint> {
    const res = (await cw.queryContractSmart(wdt, {
      allowance: { owner: contractNative, spender },
    })) as { allowance: string };
    return BigInt(res.allowance);
  }

  const claimable = (await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "claimable", args: [beneficiary.address],
  })) as bigint;
  console.log(`contract: ${contract}`);
  console.log(`beneficiary (drill): ${beneficiary.address} (${beneficiaryBech32})`);
  console.log(`claimable now: ${claimable.toString()} base units`);
  if (claimable === 0n) {
    throw new Error(
      "Nothing claimable right now (the attacker bot may have claimed first). " +
        "Fall back to a plain self-transfer from the drill account as the drill proof tx.",
    );
  }

  const claimedBefore = ((await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "schedules", args: [beneficiary.address],
  })) as [bigint, bigint, bigint, bigint, bigint, boolean])[1];

  console.log(`\nClaiming vested QVEST…`);
  const tx = await writeContract(beneficiaryWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [beneficiaryBech32],
    account: beneficiaryWallet.account ?? null, chain: beneficiaryWallet.chain,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`claim reverted: ${tx}`);
  const cosmos = await cosmosHashForEvmTx(client.publicClient, tx);
  console.log(`evmTx: ${tx}`);
  console.log(`cosmosTx: ${cosmos.cosmosHash}`);

  const claimedAfter = ((await readContract(client.publicClient, {
    address: contract, abi: qoreVestAbi, functionName: "schedules", args: [beneficiary.address],
  })) as [bigint, bigint, bigint, bigint, bigint, boolean])[1];
  const allowance = await nativeAllowance(beneficiaryBech32);
  console.log(`claimed total: ${claimedAfter.toString()} base units (was ${claimedBefore.toString()})`);
  console.log(`Native allowance: ${allowance.toString()} (invariant allowance == claimed: ${allowance === claimedAfter})`);
  if (claimedAfter !== claimedBefore + claimable) throw new Error("claimed amount mismatch");
  if (allowance !== claimedAfter) throw new Error("Native invariant broken");
  console.log("\nDRILL CLAIM VERIFIED. Submit the cosmosTx hash above on the QoreVest project page.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
