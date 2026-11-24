# AI Usage — QoreVest

This file documents how AI was used to build QoreVest, what the AI
generated, what the human contributed, and how the work was verified. It
exists for the QoreChain Developer Fest's **Best AI-Native Build** award,
and as an honest development record.

## Summary

QoreVest was built end-to-end by an AI coding agent (**Muse**, running as
the assistant "forza") from a one-paragraph human brief, over build
sessions on 15–16 November 2026. The human (Aeron) chose the event and
the Cross-VM category, approved the approach, and owns every step that
needs a human identity: accounts, funding, registration, and submission.
Work continued after the launch (19–23 November 2026): a vesting-math
test suite, a live-chain verification script, the live-demo and Q-Day
Drill schedules, and a post-cliff refresh of the recorded state — all by
the same agent, all verified against the live chain before this file was
updated.
No code was copied from any other fest project — the concept is the
category's own example ("EVM token with Native vesting"), implemented
originally, and the rival Cross-VM entry (VestCross) was never read or
copied.

## Workflow

1. **Research first, code second.** The agent spent the first session
   investigating the cross-VM mechanics before writing any contract code:
   the fest site, the QoreChain docs, the published npm packages
   (`@qorechain/sdk` 0.14.0, `@qorechain/evm` 0.14.0, `@qorechain/rdk`
   0.9.0), and — most importantly — live probing of the Diana testnet.
   The allowlist, the precompile behaviour, the reply format, and the
   window rules were all established empirically (see `research/`).
2. **An honest design change, documented.** The brief's literal concept
   (a vesting schedule enforced by an approved Native contract) turned
   out not to be implementable on the live allowlist: no vesting
   contract is allowlisted, the only cw20's supply is held entirely by
   an unreachable creator, and the other two targets are score-based
   tournament contracts. Rather than fake a cross-VM call, the agent
   redesigned the project around what the chain actually supports: the
   EVM contract enforces the schedule, and every claim atomically
   mirrors the claimed amount to the Native contract as a cw20
   allowance — a verifiable cross-VM vesting ledger. The deviation is
   flagged in the README and in the final report to the human.
3. **Never guess an API.** Every SDK/EVM function used was checked
   against the type definitions in `node_modules` (or the docs) before
   use — including `deriveUnifiedAccount` (async, returns a Promise),
   `bank.send`, `evmWindowStatus`, `fetchPqcStatus`, and viem's
   `mnemonicToAccount` derivation path.
4. **Verify at every step.** Contract compiled with `solc` 0.8.24;
   artifacts regenerated from compiler output by script (never
   hand-copied); `tsc --noEmit` typecheck; automated contract tests on a
   local EVM (including a mock precompile that mimics the chain's reply
   format); `vite build` for the frontend. On-chain verification was
   done the same day: the contract deployed, real schedules created,
   real claims executed, and the Native allowance read back after
   every claim. The live state is re-verified read-only by
   `scripts/verify-live.ts` (56 checks against
   `deployments/schedules.json` — contract identity, every schedule
   field, totals, and the pre-cliff rejection receipt). Nothing in this
   repo claims an on-chain result that has not happened.
5. **Secrets discipline.** A fresh testnet-only wallet was generated for
   this project; its mnemonic and private key live only in the local,
   git-ignored `.env` and a mode-`600` file outside the repo. The repo
   was checked for secrets before every commit (see below).

## What the AI generated

- `contracts/QoreVest.sol` — the vesting token contract (original
  design: ERC-20-style QVEST, cliff + linear vesting, atomic cross-VM
  claim mirroring, on-chain bech32 verification).
- `contracts/MockCrossVm.sol` — a test double for the cross-VM
  precompile (mimics the chain v3.2.5+ `abi.encode(bytes)` reply format
  and records every call; can be armed to fail for atomicity tests).
- `scripts/deploy.ts` — deployment + deployment record (testnet-only
  chain-id guard; Cosmos-hash resolution for explorer links).
- `scripts/usage.ts` — the on-chain usage run: four schedules, four
  claims, one forced revert, and one pre-cliff rejection, with the
  Native invariant verified after every claim; writes
  `deployments/usage.json`.
