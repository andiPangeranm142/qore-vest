# QCAI audit — stage 1 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QoreVest.flattened.sol` (348 lines, no test code), run 25 Nov
  2026 ~09:37 WIB.
- Result: **score 65/100, risk MEDIUM, quantum readiness CLASSICAL-ONLY,
  5 findings.** Report: `docs/QCAI-audit-stage1.pdf` (verified from the PDF
  itself: score, risk, readiness, and all five titles/severities/
  recommendations match).
- Cost: 150 QOR (testnet), paid ON-CHAIN from the dashboard wallet
  "SealedBid" (`qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4`) — fee tx
  `F1223421…11B66FD4` to `qor1wv0fvt…` (−150.045 QOR incl. gas; wallet
  balance verified on-chain before/after: 158.965 → 8.92 QOR). The wallet
  was topped up 150 QOR from the deployer before the run
  (tx `15DD988F…644E014A`, code 0).
- Context: our lowest QCAI score so far (Quantum Vault 85/100 x2,
  SealedBid 75/100, BillPay Guard 72/100) and the only CLASSICAL-ONLY
  result — the honest reason: this contract genuinely contains no
  post-quantum cryptography (see finding 1). The Cross-VM prizes are
  still TBA; this audit does not change the category standing, but it is
  the weakest audit of the four and should be presented as-is, not
  dressed up. Stage 2 is a fresh audit with identical source (the
  dashboard keeps no history); stage 2 NOT yet run.

## Finding 1 — HIGH — No Quantum-Safe Cryptography Implementation

**Verdict: ACCEPTED BY DESIGN — documented limitation; no code change.**

The description is fair: the contract performs no encryption and no
signature verification on-chain at all (its only "cryptography" is
keccak256 hashing and a bech32 checksum, neither of which is a signature
scheme), so there is nothing in-contract to make quantum-safe. The
recommendation (implement ML-KEM/Dilithium IN the contract) is not
possible on the EVM — the chain's PQC lives in the native lane and
client-side, and the EVM cannot run ML-KEM or Dilithium. QoreVest's
quantum story is the cross-VM bridge + the native lane, not in-contract
crypto — which is why the auditor reads CLASSICAL-ONLY while Quantum
Vault / SealedBid / BillPay Guard read HYBRID. This is stated in the
contract's NatSpec ("HONEST LIMITATIONS") and the README; a redeploy
cannot add in-contract PQC to an EVM vesting token.

## Finding 2 — MEDIUM — Reentrancy Vulnerability in Cross-VM Call

**Verdict: FALSE POSITIVE — the recommendation is inverted; no code
change.**

The contract ALREADY follows checks-effects-interactions: `claim()`
updates all state first (`s.claimed`, `totalLocked`, balances) and emits
events BEFORE the external call to the bridge precompile; nothing follows
the call except the `CrossVmMirrored` event (events cannot be reentered).
The recommendation — "move the cross-VM call before state modifications"
— is exactly the pattern that CREATES reentrancy risk. There is also no
reentrancy path: the call target is the fixed bridge precompile 0x0901
(not an arbitrary contract), and the Native leg executes a cw20
`increase_allowance` — the EVM cannot be re-entered from the Native
lane. If the Native call fails, the whole transaction reverts (atomicity,
documented in the NatSpec and verified by the chain's journaling of the
nested call). No code change.

## Finding 3 — MEDIUM — Potential Integer Overflow in Vesting Calculation

**Verdict: FALSE POSITIVE (overflow) + negligible rounding; no code
change.**

Solidity ^0.8.24 has built-in checked arithmetic — integer overflow
reverts automatically, so no SafeMath library or explicit overflow check
is needed. The integer-division "precision loss" is real but bounded and
safe: `(total * elapsed) / duration` truncates downward, so `vested()` is
always ≤ the true value (it can never overpay), the error is at most
1 base unit (0.000001 QVEST), and it resolves exactly at the end
(`vested == total` at `cliffEnd + duration`). This is standard practice
for linear vesting. No code change.

## Finding 4 — LOW — Missing Input Validation for Duration Parameters

**Verdict: ACCEPTED RISK; no code change.**

`createVesting` is owner-only (the issuer/deployer). A bad duration
harms only that one schedule and is fully public on-chain (start/cliff/
duration are readable and emitted in `VestingCreated`). There is no
upper bound that is a security property — a 10-year vesting is
legitimate. The validations that matter already exist: `duration > 0`,
`amount > 0`, no duplicate schedule, `totalLocked + amount` ≤ unallocated
supply. No code change.

## Finding 5 — INFO — No Post-Quantum Key Management

**Verdict: NOT APPLICABLE — accepted by design; no code change.**

Same root as finding 1: a vesting token contract has no keys to manage.
Key management lives in the account/native lane (ML-DSA-87 key
registration for the account) and client-side, not in a token contract.
No code change.

## Summary

0 of 5 findings need a code change: 1 false positive (finding 2), 1
false positive + negligible rounding (finding 3), 1 accepted risk
(finding 4), 2 accepted by design (findings 1, 5). No redeploy. The audit
confirms the documented security story: a vesting token whose rules are
enforced on-chain, whose cross-VM leg is atomic, and whose quantum story
lives in the bridge/native lane — not in the contract itself.
