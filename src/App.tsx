import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  classifyEvmWindowRejection,
  evmWindowStatus,
  type EvmWindowRejection,
} from "@qorechain/evm";
import { addressesFrom20 } from "@qorechain/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { hexToBytes } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { qoreVestAbi } from "../contracts/QoreVest.artifact.js";
import {
  CONTRACT_DEPLOYED,
  CROSS_VM_PRECOMPILE,
  DEPLOY_TX_COSMOS,
  EXPLORER_URL,
  NATIVE_TARGET,
  QORE_VEST_ADDRESS,
  TESTNET_CHAIN_ID,
} from "./config.js";
import { USAGE_EVIDENCE } from "./evidence.js";

/** The contract address as wagmi wants it: a real address, or undefined when not deployed. */
const CONTRACT_ADDRESS: `0x${string}` | undefined =
  QORE_VEST_ADDRESS === "" ? undefined : QORE_VEST_ADDRESS;

const REMEDY: Record<EvmWindowRejection, string> = {
  "no-pqc-key": "This account has no registered ML-DSA-87 key. Register one on the native lane first.",
  "no-window": "No EVM authorisation window is open. Open one from QoreX, then retry.",
  exhausted: "The window has run out of blocks, transactions or value. Open a new one.",
  invalid: "The chain refused the window parameters.",
};

/**
 * The testnet REST API through the dev server's proxy (vite.config.ts):
 * the public REST endpoint sends no CORS headers. On a plain static host
 * (GitHub Pages) these reads fail and the sections degrade gracefully.
 */
const REST_PROXY = "/lcd-testnet";

const QVEST_DECIMALS = 6n;

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatQvest(value: bigint): string {
  const whole = value / 10n ** QVEST_DECIMALS;
  const frac = value % 10n ** QVEST_DECIMALS;
  const fracStr = frac.toString().padStart(Number(QVEST_DECIMALS), "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
}

function formatDate(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function explorerTx(cosmosHash: string): string {
  return `${EXPLORER_URL}/tx/${cosmosHash}`;
}

function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

/** The account's EVM authorisation window, read over the native-lane REST API. */
function WindowStatus({ address, chainId }: { address: `0x${string}`; chainId: number }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", chainId, address],
    queryFn: () => evmWindowStatus({ rest: REST_PROXY, address }),
    refetchInterval: 10_000,
    retry: false,
  });
  if (chainId !== TESTNET_CHAIN_ID) return <p>Switch to the QoreChain testnet to see the window.</p>;
  if (isLoading) return <p>Reading the EVM window…</p>;
  if (error)
    return (
      <p>
        Could not read the EVM window status from here (the testnet REST API
        sends no CORS headers on a static host). If you already opened a window
        from QoreX, you can still claim; otherwise open one from QoreX first.
      </p>
    );
  if (!data?.found) {
    return (
      <p>
        EVM window: none. Claims are refused until one is open — open an EVM
        window from QoreX, then retry.
      </p>
    );
  }
  if (!data.live) {
    return <p>EVM window: expired or exhausted. Open a new one from QoreX.</p>;
  }
  return (
    <p>
      EVM window: live — {data.remainingBlocks.toString()} blocks, {data.remainingTxs.toString()} transactions,{" "}
      {data.remainingValue.toString()} uqor left.
    </p>
  );
}

/**
 * The Native cw20 allowance the contract holds for this beneficiary — the
 * cross-VM vesting ledger. Read from the Native contract over the testnet
 * REST API's CosmWasm smart-query endpoint, through the dev proxy (the
 * public endpoints send no CORS headers, so the browser cannot query the
 * RPC or REST directly). If the read fails (static host), the section
 * degrades to a pointer at the verified evidence below.
 */
