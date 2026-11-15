// Deep-probe the aegis tournament contract: tournament state, more execute variants.
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";

const EVM_RPC = "https://evm-testnet.qore.host";
const AEGIS1 = "qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd";
const AEGIS2 = "qor1nc5tatafv6eyq7llkr2gv50ff9e22mnf70qgjlv737ktmt4eswrqfye7zd";

async function ethCall(to, data) {
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
  });
  return res.json();
}

const cw = await CosmWasmClient.connect("https://rpc-testnet.qore.host");
for (const [label, addr] of [["AEGIS1", AEGIS1], ["AEGIS2", AEGIS2]]) {
  console.log(`\n===== ${label} =====`);
  const cfg = await cw.queryContractSmart(addr, { config: {} });
  console.log("config:", JSON.stringify(cfg));
  // Try tournament ids 0..3.
  for (const id of [0, 1, 2, 3]) {
    try {
      const t = await cw.queryContractSmart(addr, { tournament: { tournament_id: id } });
      console.log(`tournament ${id}:`, JSON.stringify(t).slice(0, 600));
    } catch (e) {
      console.log(`tournament ${id}:`, e.message.slice(0, 160));
    }
  }
  // Participant + claim queries for the admin on tournament 0/1.
  for (const id of [0, 1]) {
    for (const qname of ["participant", "claim"]) {
      try {
        const r = await cw.queryContractSmart(addr, { [qname]: { tournament_id: id, address: cfg.admin } });
        console.log(`${qname} t${id} admin:`, JSON.stringify(r).slice(0, 400));
      } catch (e) {
        console.log(`${qname} t${id} admin:`, e.message.slice(0, 160));
      }
    }
  }
}
cw.disconnect();

// More execute candidates via precompile eth_call.
const candidates = [
  "create_tournament", "create", "close_tournament", "close", "end", "settle",
  "finalize", "distribute", "distribute_prizes", "fund", "deposit", "open",
  "cancel", "cancel_tournament", "remove", "settle_tournament", "resolve",
  "declare_winner", "set_winner", "add_tournament", "new_tournament",
  "join_tournament", "leave", "refund", "sweep", "migrate",
];
console.log("\n===== execute candidates =====");
for (const fn of candidates) {
  const msg = JSON.stringify({ [fn]: {} });
  const calldata = encodeCrossVmCalldata({ contract: AEGIS1, msg });
  const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
  if (out.error) {
    const m = out.error.message || "";
    if (m.includes("unknown variant") || m.includes("Invalid type")) {
      // wrong variant — silent
    } else {
      console.log(`[exec ${fn}] *** HIT?:`, m.slice(0, 220));
    }
  } else {
    console.log(`[exec ${fn}] *** SUCCESS/NO-ERROR:`, JSON.stringify(out).slice(0, 300));
  }
}
console.log("(candidates with only parse errors omitted)");
