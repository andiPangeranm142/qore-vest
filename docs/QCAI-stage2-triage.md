# QCAI audit — stage 2 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/QoreVest.flattened.sol` (348 lines, no test code), run 25 Nov
  2026 ~22:37 WIB — a fresh audit with the IDENTICAL source as stage 1 (the
  dashboard keeps no history).
- Result: **score 65/100, risk MEDIUM, quantum readiness CLASSICAL-ONLY,
  5 findings.** Report: `docs/QCAI-audit-stage2.pdf` (verified from the PDF
  itself: score, risk, readiness, and all five titles/severities/
  recommendations match).
- Cost: 150 QOR (testnet), paid ON-CHAIN from the dashboard wallet
  "SealedBid" (`qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4`) — fee tx
  `065557BE…F6186EEA` to `qor1wv0fvt…` (−150.045 QOR incl. gas; wallet
  balance verified on-chain before/after: 158.785 → 8.74 QOR). The wallet
  was topped up 150 QOR from the deployer before the run
  (tx `55A2781B…622905F3`, code 0). No faucet was used (faucet was
  rate-limited for the earlier SealedBid run and cannot fund a 150 QOR
  audit from an ~8.8 QOR balance anyway).
- vs stage 1 (same source, 25 Nov ~09:37 WIB): score UNCHANGED 65/100,
  risk UNCHANGED MEDIUM, quantum readiness UNCHANGED CLASSICAL-ONLY.
  Finding composition shifted: stage 1 was 1 High / 2 Medium / 1 Low /
  1 Info; stage 2 is 2 High / 2 Medium / 1 Low. The reentrancy finding
  was upgraded MEDIUM → HIGH, a NEW MEDIUM "Owner Privilege Abuse
  Potential" appeared, the LOW finding is now about nativeTarget
  validation (was duration parameters), and the INFO "No Post-Quantum Key
  Management" finding is ABSENT in stage 2 (nothing to do: same root as
  finding 1, already documented).

## Finding 1 — HIGH — No Quantum-Safe Cryptography Implementation

**Verdict: ACCEPTED BY DESIGN — documented limitation; no code change.**

Same issue as stage-1 finding 1. The contract performs no encryption
and no signature verification on-chain at all (its only "cryptography"
is keccak256 hashing and a bech32 checksum, neither of which is a
signature scheme), so there is nothing in-contract to make quantum-safe.
The recommendation (implement ML-KEM/Dilithium IN the contract) is not
possible on the EVM — the chain's PQC lives in the native lane and
client-side, and the EVM cannot run ML-KEM or Dilithium. QoreVest's
quantum story is the cross-VM bridge + the native lane, not in-contract
crypto — which is why the auditor reads CLASSICAL-ONLY while Quantum
Vault / SealedBid / BillPay Guard read HYBRID or QUANTUM-SAFE. This is
stated in the contract's NatSpec ("HONEST LIMITATIONS") and the README;
a redeploy cannot add in-contract PQC to an EVM vesting token.

## Finding 2 — HIGH — Reentrancy Vulnerability in Cross-VM Call

**Verdict: FALSE POSITIVE — the recommendation is inverted; no code
change.**

Same issue as stage-1 finding 2, upgraded from MEDIUM to HIGH by the
auditor — the underlying facts did not change. The contract ALREADY
follows checks-effects-interactions: `claim()` updates all state first
(`s.claimed`, `totalLocked`, balances) and emits events BEFORE the
external call to the bridge precompile; nothing follows the call except
the `CrossVmMirrored` event (events cannot be reentered). The
recommendation — a reentrancy guard / mutex — would protect against a
threat that cannot occur here: the call target is the fixed bridge
precompile 0x0901 (not an arbitrary contract), the Native leg executes
a cw20 `increase_allowance`, and the EVM cannot be re-entered from the
Native lane. If the Native call fails, the whole transaction reverts
(atomicity, documented in the NatSpec and verified by the chain's
journaling of the nested call). No code change.

## Finding 3 — MEDIUM — Potential Integer Overflow in Vesting Calculation

**Verdict: FALSE POSITIVE (overflow) + negligible rounding; no code
change.**

Same issue as stage-1 finding 3. Solidity ^0.8.24 has built-in checked
arithmetic — integer overflow reverts automatically, so no SafeMath
library or explicit overflow check is needed. The integer-division
"precision loss" is real but bounded and safe: `(total * elapsed) /
duration` truncates downward, so `vested()` is always ≤ the true value
(it can never overpay), the error is at most 1 base unit (0.000001
QVEST), and it resolves exactly at the end (`vested == total` at
`cliffEnd + duration`). This is standard practice for linear vesting.
No code change.

## Finding 4 — MEDIUM — Owner Privilege Abuse Potential (NEW in stage 2)

**Verdict: ACCEPTED BY DESIGN — no code change.**

The owner (the issuer/deployer) creating vesting schedules IS the
contract's purpose — `createVesting` is the only owner function, and
every schedule it creates is fully public on-chain (start/cliff/
duration readable, emitted in `VestingCreated`). The owner cannot steal
anyone's tokens: schedules are promises against the contract's OWN
supply only (`totalLocked + amount` ≤ unallocated supply), and a
beneficiary's claim is enforced by the contract, not by the owner.
Multi-signature ownership or a timelock would add complexity without
changing the trust model of a testnet vesting token whose issuer is
publicly known. No code change.

## Finding 5 — LOW — Missing Input Validation for Cross-VM Target

**Verdict: ACCEPTED RISK (negligible) — no code change.**

`nativeTarget` is set ONCE in the constructor by the deployer, to the
approved WDT cw20 address; it is public on-chain and readable by
anyone. A wrong target does not create a vulnerability — it makes
`claim()` revert (the cross-VM call fails and the whole transaction
reverts atomically), i.e. a non-functional contract, immediately visible
to everyone. There is no user-supplied target to validate at claim time.
No code change.

## Summary

0 of 5 findings need a code change: 1 false positive (finding 2), 1
false positive + negligible rounding (finding 3), 2 accepted by design
(findings 1, 4), 1 accepted risk (finding 5). No redeploy. Stage 2
confirms stage 1 exactly — same score, same risk, same readiness — with
a reshuffled finding list. The audit confirms the documented security
story: a vesting token whose rules are enforced on-chain, whose
cross-VM leg is atomic, and whose quantum story lives in the
bridge/native lane — not in the contract itself.
