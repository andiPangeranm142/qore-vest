// Aegis deep-probe part 3: string tournament ids, create_tournament fields,
// and enumeration of stored CosmWasm codes (is there a vesting code?).
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";

const EVM_RPC = "https://evm-testnet.qore.host";
const AEGIS1 = "qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd";

async function ethCall(to, data, from) {
  const params = [{ to, data }, "latest"];
  if (from) params[0].from = from;
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params, id: 1 }),
  });
  return res.json();
}

const cw = await CosmWasmClient.connect("https://rpc-testnet.qore.host");

// 1. Tournament queries with STRING ids.
for (const id of ["0", "1", "2", "tournament-1", "flight-1", "aegis-1"]) {
  try {
    const t = await cw.queryContractSmart(AEGIS1, { tournament: { tournament_id: id } });
    console.log(`tournament "${id}":`, JSON.stringify(t).slice(0, 700));
  } catch (e) {
    console.log(`tournament "${id}":`, e.message.slice(0, 180));
  }
}
// participant / claim queries with string id.
for (const qname of ["participant", "claim"]) {
  try {
    const r = await cw.queryContractSmart(AEGIS1, { [qname]: { tournament_id: "1", address: "qor1kndlxryvnkk3fz6kf7zzg9rw0yzch9cu7tj8us" } });
    console.log(`${qname} t"1" admin:`, JSON.stringify(r).slice(0, 400));
  } catch (e) {
    console.log(`${qname} t"1" admin:`, e.message.slice(0, 180));
  }
}

// 2. Enumerate stored codes 1..12.
console.log("\n=== stored codes ===");
for (let id = 1; id <= 12; id++) {
  try {
    const c = await cw.getCodeDetails(id);
    console.log(`code ${id}: checksum=${c.checksum.slice(0, 16)}... creator=${c.creator}`);
  } catch (e) {
    console.log(`code ${id}: (none)`);
  }
}
cw.disconnect();

// 3. create_tournament field discovery: add fields one at a time per the error.
console.log("\n=== create_tournament field discovery ===");
let msg = { create_tournament: { id: "qorevest-test-1" } };
for (let i = 0; i < 8; i++) {
  const calldata = encodeCrossVmCalldata({ contract: AEGIS1, msg: JSON.stringify(msg) });
  const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
  const m = out.error ? out.error.message : JSON.stringify(out).slice(0, 300);
  console.log(`attempt ${i + 1} msg=${JSON.stringify(msg).slice(0, 160)}`);
  console.log(`  -> ${m.slice(0, 260)}`);
  const missing = m.match(/missing field `([a-z_]+)`/);
  if (!missing) break;
  const field = missing[1];
  // Guess a plausible value for the missing field.
  const guesses = {
    name: "QoreVest Test", entry_fee: "1000000", prize_pool: "0",
    start_time: "1790000000", end_time: "1790003600", max_participants: 10,
    denom: "uqor", description: "test", tournament_id: "qorevest-test-1",
    fee_bps: 100, min_participants: 1, status: "open",
  };
  msg.create_tournament[field] = guesses[field] ?? "1";
}