- `scripts/verify-live.ts` — read-only live-chain verification: 56
  checks of the Diana chain against `deployments/schedules.json`
  (added 19 Nov 2026; 56/56 PASS on 23 Nov 2026, block 10598414).
- `scripts/live-schedule.ts` — the live-demo schedule (50,000 QVEST,
  7-day cliff, 30-day duration; cliff ended 23 Nov 2026 04:31 WIB, now
  claimable, claimed still 0).
- `scripts/precliff-setup.ts`, `scripts/precliff-claim.ts` — the
  pre-cliff rejection proof: a claim attempted before the cliff reverted
  on chain ("nothing claimable"), no state changed (recorded in
  `deployments/precliff-rejection.json`).
- `scripts/drill-schedule.ts`, `scripts/drill-claim.ts` — the Q-Day
  Drill schedule (10,000 QVEST) and its drill-day claim.
- `scripts/setup-second-account.ts` — funds, PQC-registers, and opens a
  window for the second beneficiary account (index 1 of the deployer
  mnemonic).
- `scripts/build-artifact.mjs` — artifact regeneration from `solc` output.
- `scripts/gen-evidence.mjs` — generates `src/evidence.ts` from the
  usage run so the demo page shows the verified evidence.
- `research/*.mjs` — the live testnet probes that established the
  allowlist, the precompile behaviour, and the contract-as-sender rule.
- `test/qore-vest.test.ts` — contract tests (9 tests: artifact checks,
  vesting math, claim happy path with exact Native payload assertions,
  bech32 rejections, atomicity, full vesting, ERC-20 transfers).
