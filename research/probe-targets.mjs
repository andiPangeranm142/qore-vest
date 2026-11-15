// Probe the allowlisted Native contracts through the cross-VM precompile.
// Read-only eth_call: payload `{}` forces each contract to report its
// ExecuteMsg variants in the parse error. Also queries WDT minter info.
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { encodeCrossVmCalldata, CROSS_VM_PRECOMPILE } from "@qorechain/rdk";

const EVM_RPC = "https://evm-testnet.qore.host";
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
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

// 1. WDT minter + marketing info (CosmJS smart queries).
const cw = await CosmWasmClient.connect("https://rpc-testnet.qore.host");
try {
  const minter = await cw.queryContractSmart(WDT, { minter: {} });
  console.log("WDT minter:", JSON.stringify(minter));
} catch (e) {
  console.log("WDT minter query failed:", e.message.slice(0, 200));
}
try {
  const marketing = await cw.queryContractSmart(WDT, { marketing_info: {} });
  console.log("WDT marketing:", JSON.stringify(marketing).slice(0, 300));
} catch (e) {
  console.log("WDT marketing query failed:", e.message.slice(0, 200));
}
// Check WDT balance of a few plausible holder addresses (creator + our deployer).
for (const [label, addr] of [
  ["wdt creator", "qor1sxsu7z3r8wgw3623nxpqwgq8q4hz5g92vnkk48"],
  ["our deployer", "qor1ra4qne4vj632aqpg9zce6vds9p9cgxua2lsmny"],
]) {
  try {
    const bal = await cw.queryContractSmart(WDT, { balance: { address: addr } });
    console.log(`WDT balance ${label} (${addr}):`, JSON.stringify(bal));
  } catch (e) {
    console.log(`WDT balance ${label} failed:`, e.message.slice(0, 150));
  }
}
cw.disconnect();

// 2. eth_call through the precompile with an empty payload to learn ExecuteMsg variants.
for (const [label, target] of [["WDT", WDT], ["AEGIS1", AEGIS1], ["AEGIS2", AEGIS2]]) {
  const calldata = encodeCrossVmCalldata({ contract: target, msg: "{}" });
  console.log(`\n--- ${label} precompile eth_call (payload {}) ---`);
  console.log("calldata:", calldata.slice(0, 80) + "...");
  const out = await ethCall(CROSS_VM_PRECOMPILE, calldata);
  console.log(JSON.stringify(out, null, 2).slice(0, 2000));
}
