// Decisive test: fully-valid create_tournament (future ends_at) via eth_call.
// Success => creation is permissionless. "unauthorized" => admin/operator-gated.
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";
const EVM_RPC = "https://evm-testnet.qore.host";
const AEGIS1 = "qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd";
async function ethCall(to, data) {
  const res = await fetch(EVM_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }) });
  return res.json();
}
const nowSec = Math.floor(Date.now() / 1000);
console.log("now (unix sec):", nowSec);
const msg = { create_tournament: { id: "probe-final-1", name: "QoreVest Probe", kind: "Sponsored", entry_fee_uqor: "0", topup_price_uqor: "0", topup_limit: 1, winner_shares: [10000], ends_at: nowSec + 86400 } };
const calldata = encodeCrossVmCalldata({ contract: AEGIS1, msg: JSON.stringify(msg) });
const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
console.log("msg:", JSON.stringify(msg));
console.log("result:", JSON.stringify(out, null, 2).slice(0, 1200));
