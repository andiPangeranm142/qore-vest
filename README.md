# QoreVest

An EVM token with Native vesting on the **QoreChain testnet**
(`qorechain-diana`, EVM chain id 9800). Built for the QoreChain Developer
Fest **"Build Before Q-Day"** (Cross-VM category).

QVEST is issued on the EVM side and locked in the QoreVest contract. The
owner creates a vesting schedule per beneficiary (cliff + linear release).
When a beneficiary claims, **one atomic transaction** releases the vested
QVEST on the EVM side *and* calls the cross-VM bridge precompile
(`0x…0901`) to increase the beneficiary's allowance on the allowlisted
Native cw20 contract by exactly the claimed amount. The Native contract
therefore holds a cross-VM vesting ledger with the verifiable invariant:

```
allowance(QoreVest, beneficiary) == total claimed
```

The claim also verifies on chain that the Native address the caller
passes is the bech32 encoding of their own EVM address — nobody can
mirror a claim to someone else's Native account. If the Native leg fails,
the whole claim reverts and no QVEST moves.

> **Design note — read this.** The category's example is "EVM token with
> Native vesting", and the brief asked for the schedule to be enforced by
> an approved Native contract. That literal design is **not implementable
> on the live allowlist**: no vesting contract is allowlisted (the three
> targets are one cw20 whose supply is held entirely by an unreachable
> creator, and two score-based tournament contracts — see `research/`).
> Rather than fake a cross-VM call, QoreVest enforces the schedule on the
> EVM side and uses the Native leg as a ledger/attestation. The category
> requirement — a working EVM-to-Native call to an approved Native
> contract, with atomic execution shown on testnet — is literally
> satisfied, and the limitation is stated honestly here, in the app, and
> in the submission. The WDT vault on this testnet is unfunded, so the
> Native allowance is a verifiable record, not a spendable release.

## Live deployment (testnet)

