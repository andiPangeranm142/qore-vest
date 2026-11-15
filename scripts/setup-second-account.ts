/**
 * setup-second-account.ts - prepare the second beneficiary account (index 1
 * of the deployer mnemonic) so it can claim its own vesting schedule:
 *
 *   1. fund it with 1.5 QOR via a Native bank send from the deployer
 *      (this also creates the account on chain),
 *   2. register its ML-DSA-87 key (its very first transaction, signed
 *      classically — the one message the chain accepts that way),
 *   3. open an EVM authorisation window for it (hybrid-signed).
 *
 * The account is derived from the SAME mnemonic as the deployer (index 1),
 * so no new secret is introduced. Nothing in this script prints the
 * mnemonic or any private key — only addresses and transaction hashes.
 *
 * Run: npx tsx --env-file=.env scripts/setup-second-account.ts
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  bank,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";

/** 1.5 QOR in uqor. */
const FUND_AMOUNT = "1500000";
/** A native-lane fee: hybrid transactions are large, so the gas limit is generous. */
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint } | null> {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function waitForAccount(address: string, label: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (await accountSequence(address)) return;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label} (${address}) to exist on chain`);
}

async function broadcast(
  acc: UnifiedAccount,
  mode: "hybrid" | "classical",
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
): Promise<string> {
  const seq = await accountSequence(acc.cosmos);
  if (!seq) throw new Error(`${acc.cosmos} does not exist on chain yet`);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber: seq.accountNumber,
      sequence: seq.sequence,
      fee: FEE,
      messages,
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("QORE_MNEMONIC missing in .env");
  const deployer = await deriveUnifiedAccount(mnemonic, 0);
  const second = await deriveUnifiedAccount(mnemonic, 1);
  console.log(`deployer: ${deployer.evm} (${deployer.cosmos})`);
  console.log(`second:   ${second.evm} (${second.cosmos})`);

  // 1. Fund the second account (Native bank send from the deployer).
  const existing = await accountSequence(second.cosmos);
  if (existing) {
    console.log("second account already exists on chain; skipping the funding send");
  } else {
    console.log(`\nFunding the second account with ${Number(FUND_AMOUNT) / 1e6} QOR…`);
    const msg = bank.send({
      fromAddress: deployer.cosmos,
      toAddress: second.cosmos,
      amount: [{ denom: "uqor", amount: FUND_AMOUNT }],
    });
    console.log(`fund tx: ${await broadcast(deployer, "hybrid", [msg])}`);
    await waitForAccount(second.cosmos, "second account");
    console.log("second account exists on chain");
  }

  // 2. Register its ML-DSA-87 key (its first transaction).
  const pqc = await fetchPqcStatus({ rest: REST, address: second.cosmos });
  if (pqc.registered && isRegisteredPqcKey(pqc, second.pqc.publicKey)) {
    console.log("PQC key already registered for the second account");
  } else {
    if (pqc.registered) throw new Error("second account has a DIFFERENT PQC key registered — refusing to continue");
    console.log("\nRegistering the second account's ML-DSA-87 key…");
    const proofOfPossession = signProofOfPossession({ chainId: CHAIN_ID, account: second.cosmos, keypair: second.pqc });
    const msg = buildRegisterPqcKeyMsg(second.cosmos, { pqcKeypair: second.pqc, proofOfPossession });
    console.log(`register tx: ${await broadcast(second, "classical", [msg])}`);
    for (let i = 0; i < 30; i++) {
      const st = await fetchPqcStatus({ rest: REST, address: second.cosmos });
      if (st.registered && isRegisteredPqcKey(st, second.pqc.publicKey)) break;
      if (i === 29) throw new Error("timed out waiting for the PQC registration to land");
      await sleep(2000);
    }
    console.log("PQC key registered");
  }

  // 3. Open an EVM window for it (1200 blocks, 5 txs).
  const w = await evmWindowStatus({ rest: REST, address: second.cosmos });
  if (w.found && w.live && w.remainingTxs >= 2) {
    console.log(`window already live: ${w.remainingBlocks} blocks, ${w.remainingTxs} txs, ${w.remainingValue} uqor left`);
  } else {
    const blocks = 1200n;
    const maxTxs = 5n;
    const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });
    const maxValue = perTx * maxTxs;
    console.log(`\nOpening a window (${blocks} blocks, ${maxTxs} txs, ${maxValue} uqor)…`);
    const msg = openEvmWindowMsg({ sender: second.cosmos, blocks, maxTxs, maxValue });
    console.log(`window tx: ${await broadcast(second, "hybrid", [msg])}`);
    await sleep(10000);
    const w2 = await evmWindowStatus({ rest: REST, address: second.cosmos });
    console.log(`window: ${w2.live ? "live" : "NOT LIVE"}; ${w2.remainingBlocks} blocks, ${w2.remainingTxs} txs, ${w2.remainingValue} uqor left`);
    if (!w2.live) throw new Error("window did not become live");
  }

  // Verify the EVM balance.
  const balRes = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${second.cosmos}`);
  const bal = (await balRes.json()) as { balances: Array<{ denom: string; amount: string }> };
  console.log(`\nsecond account balances: ${JSON.stringify(bal.balances)}`);
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
