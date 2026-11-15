/**
 * qore-vest.test.ts - end-to-end tests for the QoreVest contract on a local
 * in-memory Ganache chain (plain EVM, no PQC window: the window is a
 * QoreChain admission rule, not contract logic).
 *
 * The cross-VM precompile is replaced by MockCrossVm, which mimics the
 * chain v3.2.5+ reply format (abi.encode(bytes)) and records every call, so
 * the tests assert the exact target, target VM, and JSON payload of each
 * Native call — including the atomicity case (a failing Native call must
 * revert the whole claim).
 *
 * The accounts are Ganache's built-in deterministic test accounts. They are
 * public test keys that exist only on this throwaway local chain; they are
 * NEVER funded anywhere and must never be used on testnet or mainnet.
 *
 * Bech32 reference: the beneficiaries' `qor1...` addresses are derived with
 * the chain SDK's own addressesFrom20, so the tests check the contract's
 * on-chain bech32 decoder against the reference implementation. A real
 * testnet pair (the qore-vest deployer) is used as a negative vector: its
 * bech32 must be REJECTED for any other caller.
 *
 * Each vesting test uses its own beneficiary and a freshly created schedule:
 * Ganache time only moves forward, so tests must never depend on another
 * test's clock position. Linear-vesting assertions allow a small tolerance
 * for the seconds of real time a test run takes.
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

/** Real qore-vest deployer pair (negative bech32 vector only — never signed as). */
const REAL_DEPLOYER_EVM = "0x1F6A09E6aC96a2Ae802828B19d31B0284b841B9d";
const REAL_DEPLOYER_BECH32 = "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny";

/** 1,000,000 QVEST at 6 decimals. */
const INITIAL_SUPPLY = 1_000_000n * 10n ** 6n;
/** 100,000 QVEST at 6 decimals (the standard test schedule size). */
const SCHEDULE_AMOUNT = 100_000n * 10n ** 6n;

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

function createClients(provider: ReturnType<typeof Ganache.provider>) {
  const transport = custom(provider as never);
  return {
    public: createPublicClient({ chain: localChain, transport }),
    wallet: createWalletClient({ chain: localChain, transport }),
  };
}

describe("QoreVest artifact", () => {
  it("exposes the expected ABI entries and non-empty bytecode", () => {
    const names = new Set(
      qoreVestAbi
        .filter((e): e is { type: string; name: string } => "name" in e)
        .map((e) => e.name),
    );
    for (const name of [
      "claim", "createVesting", "vested", "claimable", "transfer", "approve", "transferFrom",
      "balanceOf", "allowance", "totalSupply", "name", "symbol", "decimals", "schedules",
      "beneficiaries", "totalLocked", "owner", "crossVmPrecompile", "nativeTarget",
      "VestingCreated", "Claimed", "CrossVmMirrored", "Transfer", "Approval",
    ]) {
      assert.ok(names.has(name), `ABI is missing ${name}`);
    }
    assert.ok(qoreVestBytecode.startsWith("0x"));
    assert.ok(qoreVestBytecode.length > 100, "bytecode looks too short");
  });
});

