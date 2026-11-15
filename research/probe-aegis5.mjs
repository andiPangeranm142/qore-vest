// Continue create_tournament discovery with corrected types (numbers as numbers).
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";
const EVM_RPC = "https://evm-testnet.qore.host";
const AEGIS1 = "qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd";
async function ethCall(to, data) {
  const res = await fetch(EVM_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }) });
  return res.json();
}
// Numeric fields that must be JSON numbers, not strings.
const NUMERIC = new Set(["topup_limit", "max_participants", "min_participants", "fee_bps", "max_entries", "prize_count", "duration_seconds", "round_count"]);
const STRVALS = { name: "QoreVest Probe", entry_fee_uqor: "0", topup_price_uqor: "0", denom: "uqor", prize_denom: "uqor", entry_fee_denom: "uqor", description: "probe", sponsor: "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny", start_time: "1790000000", end_time: "1790003600", starts_at: "1790000000", ends_at: "1790003600" };
for (const kind of ["Sponsored", "Entry"]) {
  console.log(`\n===== kind=${kind} =====`);
  const msg = { create_tournament: { id: `probe-${kind.toLowerCase()}-1`, name: "QoreVest Probe", kind, entry_fee_uqor: "0", topup_price_uqor: "0", topup_limit: 1 } };
  for (let i = 0; i < 14; i++) {
    const calldata = encodeCrossVmCalldata({ contract: AEGIS1, msg: JSON.stringify(msg) });
    const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
    if (!out.error) { console.log(`SUCCESS. Final msg:`, JSON.stringify(msg)); console.log("Return:", JSON.stringify(out).slice(0, 300)); break; }
    const m = out.error.message || "";
    console.log(`attempt ${i + 1}: ${m.slice(0, 200)}`);
    const missing = m.match(/missing field `([a-z_0-9]+)`/);
    if (missing) {
      const f = missing[1];
      msg.create_tournament[f] = NUMERIC.has(f) ? 1 : (STRVALS[f] ?? "1");
      console.log(`  + ${f} = ${JSON.stringify(msg.create_tournament[f])}`);
      continue;
    }
    console.log("  STOP (non-missing-field result). Final msg:", JSON.stringify(msg));
    break;
  }
}
