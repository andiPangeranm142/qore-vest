# QoreVest — flattened contract source for QCAI audit

File: `QoreVest.flattened.sol` — 348 lines, 14,938 bytes.
Generated with hardhat v2.29.2 (`npx hardhat flatten`) from
`contracts/QoreVest.sol` (343 lines, no imports). The body is
byte-identical to the deployed source (verified by diff from the
pragma line onward); no test code is included (the single word "mock"
in the file is a NatSpec comment noting the bridge precompile is
mocked in tests).

Deployed: 0x67e4862c388a5ead666f5ac340fe9ef2fc1f8f68 on qorechain-diana
(chain 9800), deploy tx
0x498b82315b55a26dbb4b76bd1b5b9ca4de817330dd6b1dbe433b337e516536d3.

## How to run the audit

1. Open https://dashboard.qorechain.io/audit, sign in with the project account.
2. Start a NEW audit. The form has no file upload — paste the entire
   contents of `QoreVest.flattened.sol` into the "Contract Source Code"
   textarea.
3. Set Blockchain = QoreChain. Run the audit (150 QOR testnet per run,
   paid ON-CHAIN from the connected dashboard wallet — the fee is a real
   MsgSend to qor1wv0fvt5qzx7gllk9ckzv3u6ypceaqq8evuny0h; make sure the
   wallet holds ≥150 QOR + gas BEFORE running. The faucet alone
   (100 QOR/24h) is NOT enough — top up from the deployer first).
4. Wait for the result. Record score / risk / quantum readiness / findings.
5. Export the PDF and save it as `docs/QCAI-audit-stage1.pdf`
   (stage 2: `docs/QCAI-audit-stage2.pdf`), then triage every finding in
   `docs/QCAI-stage1-triage.md` (stage 2 likewise).

Notes: the dashboard keeps NO audit history and offers NO stage-2 option
on an existing result — stage 2 is a fresh audit with the identical
source. The dashboard failed twice on BillPay Guard's stage 2 on 25 Nov
("No wallet found" toast) because the account had no dashboard wallet;
the fix (approved by the user 25 Nov 09:11) was creating one via the
dashboard's own "Create a new wallet" button (wallet "SealedBid"
qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4, funded by top-ups from the
deployer).

## Auditor context

- EVM token (QVEST, 6 decimals) with time-based vesting, Cross-VM
  category. Every claim is a single atomic EVM transaction with two legs:
  (1) EVM leg — vested QVEST is transferred to the beneficiary;
  (2) Native leg — this contract calls the cross-VM bridge precompile
  (0x0901) to grant the beneficiary a vesting allowance on the approved
  Native cw20 contract (WDT), equal to the claimed amount. The allowance
  is owned by this contract, so the Native contract holds a cross-VM
  vesting ledger whose invariant anyone can verify off-chain:
  allowance(QoreVest, beneficiary) == total claimed. If the Native call
  fails, the whole transaction reverts: no QVEST moves and no vesting
  state changes.
- Honest limitations (documented in the README): the vesting SCHEDULE
  (cliff, linear release) is enforced by this EVM contract, not by the
  Native contract — no vesting contract is on the bridge allowlist (the
  three allowlisted targets are a cw20 test token and two instances of a
  third-party tournament contract). The Native leg is a vesting
  ledger/attestation, not the schedule enforcer. The WDT vault is
  unfunded on this testnet (the whole WDT supply is held by its
  deployer), so the Native allowance is an attestation of vested amounts,
  not a spendable release. The beneficiary's Native (bech32) address is
  verified on-chain against msg.sender, so allowances can never be
  misdirected.
- A user calling claim() needs only a NORMAL EVM authorisation window:
  the chain's window check applies to the transaction's recipient (this
  contract); the internal precompile call is admitted with it.
- Testnet only (qorechain-diana).