describe("QoreVest contract", () => {
  let clients: Clients;
  let provider: ReturnType<typeof Ganache.provider>;
  let qoreVest: Address;
  let mock: Address;
  let owner: Account;
  const accounts: Account[] = [];

  async function increaseTime(seconds: number): Promise<void> {
    await provider.request({ method: "evm_increaseTime", params: [seconds] });
    await provider.request({ method: "evm_mine", params: [] });
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

  /** Create a schedule for an account; returns its start timestamp. */
  async function createSchedule(
    beneficiary: Account,
    amount: bigint,
    cliff: bigint,
    duration: bigint,
  ): Promise<number> {
    const start = await latestTimestamp();
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
    return start;
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

  before(async () => {
    provider = Ganache.provider({
      wallet: { mnemonic: TEST_MNEMONIC },
      logging: { quiet: true },
    });
    clients = createClients(provider);
    for (let i = 0; i < 8; i++) accounts.push(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i }));
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

  it("starts with the full supply locked in the contract", async () => {
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "totalSupply" }), INITIAL_SUPPLY);
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "name" }), "QoreVest");
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "symbol" }), "QVEST");
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "decimals" }), 6);
    assert.equal(
      await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [qoreVest] }),
      INITIAL_SUPPLY,
    );
    assert.equal(
      (await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "owner" }) as string).toLowerCase(),
      owner.address.toLowerCase(),
    );
    assert.equal(
      (await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "crossVmPrecompile" }) as string).toLowerCase(),
      mock.toLowerCase(),
    );
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "nativeTarget" }), WDT);
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "totalLocked" }), 0n);
  });

  it("creates vesting schedules (owner only) and guards the inputs", async () => {
    const alice = accounts[1];
    const bob = accounts[2];
    const start = await createSchedule(alice, SCHEDULE_AMOUNT, 3600n, 36000n);
    const s = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "schedules", args: [alice.address],
    })) as [bigint, bigint, bigint, bigint, bigint, boolean];
    assert.deepEqual(s, [SCHEDULE_AMOUNT, 0n, BigInt(start), 3600n, 36000n, true]);
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "totalLocked" }), SCHEDULE_AMOUNT);

    const now = await latestTimestamp();
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "createVesting",
        args: [bob.address, 1n, BigInt(now), 0n, 100n], account: alice, chain: localChain,
      }),
      "not the owner",
    );
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "createVesting",
        args: [alice.address, 1n, BigInt(now), 0n, 100n], account: owner, chain: localChain,
      }),
      "schedule exists",
    );
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "createVesting",
        args: [bob.address, 0n, BigInt(now), 0n, 100n], account: owner, chain: localChain,
      }),
      "zero amount",
    );
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "createVesting",
        args: [bob.address, 1n, BigInt(now), 0n, 0n], account: owner, chain: localChain,
      }),
      "zero duration",
    );
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "createVesting",
        args: [bob.address, INITIAL_SUPPLY, BigInt(now), 0n, 100n], account: owner, chain: localChain,
      }),
      "exceeds unallocated supply",
    );
  });

  it("vests nothing before the cliff and linearly after it", async () => {
    const bob = accounts[2];
    // Fresh schedule: cliff 3600, duration 36000. Margins are wide (1800s+)
    // so the seconds of real time a test run takes cannot cross a boundary.
    await createSchedule(bob, SCHEDULE_AMOUNT, 3600n, 36000n);
    assert.equal(await vestedOf(bob.address), 0n);
    assert.equal(await claimableOf(bob.address), 0n);

    await increaseTime(1800); // halfway through the cliff
    assert.equal(await vestedOf(bob.address), 0n);

    await increaseTime(3600); // 1800s into the linear phase: ~5% vested
    const slack = (SCHEDULE_AMOUNT * 30n) / 36000n + 1n; // 30s of drift
    const expected5 = (SCHEDULE_AMOUNT * 1800n) / 36000n;
    const v5 = await vestedOf(bob.address);
    assert.ok(v5 >= expected5 - slack && v5 <= expected5 + slack, `expected ~${expected5}, got ${v5}`);

    await increaseTime(16200); // 18000s into the linear phase: ~50% vested
    const expected50 = SCHEDULE_AMOUNT / 2n;
    const v50 = await vestedOf(bob.address);
    assert.ok(v50 >= expected50 - slack && v50 <= expected50 + slack, `expected ~${expected50}, got ${v50}`);

    await increaseTime(20000); // past the end: fully vested
    assert.equal(await vestedOf(bob.address), SCHEDULE_AMOUNT);
  });

  it("claims vested QVEST and mirrors the claim to the Native side", async () => {
    const carol = accounts[3];
    const carolBech32 = bech32Of(carol.address);
    await createSchedule(carol, SCHEDULE_AMOUNT, 0n, 36000n);
    await increaseTime(18000); // half vested
    const claimableBefore = await claimableOf(carol.address);
    assert.ok(claimableBefore > 0n, "carol must have something claimable at half duration");
    const callsBefore = (await clients.public.readContract({ address: mock, abi: mockCrossVmAbi, functionName: "callCount" })) as bigint;

    const hash = await clients.wallet.writeContract({
      address: qoreVest,
      abi: qoreVestAbi,
      functionName: "claim",
      args: [carolBech32],
      account: carol,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");

    // The claimed amount is read back from the schedule: it can be slightly
    // larger than the pre-claim read because a few seconds pass between the
    // read and the mined claim transaction.
    const s = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "schedules", args: [carol.address],
    })) as [bigint, bigint, bigint, bigint, bigint, boolean];
    const claimedAmount = s[1];
    assert.ok(claimedAmount >= claimableBefore, "claimed amount cannot be less than the pre-read");
    assert.ok(claimedAmount > 0n, "something must have been claimed");

    // QVEST moved to carol.
    assert.equal(
      await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [carol.address] }),
      claimedAmount,
    );

    // The mock precompile saw exactly one call, to the WDT target, target VM 1,
    // with the increase_allowance JSON for carol's Native address and amount.
    assert.equal(
      (await clients.public.readContract({ address: mock, abi: mockCrossVmAbi, functionName: "callCount" })) as bigint,
      callsBefore + 1n,
    );
    assert.equal(await clients.public.readContract({ address: mock, abi: mockCrossVmAbi, functionName: "lastTargetVm" }), 1);
    assert.equal(await clients.public.readContract({ address: mock, abi: mockCrossVmAbi, functionName: "lastTarget" }), WDT);
    const payloadHex = (await clients.public.readContract({ address: mock, abi: mockCrossVmAbi, functionName: "lastPayload" })) as Hex;
    const payload = JSON.parse(Buffer.from(payloadHex.slice(2), "hex").toString("utf8")) as {
      increase_allowance: { spender: string; amount: string };
    };
    assert.equal(payload.increase_allowance.spender, carolBech32);
    assert.equal(payload.increase_allowance.amount, claimedAmount.toString());

    // Events: Claimed + CrossVmMirrored, exactly one each.
    const events = receipt.logs.map((log) => {
      try {
        return decodeEventLog({ abi: qoreVestAbi, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    }).filter((e): e is NonNullable<typeof e> => e !== null);
    assert.equal(events.filter((e) => e.eventName === "Claimed").length, 1);
    assert.equal(events.filter((e) => e.eventName === "CrossVmMirrored").length, 1);
    const claimed = events.find((e) => e.eventName === "Claimed")?.args as unknown as {
      beneficiary: Address; amount: bigint; totalClaimed: bigint; nativeSpender: string;
    };
    assert.equal(claimed.amount, claimedAmount);
    assert.equal(claimed.totalClaimed, claimedAmount);
    assert.equal(claimed.nativeSpender, carolBech32);
  });

  it("rejects claims with a mismatched, corrupted, or empty Native address", async () => {
    const dave = accounts[4];
    const eve = accounts[5];
    const daveBech32 = bech32Of(dave.address);
    await createSchedule(dave, SCHEDULE_AMOUNT, 0n, 36000n);
    await increaseTime(3600); // vest a bit so a claim would otherwise succeed
    assert.ok((await claimableOf(dave.address)) > 0n);

    // Eve's bech32 for dave's claim: valid bech32, wrong owner.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [bech32Of(eve.address)], account: dave, chain: localChain,
      }),
      "native address mismatch",
    );
    // The real deployer's bech32 for dave's claim: valid, wrong owner.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [REAL_DEPLOYER_BECH32], account: dave, chain: localChain,
      }),
      "native address mismatch",
    );
    // Corrupted checksum: flip the last character of dave's address.
    const last = daveBech32.slice(-1);
    const corrupted = daveBech32.slice(0, -1) + (last === "q" ? "p" : "q");
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [corrupted], account: dave, chain: localChain,
      }),
      "bad bech32 checksum",
    );
    // Wrong prefix.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [`cosmos1${daveBech32.slice(4)}`], account: dave, chain: localChain,
      }),
      "bad bech32",
    );
    // Empty.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [""], account: dave, chain: localChain,
      }),
      "bad bech32 length",
    );
    // And the correct address still works afterwards.
    const hash = await clients.wallet.writeContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "claim",
      args: [daveBech32], account: dave, chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
  });

  it("reverts atomically when the Native call fails: no QVEST moves", async () => {
    const eve = accounts[5];
    const eveBech32 = bech32Of(eve.address);
    await createSchedule(eve, SCHEDULE_AMOUNT, 0n, 36000n);
    await increaseTime(3600);
    const lockedBefore = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "totalLocked",
    })) as bigint;

    // Arm the mock to fail the next Native call. The claimable snapshot is
    // taken AFTER arming: the arm transaction mines a block, and a second of
    // vesting accrues with it.
    const armHash = await clients.wallet.writeContract({
      address: mock, abi: mockCrossVmAbi, functionName: "setFailNext", args: [true],
      account: owner, chain: localChain,
    });
    await clients.public.waitForTransactionReceipt({ hash: armHash });
    const claimableBefore = await claimableOf(eve.address);
    assert.ok(claimableBefore > 0n, "eve must have something claimable for this test");
    const balanceBefore = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [eve.address],
    })) as bigint;
    const scheduleBefore = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "schedules", args: [eve.address],
    })) as [bigint, bigint, bigint, bigint, bigint, boolean];

    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [eveBech32], account: eve, chain: localChain,
      }),
      "cross-VM call failed",
    );

    // Nothing changed: the revert undid the EVM leg too.
    assert.equal(
      await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [eve.address] }),
      balanceBefore,
    );
    const scheduleAfter = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "schedules", args: [eve.address],
    })) as [bigint, bigint, bigint, bigint, bigint, boolean];
    assert.deepEqual(scheduleAfter, scheduleBefore);
    assert.equal(await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "totalLocked" }), lockedBefore);
    assert.equal(await claimableOf(eve.address), claimableBefore);

    // Disarm the mock (its fail flag survives the revert by design) and prove
    // the same claim now succeeds.
    const disarmHash = await clients.wallet.writeContract({
      address: mock, abi: mockCrossVmAbi, functionName: "setFailNext", args: [false],
      account: owner, chain: localChain,
    });
    await clients.public.waitForTransactionReceipt({ hash: disarmHash });
    const hash = await clients.wallet.writeContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "claim",
      args: [eveBech32], account: eve, chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
  });

  it("claims the remainder after full vesting and rejects empty claims", async () => {
    const frank = accounts[6];
    const grace = accounts[7];
    const frankBech32 = bech32Of(frank.address);
    await createSchedule(frank, SCHEDULE_AMOUNT, 0n, 1000n);
    await increaseTime(2000); // past the end
    const claimableBefore = await claimableOf(frank.address);
    assert.equal(claimableBefore, SCHEDULE_AMOUNT, "fully vested after the schedule ends");
    const hash = await clients.wallet.writeContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "claim",
      args: [frankBech32], account: frank, chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const s = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "schedules", args: [frank.address],
    })) as [bigint, bigint, bigint, bigint, bigint, boolean];
    assert.equal(s[1], s[0], "fully claimed after the schedule ends");
    assert.equal(await claimableOf(frank.address), 0n);

    // Nothing left to claim.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [frankBech32], account: frank, chain: localChain,
      }),
      "nothing claimable",
    );
    // Grace has no schedule at all.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "claim",
        args: [bech32Of(grace.address)], account: grace, chain: localChain,
      }),
      "no schedule",
    );
  });

  it("supports plain ERC-20 transfers of claimed QVEST", async () => {
    const frank = accounts[6];
    const grace = accounts[7];
    const frankBalance = (await clients.public.readContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [frank.address],
    })) as bigint;
    assert.equal(frankBalance, SCHEDULE_AMOUNT, "frank claimed his full schedule");
    const amount = 1000n * 10n ** 6n; // 1,000 QVEST
    const hash = await clients.wallet.writeContract({
      address: qoreVest, abi: qoreVestAbi, functionName: "transfer",
      args: [grace.address, amount], account: frank, chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal(
      await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [grace.address] }),
      amount,
    );
    assert.equal(
      await clients.public.readContract({ address: qoreVest, abi: qoreVestAbi, functionName: "balanceOf", args: [frank.address] }),
      frankBalance - amount,
    );
    // Transfer more than the balance reverts.
    await expectRevert(
      clients.wallet.writeContract({
        address: qoreVest, abi: qoreVestAbi, functionName: "transfer",
        args: [grace.address, frankBalance], account: frank, chain: localChain,
      }),
      "insufficient balance",
    );
  });
});