| | |
| --- | --- |
| Network | QoreChain testnet `qorechain-diana` (EVM chain id 9800) |
| Deployer (EVM) | `0x1F6A09E6aC96a2Ae802828B19d31B0284b841B9d` |
| Deployer (Cosmos) | `qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny` |
| Contract | [`0x67e4862c388a5ead666f5ac340fe9ef2fc1f8f68`](https://explore.qore.network/address/0x67e4862c388a5ead666f5ac340fe9ef2fc1f8f68) |
| Contract (Native) | `qor1vljgvtpc3f026en0ttp5pl577t7plrmgce7vdj` (mapped address; the allowance owner) |
| Deploy tx | [`0x498b82315b55a26dbb4b76bd1b5b9ca4de817330dd6b1dbe433b337e516536d3`](https://explore.qore.network/tx/71E9E424AB355A006FC2D3DC0E8C584610C85700A45FFFC7288495B4E4AFE184) |
| Cross-VM precompile | `0x0000000000000000000000000000000000000901` |
| Native target (allowlisted cw20) | `qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt` (WDT) |
| PQC key registration | `19454BD27AF3888DE81F61B51B57DA12EC14F6A805DC6E3D1BBFFA3EBAD787D1` (native tx) |
| EVM window opened | `DF01598868ABA88ABCE853D26E4DC8B14F751D094CE4DF336222879C4CC5E743` (hybrid-signed native tx; 1200 blocks, 10 txs) |
| Second beneficiary (EVM) | `0xD2C678D480690c48e9C909340685AD856f7ddDaE` |
| Second beneficiary (Cosmos) | `qor16tr834yqdyxy36wfpy6qdpdds4hhmhdwqu2f3v` |
| Video beneficiary (EVM) | `0x76Ec0922C08140E4DA043819DC79799102DD20Db` |
| Video beneficiary (Cosmos) | `qor1wmkqjgkqs9qwfksy8qvac7tejypd6gxmtt5dm3` |
| Drill beneficiary (EVM) | `0xd40fcee41591b61a7a72ec4ecb9003aee35c8e26` |
| Drill beneficiary (Cosmos) | `qor16s8uaeq4jxmp57nja38vhyqr4m34er3x7ft3xf` |
| Live-demo beneficiary (EVM) | `0x0A9F2F8fAc9E286D140f9C115D8C4DD28904507b` |
| Live-demo beneficiary (Cosmos) | `qor1p20jlravnc5x69q0nsg4mrzd62ysg5rms7yflt` |
| Explorer | https://explore.qore.network (switch to Testnet) |

> Explorer transaction links use the Cosmos hash of each EVM transaction:
> the explorer's `/tx/` route only resolves Cosmos hashes.

> **Deployed 16 Nov 2026** (02:52 WIB). Full details in
> [`deployments/testnet.json`](deployments/testnet.json).
>
> **Live demo:** https://andipangeranm142.github.io/qore-vest/ — connect
> QoreX (or any injected wallet) on the QoreChain testnet, open an EVM window
> from QoreX, and claim from your schedule. The window-status panel cannot
> read the native-lane REST API from a static host (it sends no CORS
> headers), so it says so and claims still work when a window is open.

## On-chain evidence (usage run, 16 Nov 2026)

`scripts/usage.ts` exercised the full flow on the Diana testnet: two
schedules, four claims, one forced revert. After every claim it read the
Native allowance back from the cw20 contract and verified the invariant.
Full evidence (both hashes for every transaction) is in
[`deployments/usage.json`](deployments/usage.json); the demo page shows
the same evidence with explorer links.

| Step | Result |
| --- | --- |
| createVesting (deployer, 100,000 QVEST, cliff 60s, 600s) | [`0x13e4126b…`](https://explore.qore.network/tx/4A364375CE13E08A3651C46238FBF0BF0EF80039E4DF20ADE6ACDFEABDAE769F) |
| createVesting (second, 50,000 QVEST, no cliff, 300s) | [`0x1078fdff…`](https://explore.qore.network/tx/691EE1CB06EB953031E33D7F4BA37D776E8508B7C3678984E21E66E189D805CB) |
| claim (deployer, first) — 4,333.33 QVEST | [`0xcc635b9e…`](https://explore.qore.network/tx/AE295D060AC54A19D141150DC00BC4E24DEBC156795B079A7E35343CC1FA43F1) — allowance == claimed ✓ |
| claim (second, first) — 15,000 QVEST | [`0xa117b2a5…`](https://explore.qore.network/tx/84581A1F0ED7A7BD185F62AC9A861BDB84BF5BA51F0E6B1E94931FEF83C3BD3C) — allowance == claimed ✓ |
| claim (deployer, wrong Native address) — forced revert | [`0xae63c349…`](https://explore.qore.network/tx/9A3402F8000FCE13FCE344F8F46DD682FE818CC59ABC9B9AF86C64B2FB03CA72) — reverted, no state changed ✓ |
| claim (deployer, remainder) — 95,666.67 QVEST | [`0xda739584…`](https://explore.qore.network/tx/49FB10BDEA7007A68216B26FA47D5D9A2143610B8D2FBA90ED47EC81A4109989) — allowance == 100,000 QVEST total ✓ |
| claim (second, remainder) — 35,000 QVEST | [`0x9e015196…`](https://explore.qore.network/tx/AB8E8AF5BC902B4A55069E2E318B4EC89BBFCCC70FFA75C4B8D0D44579728F20) — allowance == 50,000 QVEST total ✓ |
| createVesting (video account, 25,000 QVEST, no cliff, 300s) | [`0xe78305bc…`](https://explore.qore.network/tx/1040FDE84F43C2E42746DF20614FD111EBC2622DA92D5558DE8CAE33BA734649) |
| claim (video account, on camera) — 25,000 QVEST | [`0x95d0dcbe…`](https://explore.qore.network/tx/387A7DF2673D9ECE685A18D78505D4542C4CF1DDA957A586D092F3ED75A8661E) — allowance == 25,000 QVEST total ✓ |
| createVesting (live-demo account, 50,000 QVEST, cliff 7d, 30d) | [`0x9532d8ad…`](https://explore.qore.network/tx/A3B90F2BFA1D723868214C6272B9F1F02D3CBF74AE830AEB28BF85E1CCF3B76E) — cliff ended 23 Nov 2026 04:31 WIB; claimed 9,751.523919 QVEST on 28 Nov 2026 |
| claim (live-demo account, pre-cliff) — rejected on chain | [`0xb066c478…`](https://explore.qore.network/tx/E6EDD1EE040FB1510D2902FAA4D76D7769672E047CEB5A76A2825705B2EF9353) — reverted ("nothing claimable"), no state changed ✓ |
| createVesting (drill account, 10,000 QVEST, no cliff, 7d) | [`0x0a0d0c76…`](https://explore.qore.network/tx/16FF820CD3DF1DB4F4ABBE881573A56B0D5A5EF83FB631085F6985567A3722C3) — Q-Day Drill schedule, claimed once on drill day |

Final state: all three schedules fully claimed; Native allowance equals
total claimed for each beneficiary (100,000, 50,000, and 25,000 WDT
units). The video claim is the one shown in
[`docs/demo.mp4`](docs/demo.mp4) (1:47, real screen recording).

A fourth schedule (50,000 QVEST, 7-day cliff, 30-day duration, created
16 Nov 2026 via `scripts/live-schedule.ts`) is past its cliff since
23 Nov 2026 04:31 WIB and now vests linearly, claimed still 0, so the
demo keeps showing live vesting funds through judging. On 19 Nov 2026
— four days before the cliff ended (23 Nov 2026, 04:31 WIB) — the
beneficiary attempted a claim; it reverted on chain with `nothing
claimable` (receipt status `reverted`, block 10335895, EVM tx
[`0xb066c478…`](https://explore.qore.network/tx/E6EDD1EE040FB1510D2902FAA4D76D7769672E047CEB5A76A2825705B2EF9353)),
and the post-receipt check confirmed claimed stayed 0 and `totalLocked`
unchanged: the cliff is enforced by the contract, not by the UI. Full
record in [`deployments/precliff-rejection.json`](deployments/precliff-rejection.json);
reproducible via `scripts/precliff-setup.ts` + `scripts/precliff-claim.ts`
(the beneficiary is mnemonic index 2 — the same mnemonic as the
deployer, so no new secret is involved).

A fifth schedule (10,000 QVEST, no cliff, 7-day duration, created
16 Nov 2026 via `scripts/drill-schedule.ts`) belongs to the Q-Day Drill
beneficiary (`qor16s8uaeq4jxmp57nja38vhyqr4m34er3x7ft3xf`); it was claimed
once on drill day (18 Nov 2026) as the drill proof transaction, via
`scripts/drill-claim.ts` — 3,046.197089 QVEST claimed. The contract
subtracts claims from `totalLocked`, so it now reads **47,202.278992
QVEST** (60,000 − 3,046.197089 − 9,751.523919); the live-demo schedule
was claimed once post-cliff on 28 Nov 2026 (9,751.523919 QVEST) and
keeps vesting the remainder.

## Live state (verified 28 Nov 2026)

Read from the Diana testnet at block 10598414 (23 Nov 2026 13:12 WIB).
Reproduce it any time, read-only and without keys, with
`npm run verify-live`, which compares the live chain against
[`deployments/schedules.json`](deployments/schedules.json) and prints
PASS/FAIL per check (56 checks: contract identity, every schedule field,
both reconciliations, per-beneficiary balances, cliff status, the Native
allowance invariant, and the pre-cliff rejection receipt).

| # | Schedule | Total (QVEST) | Claimed (QVEST) | Cliff | Duration | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | deployer | 100,000 | 100,000 | 60s | 600s | fully claimed |
| 1 | second | 50,000 | 50,000 | — | 300s | fully claimed |
| 2 | video | 25,000 | 25,000 | — | 300s | fully claimed |
| 3 | live-demo | 50,000 | 0 | 7d | 30d | past cliff; vesting, claimed 0 |
| 4 | drill | 10,000 | 3,046.197089 | — | 7d | partially claimed |

Totals: scheduled 235,000 QVEST; claimed 187,797.721008 QVEST;
`totalLocked` 47,202.278992 QVEST; contract balance 812,202.278992 QVEST;
supply 1,000,000 QVEST. Both reconciliations hold:
235,000 − 187,797.721008 = 47,202.278992, and
812,202.278992 + 187,797.721008 = 1,000,000.

The drill schedule is fully vested (since 23 Nov 2026 04:51 WIB); its
claimable amount (vested minus claimed) stays until claimed. The
live-demo schedule's cliff ended 23 Nov 2026 04:31 WIB and it now vests
linearly over its 30-day duration from the cliff; claimed is still 0.
The figures above are as of the verification block. If either schedule
is claimed, refresh `deployments/schedules.json` and this table from
the chain — `verify-live` fails until they match the live state again.

> **Duplicate deployment (honest note).** During the usage run, an
> unguarded `main()` in `scripts/deploy.ts` fired when `usage.ts`
> imported the Cosmos-hash helper from it, deploying a second, identical
> QoreVest contract at `0xc0ae0f1e3d2fd928944ee01a6401ea24b75bdcad`
> (deploy tx
> [`0x74951c89…`](https://explore.qore.network/tx/3101FBDF945CA2850CEC4DCCDFC7A4927CFAFCE2DB4E726851AF795C3716A25E)).
> It holds its own 1,000,000 QVEST supply, has no schedules, and is **not**
> the project contract — the usage run, the demo, and this README all use
> `0x67e4862c…`. The helper now lives in `scripts/cosmos-hash.ts` and
> both scripts guard their entry points, so it cannot happen again.

## How to use

1. Open the app (`npm run dev`, then http://localhost:5174).
2. Connect **QoreX** (or any injected EVM wallet) on the QoreChain Testnet.
3. Make sure an EVM authorisation window is open for your account — the
   app shows the window status live. Open one from QoreX (EVM access
   window) or with `npm run window open` (see below).
4. If your account has a vesting schedule, the app shows it (amount,
   vested, claimable, progress) and a **Claim** button. One click sends
   the atomic claim: QVEST to you, Native allowance mirrored.
5. The owner (connected deployer account) can create new schedules from
   the app.

## Quick start

### Prerequisites

- **Node.js 20+** (developed and tested on Node 24).
- A funded testnet account for deploying: test QOR from the Dashboard
  faucet (see the deployment status above).

### Install

```sh
npm install
```

### Configure

```sh
cp .env.example .env
```

Edit `.env`:

| Variable | Purpose |
| --- | --- |
| `QORE_EVM_RPC_URL` | Testnet EVM JSON-RPC: `https://evm-testnet.qore.host` |
| `QORE_EVM_PRIVATE_KEY` | The deployer's funded testnet private key (`0x…`) |
| `QORE_MNEMONIC` | The same account's mnemonic, for `npm run window` |
| `QORE_NETWORK` | `testnet` (QoreVest is testnet-only) |
| `QORE_WINDOW_BLOCKS` / `QORE_WINDOW_TXS` | Size of the EVM window opened by `npm run window open` |
| `QORE_WINDOW_TARGETS` | Comma-separated 0x recipients for a *scoped* window (see below) |

`QORE_EVM_PRIVATE_KEY` and `QORE_MNEMONIC` must be the **same account**
(derived at `m/44'/60'/0'/0/0`): the window is opened for the mnemonic's
account, and the deploy signs from the private key. Never commit `.env`.

### Open the post-quantum gate

```sh
npm run window status    # show the account, its PQC key and its window
npm run window register  # register the account's ML-DSA-87 key (once)
npm run window open      # open a window sized for a few deploys
```

Registration is the account's first native transaction (signed classically;
it is the one message the chain accepts that way). Opening the window is a
**hybrid-signed** native transaction. Opening a window advances the
account's nonce, so deploy **after** it lands, and wait ~10 seconds before
the first EVM transaction.

**Window scoping, learned the hard way:** a *direct* EOA call to the
cross-VM precompile (`0x…0901`) is refused under an unscoped window —
the chain demands a scoped window listing it in `allowed_targets` — and
a scoped window refuses contract creation. So: deploy first under an
unscoped window, then open a scoped one (`QORE_WINDOW_TARGETS=0x…0901`)
for direct precompile calls. A *contract-mediated* call (what QoreVest
does) works under a normal unscoped window, because the window check is
on the transaction's `to` only — demo users need only a normal window.

### Deploy

```sh
npm run deploy
```

This deploys `QoreVest` (precompile `0x…0901`, Native target WDT,
1,000,000 QVEST), prints the contract address and transaction hashes,
reads the deployment state back, and writes `deployments/testnet.json`.
The script refuses to run on any chain other than the testnet (chain id
9800).

### Run the on-chain usage demo

```sh
npx tsx --env-file=.env scripts/setup-second-account.ts  # fund + register + window for the second beneficiary
npx tsx --env-file=.env scripts/usage.ts                 # ~12 minutes: schedules, claims, forced revert
```

`usage.ts` needs live EVM windows for both accounts and writes
`deployments/usage.json` with every transaction hash and the invariant
checks.

### Run the web app

```sh
npm run dev
```

Then open http://localhost:5174. The contract address comes from
`deployments/testnet.json` (written by `npm run deploy`); without it the
app shows a "not deployed yet" notice instead of the vesting UI.

### Tests

```sh
npm test        # contract tests on a local in-memory EVM (Ganache) — 39/39 pass
npm run typecheck
npm run build   # regenerate evidence + typecheck + production frontend build
```

The contract tests deploy the real compiled bytecode to a local chain
with a mock precompile that mimics the chain's reply format, and check
exact vesting math (amounts at the cliff edge, one second into the
linear phase, mid-vest, one second before the end, and at the end, all
at exact block timestamps), claim accounting (claimed totals across
multiple claims, `totalLocked` and contract-balance reconciliation,
double-claim prevention, schedule isolation), the exact Native payload
of every claim (target, target VM, JSON), bech32 rejections (wrong
owner, corrupted checksum, wrong prefix, empty, bad charset character,
off-by-one length, uppercase), atomicity (a failing Native call reverts
the whole claim), full vesting, and ERC-20 transfers (including
`transferFrom` and the max-allowance branch). The test accounts are
Ganache's built-in deterministic test accounts — public test keys that
exist only on the throwaway local chain.

### Verify the live state

```sh
npm run verify-live   # read-only: 56 checks of the live Diana chain vs deployments/schedules.json
```

No keys or `.env` needed: the script reads the contract and the WDT
cw20 allowance over the public RPC/LCD and prints PASS/FAIL per check,
exiting non-zero if anything disagrees with the recorded state. See
[Live state (verified 23 Nov 2026)](#live-state-verified-23-nov-2026).

### Recompile the contract

```sh
npm run compile
```

This runs `solc` 0.8.24 and regenerates the committed artifacts
(`contracts/*.artifact.ts`, ABI + creation bytecode) from the `.sol`
sources, so the artifacts can never drift from the source.

## How it works

### The contract (`contracts/QoreVest.sol`)

- **Token.** ERC-20-style QVEST (6 decimals, to match WDT 1:1). The full
  1,000,000 QVEST supply is minted to the contract at deployment;
  schedules draw from it (`totalLocked` accounting; creation reverts if
  it would exceed the unallocated supply).
- **Vesting.** `createVesting(beneficiary, amount, start, cliff,
  duration)` (owner only, one schedule per beneficiary). `vested()` is
  0 before the cliff, linear after it, capped at the full amount;
  `claimable()` is vested minus claimed.
- **Claim.** `claim(string nativeSpender)` releases the claimable QVEST
  to the caller and atomically calls the precompile
  (`executeCrossVMCall`, target VM 1 = Native, target WDT) with the
  `increase_allowance` JSON for the caller's Native address and the
  claimed amount. It emits `Claimed` and `CrossVmMirrored`. The
  precompile reply is decoded as `abi.encode(bytes)` (chain v3.2.5+
  format) and the claim reverts unless the call succeeded and returned
  at least 64 bytes.
- **Bech32 binding.** Before the Native call, the contract verifies the
  passed Native address on chain: 42 characters, `qor1` prefix, valid
  bech32 polymod checksum, and the decoded 20 bytes equal `msg.sender`.
  This is the contract's most intricate part and is covered by dedicated
  tests (wrong owner, corrupted checksum, wrong prefix, empty, bad
  charset character, off-by-one length, uppercase, corrupted data
  character).
- **Atomicity.** The bridge journals the nested Native call, so an EVM
  revert undoes the Native side. The test suite proves it with the mock
  precompile (armed failure → claim reverts, no state changes), and the
  usage run proves the guard path on chain (forced revert → no state
  changed).

### The cross-VM bridge (what the research found)

See `research/` for the probe scripts and their findings:

- The CrossVM Bridge precompile `0x…0901` is active on Diana; the only
  supported target VM is 1 (QoreChain Native / CosmWasm). The payload is
  the target contract's execute message as UTF-8 JSON bytes. Gas: 50,000
  base + 4 per input byte + execution cost. Funds cannot be attached
  through the precompile.
- The allowlist (`/qorechain/crossvm/v1/params`, `enabled: true`) holds
  exactly three targets: the cw20 WDT and two instances of the
  `aegis_flight_tournament` contract. New instances of stored codes are
  not allowlisted.
- **The sender seen by the Native contract is the immediate caller.**
  Proven on chain: an EOA's direct call attributes the allowance to the
  EOA's mapped address; a contract's call attributes it to the
  contract's mapped address. QoreVest therefore owns the allowances it
  creates, and the ledger invariant is per-beneficiary under the
  contract's mapped address.
- The aegis contracts were investigated in depth (their interface was
  discovered purely by probing — no public docs exist) and rejected for
  vesting: score-based winner determination, likely operator-gated
  settlement, no vesting semantics.

### The quantum-safe gate

Since chain v3.2.0 the EVM lane admits a transaction only from an account
that (1) has a registered ML-DSA-87 key and (2) has a live EVM
authorisation window. The window is opened by a native-lane message
signed hybrid (ML-DSA-87 + secp256k1) and bounds the blocks, transaction
count and total value the account may spend. The SDK deliberately never
opens a window automatically — it is a spending authorisation, so it
stays explicit. The frontend reads the window over REST
(`evmWindowStatus`) and explains exactly which requirement is missing
when a claim is refused (`no-pqc-key`, `no-window`, `exhausted`).

### Limitations (honest)

- The vesting **schedule** is enforced by the EVM contract, not by a
  Native contract — no vesting contract is on the cross-VM allowlist
  today. The Native leg is a ledger/attestation.
- The WDT vault on this testnet is unfunded (the entire WDT supply is
  held by the test contract's creator), so the Native allowance is a
  verifiable record, not a spendable release.
- One schedule per beneficiary; schedules cannot be revoked or edited.
- The frontend's Native allowance read needs the Tendermint RPC to be
  reachable from the browser; on a host where it is not, the panel says
  so and points at the verified evidence instead.

## Project layout

```
contracts/
  QoreVest.sol               # the vesting token contract
  QoreVest.artifact.ts       # compiled ABI + creation bytecode (generated)
  MockCrossVm.sol            # test double for the cross-VM precompile
  MockCrossVm.artifact.ts    # compiled ABI + creation bytecode (generated)
scripts/
  deploy.ts                  # deploy + record deployments/testnet.json
  usage.ts                   # on-chain usage run + record deployments/usage.json
  cosmos-hash.ts             # EVM tx hash -> Cosmos tx hash (explorer links)
  setup-second-account.ts    # fund + PQC-register + window for the 2nd beneficiary
  precliff-setup.ts          # fund + PQC-register + window for the live-demo beneficiary
  precliff-claim.ts          # the one pre-cliff claim attempt (reverts on chain)
  precliff-state.ts          # read-only state check for the live-demo schedule
  verify-live.ts             # read-only live-state verification vs deployments/schedules.json
  window.ts                  # PQC key registration + EVM window helper
  build-artifact.mjs         # regenerate the artifacts from solc output
  gen-evidence.mjs           # generate src/evidence.ts from deployments/usage.json
research/                    # live testnet probes (allowlist, precompile, aegis)
src/
  App.tsx                    # the vesting UI
  config.ts                  # contract address (from deployments/) + constants
  evidence.ts                # verified on-chain evidence (generated)
  wagmi.ts                   # wagmi + RainbowKit config, QoreX first
  main.tsx                   # providers
test/
  qore-vest.test.ts          # contract tests on a local EVM
  qore-vest-math.test.ts     # exact vesting-math + accounting tests on a local EVM
deployments/
  testnet.json               # written by `npm run deploy`
  usage.json                 # written by `scripts/usage.ts`
  schedules.json             # expected live state (verified 23 Nov 2026), checked by verify-live.ts
  precliff-rejection.json    # the pre-cliff rejection record (19 Nov 2026)
docs/
  demo.mp4                   # demo video (≤3 min, real screen recording)
  featured.png               # featured image for the project page
```

## Credits

Built with the QoreChain SDK 0.14.0 / EVM 0.14.0 / RDK 0.9.0:

- `scripts/window.ts` — the official `hardhat`-template PQC key
  registration and EVM authorisation window helper, copied from the
  sibling Quantum Flip project with a scoped-window extension added.
- Frontend pattern (`wagmi.ts`, window-status component, Vite `/lcd`
  REST proxy) adapted from the official `viem-wagmi` template via the
  same sibling project.
- Libraries: `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/rdk`,
  `@qorechain/qorex-rainbowkit`, `viem`, `wagmi`, `@rainbow-me/rainbowkit`,
  `@tanstack/react-query`, `@cosmjs/cosmwasm-stargate`, `solc` (contract
  compilation), `ganache` (local contract tests).

QoreChain itself: https://qorechain.io — docs at https://docs.qorechain.io.

## License

Apache-2.0 — see [LICENSE](LICENSE).
