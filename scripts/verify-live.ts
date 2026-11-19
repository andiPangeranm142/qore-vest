/**
 * verify-live.ts — verify the LIVE QoreVest state on the Diana testnet
 * against the numbers stated in deployments/schedules.json (which the
 * README's live-state table mirrors).
 *
 * READ-ONLY: no keys, no transactions, no .env needed. Every check reads
 * the chain (EVM RPC + the Native LCD for the cw20 allowance) and prints
 * PASS or FAIL. Exit code 0 only if every check passes.
 *
 *   npx tsx scripts/verify-live.ts
 *   npm run verify-live
 *
 * What it checks:
 *   - contract identity (chain id, code, owner, precompile, Native target,
 *     name/symbol/decimals, total supply)
 *   - all five schedules, enumerated from beneficiaries[]: address, total,
 *     claimed, start, cliff, duration — exactly as recorded
 *   - totals: totalLocked, sum of scheduled totals, sum of claimed, and the
 *     two reconciliations (scheduled - claimed == totalLocked;
 *     contract balance + claimed == total supply)
 *   - per-beneficiary QVEST balances equal their claimed amounts
 *   - the live-demo schedule is still pre-cliff (vested == claimable == 0)
 *   - the drill schedule's vested/claimable values are internally
 *     consistent (they grow with time, so only relations are checked)
 *   - the Native allowance invariant: allowance(QoreVest, beneficiary) ==
 *     total claimed, read back from the WDT cw20 contract for each
 *     beneficiary (the bech32 addresses are cross-checked against the
 *     SDK's own derivation from the EVM addresses)
 *   - the pre-cliff rejection evidence: the recorded transaction's receipt
 *     is fetched from the chain and must be reverted, at the recorded
 *     block, with the recorded gas used
 *
 * If a check fails because the on-chain state genuinely moved (e.g. the
 * drill beneficiary claims again, or the live-demo cliff passes on
 * 23 Nov 2026), refresh deployments/schedules.json — and the README table
 * — from the chain, never by editing the script's expectations to match.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, http, type Address } from "viem";
import { addressesFrom20 } from "@qorechain/sdk";
import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVM_RPC = "https://evm-testnet.qore.host";
const REST = "https://api-testnet.qore.host";
const PRECOMPILE = "0x0000000000000000000000000000000000000901";
const MAX_BENEFICIARIES = 20;

type ScheduleRow = {
  index: number;
  label: string;
  beneficiary: string;
  beneficiaryNative: string;
  total: string;
  claimed: string;
  start: number;
  cliff: number;
  duration: number;
};
type SchedulesFile = {
  chainId: number;
  contract: string;
  contractNativeAddress: string;
  nativeTarget: string;
  verifiedAt: string;
  verifiedAtBlock: number;
  totalSupply: string;
  totalLocked: string;
  contractBalance: string;
  totalClaimed: string;
  totalScheduled: string;
  schedules: ScheduleRow[];
};
type PrecliffFile = {
  contract: string;
  beneficiary: string;
  schedule: { total: string; claimed: string; cliffEndsAt: string };
  evmTx: string;
  blockNumber: string;
  gasUsed: string;
  receiptStatus: string;
};

const expected = JSON.parse(
  readFileSync(join(ROOT, "deployments", "schedules.json"), "utf8"),
) as SchedulesFile;
const precliff = JSON.parse(
  readFileSync(join(ROOT, "deployments", "precliff-rejection.json"), "utf8"),
) as PrecliffFile;

const CONTRACT = expected.contract as Address;
const diana = defineChain({
  id: 9800,
  name: "QoreChain Diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
const client = createPublicClient({ chain: diana, transport: http() });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** "56,953.802911 QVEST (56953802911)" */
function fmt(v: bigint): string {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toLocaleString("en-US")}.${frac} QVEST (${v})`;
}

type ReadFn =
  | "owner"
  | "crossVmPrecompile"
  | "nativeTarget"
  | "name"
  | "symbol"
  | "decimals"
  | "totalSupply"
  | "beneficiaries"
  | "schedules"
  | "vested"
  | "claimable"
  | "balanceOf"
  | "totalLocked";

async function read<T>(functionName: ReadFn, args?: unknown[]): Promise<T> {
  return (await client.readContract({
    address: CONTRACT,
    abi: qoreVestAbi,
    functionName,
    args: args as never,
  })) as T;
}

/** Query the WDT cw20 allowance for one beneficiary over the Native LCD. */
async function nativeAllowance(spender: string): Promise<bigint | null> {
  const query = Buffer.from(
    JSON.stringify({
      allowance: { owner: expected.contractNativeAddress, spender },
    }),
  ).toString("base64url");
  const url = `${REST}/cosmwasm/wasm/v1/contract/${expected.nativeTarget}/smart/${query}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { allowance?: string } };
      if (typeof json.data?.allowance !== "string") return null;
      return BigInt(json.data.allowance);
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  console.log("QoreVest live verification — Diana testnet (chain 9800)");
  console.log(`contract ${CONTRACT}`);
  console.log(
    `expected state: deployments/schedules.json (verified ${expected.verifiedAt} @ block ${expected.verifiedAtBlock})`,
  );
  const block = await client.getBlock();
  console.log(
    `live block ${block.number} @ ${new Date(Number(block.timestamp) * 1000).toISOString()}`,
  );
  console.log("");

  // --- contract identity -------------------------------------------------
  check("chain id is 9800", (await client.getChainId()) === 9800);
  const code = await client.getBytecode({ address: CONTRACT });
  check("contract has code on chain", !!code && code.length > 2);
  check(
    "owner is the deployer",
    ((await read<string>("owner")).toLowerCase() ===
      expected.schedules[0].beneficiary.toLowerCase()),
  );
  check(
    "cross-VM precompile is 0x…0901",
    (await read<string>("crossVmPrecompile")).toLowerCase() === PRECOMPILE,
  );
  check("Native target is the WDT cw20", (await read<string>("nativeTarget")) === expected.nativeTarget);
  check("token name is QoreVest", (await read<string>("name")) === "QoreVest");
  check("token symbol is QVEST", (await read<string>("symbol")) === "QVEST");
  check("token decimals are 6", (await read<number>("decimals")) === 6);
  const totalSupply = await read<bigint>("totalSupply");
  check("totalSupply is 1,000,000 QVEST", totalSupply === BigInt(expected.totalSupply), `live ${fmt(totalSupply)}`);

  // --- schedules, enumerated from the chain ------------------------------
  const onChainBeneficiaries: string[] = [];
  for (let i = 0; i < MAX_BENEFICIARIES; i++) {
    try {
      onChainBeneficiaries.push(await read<string>("beneficiaries", [BigInt(i)]));
    } catch {
      break;
    }
  }
  check(
    `beneficiary count is ${expected.schedules.length}`,
    onChainBeneficiaries.length === expected.schedules.length,
    `live ${onChainBeneficiaries.length}: ${onChainBeneficiaries.join(", ")}`,
  );

  let sumTotal = 0n;
  let sumClaimed = 0n;
  const liveByLabel = new Map<string, { total: bigint; claimed: bigint; vested: bigint; claimable: bigint }>();
  for (const row of expected.schedules) {
    const liveAddr = onChainBeneficiaries[row.index];
    check(
      `schedule #${row.index} (${row.label}) beneficiary address`,
      !!liveAddr && liveAddr.toLowerCase() === row.beneficiary.toLowerCase(),
      `live ${liveAddr ?? "(missing)"}`,
    );
    if (!liveAddr) continue;
    const s = (await read<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>("schedules", [
      liveAddr as Address,
    ])) as [bigint, bigint, bigint, bigint, bigint, boolean];
    const [total, claimed, start, cliff, duration, exists] = s;
    const vested = await read<bigint>("vested", [liveAddr as Address]);
    const claimable = await read<bigint>("claimable", [liveAddr as Address]);
    liveByLabel.set(row.label, { total, claimed, vested, claimable });
    sumTotal += total;
    sumClaimed += claimed;
    const matches =
      exists &&
      total === BigInt(row.total) &&
      claimed === BigInt(row.claimed) &&
      start === BigInt(row.start) &&
      cliff === BigInt(row.cliff) &&
      duration === BigInt(row.duration);
    check(
      `schedule #${row.index} (${row.label}) total/claimed/start/cliff/duration`,
      matches,
      `live total=${fmt(total)} claimed=${fmt(claimed)} start=${start} cliff=${cliff} duration=${duration} exists=${exists}`,
    );
    const balance = await read<bigint>("balanceOf", [liveAddr as Address]);
    check(
      `schedule #${row.index} (${row.label}) QVEST balance == claimed`,
      balance === claimed,
      `live balance=${fmt(balance)} claimed=${fmt(claimed)}`,
    );
  }

  // --- totals and reconciliation ------------------------------------------
  const totalLocked = await read<bigint>("totalLocked");
  check(
    "totalLocked matches the recorded value",
    totalLocked === BigInt(expected.totalLocked),
    `live ${fmt(totalLocked)}, recorded ${fmt(BigInt(expected.totalLocked))}`,
  );
  check(
    "sum of scheduled totals is 235,000 QVEST",
    sumTotal === BigInt(expected.totalScheduled),
    `live ${fmt(sumTotal)}`,
  );
  check(
    "sum of claimed amounts is 178,046.197089 QVEST",
    sumClaimed === BigInt(expected.totalClaimed),
    `live ${fmt(sumClaimed)}`,
  );
  check(
    "scheduled - claimed == totalLocked",
    sumTotal - sumClaimed === totalLocked,
    `scheduled ${fmt(sumTotal)} - claimed ${fmt(sumClaimed)} = ${fmt(sumTotal - sumClaimed)}, totalLocked ${fmt(totalLocked)}`,
  );
  const contractBalance = await read<bigint>("balanceOf", [CONTRACT]);
  check(
    "contract balance matches the recorded value",
    contractBalance === BigInt(expected.contractBalance),
    `live ${fmt(contractBalance)}, recorded ${fmt(BigInt(expected.contractBalance))}`,
  );
  check(
    "contract balance + claimed == totalSupply",
    contractBalance + sumClaimed === totalSupply,
    `balance ${fmt(contractBalance)} + claimed ${fmt(sumClaimed)} = ${fmt(contractBalance + sumClaimed)}, supply ${fmt(totalSupply)}`,
  );

  // --- cliff / vesting status ---------------------------------------------
  const liveDemo = expected.schedules.find((s) => s.label === "live-demo");
  const liveDemoLive = liveDemo && liveByLabel.get("live-demo");
  if (liveDemo && liveDemoLive) {
    const cliffEnds = liveDemo.start + liveDemo.cliff;
    check(
      "live-demo schedule is still pre-cliff",
      Number(block.timestamp) < cliffEnds,
      `now ${Number(block.timestamp)}, cliff ends ${cliffEnds} (${new Date(cliffEnds * 1000).toISOString()})`,
    );
    check("live-demo vested is 0", liveDemoLive.vested === 0n, `live ${fmt(liveDemoLive.vested)}`);
    check("live-demo claimable is 0", liveDemoLive.claimable === 0n, `live ${fmt(liveDemoLive.claimable)}`);
    check("live-demo claimed is 0", liveDemoLive.claimed === 0n, `live ${fmt(liveDemoLive.claimed)}`);
  }
  const drill = liveByLabel.get("drill");
  const drillRow = expected.schedules.find((s) => s.label === "drill");
  if (drill && drillRow) {
    check(
      "drill vested is between claimed and total (grows with time)",
      drill.vested >= drill.claimed && drill.vested <= drill.total,
      `vested ${fmt(drill.vested)}, claimed ${fmt(drill.claimed)}, total ${fmt(drill.total)}`,
    );
    // vested and claimable are read in two separate RPC calls, and vesting
    // accrues with time, so the later claimable read is always slightly
    // larger than vested - claimed. Allow up to 120s of vesting accrual.
    const ratePerSecond = BigInt(drillRow.total) / BigInt(drillRow.duration);
    const tolerance = ratePerSecond * 120n + 1n;
    const diff = drill.claimable - (drill.vested - drill.claimed);
    check(
      "drill claimable == vested - claimed (within 120s of vesting accrual)",
      diff >= 0n && diff <= tolerance,
      `claimable ${fmt(drill.claimable)}, vested - claimed ${fmt(drill.vested - drill.claimed)}, diff ${fmt(diff)}, tolerance ${fmt(tolerance)}`,
    );
  }
  for (const label of ["deployer", "second", "video"]) {
    const row = liveByLabel.get(label);
    if (row) {
      check(`${label} schedule is fully claimed (claimable 0)`, row.claimable === 0n, `live ${fmt(row.claimable)}`);
    }
  }

  // --- Native allowance invariant -----------------------------------------
  for (const row of expected.schedules) {
    const derived = addressesFrom20(Buffer.from(row.beneficiary.slice(2), "hex")).cosmos;
    check(
      `bech32 for ${row.label} matches the SDK derivation`,
      derived === row.beneficiaryNative,
      `derived ${derived}, recorded ${row.beneficiaryNative}`,
    );
    const allowance = await nativeAllowance(row.beneficiaryNative);
    check(
      `Native allowance for ${row.label} == claimed`,
      allowance !== null && allowance === BigInt(row.claimed),
      allowance === null
        ? "LCD query failed"
        : `live ${fmt(allowance)}, claimed ${fmt(BigInt(row.claimed))}`,
    );
  }

  // --- pre-cliff rejection evidence ---------------------------------------
  const receipt = await client.getTransactionReceipt({ hash: precliff.evmTx as `0x${string}` });
  check("pre-cliff tx receipt status is reverted", receipt.status === "reverted", `live ${receipt.status}`);
  check(
    "pre-cliff tx is at the recorded block",
    receipt.blockNumber === BigInt(precliff.blockNumber),
    `live ${receipt.blockNumber}, recorded ${precliff.blockNumber}`,
  );
  check(
    "pre-cliff tx gas used matches the record",
    receipt.gasUsed === BigInt(precliff.gasUsed),
    `live ${receipt.gasUsed}, recorded ${precliff.gasUsed}`,
  );
  check(
    "pre-cliff tx was sent to the QoreVest contract",
    receipt.to?.toLowerCase() === CONTRACT.toLowerCase(),
    `live to=${receipt.to}`,
  );
  check(
    "pre-cliff tx was sent by the live-demo beneficiary",
    receipt.from.toLowerCase() === precliff.beneficiary.toLowerCase(),
    `live from=${receipt.from}`,
  );
  check(
    "pre-cliff record's claimed amount (0) matches the live schedule",
    BigInt(precliff.schedule.claimed) === (liveDemoLive?.claimed ?? -1n),
    `record ${precliff.schedule.claimed}, live ${liveDemoLive?.claimed}`,
  );

  console.log("");
  console.log(`SUMMARY: ${passed}/${passed + failed} checks passed`);
  if (failed > 0) {
    console.log("RESULT: FAIL — see the [FAIL] lines above.");
    process.exitCode = 1;
  } else {
    console.log("RESULT: PASS — live chain matches the recorded state.");
  }
}

main().catch((err: unknown) => {
  console.log(`[FAIL] verify-live crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
