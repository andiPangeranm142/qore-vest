// Learn the aegis_flight_tournament contract interface.
// 1. Full CosmJS query error text lists ALL QueryMsg variants.
// 2. eth_call through the precompile with candidate execute messages:
//    a parse error means wrong variant; a logic error/success means right variant.
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
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

const cw = await CosmWasmClient.connect("https://rpc-testnet.qore.host");
// Full error text for an unknown query variant (lists all variants).
try {
  await cw.queryContractSmart(AEGIS1, { __no_such_query__: {} });
} catch (e) {
  console.log("=== FULL QueryMsg error (lists all query variants) ===");
  console.log(e.message);
}
// Also try a few likely queries directly.
for (const [name, q] of [
  ["config", { config: {} }],
  ["state", { state: {} }],
  ["tournament", { tournament: {} }],
  ["info", { info: {} }],
  ["leaderboard", { leaderboard: {} }],
  ["flights", { flights: {} }],
  ["get_config", { get_config: {} }],
]) {
  try {
    const res = await cw.queryContractSmart(AEGIS1, q);
    console.log(`[query ${name}] OK:`, JSON.stringify(res).slice(0, 500));
  } catch (e) {
    console.log(`[query ${name}] no:`, e.message.slice(0, 160));
  }
}
cw.disconnect();

// Candidate execute messages via the precompile (read-only eth_call).
const candidates = [
  "register", "register_flight", "submit", "submit_score", "submit_flight",
  "claim", "claim_reward", "claim_prize", "enter", "join", "start",
  "end_tournament", "finish", "record", "record_flight", "attest",
  "update_config", "set_config", "pause", "unpause", "withdraw",
];
for (const fn of candidates) {
  const msg = JSON.stringify({ [fn]: {} });
  const calldata = encodeCrossVmCalldata({ contract: AEGIS1, msg });
  const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
  const text = JSON.stringify(out);
  if (out.error) {
    const m = out.error.message || "";
    if (m.includes("unknown variant") || m.includes("Invalid type")) {
      console.log(`[exec ${fn}] PARSE-ERROR (wrong variant)`);
    } else {
      console.log(`[exec ${fn}] *** DIFFERENT ERROR (possible hit):`, m.slice(0, 220));
    }
  } else {
    console.log(`[exec ${fn}] *** SUCCESS/NO-ERROR:`, text.slice(0, 300));
  }
}
