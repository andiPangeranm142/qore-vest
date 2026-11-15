// Complete the create_tournament field discovery for BOTH kinds (Sponsored, Entry).
// Iteratively satisfies the parser: missing-field errors add a guessed value,
// unknown-variant errors pick the first expected variant. A non-parse result
// (success or "unauthorized") is decisive: it tells us whether creation is
// permissionless and what a tournament looks like.
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";

const EVM_RPC = "https://evm-testnet.qore.host";
const AEGIS1 = "qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd";

async function ethCall(to, data) {
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
  });
  return res.json();
}

const GUESSES = {
  name: "QoreVest Probe", entry_fee: "1000000", prize_pool: "0",
  start_time: "1790000000", end_time: "1790003600", max_participants: 10,
  denom: "uqor", description: "probe", tournament_id: "probe-1",
  fee_bps: 100, min_participants: 1, prize_denom: "uqor",
  entry_fee_denom: "uqor", sponsor: "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny",
  starts_at: "1790000000", ends_at: "1790003600", registration_end: "1790001800",
};

for (const kind of ["Sponsored", "Entry"]) {
  console.log(`\n===== create_tournament kind=${kind} =====`);
  const msg = { create_tournament: { id: `probe-${kind.toLowerCase()}-1`, name: "QoreVest Probe", kind } };
  for (let i = 0; i < 12; i++) {
    const calldata = encodeCrossVmCalldata({ contract: AEGIS1, msg: JSON.stringify(msg) });
    const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
    if (!out.error) {
      console.log(`SUCCESS after ${i} fixes. Final msg:`, JSON.stringify(msg));
      console.log("Return:", JSON.stringify(out).slice(0, 400));
      break;
    }
    const m = out.error.message || "";
    console.log(`attempt ${i + 1}: ${m.slice(0, 220)}`);
    const missing = m.match(/missing field `([a-z_0-9]+)`/);
    if (missing) {
      const field = missing[1];
      msg.create_tournament[field] = GUESSES[field] ?? "1";
      console.log(`  + field ${field} = ${JSON.stringify(msg.create_tournament[field])}`);
      continue;
    }
    const variant = m.match(/unknown variant `([^`]+)`, expected (?:`([^`]+)`(?: or `([^`]+)`)?|(.+?))(?::|;|$)/);
    if (variant) {
      // Find which field holds the bad variant: re-check by removing suspects is
      // complex; instead report and stop — the field is the last one added.
      console.log("  variant error — cannot auto-fix; stopping.");
      break;
    }
    if (m.includes("Invalid type") || m.includes("invalid type")) {
      console.log("  type error (a field has the wrong JSON type) — stopping.");
      break;
    }
    console.log("  NON-PARSE result (decisive). Final msg:", JSON.stringify(msg));
    break;
  }
}