function NativeAllowance({ spender, contractNative }: { spender: string; contractNative: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["native-allowance", spender],
    queryFn: async () => {
      const query = encodeURIComponent(
        btoa(JSON.stringify({ allowance: { owner: contractNative, spender } })),
      );
      const res = await fetch(
        `${REST_PROXY}/cosmwasm/wasm/v1/contract/${NATIVE_TARGET}/smart/${query}`,
      );
      if (!res.ok) throw new Error(`allowance query failed: HTTP ${res.status}`);
      const json = (await res.json()) as { data: { allowance: string } };
      return BigInt(json.data.allowance);
    },
    retry: false,
    staleTime: 15_000,
  });
  if (isLoading) return <p>Reading the Native allowance…</p>;
  if (error || data === undefined)
    return (
      <p>
        Native allowance: could not be read from this host (the testnet APIs
        send no CORS headers on a static host). The verified allowance reads
        from the usage run are in the evidence section below.
      </p>
    );
  return (
    <p>
      Native allowance (WDT, owner = QoreVest): <strong>{formatQvest(data)} WDT</strong> — the
      cross-VM vesting ledger. It must always equal your total claimed QVEST.
    </p>
  );
}

type Schedule = [bigint, bigint, bigint, bigint, bigint, boolean];

function ClaimPanel({ address }: { address: `0x${string}` }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>("");
  const [claimHash, setClaimHash] = useState<string>("");
  // hexToBytes, not Buffer: Buffer is a Node API and does not exist in the
  // browser (this crashed the connected view until it was fixed).
  const nativeAddress = addressesFrom20(hexToBytes(address)).cosmos;
  const contractNative = QORE_VEST_ADDRESS
    ? addressesFrom20(hexToBytes(QORE_VEST_ADDRESS)).cosmos
    : "";

  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "balanceOf", args: [address] },
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "schedules", args: [address] },
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "vested", args: [address] },
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "claimable", args: [address] },
    ],
    query: { enabled: CONTRACT_DEPLOYED, refetchInterval: 10_000 },
  });
  const balance = (reads?.[0]?.result ?? 0n) as bigint;
  const schedule = (reads?.[1]?.result ?? [0n, 0n, 0n, 0n, 0n, false]) as Schedule;
  const vested = (reads?.[2]?.result ?? 0n) as bigint;
  const claimable = (reads?.[3]?.result ?? 0n) as bigint;
  const [amount, claimed, start, cliff, duration, exists] = schedule;
  const progress = amount > 0n ? Number((vested * 10000n) / amount) / 100 : 0;

  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (hash) setClaimHash(hash);
  }, [hash]);
  useEffect(() => {
    if (confirmed) {
      setStatus("Claim confirmed on chain.");
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ["native-allowance", nativeAddress] });
    }
  }, [confirmed, refetch, queryClient, nativeAddress]);
  useEffect(() => {
    if (error) {
      const rejection = classifyEvmWindowRejection(error);
      setStatus(
        rejection
          ? `Claim refused: ${REMEDY[rejection]}`
          : `Claim failed: ${error.message.slice(0, 200)}`,
      );
    }
  }, [error]);

  function claim(): void {
    if (!CONTRACT_ADDRESS) return;
    setStatus("Waiting for your wallet…");
    setClaimHash("");
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: qoreVestAbi,
      functionName: "claim",
      args: [nativeAddress],
    });
  }

  return (
    <section style={card}>
      <h2>Your vesting</h2>
      <p>
        EVM address: <code>{shorten(address)}</code>
        <br />
        Native address: <code>{nativeAddress}</code> (derived from your EVM address; the
        contract verifies this binding on chain before every claim)
      </p>
      <p>
        QVEST balance: <strong>{formatQvest(balance)} QVEST</strong>
      </p>
      <NativeAllowance spender={nativeAddress} contractNative={contractNative} />
      {!exists ? (
        <p>
          No vesting schedule for this account yet. The owner creates schedules;
          the demo schedules belong to the deployer accounts (see the evidence
          below).
        </p>
      ) : (
        <>
          <p>
            Schedule: <strong>{formatQvest(amount)} QVEST</strong> · start{" "}
            {formatDate(start)} · cliff {cliff.toString()}s · duration {duration.toString()}s
            <br />
            Vested: {formatQvest(vested)} QVEST · claimed: {formatQvest(claimed)} QVEST ·{" "}
            claimable now: <strong>{formatQvest(claimable)} QVEST</strong>
          </p>
          <div style={barOuter}>
            <div style={{ ...barInner, width: `${Math.min(progress, 100)}%` }} />
          </div>
          <p>{progress.toFixed(1)}% vested</p>
          <button style={button} onClick={claim} disabled={isPending || claimable === 0n}>
            {isPending ? "Claiming…" : claimable === 0n ? "Nothing claimable yet" : `Claim ${formatQvest(claimable)} QVEST`}
          </button>
          <p style={{ fontSize: "0.9em", color: "#94a3b8" }}>
            One atomic transaction: QVEST is released on the EVM side and the
            Native cw20 allowance is increased by the same amount through the
            cross-VM bridge precompile. If the Native leg fails, the whole
            claim reverts and nothing moves.
          </p>
        </>
      )}
      {status && <p>{status}</p>}
      {claimHash && (
        <p>
          Claim transaction (EVM hash): <code>{claimHash}</code>
        </p>
      )}
    </section>
  );
}

