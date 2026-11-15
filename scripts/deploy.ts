/**
 * deploy.ts - deploy the QoreVest contract to the QoreChain EVM Engine
 * (testnet qorechain-diana, chain id 9800).
 *
 * Uses @qorechain/evm:
 *   - createEvmClient({ endpoints })  → a viem-backed client (chain id auto-detected)
 *   - deployContract(walletClient, …) → deploy and get the tx hash
 *   - readContract                    → typed reads
 *
 * Prerequisites (see README):
 *   - QORE_EVM_RPC_URL pointing at the testnet EVM JSON-RPC endpoint.
 *   - QORE_EVM_PRIVATE_KEY for the funded qore-vest deployer account
 *     (0x-prefixed, 32 bytes). It must be the SAME account as QORE_MNEMONIC
 *     (used by scripts/window.ts), derived at m/44'/60'/0'/0/0.
 *   - A registered ML-DSA-87 key and a live EVM authorisation window for
 *     that account: run `npm run window register` once, then
 *     `npm run window open`, and wait ~10 seconds before deploying.
 *
 * Constructor arguments:
 *   - crossVmPrecompile: 0x0000000000000000000000000000000000000901 (the
 *     CrossVM Bridge precompile, confirmed active on Diana)
 *   - nativeTarget: the allowlisted cw20 contract WDT
 *     (qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt)
 *   - initialSupply: 1,000,000 QVEST at 6 decimals (1e12 base units)
 *
 * Safety: this script REFUSES to run on any chain other than the testnet
 * (chain id 9800). QoreVest is a testnet-only project.
 *
 * On success it writes deployments/testnet.json with the contract address
 * and the transaction hashes, so the frontend, the usage script, and the
 * README can point at the live deployment.
 */
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
  readContract,
} from "@qorechain/evm";
import { type Address, type Hex } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qoreVestAbi, qoreVestBytecode } from "../contracts/QoreVest.artifact.js";
import { cosmosHashForEvmTx } from "./cosmos-hash.js";

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;

/** The CrossVM Bridge precompile (confirmed active on Diana). */
const CROSS_VM_PRECOMPILE = "0x0000000000000000000000000000000000000901" as Address;

/** The allowlisted cw20 contract WDT, the Native leg of every claim. */
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";

/** 1,000,000 QVEST at 6 decimals. */
const INITIAL_SUPPLY = 1_000_000n * 10n ** 6n;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}. ` +
        `Check QORE_EVM_RPC_URL (testnet: https://evm-testnet.qore.host).`,
    );
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`deployer: ${account.address}`);

  // Deploy.
  console.log(`\nDeploying QoreVest (precompile ${CROSS_VM_PRECOMPILE}, target WDT, supply ${INITIAL_SUPPLY})…`);
  const deployHash = await deployContract(wallet, {
    abi: qoreVestAbi,
    bytecode: qoreVestBytecode,
    args: [CROSS_VM_PRECOMPILE, WDT, INITIAL_SUPPLY],
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });
  const contract = receipt.contractAddress;
  if (!contract) {
    throw new Error("Deployment receipt did not include a contract address.");
  }
  console.log(`deployed: ${contract}`);
  console.log(`deploy tx: ${deployHash}`);
  const deployCosmos = await cosmosHashForEvmTx(client.publicClient, deployHash);
  console.log(`explorer: https://explore.qore.network/tx/${deployCosmos.cosmosHash} (switch the explorer to Testnet)`);

  // Read back the deployment state.
  const name = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "name",
  });
  const symbol = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "symbol",
  });
  const decimals = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "decimals",
  });
  const totalSupply = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "totalSupply",
  });
  const nativeTarget = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "nativeTarget",
  });
  const precompile = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "crossVmPrecompile",
  });
  const contractBalance = await readContract(client.publicClient, {
    address: contract as Address, abi: qoreVestAbi, functionName: "balanceOf", args: [contract as Address],
  });
  console.log(`\nname: ${name} (${symbol}, ${decimals} decimals)`);
  console.log(`totalSupply: ${totalSupply}`);
  console.log(`nativeTarget: ${nativeTarget}`);
  console.log(`crossVmPrecompile: ${precompile}`);
  console.log(`contract balance: ${contractBalance}`);
  if (name !== "QoreVest" || symbol !== "QVEST" || decimals !== 6 || totalSupply !== INITIAL_SUPPLY) {
    throw new Error("Deployment read-back does not match the expected state.");
  }
  if (nativeTarget !== WDT || (precompile as string).toLowerCase() !== CROSS_VM_PRECOMPILE.toLowerCase()) {
    throw new Error("Deployment read-back: precompile/target mismatch.");
  }

  // Record the deployment for the frontend, the usage script, and the README.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(dir, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const deployment = {
    network: "qorechain-diana",
    chainId: 9800,
    contract: contract as Address,
    deployer: account.address,
    crossVmPrecompile: CROSS_VM_PRECOMPILE,
    nativeTarget: WDT,
    initialSupply: INITIAL_SUPPLY.toString(),
    deployTx: deployHash,
    deployTxCosmos: deployCosmos.cosmosHash,
    explorerContract: `https://explore.qore.network/address/${contract}`,
    explorerDeployTx: `https://explore.qore.network/tx/${deployCosmos.cosmosHash}`,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, "testnet.json"),
    JSON.stringify(deployment, null, 2) + "\n",
  );
  console.log("\nWrote deployments/testnet.json");
  console.log("Done.");
}

// Only run when invoked directly: importing this module must never deploy.
// (On 16 Nov 2026 usage.ts imported the Cosmos-hash helper from here and the
// unguarded main() deployed a second, duplicate contract mid-run —
// 0xc0ae0f1e…, deploy tx 0x74951c89…. The helper now lives in
// cosmos-hash.ts and both scripts guard their entry points.)
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err: unknown) => {
    console.error("\nDeploy failed.");
    console.error(
      "Check QORE_EVM_RPC_URL is reachable, QORE_EVM_PRIVATE_KEY funds an account, " +
        "and a live EVM authorisation window is open (`npm run window status`).",
    );
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