- `test/qore-vest-math.test.ts` — vesting-math tests (30 tests, added
  19 Nov 2026: cliff boundaries, linear accrual, rounding, and edge
  cases, computed against the contract's own formulas).
- `src/*` — the React frontend (vesting UI, QoreX connect, live EVM
  window status, Native allowance read, owner schedule form, evidence
  section), adapted from the `viem-wagmi` template pattern.
- `README.md`, this file, `.gitignore`, `.env.example`, `LICENSE`
  (Apache-2.0 text).
- `scripts/window.ts` was **not** AI-written: it is the official
  `hardhat`-template helper, copied from the sibling Quantum Flip
  project with a scoped-window extension added.

## Debugging the AI did (and how)

Three real problems were found and fixed during testing, all by reading
source or chain behaviour rather than guessing:

1. **Ganache time drift broke the vesting tests.** The first test suite
   asserted exact vested amounts at cliff boundaries, but real seconds
   pass between a schedule's creation and its checks, pushing the clock
   past the boundary. Fix: each test uses its own beneficiary and a
   freshly created schedule, with wide margins (1,800s+) and a
   tolerance band on linear-vesting assertions; claimed amounts are read
   back from the schedule instead of compared to a pre-claim snapshot.
2. **The mock's fail flag survived the revert it caused.** The mock sets
   `failNext = false` before reverting, but the revert rolls that
   assignment back — so the flag stayed armed and poisoned later tests.
   Fix: the atomicity test disarms the mock with a separate transaction
   after the failing claim, then proves the same claim succeeds.
3. **The precompile rejected direct EOA calls under an unscoped window.**
   Probing the live chain showed the admission rule: a direct call to
   `0x0901` needs a scoped window listing it, but scoped windows refuse
   contract creation. A contract-mediated call works under a normal
   unscoped window (the window check is on the transaction's `to` only),
   and the sender seen by the Native contract is the calling contract —
   proven on chain with a probe contract before QoreVest was written.
4. **An import deployed a duplicate contract mid-run.** `usage.ts`
   imported the Cosmos-hash helper from `deploy.ts`, whose unguarded
   top-level `main()` fired on import and deployed a second, identical
   QoreVest contract (`0xc0ae0f1e…`) during the usage run, overwriting
   `deployments/testnet.json`. The usage run itself had already read the
   original file, so all seven of its transactions went to the correct
   contract — verified from `deployments/usage.json` before anything
   else. Fix: the helper moved to `scripts/cosmos-hash.ts`, both
   scripts guard their entry points, `testnet.json` was restored from
   the on-chain deploy transaction (timestamp verified via REST), and
   the duplicate is documented in the README. Importing either script
   was re-tested to confirm nothing runs.

All fixes are covered by the passing test suite (`npm test`: 39/39 —
9 contract tests + 30 vesting-math tests).

## Human contribution

- Chose the event and the Cross-VM category; gave the go-ahead for four
  new fest projects at once ("gas semuanya") and the quality bar ("no
  mistakes, however small; maximise the chance of winning").
- Owns the accounts and identity steps the agent cannot do: the GitHub
  account the repo lives under, the Dashboard sign-in for the faucet
  claim that funds the deployer, the fest registration (GitHub OAuth,
  X, QoreX), and the final submission.
- Reviews and approves the demo video and the submission text.

## Verification status (updated 25 Nov 2026)

| Check | Result |
| --- | --- |
| `solc` 0.8.24 compile | Passes, no warnings shown |
| `npm test` (contract + vesting-math, local EVM) | 39/39 pass (9 contract + 30 math) |
| `npm run verify-live` (56 live-chain checks) | 56/56 PASS (23 Nov 2026, block 10598414) |
| `npm run typecheck` | Passes |
| `npm run build` (frontend) | Passes |
| No secrets in repo / git history | Checked (see below) |
| Testnet deploy | **Done 16 Nov 2026 02:52 WIB** — contract `0x67e4862c…f8f68`, deploy tx `0x498b8231…`, Cosmos hash `71E9E424…` |
| On-chain usage run | **Done** — 5 schedules (235,000 QVEST), 6 claims, 1 forced revert, 1 pre-cliff rejection; Native invariant held after every claim (see `deployments/usage.json`, `deployments/schedules.json`, `deployments/precliff-rejection.json`, `deployments/video-claim.json`). Live-demo schedule (50,000 QVEST) past its cliff since 23 Nov 2026 04:31 WIB, now claimable, claimed still 0; drill schedule claimed once on drill day |
| Demo video (≤3 min, real recording) | **Done 16 Nov 2026** — `docs/demo.mp4`, 106.6 s (1:47), 1920×1080 H.264, real Playwright screen recording of a live claim (25,000 QVEST, video account), burned-in captions, explorer confirmation on camera; frames verified at 6 timestamps |
| Live demo (GitHub Pages) | Done — https://andipangeranm142.github.io/qore-vest/ |

Two bugs were found and fixed during the video work (16 Nov 2026):
`App.tsx` used Node's `Buffer.from` in the browser, which crashed the
connected view ("Buffer is not defined") — replaced with viem's
`hexToBytes`. And the Native allowance read used the Tendermint RPC,
which sends no CORS headers, so the browser could not reach it — it now
goes through the testnet REST API's CosmWasm smart-query endpoint via
the dev proxy, like the window-status read. The recording itself used
a small Node static server with a fetch-based `/lcd-testnet` proxy
(`video/serve.mjs`, outside the repo) because Vite's http-proxy cannot
do TLS through this sandbox's egress proxy and every proxied request
500s; the app code is unchanged and still reads through `/lcd-testnet`.

## Secrets check

Before each commit, the repo is checked for secrets: `.env` is
git-ignored (and holds the only copy of the testnet key used by the
scripts); the deployer mnemonic lives in a mode-`600` file outside the
repo; `git log` / `git show` history is reviewed for accidental
additions. The test mnemonic in `test/` is the public Hardhat test
mnemonic — it funds nothing outside the throwaway local chain and is
labelled as such in the test file. `research/` contains only public
addresses and transaction hashes.

## Tools

- Agent: Muse ("forza"), working as a build subagent under the main
  agent (no further subagents were spawned for this build).
- Toolchain: Node 24, TypeScript, `solc` 0.8.24, viem, wagmi,
  RainbowKit, Ganache (tests), QoreChain SDK/EVM 0.14.0, RDK 0.9.0,
  CosmJS 0.39.0, Playwright (demo render check + video recording).
