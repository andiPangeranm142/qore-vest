/**
 * usage.ts - demonstrate the REAL atomic EVM→Native vesting flow on the
 * Diana testnet and record the evidence:
 *
 *   1. create vesting schedules for the deployer (100,000 QVEST, 60s cliff,
 *      600s duration) and the second account (50,000 QVEST, no cliff,
 *      300s duration),
 *   2. claim partway through each schedule and verify BOTH legs:
 *      QVEST moved on the EVM side AND the Native cw20 allowance under the
 *      contract's mapped address equals the claimed amount,
 *   3. force an on-chain revert (a claim with another beneficiary's Native
 *      address) and verify no state changed,
 *   4. claim the remainders after both schedules fully vest and verify the
 *      final invariant: allowance == total claimed, per beneficiary.
 *
 * The script waits for real vesting time (~12 minutes total). It needs live
 * EVM windows for both accounts: run `npm run window open` for the deployer
 * and `scripts/setup-second-account.ts` for the second account first.
 *
 * Evidence is written to deployments/usage.json (hashes, both EVM and
 * Cosmos, plus the before/after allowance reads).
 *
 * Run: npx tsx --env-file=.env scripts/usage.ts
 */
import {
  createEvmClient,
  evmAccountFromPrivateKey,
  readContract,
  writeContract,
} from "@qorechain/evm";
import { addressesFrom20 } from "@qorechain/sdk";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { mnemonicToAccount } from "viem/accounts";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

const TESTNET_CHAIN_ID = 9800;
const RPC = "https://rpc-testnet.qore.host";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Deployment = {
  contract: Address;
  nativeTarget: string;
};