function OwnerPanel({ address }: { address: `0x${string}` }) {
  const { data: owner } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: qoreVestAbi,
    functionName: "owner",
    query: { enabled: CONTRACT_DEPLOYED },
  });
  const [beneficiary, setBeneficiary] = useState("");
  const [amount, setAmount] = useState("10000");
  const [cliff, setCliff] = useState("0");
  const [duration, setDuration] = useState("86400");
  const [status, setStatus] = useState("");
  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (confirmed) setStatus("Schedule created.");
  }, [confirmed]);
  useEffect(() => {
    if (error) {
      const rejection = classifyEvmWindowRejection(error);
      setStatus(
        rejection
          ? `Refused: ${REMEDY[rejection]}`
          : `Failed: ${error.message.slice(0, 200)}`,
      );
    }
  }, [error]);

  if (!owner || (owner as string).toLowerCase() !== address.toLowerCase()) return null;
  return (
    <section style={card}>
      <h2>Owner: create a vesting schedule</h2>
      <p style={{ fontSize: "0.9em", color: "#94a3b8" }}>
        You are connected as the contract owner. One schedule per beneficiary;
        the start is the current block time.
      </p>
      <label style={label}>
        Beneficiary (0x…)
        <input style={input} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="0x…" />
      </label>
      <label style={label}>
        Amount (QVEST)
        <input style={input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <label style={label}>
        Cliff (seconds)
        <input style={input} value={cliff} onChange={(e) => setCliff(e.target.value)} inputMode="numeric" />
      </label>
      <label style={label}>
        Duration (seconds)
        <input style={input} value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" />
      </label>
      <button
        style={button}
        disabled={isPending}
        onClick={() => {
          if (!CONTRACT_ADDRESS) return;
          setStatus("Waiting for your wallet…");
          const value = BigInt(Math.round(Number(amount) * 1e6));
          writeContract({
            address: CONTRACT_ADDRESS,
            abi: qoreVestAbi,
            functionName: "createVesting",
            args: [beneficiary as `0x${string}`, value, BigInt(Math.floor(Date.now() / 1000)), BigInt(cliff), BigInt(duration)],
          });
        }}
      >
        {isPending ? "Creating…" : "Create schedule"}
      </button>
      {status && <p>{status}</p>}
      {hash && (
        <p>
          Transaction: <code>{hash}</code>
        </p>
      )}
    </section>
  );
}

