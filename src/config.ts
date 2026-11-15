import { isAddress } from "viem";

import deployment from "../deployments/testnet.json";

/** EVM chain id of the QoreChain testnet (`qorechain-diana`). */
export const TESTNET_CHAIN_ID = 9800;

/** QoreChain block explorer (covers the testnet). */
export const EXPLORER_URL = "https://explore.qore.network";

/** The CrossVM Bridge precompile address. */
export const CROSS_VM_PRECOMPILE = deployment.crossVmPrecompile as `0x${string}`;

/** The allowlisted Native (CosmWasm) cw20 contract that holds the vesting ledger. */
export const NATIVE_TARGET = deployment.nativeTarget as string;

/**
 * The deployed QoreVest contract address, from deployments/testnet.json
 * (written by scripts/deploy.ts). Empty string means the contract has not
 * been deployed yet — the UI must not show claim buttons in that case.
 *
 * A malformed value is treated the same as unset: never trust a bad address.
 */
const raw = (deployment.contract ?? "").trim();

export const QORE_VEST_ADDRESS: `0x${string}` | "" = isAddress(raw)
  ? (raw as `0x${string}`)
  : "";

export const CONTRACT_DEPLOYED = QORE_VEST_ADDRESS !== "";

export const DEPLOY_TX_COSMOS = deployment.deployTxCosmos as string | undefined;
export const DEPLOY_TX_EVM = deployment.deployTx as string | undefined;