type Evidence = {
  network: string;
  chainId: number;
  contract: string;
  contractNativeAddress: string;
  nativeTarget: string;
  steps: Array<Record<string, unknown>>;
  finalVerification: Record<string, unknown>;
  ranAt: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;
  const mnemonic = requireEnv("QORE_MNEMONIC");

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const deployment = JSON.parse(
    fs.readFileSync(path.resolve(dir, "..", "deployments", "testnet.json"), "utf8"),
  ) as Deployment;
  const contract = deployment.contract;
  const wdt = deployment.nativeTarget;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`wrong chain id ${chainId}`);
  const deployer = evmAccountFromPrivateKey(privateKey);
  const second = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const deployerWallet = client.getWalletClient(deployer);
  const secondWallet = client.getWalletClient(second);

  const deployerBech32 = addressesFrom20(Buffer.from(deployer.address.slice(2), "hex")).cosmos;
  const secondBech32 = addressesFrom20(Buffer.from(second.address.slice(2), "hex")).cosmos;
  const contractNative = addressesFrom20(Buffer.from(contract.slice(2), "hex")).cosmos;
  console.log(`contract: ${contract} (Native ${contractNative})`);
  console.log(`deployer: ${deployer.address} (${deployerBech32})`);
  console.log(`second:   ${second.address} (${secondBech32})`);

  const cw = await CosmWasmClient.connect(RPC);
  async function nativeAllowance(spender: string): Promise<bigint> {
    const res = (await cw.queryContractSmart(wdt, {
      allowance: { owner: contractNative, spender },
    })) as { allowance: string };
    return BigInt(res.allowance);
  }
  async function qvestBalance(who: Address): Promise<bigint> {
    return (await readContract(client.publicClient, {
      address: contract, abi: qoreVestAbi, functionName: "balanceOf", args: [who],
    })) as bigint;
  }
  async function claimable(who: Address): Promise<bigint> {
    return (await readContract(client.publicClient, {
      address: contract, abi: qoreVestAbi, functionName: "claimable", args: [who],
    })) as bigint;
  }
  async function scheduleOf(who: Address): Promise<[bigint, bigint, bigint, bigint, bigint, boolean]> {
    return (await readContract(client.publicClient, {
      address: contract, abi: qoreVestAbi, functionName: "schedules", args: [who],
    })) as [bigint, bigint, bigint, bigint, bigint, boolean];
  }

  const evidence: Evidence = {
    network: "qorechain-diana",
    chainId: 9800,
    contract,
    contractNativeAddress: contractNative,
    nativeTarget: wdt,
    steps: [],
    finalVerification: {},
    ranAt: new Date().toISOString(),
  };
  const step = (s: Record<string, unknown>) => {
    evidence.steps.push(s);
    console.log(JSON.stringify(s));
  };

  // Pre-flight: allowances start at zero.
  console.log(`\npre-flight allowance (deployer): ${await nativeAllowance(deployerBech32)}`);
  console.log(`pre-flight allowance (second):   ${await nativeAllowance(secondBech32)}`);

  // 1. Create the two schedules.
  const now = Math.floor(Date.now() / 1000);
  const deployerAmount = 100_000n * 10n ** 6n;
  const secondAmount = 50_000n * 10n ** 6n;
  console.log("\nCreating the deployer's schedule (100,000 QVEST, cliff 60s, duration 600s)…");
  const create1 = await writeContract(deployerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "createVesting",
    args: [deployer.address, deployerAmount, BigInt(now), 60n, 600n],
    account: deployerWallet.account ?? null, chain: deployerWallet.chain,
  });
  await client.publicClient.waitForTransactionReceipt({ hash: create1 });
  const create1Cosmos = await cosmosHashForEvmTx(client.publicClient, create1);
  step({ action: "createVesting", beneficiary: deployer.address, amount: deployerAmount.toString(), start: now, cliff: 60, duration: 600, evmTx: create1, cosmosTx: create1Cosmos.cosmosHash });

  console.log("Creating the second account's schedule (50,000 QVEST, no cliff, duration 300s)…");
  const create2 = await writeContract(deployerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "createVesting",
    args: [second.address, secondAmount, BigInt(now), 0n, 300n],
    account: deployerWallet.account ?? null, chain: deployerWallet.chain,
  });
  await client.publicClient.waitForTransactionReceipt({ hash: create2 });
  const create2Cosmos = await cosmosHashForEvmTx(client.publicClient, create2);
  step({ action: "createVesting", beneficiary: second.address, amount: secondAmount.toString(), start: now, cliff: 0, duration: 300, evmTx: create2, cosmosTx: create2Cosmos.cosmosHash });

  // 2. Wait past the deployer's cliff, then claim from both.
  console.log("\nWaiting 75s (past the deployer's 60s cliff)…");
  await sleep(75_000);

  console.log(`\nDeployer claimable: ${await claimable(deployer.address)}`);
  const claim1 = await writeContract(deployerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [deployerBech32], account: deployerWallet.account ?? null, chain: deployerWallet.chain,
  });
  const claim1Receipt = await client.publicClient.waitForTransactionReceipt({ hash: claim1 });
  const claim1Cosmos = await cosmosHashForEvmTx(client.publicClient, claim1);
  const deployerClaimed1 = (await scheduleOf(deployer.address))[1];
  const deployerAllowance1 = await nativeAllowance(deployerBech32);
  step({
    action: "claim", beneficiary: deployer.address, status: claim1Receipt.status,
    claimedTotal: deployerClaimed1.toString(), qvestBalance: (await qvestBalance(deployer.address)).toString(),
    nativeAllowance: deployerAllowance1.toString(), invariantHolds: deployerAllowance1 === deployerClaimed1,
    evmTx: claim1, cosmosTx: claim1Cosmos.cosmosHash,
  });
  if (deployerAllowance1 !== deployerClaimed1) throw new Error("INVARIANT BROKEN: deployer allowance != claimed");

  console.log(`Second claimable: ${await claimable(second.address)}`);
  const claim2 = await writeContract(secondWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [secondBech32], account: secondWallet.account ?? null, chain: secondWallet.chain,
  });
  const claim2Receipt = await client.publicClient.waitForTransactionReceipt({ hash: claim2 });
  const claim2Cosmos = await cosmosHashForEvmTx(client.publicClient, claim2);
  const secondClaimed1 = (await scheduleOf(second.address))[1];
  const secondAllowance1 = await nativeAllowance(secondBech32);
  step({
    action: "claim", beneficiary: second.address, status: claim2Receipt.status,
    claimedTotal: secondClaimed1.toString(), qvestBalance: (await qvestBalance(second.address)).toString(),
    nativeAllowance: secondAllowance1.toString(), invariantHolds: secondAllowance1 === secondClaimed1,
    evmTx: claim2, cosmosTx: claim2Cosmos.cosmosHash,
  });
  if (secondAllowance1 !== secondClaimed1) throw new Error("INVARIANT BROKEN: second allowance != claimed");

  // 3. Forced on-chain revert: the deployer claims with the second
  // account's Native address. Explicit gas bypasses estimation so the
  // transaction actually lands (and reverts) on chain.
  console.log("\nForcing an on-chain revert (deployer claims with the second account's Native address)…");
  const balBefore = await qvestBalance(deployer.address);
  const allowBefore = await nativeAllowance(deployerBech32);
  const schedBefore = await scheduleOf(deployer.address);
  const revertHash = await writeContract(deployerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [secondBech32], account: deployerWallet.account ?? null, chain: deployerWallet.chain,
    gas: 800_000n,
  });
  const revertReceipt = await client.publicClient.waitForTransactionReceipt({ hash: revertHash });
  const revertCosmos = await cosmosHashForEvmTx(client.publicClient, revertHash);
  const balAfter = await qvestBalance(deployer.address);
  const allowAfter = await nativeAllowance(deployerBech32);
  const schedAfter = await scheduleOf(deployer.address);
  const unchanged = balAfter === balBefore && allowAfter === allowBefore && schedAfter[1] === schedBefore[1];
  step({
    action: "claim (forced revert)", beneficiary: deployer.address, status: revertReceipt.status,
    stateUnchanged: unchanged, evmTx: revertHash, cosmosTx: revertCosmos.cosmosHash,
  });
  if (revertReceipt.status !== "reverted") throw new Error("expected the forced claim to revert on chain");
  if (!unchanged) throw new Error("state changed after the reverted claim");

  // 4. Wait until both schedules fully vest, then claim the remainders.
  const endTime = now + 660; // deployer schedule ends at start + 60 + 600
  const waitMs = Math.max(0, (endTime - Math.floor(Date.now() / 1000) + 5) * 1000);
  console.log(`\nWaiting ${Math.round(waitMs / 1000)}s until both schedules fully vest…`);
  await sleep(waitMs);

  const claim3 = await writeContract(deployerWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [deployerBech32], account: deployerWallet.account ?? null, chain: deployerWallet.chain,
  });
  const claim3Receipt = await client.publicClient.waitForTransactionReceipt({ hash: claim3 });
  const claim3Cosmos = await cosmosHashForEvmTx(client.publicClient, claim3);
  const deployerClaimedTotal = (await scheduleOf(deployer.address))[1];
  const deployerAllowanceFinal = await nativeAllowance(deployerBech32);
  step({
    action: "claim (remainder)", beneficiary: deployer.address, status: claim3Receipt.status,
    claimedTotal: deployerClaimedTotal.toString(), qvestBalance: (await qvestBalance(deployer.address)).toString(),
    nativeAllowance: deployerAllowanceFinal.toString(), invariantHolds: deployerAllowanceFinal === deployerClaimedTotal,
    evmTx: claim3, cosmosTx: claim3Cosmos.cosmosHash,
  });

  const claim4 = await writeContract(secondWallet, {
    address: contract, abi: qoreVestAbi, functionName: "claim",
    args: [secondBech32], account: secondWallet.account ?? null, chain: secondWallet.chain,
  });
  const claim4Receipt = await client.publicClient.waitForTransactionReceipt({ hash: claim4 });
  const claim4Cosmos = await cosmosHashForEvmTx(client.publicClient, claim4);
  const secondClaimedTotal = (await scheduleOf(second.address))[1];
  const secondAllowanceFinal = await nativeAllowance(secondBech32);
  step({
    action: "claim (remainder)", beneficiary: second.address, status: claim4Receipt.status,
    claimedTotal: secondClaimedTotal.toString(), qvestBalance: (await qvestBalance(second.address)).toString(),
    nativeAllowance: secondAllowanceFinal.toString(), invariantHolds: secondAllowanceFinal === secondClaimedTotal,
    evmTx: claim4, cosmosTx: claim4Cosmos.cosmosHash,
  });

  evidence.finalVerification = {
    deployer: {
      totalClaimed: deployerClaimedTotal.toString(),
      expectedTotal: deployerAmount.toString(),
      fullyClaimed: deployerClaimedTotal === deployerAmount,
      nativeAllowance: deployerAllowanceFinal.toString(),
      invariantHolds: deployerAllowanceFinal === deployerClaimedTotal,
    },
    second: {
      totalClaimed: secondClaimedTotal.toString(),
      expectedTotal: secondAmount.toString(),
      fullyClaimed: secondClaimedTotal === secondAmount,
      nativeAllowance: secondAllowanceFinal.toString(),
      invariantHolds: secondAllowanceFinal === secondClaimedTotal,
    },
  };
  if (deployerClaimedTotal !== deployerAmount || secondClaimedTotal !== secondAmount) {
    throw new Error("final claimed totals do not match the schedule amounts");
  }
  if (deployerAllowanceFinal !== deployerClaimedTotal || secondAllowanceFinal !== secondClaimedTotal) {
    throw new Error("FINAL INVARIANT BROKEN: allowance != total claimed");
  }

  const outDir = path.resolve(dir, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "usage.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("\nAll invariants hold. Wrote deployments/usage.json");
  console.log("Done.");
}

// Only run when invoked directly: importing this module must never transact.
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    console.error("\nUsage run failed.");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