function Evidence() {
  if (!USAGE_EVIDENCE) return null;
  return (
    <section style={card}>
      <h2>Verified on-chain evidence</h2>
      <p>
        The evidence below — the usage run (
        {new Date(USAGE_EVIDENCE.ranAt).toLocaleString("en-GB")}) plus later
        on-chain runs — covers the full flow on the Diana testnet: five
        schedules, six claims, two forced reverts. Every claim verified the
        invariant{" "}
        <code>allowance(QoreVest, beneficiary) == total claimed</code> by reading
        the Native contract after the transaction.
      </p>
      <ul>
        {USAGE_EVIDENCE.steps.map((s, i) => (
          <li key={i} style={{ marginBottom: "0.5em" }}>
            <strong>{s.action}</strong>
            {s.beneficiary ? ` — ${shorten(s.beneficiary)}` : ""}
            {s.claimedTotal !== undefined ? ` — total claimed ${formatQvest(BigInt(s.claimedTotal))} QVEST` : ""}
            {s.amount !== undefined ? ` — ${formatQvest(BigInt(s.amount))} QVEST` : ""}
            {s.invariantHolds !== undefined ? ` — Native invariant ${s.invariantHolds ? "holds ✓" : "BROKEN ✗"}` : ""}
            {s.stateUnchanged !== undefined ? ` — state unchanged ${s.stateUnchanged ? "✓" : "✗"}` : ""}
            {s.status ? ` — ${s.status}` : ""}
            <br />
            {s.cosmosTx && (
              <a href={explorerTx(s.cosmosTx)} target="_blank" rel="noreferrer">
                explorer ↗
              </a>
            )}{" "}
            {s.evmTx && <code style={{ fontSize: "0.8em" }}>{shorten(s.evmTx)}</code>}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: "0.9em", color: "#94a3b8" }}>
        The full evidence file (both hashes for every transaction) is{" "}
        <code>deployments/usage.json</code> in the repository.
      </p>
    </section>
  );
}

export function App() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  const { data: totals } = useReadContracts({
    contracts: [
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "totalSupply" },
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "totalLocked" },
      { address: CONTRACT_ADDRESS, abi: qoreVestAbi, functionName: "owner" },
    ],
    query: { enabled: CONTRACT_DEPLOYED, refetchInterval: 15_000 },
  });
  const totalSupply = totals?.[0]?.result as bigint | undefined;
  const totalLocked = totals?.[1]?.result as bigint | undefined;
  const owner = totals?.[2]?.result as string | undefined;

  const onTestnet = chainId === TESTNET_CHAIN_ID;

  return (
    <div style={page}>
      <header style={header}>
        <div>
          <h1 style={{ margin: 0 }}>QoreVest</h1>
          <p style={{ margin: "0.25em 0 0", color: "#94a3b8" }}>
            An EVM token with Native vesting — claims settle atomically across
            the EVM and Native VMs on the QoreChain testnet.
          </p>
        </div>
        <ConnectButton />
      </header>

      <main style={main}>
        {!CONTRACT_DEPLOYED ? (
          <section style={card}>
            <p>The QoreVest contract has not been deployed yet.</p>
          </section>
        ) : (
          <>
            <section style={card}>
              <h2>Contract</h2>
              <p>
                QoreVest (QVEST):{" "}
                <a href={explorerAddress(QORE_VEST_ADDRESS)} target="_blank" rel="noreferrer">
                  {QORE_VEST_ADDRESS}
                </a>
                <br />
                Total supply: {totalSupply === undefined ? "…" : `${formatQvest(totalSupply)} QVEST`} · locked in schedules:{" "}
                {totalLocked === undefined ? "…" : `${formatQvest(totalLocked)} QVEST`}
                <br />
                Owner: {owner ? <code>{shorten(owner)}</code> : "…"}
                <br />
                Cross-VM precompile: <code>{CROSS_VM_PRECOMPILE}</code>
                <br />
                Native target (allowlisted cw20): <code>{NATIVE_TARGET}</code>
                <br />
                {DEPLOY_TX_COSMOS && (
                  <>
                    Deploy transaction:{" "}
                    <a href={explorerTx(DEPLOY_TX_COSMOS)} target="_blank" rel="noreferrer">
                      explorer ↗
                    </a>
                  </>
                )}
              </p>
            </section>

            {isConnected && address ? (
              <>
                {!onTestnet && (
                  <section style={card}>
                    <p>
                      You are connected to chain {chainId}. QoreVest lives on
                      the QoreChain testnet (chain id {TESTNET_CHAIN_ID}).
                    </p>
                    <button style={button} onClick={() => switchChain({ chainId: TESTNET_CHAIN_ID })}>
                      Switch to the QoreChain testnet
                    </button>
                  </section>
                )}
                <section style={card}>
                  <h2>EVM window</h2>
                  <WindowStatus address={address} chainId={chainId ?? 0} />
                </section>
                <ClaimPanel address={address} />
                <OwnerPanel address={address} />
              </>
            ) : (
              <section style={card}>
                <p>Connect a wallet (QoreX recommended) to see your vesting schedule and claim.</p>
              </section>
            )}

            <section style={card}>
              <h2>How it works</h2>
              <p>
                QVEST is minted on the EVM side and locked in the QoreVest
                contract. The owner creates a vesting schedule per beneficiary
                (cliff + linear release). When a beneficiary claims, one atomic
                transaction does two things: it releases the vested QVEST on
                the EVM side, and it calls the cross-VM bridge precompile (
                <code>0x…0901</code>) to increase the beneficiary&apos;s
                allowance on the allowlisted Native cw20 contract by exactly
                the claimed amount. The Native contract therefore holds a
                cross-VM vesting ledger with the invariant{" "}
                <code>allowance(QoreVest, beneficiary) == total claimed</code>.
                The claim also verifies on chain that the Native address the
                caller passes is the bech32 encoding of their own EVM address
                — nobody can mirror a claim to someone else&apos;s Native
                account. If the Native leg fails, the whole claim reverts and
                no QVEST moves (proven by the test suite and by the forced
                revert in the evidence below).
              </p>
              <p style={{ fontSize: "0.9em", color: "#94a3b8" }}>
                Honest limitation: no vesting contract is on the cross-VM
                allowlist today, so the schedule itself is enforced by the EVM
                contract and the Native leg is a ledger/attestation, not the
                schedule enforcer. The WDT vault on this testnet is unfunded,
                so the Native allowance is a verifiable record, not a spendable
                release. See the README for the full design note.
              </p>
            </section>

            <Evidence />

            <footer style={{ color: "#64748b", fontSize: "0.9em", padding: "1em 0" }}>
              <p>
                QoreVest — a QoreChain Developer Fest entry (Cross-VM
                category). Testnet only; QVEST has no value. Source:{" "}
                <a
                  href="https://github.com/andiPangeranm142/qore-vest"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/andiPangeranm142/qore-vest
                </a>
              </p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0f172a",
  color: "#e2e8f0",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1em",
  flexWrap: "wrap",
  padding: "1.5em 1.5em 0",
  maxWidth: "900px",
  margin: "0 auto",
};

const main: React.CSSProperties = {
  maxWidth: "900px",
  margin: "0 auto",
  padding: "1.5em",
};

const card: React.CSSProperties = {
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: "12px",
  padding: "1.25em 1.5em",
  marginBottom: "1em",
};

const button: React.CSSProperties = {
  background: "#059669",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "0.75em 1.25em",
  fontSize: "1em",
  cursor: "pointer",
};

const barOuter: React.CSSProperties = {
  background: "#0f172a",
  borderRadius: "6px",
  height: "12px",
  overflow: "hidden",
};

const barInner: React.CSSProperties = {
  background: "#10b981",
  height: "100%",
  transition: "width 0.3s",
};

const label: React.CSSProperties = {
  display: "block",
  marginBottom: "0.75em",
  fontSize: "0.95em",
};

const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  marginTop: "0.25em",
  padding: "0.5em",
  borderRadius: "6px",
  border: "1px solid #475569",
  background: "#0f172a",
  color: "#e2e8f0",
  fontSize: "1em",
};
