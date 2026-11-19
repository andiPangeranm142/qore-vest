/**
 * qore-vest-math.test.ts - exact vesting-math and accounting tests for the
 * QoreVest contract on a local in-memory Ganache chain.
 *
 * Companion to qore-vest.test.ts (which covers the claim flow, the Native
 * payload, bech32 rejections, atomicity, and transfers). This file pins the
 * numbers exactly:
 *
 *   - Vesting math at exact block timestamps (`evm_mine` with an explicit
 *     timestamp, then a read against that exact block — Ganache 7 supports
 *     mining at a given timestamp, but NOT `evm_setNextBlockTimestamp`):
 *     one second before the cliff, at the cliff end, one second into the
 *     linear phase, mid-vest, one second before the end, at the end, and
 *     after the end.
 *     Expected values are computed with the contract's own formula in
 *     BigInt, so the assertions are exact, not tolerance-based.
 *   - Claim accounting: claimed totals across multiple claims, totalLocked
 *     against the sum of unclaimed schedule totals, the contract-balance
 *     reconciliation (balance + claimed == totalSupply), per-schedule
 *     balances, double-claim prevention, and schedule isolation.
 *   - Extra bech32 vectors (bad charset character, off-by-one length,
 *     uppercase, corrupted data character) and acceptance for several
 *     accounts.
 *   - The ERC-20 subset (approve / transferFrom, including the
 *     max-allowance branch) and the remaining createVesting guards.
 *   - The exact cross-VM payload amount for an odd claimed amount, and the
 *     beneficiaries[] enumeration order (the same enumeration the
 *     scripts/verify-live.ts script uses against Diana).
 *
 * The accounts are Ganache's built-in deterministic test accounts. They are
 * public test keys that exist only on this throwaway local chain; they are
 * NEVER funded anywhere and must never be used on testnet or mainnet.
 *
 * Run: npm test
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { addressesFrom20 } from "@qorechain/sdk";
import { qoreVestAbi, qoreVestBytecode } from "../contracts/QoreVest.artifact.js";
import { mockCrossVmAbi, mockCrossVmBytecode } from "../contracts/MockCrossVm.artifact.js";

/**
 * The well-known public test mnemonic (Hardhat's default). It funds NOTHING
 * outside this throwaway local chain. Never use this mnemonic anywhere else.
 */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/** The approved Native cw20 contract on Diana (used as the target string). */
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";

/** Real qore-vest deployer pair (derivation sanity check only — never signed as). */
const REAL_DEPLOYER_EVM = "0x1F6A09E6aC96a2Ae802828B19d31B0284b841B9d";
const REAL_DEPLOYER_BECH32 = "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny";

/** 1,000,000 QVEST at 6 decimals. */
const INITIAL_SUPPLY = 1_000_000n * 10n ** 6n;
/** 100,000 QVEST at 6 decimals (the standard test schedule size). */
const SCHEDULE_AMOUNT = 100_000n * 10n ** 6n;
/**
 * 3,600 QVEST at 6 decimals. Used by the read-only math tests and the
 * bech32-rejection tests, whose schedules are never claimed: with a
 * 1,000,000 QVEST supply, many unclaimed 100,000 QVEST schedules would
 * exceed the unallocated supply. 3,600 divides evenly by 2 and by the
 * 36,000s test duration, so the exact assertions stay exact.
 */
const MATH_AMOUNT = 3_600n * 10n ** 6n;

