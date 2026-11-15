// Identify the 3 allowlisted cross-VM target contracts on Diana testnet.
// Read-only: queries contract info + probes standard CosmWasm queries.
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";

const RPC = "https://rpc-testnet.qore.host";
const TARGETS = [
  "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt", // code 1
  "qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd", // code 5
  "qor1nc5tatafv6eyq7llkr2gv50ff9e22mnf70qgjlv737ktmt4eswrqfye7zd", // code 6
];

const client = await CosmWasmClient.connect(RPC);
console.log("connected, height:", await client.getHeight());

for (const addr of TARGETS) {
  console.log("\n=====", addr, "=====");
  try {
    const info = await client.getContract(addr);
    console.log("codeId:", info.codeId, "| creator:", info.creator, "| admin:", info.admin, "| label:", JSON.stringify(info.label));
  } catch (e) {
    console.log("getContract FAILED:", e.message);
    continue;
  }
  // Probe standard queries to identify the contract type.
  const probes = [
    ["cw20 token_info", { token_info: {} }],
    ["cw721/cw20 contract_info", { contract_info: {} }],
    ["cw4 total_weight", { total_weight: {} }],
    ["cw3 threshold", { threshold: {} }],
    ["vesting info", { info: {} }],
  ];
  for (const [name, q] of probes) {
    try {
      const res = await client.queryContractSmart(addr, q);
      console.log(`  [${name}] OK:`, JSON.stringify(res).slice(0, 300));
    } catch (e) {
      console.log(`  [${name}] no:`, String(e.message).slice(0, 120));
    }
  }
}
for (const codeId of [1, 5, 6]) {
  try {
    const code = await client.getCodeDetails(codeId);
    console.log(`\ncode ${codeId}: checksum=${code.checksum} creator=${code.creator} source=${code.source || "(none)"} builder=${code.builder || "(none)"}`);
  } catch (e) {
    console.log(`\ncode ${codeId}: FAILED:`, e.message);
  }
}
client.disconnect();
