# Demo Video Plan — QoreVest

The fest submission requires a demo video (max 3 minutes) showing the
project actually running. This file is the recording plan. The recording
happens **after** the testnet deployment, because the video must show the
real app and a real testnet transaction — no slideshows, no mock-ups.

## Prerequisites (before recording)

- [x] Contract deployed on `qorechain-diana`; address in
      `deployments/testnet.json` (the app reads it from there).
- [x] Preview server running: `npm run build`, then
      `node ../video/serve.mjs` (serves `http://127.0.0.1:4180/qore-vest/`
      with a working `/lcd-testnet` proxy — the recording uses the local
      server so the EVM window-status panel and the Native allowance
      panel can read the testnet REST API through the proxy; the live
      Pages site cannot, no CORS headers — and both panels are part of
      the story). `vite preview` does NOT work for this in the sandbox:
      its http-proxy opens a raw TLS connection that ignores the egress
      proxy and every proxied request 500s; `serve.mjs` forwards with
      Node's fetch instead.
- [x] A fresh video account (testnet only): funded with 1.5 test QOR,
      PQC key registered, fresh EVM window (1200 blocks, 5 txs), and a
      fresh vesting schedule (25,000 QVEST, no cliff, 300 s) created
      just before the take. See `~/workspace/qorechain/qore-vest/video/`
      (`gen-video-wallet.mjs`, `setup-video-account.mjs`,
      `wallet-bridge.mjs`, `record.mjs`) — the take used an injected EVM
      wallet instead of the QoreX extension, with the key held in Node
      and never entering the page.
- [x] Browser window 1920×1080, screen recording at 1080p, system audio
      off, notifications silenced.
- [x] Explorer tab ready: https://explore.qore.network (Testnet).

## Scenes (final cut: 1:47 total — 96.6 s take + 10 s title card)

| # | Time | What is shown | Narration (burned-in caption) |
| --- | --- | --- | --- |
| 1 | 0:02–0:17 | App loaded, unconnected state. | "QoreVest is an EVM token with Native vesting on the QoreChain testnet. Claims settle atomically across both VMs." |
| 2 | 0:17–0:40 | Click Connect, choose Injected Wallet, account appears. Window status reads "live". The vesting schedule shows: 25,000 QVEST, claimable amount, progress. | "I connect on the testnet. My EVM window is live, and my schedule shows what has vested so far." |
| 3 | 0:40–0:55 | Click "Claim … QVEST". Pending state, then "Claim confirmed on chain", the transaction hash, updated balance, and the Native allowance matching the claimed amount. | "One claim, one atomic transaction: QVEST is released on the EVM side and the Native allowance is mirrored by the same amount." |
| 4 | 0:55–1:19 | Click the transaction hash; the explorer opens on the testnet showing the confirmed transaction and its MsgEthereumTx. | "Here is the same claim on the explorer: confirmed on qorechain-diana." |
| 5 | 1:19–1:37 | Back in the app: the vesting panel after the claim — claimed total, Native allowance, progress. | "The schedule, the balance, and the Native ledger all agree — that is the cross-VM invariant." |
| 6 | 1:37–1:47 | Title card (featured.png) with the claim hashes in full. | "QoreVest — one atomic claim, two VMs." |

## Rules for the recording

- Show the **real** app and **real** transactions only. If a claim fails
  on camera (e.g. the window expired), keep recording, open a new window,
  and claim again — do not cut to a fake success.
- Do not show any seed phrase, private key, or `.env` file at any point.
  The recording account is a testnet-only account.
- Keep it under 3:00. If a take runs long, trim scene 5, never scenes
  2–4 (the proof is in the live claim and the explorer).
- Export as MP4 (H.264, 1080p). Attach the file to the fest submission
  and keep a copy at `docs/demo.mp4` in this repo.

## After recording

- [x] Watch the full video once: captions readable, all hashes legible,
      total length ≤ 3:00. (Verified 16 Nov 2026: frames at 5s, 25s,
      45s, 60s, 85s, 101s all checked — the claim frame shows balance
      25,000 QVEST, Native allowance 25,000 WDT, claimed 25,000 QVEST;
      the explorer frame shows status success, block #10,153,462,
      MsgEthereumTx; no secrets visible anywhere.)
- [x] Update this file with the final length and the transaction hashes
      shown in the video.

Final cut: `docs/demo.mp4`, **106.6 s (1:47)**, 1920×1080, H.264, 25 fps,
5.1 MB. Claim shown on camera (video account, 25,000 QVEST, fully
vested): EVM
`0x95d0dcbe979252dabb636911e95da4d3ce8c0be2fc0d28d6521db8ca598bbdb2`,
Cosmos `387A7DF2673D9ECE685A18D78505D4542C4CF1DDA957A586D092F3ED75A8661E`
(block 10153462). The Native allowance for the video account was read
back after the claim: 25,000 WDT — the invariant holds on camera.