const localChain = defineChain({
  id: 1337,
  name: "Ganache Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

function bech32Of(address: Address): string {
  return addressesFrom20(Buffer.from(address.slice(2), "hex")).cosmos;
}

type Account = ReturnType<typeof mnemonicToAccount>;
type Clients = ReturnType<typeof createClients>;
type Schedule = [bigint, bigint, bigint, bigint, bigint, boolean];

function createClients(provider: ReturnType<typeof Ganache.provider>) {
  const transport = custom(provider as never);
  return {
    public: createPublicClient({ chain: localChain, transport }),
    wallet: createWalletClient({ chain: localChain, transport }),
  };
}

describe("QoreVest vesting math (exact)", () => {
  let clients: Clients;
  let provider: ReturnType<typeof Ganache.provider>;
  let qoreVest: Address;
  let mock: Address;
  let owner: Account;
  const accounts: Account[] = [];
  /** Beneficiaries with a schedule on the main contract, in creation order. */
  const createdOrder: Address[] = [];

  /** Mine a block at an exact timestamp; later reads see exactly that time. */
  async function setTime(timestamp: number): Promise<void> {
    // Ganache 7 has no evm_setNextBlockTimestamp; evm_mine with an explicit
    // timestamp does the same thing (verified: the mined block carries
    // exactly that timestamp).
    await provider.request({ method: "evm_mine", params: [timestamp] });
    assert.equal(await latestTimestamp(), timestamp, "block timestamp was not set exactly");
  }

  async function latestTimestamp(): Promise<number> {
    const block = await clients.public.getBlock();
    return Number(block.timestamp);
  }

  async function expectRevert(promise: Promise<unknown>, needle: string): Promise<void> {
    await assert.rejects(promise, (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(
        msg.includes(needle),
        `expected revert containing "${needle}", got: ${msg.slice(0, 300)}`,
      );
      return true;
    });
  }

  async function readSchedule(who: Address): Promise<Schedule> {
    return (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "schedules", args: [who],
    })) as Schedule;
  }

  /** Create a schedule on the main contract; returns its stored start. */
  async function createSchedule(
    beneficiary: Account,
    amount: bigint,
    cliff: bigint,
    duration: bigint,
    startOverride?: number,
  ): Promise<number> {
    const start = startOverride ?? (await latestTimestamp());
    const hash = await clients.wallet.writeContract({
      address: qoreVest,
      abi: qoreVestAbi,
      functionName: "createVesting",
      args: [beneficiary.address, amount, BigInt(start), cliff, duration],
      account: owner,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    createdOrder.push(beneficiary.address);
    return Number((await readSchedule(beneficiary.address))[2]);
  }

  async function vestedOf(who: Address): Promise<bigint> {
    return (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "vested", args: [who],
    })) as bigint;
  }

  async function claimableOf(who: Address): Promise<bigint> {
    return (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "claimable", args: [who],
    })) as bigint;
  }

  async function totalLocked(): Promise<bigint> {
    return (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "totalLocked",
    })) as bigint;
  }

  async function claim(who: Account) {
    const hash = await clients.wallet.writeContract({
      address: qoreVest,
      abi: qoreVestAbi,
      functionName: "claim",
      args: [bech32Of(who.address)],
      account: who,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }

  /** The contract's own vesting formula, computed off-chain in BigInt. */
  function expectedVested(total: bigint, cliffEnd: number, duration: bigint, now: number): bigint {
    if (now < cliffEnd) return 0n;
    if (now >= cliffEnd + Number(duration)) return total;
    return (total * BigInt(now - cliffEnd)) / duration;
  }

  before(async () => {
    provider = Ganache.provider({
      // Ganache funds only 10 accounts by default; this file signs from
      // mnemonic indices up to 109, so fund them all (100 ETH each).
      wallet: { mnemonic: TEST_MNEMONIC, totalAccounts: 256 },
      logging: { quiet: true },
    });
    clients = createClients(provider);
    for (let i = 0; i < 24; i++) accounts.push(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i }));
    owner = accounts[0];
    // Sanity: the SDK derives the known real deployer pair.
    assert.equal(bech32Of(REAL_DEPLOYER_EVM as Address), REAL_DEPLOYER_BECH32);

    const mockHash = await clients.wallet.deployContract({
      abi: mockCrossVmAbi,
      bytecode: mockCrossVmBytecode as Hex,
      account: owner,
      chain: localChain,
    });
    const mockReceipt = await clients.public.waitForTransactionReceipt({ hash: mockHash });
    assert.ok(mockReceipt.contractAddress, "mock deployment receipt has no contract address");
    mock = mockReceipt.contractAddress;

    const hash = await clients.wallet.deployContract({
      abi: qoreVestAbi,
      bytecode: qoreVestBytecode as Hex,
      args: [mock, WDT, INITIAL_SUPPLY],
      account: owner,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.ok(receipt.contractAddress, "deployment receipt has no contract address");
    qoreVest = receipt.contractAddress;
    assert.equal(receipt.status, "success");
  });

  it("vests exactly 0 one second before the cliff ends", async () => {
    const ben = accounts[1];
    const start = await createSchedule(ben, MATH_AMOUNT, 3600n, 36000n);
    await setTime(start + 3600 - 1);
    assert.equal(await vestedOf(ben.address), 0n);
    assert.equal(await claimableOf(ben.address), 0n);
  });

  it("vests exactly 0 at the cliff end and total/duration one second in", async () => {
    const ben = accounts[2];
    const start = await createSchedule(ben, MATH_AMOUNT, 3600n, 36000n);
    const cliffEnd = start + 3600;
    await setTime(cliffEnd);
    assert.equal(await vestedOf(ben.address), 0n, "linear phase starts at zero");
    await setTime(cliffEnd + 1);
    // (3,600 QVEST * 1s) / 36000s = 100,000 base units (exact division).
    assert.equal(await vestedOf(ben.address), (MATH_AMOUNT * 1n) / 36000n);
    assert.equal(
      await vestedOf(ben.address),
      expectedVested(MATH_AMOUNT, cliffEnd, 36000n, cliffEnd + 1),
    );
  });

  it("vests exactly half at mid-vest and total*(d-1)/d one second before the end", async () => {
    const ben = accounts[3];
    const start = await createSchedule(ben, MATH_AMOUNT, 3600n, 36000n);
    const cliffEnd = start + 3600;
    await setTime(cliffEnd + 18000);
    assert.equal(await vestedOf(ben.address), MATH_AMOUNT / 2n);
    await setTime(cliffEnd + 35999);
    assert.equal(await vestedOf(ben.address), (MATH_AMOUNT * 35999n) / 36000n);
    assert.equal(
      await vestedOf(ben.address),
      expectedVested(MATH_AMOUNT, cliffEnd, 36000n, cliffEnd + 35999),
    );
  });

  it("vests exactly the total at the end and stays capped afterwards", async () => {
    const ben = accounts[4];
    const start = await createSchedule(ben, MATH_AMOUNT, 3600n, 36000n);
    const cliffEnd = start + 3600;
    await setTime(cliffEnd + 36000);
    assert.equal(await vestedOf(ben.address), MATH_AMOUNT);
    await setTime(cliffEnd + 36000 + 100000);
    assert.equal(await vestedOf(ben.address), MATH_AMOUNT, "vesting is capped at the total");
    assert.equal(await claimableOf(ben.address), MATH_AMOUNT);
  });

  it("a zero-cliff schedule vests linearly from its start", async () => {
    const ben = accounts[5];
    // Future start so the exact start second can be observed.
    const start = await createSchedule(ben, 10_000n * 10n ** 6n, 0n, 1000n, (await latestTimestamp()) + 10000);
    await setTime(start);
    assert.equal(await vestedOf(ben.address), 0n);
    await setTime(start + 500);
    assert.equal(await vestedOf(ben.address), 5_000n * 10n ** 6n);
    await setTime(start + 1000);
    assert.equal(await vestedOf(ben.address), 10_000n * 10n ** 6n);
  });

  it("a schedule with a future start vests nothing until it starts", async () => {
    const ben = accounts[6];
    const start = await createSchedule(ben, MATH_AMOUNT, 3600n, 36000n, (await latestTimestamp()) + 50000);
    assert.equal(await vestedOf(ben.address), 0n, "nothing vests before the start");
    assert.equal(await claimableOf(ben.address), 0n);
    await setTime(start + 3600 + 18000);
    assert.equal(await vestedOf(ben.address), MATH_AMOUNT / 2n);
  });

  it("vested and claimable return 0 for an address with no schedule", async () => {
    const stranger = accounts[23];
    assert.equal(await vestedOf(stranger.address), 0n);
    assert.equal(await claimableOf(stranger.address), 0n);
    assert.deepEqual(await readSchedule(stranger.address), [0n, 0n, 0n, 0n, 0n, false]);
  });

  it("partial claim then remainder: claimed totals accumulate to exactly the total", async () => {
    const ben = accounts[7];
    const start = await createSchedule(ben, SCHEDULE_AMOUNT, 0n, 36000n);
    await setTime(start + 18000);
    // The claim mines one block past the read, so the first amount is the
    // half-vested value plus at most a few seconds of vesting.
    const slack = (SCHEDULE_AMOUNT * 60n) / 36000n; // 60s of vesting
    await claim(ben);
    const firstClaimed = (await readSchedule(ben.address))[1];
    assert.ok(firstClaimed >= SCHEDULE_AMOUNT / 2n - slack && firstClaimed <= SCHEDULE_AMOUNT / 2n + slack,
      `expected ~half, got ${firstClaimed}`);
    // After the end, the remainder is exact: total minus what was claimed.
    await setTime(start + 36000 + 100);
    await claim(ben);
    const s = await readSchedule(ben.address);
    assert.equal(s[1], SCHEDULE_AMOUNT, "fully claimed after the schedule ends");
    assert.equal(await claimableOf(ben.address), 0n);
  });

  it("totalLocked equals the sum of unclaimed schedule totals", async () => {
    const a = accounts[8];
    const b = accounts[9];
    const c = accounts[10];
    const lockedBefore = await totalLocked();
    const startA = await createSchedule(a, SCHEDULE_AMOUNT, 0n, 1000n);
    await createSchedule(b, 50_000n * 10n ** 6n, 0n, 36000n);
    await createSchedule(c, 25_000n * 10n ** 6n, 0n, 36000n);
    assert.equal(await totalLocked(), lockedBefore + 175_000n * 10n ** 6n);
    // A fully vested and claimed; B half-vested and claimed; C untouched.
    await setTime(startA + 1000 + 10);
    await claim(a);
    const bStart = Number((await readSchedule(b.address))[2]);
    await setTime(bStart + 18000);
    await claim(b);
    const claimedA = (await readSchedule(a.address))[1];
    const claimedB = (await readSchedule(b.address))[1];
    const claimedC = (await readSchedule(c.address))[1];
    assert.equal(claimedA, SCHEDULE_AMOUNT);
    assert.equal(claimedC, 0n);
    const expected = lockedBefore
      + (SCHEDULE_AMOUNT - claimedA)
      + (50_000n * 10n ** 6n - claimedB)
      + (25_000n * 10n ** 6n - claimedC);
    assert.equal(await totalLocked(), expected);
  });

  it("contract balance reconciles: balance + claimed == totalSupply", async () => {
    let claimedSum = 0n;
    for (const who of createdOrder) {
      claimedSum += (await readSchedule(who))[1];
    }
    const contractBalance = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [qoreVest],
    })) as bigint;
    const supply = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "totalSupply",
    })) as bigint;
    assert.equal(contractBalance + claimedSum, supply);
    assert.equal(supply, INITIAL_SUPPLY);
  });

  it("each beneficiary's QVEST balance equals their claimed amount", async () => {
    const ben = accounts[11];
    const start = await createSchedule(ben, 7_500n * 10n ** 6n, 0n, 100n);
    await setTime(start + 100 + 5);
    await claim(ben);
    const claimed = (await readSchedule(ben.address))[1];
    assert.equal(claimed, 7_500n * 10n ** 6n);
    assert.equal(
      (await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [ben.address] })) as bigint,
      claimed,
    );
  });

  it("double-claim prevention: a second claim after a full claim reverts", async () => {
    const ben = accounts[12];
    const start = await createSchedule(ben, MATH_AMOUNT, 0n, 100n);
    await setTime(start + 100 + 5);
    await claim(ben);
    const lockedBefore = await totalLocked();
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [bech32Of(ben.address)], account: ben, chain: localChain,
      }),
      "nothing claimable",
    );
    // The failed claim changed nothing.
    assert.equal((await readSchedule(ben.address))[1], MATH_AMOUNT);
    assert.equal(await totalLocked(), lockedBefore);
  });

  it("claiming one schedule leaves other beneficiaries' schedules untouched", async () => {
    const a = accounts[13];
    const b = accounts[14];
    const startA = await createSchedule(a, SCHEDULE_AMOUNT, 0n, 100n);
    const startB = await createSchedule(b, 50_000n * 10n ** 6n, 0n, 100n);
    await setTime(Math.max(startA, startB) + 100 + 5);
    const bBefore = await readSchedule(b.address);
    const bClaimableBefore = await claimableOf(b.address);
    await claim(a);
    assert.deepEqual(await readSchedule(b.address), bBefore);
    assert.equal(await claimableOf(b.address), bClaimableBefore);
  });

  it("totalLocked decreases by exactly the claimed amount on each claim", async () => {
    const ben = accounts[15];
    const start = await createSchedule(ben, SCHEDULE_AMOUNT, 0n, 36000n);
    await setTime(start + 18000);
    const lockedBefore = await totalLocked();
    await claim(ben);
    const claimed = (await readSchedule(ben.address))[1];
    assert.equal(await totalLocked(), lockedBefore - claimed);
    await setTime(start + 36000 + 5);
    const lockedBefore2 = await totalLocked();
    await claim(ben);
    const claimedTotal = (await readSchedule(ben.address))[1];
    assert.equal(await totalLocked(), lockedBefore2 - (claimedTotal - claimed));
  });

  it("Claimed event totalClaimed accumulates across claims", async () => {
    const ben = accounts[16];
    const start = await createSchedule(ben, SCHEDULE_AMOUNT, 0n, 36000n);
    await setTime(start + 18000);
    const receipt1 = await claim(ben);
    const claimed1 = (await readSchedule(ben.address))[1];
    await setTime(start + 36000 + 5);
    const receipt2 = await claim(ben);
    const decodeClaimed = (receipt: { logs: Array<{ data: Hex; topics: [Hex, ...Hex[]] }> }) =>
      receipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: qoreVestAbi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === "Claimed");
    const ev1 = decodeClaimed(receipt1)?.args as unknown as { amount: bigint; totalClaimed: bigint };
    const ev2 = decodeClaimed(receipt2)?.args as unknown as { amount: bigint; totalClaimed: bigint };
    assert.equal(ev1.totalClaimed, claimed1);
    assert.equal(ev1.amount, claimed1);
    assert.equal(ev2.totalClaimed, SCHEDULE_AMOUNT);
    assert.equal(ev2.amount, SCHEDULE_AMOUNT - claimed1);
  });

  it("a claim emits a Transfer from the contract for the exact amount", async () => {
    const ben = accounts[17];
    const start = await createSchedule(ben, 3_000n * 10n ** 6n, 0n, 100n);
    await setTime(start + 100 + 5);
    const receipt = await claim(ben);
    const transfers = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({ abi: qoreVestAbi, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .filter((e) => e?.eventName === "Transfer");
    assert.equal(transfers.length, 1);
    const t = transfers[0]?.args as unknown as { from: Address; to: Address; value: bigint };
    assert.equal(t.from.toLowerCase(), qoreVest.toLowerCase());
    assert.equal(t.to.toLowerCase(), ben.address.toLowerCase());
    assert.equal(t.value, 3_000n * 10n ** 6n);
  });

  it("VestingCreated event carries the schedule parameters", async () => {
    const ben = accounts[18];
    const start = await latestTimestamp();
    const hash = await clients.wallet.writeContract({
      address: qoreVest,
      abi: qoreVestAbi,
      functionName: "createVesting",
      args: [ben.address, 42_000n * 10n ** 6n, BigInt(start), 7200n, 86400n],
      account: owner,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    createdOrder.push(ben.address);
    const events = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({ abi: qoreVestAbi, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .filter((e) => e?.eventName === "VestingCreated");
    assert.equal(events.length, 1);
    const e = events[0]?.args as unknown as {
      beneficiary: Address; total: bigint; start: bigint; cliff: bigint; duration: bigint;
    };
    assert.equal(e.beneficiary.toLowerCase(), ben.address.toLowerCase());
    assert.equal(e.total, 42_000n * 10n ** 6n);
    assert.equal(e.start, BigInt(start));
    assert.equal(e.cliff, 7200n);
    assert.equal(e.duration, 86400n);
  });

  it("rejects a bech32 address with a character outside the charset", async () => {
    const ben = accounts[19];
    const start = await createSchedule(ben, MATH_AMOUNT, 0n, 100n);
    await setTime(start + 100 + 5);
    assert.ok((await claimableOf(ben.address)) > 0n);
    // 'b' is not in the bech32 charset (qpzry9x8gf2tvdw0s3jn54khce6mua7l).
    const bad = bech32Of(ben.address).slice(0, 10) + "b" + bech32Of(ben.address).slice(11);
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [bad], account: ben, chain: localChain,
      }),
      "bad bech32 char",
    );
  });

  it("rejects bech32 addresses one character too short or too long", async () => {
    const ben = accounts[20];
    const start = await createSchedule(ben, MATH_AMOUNT, 0n, 100n);
    await setTime(start + 100 + 5);
    const good = bech32Of(ben.address);
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [good.slice(0, -1)], account: ben, chain: localChain,
      }),
      "bad bech32 length",
    );
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [`${good}q`], account: ben, chain: localChain,
      }),
      "bad bech32 length",
    );
  });

  it("rejects an uppercase bech32 address", async () => {
    const ben = accounts[21];
    const start = await createSchedule(ben, MATH_AMOUNT, 0n, 100n);
    await setTime(start + 100 + 5);
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [bech32Of(ben.address).toUpperCase()], account: ben, chain: localChain,
      }),
      "bad bech32 prefix",
    );
  });

  it("rejects a corrupted data character (checksum failure mid-string)", async () => {
    const ben = accounts[22];
    const start = await createSchedule(ben, MATH_AMOUNT, 0n, 100n);
    await setTime(start + 100 + 5);
    const good = bech32Of(ben.address);
    // Flip a data character (position 10, well inside the payload) to a
    // different valid charset character: length and prefix stay valid, so
    // only the checksum can catch it.
    const ch = good[10];
    const replacement = ch === "q" ? "p" : "q";
    const corrupted = good.slice(0, 10) + replacement + good.slice(11);
    assert.equal(corrupted.length, 42);
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [corrupted], account: ben, chain: localChain,
      }),
      "bad bech32 checksum",
    );
  });

  it("accepts SDK-derived bech32 addresses for several accounts", async () => {
    // Two accounts beyond the shared pool, each with its own schedule.
    const first = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 100 });
    const second = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 101 });
    for (const ben of [first, second]) {
      const start = await createSchedule(ben, 1_000n * 10n ** 6n, 0n, 100n);
      await setTime(start + 100 + 5);
      await claim(ben);
      assert.equal((await readSchedule(ben.address))[1], 1_000n * 10n ** 6n);
    }
  });

  it("cross-VM payload amount is the exact claimed amount in base units", async () => {
    const ben = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 102 });
    // An odd amount (1.234567 QVEST) exercises the uint-to-string conversion.
    const start = await createSchedule(ben, 1_234_567n, 0n, 100n);
    await setTime(start + 100 + 5);
    await claim(ben);
    assert.equal((await readSchedule(ben.address))[1], 1_234_567n);
    const payloadHex = (await clients.public.readContract({
      address: mock, abi: mockCrossVmAbi, functionName: "lastPayload",
    })) as Hex;
    const payload = JSON.parse(Buffer.from(payloadHex.slice(2), "hex").toString("utf8")) as {
      increase_allowance: { spender: string; amount: string };
    };
    assert.equal(payload.increase_allowance.amount, "1234567");
    assert.equal(payload.increase_allowance.spender, bech32Of(ben.address));
  });

  describe("ERC-20 subset", () => {
    let holder: Account;
    let spender: Account;
    let recipient: Account;

    before(async () => {
      holder = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 103 });
      spender = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 104 });
      recipient = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 105 });
      const start = await createSchedule(holder, SCHEDULE_AMOUNT, 0n, 100n);
      await setTime(start + 100 + 5);
      await claim(holder);
      assert.equal(
        (await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [holder.address] })) as bigint,
        SCHEDULE_AMOUNT,
      );
    });

    async function allowanceOf(ownerAddr: Address, spenderAddr: Address): Promise<bigint> {
      return (await clients.public.readContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "allowance",
        args: [ownerAddr, spenderAddr],
      })) as bigint;
    }

    it("approve + transferFrom move claimed QVEST and decrease the allowance exactly", async () => {
      const approveHash = await clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "approve",
        args: [spender.address, 10_000n * 10n ** 6n], account: holder, chain: localChain,
      });
      await clients.public.waitForTransactionReceipt({ hash: approveHash });
      assert.equal(await allowanceOf(holder.address, spender.address), 10_000n * 10n ** 6n);
      const hash = await clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "transferFrom",
        args: [holder.address, recipient.address, 6_000n * 10n ** 6n], account: spender, chain: localChain,
      });
      const receipt = await clients.public.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.equal(
        (await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [recipient.address] })) as bigint,
        6_000n * 10n ** 6n,
      );
      assert.equal(
        (await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [holder.address] })) as bigint,
        SCHEDULE_AMOUNT - 6_000n * 10n ** 6n,
      );
      assert.equal(await allowanceOf(holder.address, spender.address), 4_000n * 10n ** 6n);
    });

    it("transferFrom beyond the allowance reverts", async () => {
      const other = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 106 });
      const approveHash = await clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "approve",
        args: [other.address, 100n], account: holder, chain: localChain,
      });
      await clients.public.waitForTransactionReceipt({ hash: approveHash });
      await expectRevert(
        clients.wallet.writeContract({
          address: qoreVest, abi: qoreVestAbi, functionName: "transferFrom",
          args: [holder.address, recipient.address, 101n], account: other, chain: localChain,
        }),
        "allowance exceeded",
      );
    });

    it("transferFrom with a max allowance does not decrease it", async () => {
      const maxSpender = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 107 });
      const approveHash = await clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "approve",
        args: [maxSpender.address, 2n ** 256n - 1n], account: holder, chain: localChain,
      });
      await clients.public.waitForTransactionReceipt({ hash: approveHash });
      const hash = await clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "transferFrom",
        args: [holder.address, recipient.address, 500n], account: maxSpender, chain: localChain,
      });
      const receipt = await clients.public.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert.equal(await allowanceOf(holder.address, maxSpender.address), 2n ** 256n - 1n);
    });

    it("transfer to the zero address reverts", async () => {
      await expectRevert(
        clients.wallet.writeContract({
          address: qoreVest, abi: qoreVestAbi, functionName: "transfer",
          args: ["0x0000000000000000000000000000000000000000", 1n], account: holder, chain: localChain,
        }),
        "zero recipient",
      );
    });
  });

  it("createVesting rejects a zero beneficiary", async () => {
    const now = await latestTimestamp();
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "createVesting",
        args: ["0x0000000000000000000000000000000000000000", 1n, BigInt(now), 0n, 100n],
        account: owner, chain: localChain,
      }),
      "zero beneficiary",
    );
  });

  it("createVesting accepts exactly the remaining supply, then rejects any more", async () => {
    // A separate deployment: locking the whole supply here must not affect
    // the main contract's other tests.
    const hash = await clients.wallet.deployContract({
      abi: qoreVestAbi,
      bytecode: qoreVestBytecode as Hex,
      args: [mock, WDT, INITIAL_SUPPLY],
      account: owner,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    const fresh = receipt.contractAddress as Address;
    const ben = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 108 });
    const other = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 109 });
    const now = await latestTimestamp();
    const createHash = await clients.wallet.writeContract({
      address: fresh, abi: qoreVestAbi, functionName: "createVesting",
      args: [ben.address, INITIAL_SUPPLY, BigInt(now), 0n, 100n], account: owner, chain: localChain,
    });
    const createReceipt = await clients.public.waitForTransactionReceipt({ hash: createHash });
    assert.equal(createReceipt.status, "success");
    assert.equal(
      (await clients.public.readContract({ address: fresh, abi: qoreVestAbi, functionName: "totalLocked" })) as bigint,
      INITIAL_SUPPLY,
    );
    await expectRevert(
      clients.wallet.writeContract({
        address: fresh, abi: qoreVestAbi, functionName: "createVesting",
        args: [other.address, 1n, BigInt(now), 0n, 100n], account: owner, chain: localChain,
      }),
      "exceeds unallocated supply",
    );
  });

  it("beneficiaries array lists every schedule in creation order", async () => {
    assert.ok(createdOrder.length > 0, "no schedules were created");
    for (let i = 0; i < createdOrder.length; i++) {
      const onChain = (await clients.public.readContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "beneficiaries", args: [BigInt(i)],
      })) as string;
      assert.equal(onChain.toLowerCase(), createdOrder[i].toLowerCase(), `beneficiaries[${i}] mismatch`);
    }
    // One past the end reverts (out of bounds), so enumeration terminates.
    await assert.rejects(
      clients.public.readContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "beneficiaries",
        args: [BigInt(createdOrder.length)],
      }),
    );
  });
});
