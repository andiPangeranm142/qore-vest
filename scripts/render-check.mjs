/**
 * render-check.mjs - verify the built demo renders without errors.
 *
 * Usage: npm run build, then `npx vite preview --port 4173` in one shell
 * and `node scripts/render-check.mjs [url]` in another. Defaults to the
 * local preview URL. Pass the live GitHub Pages URL to check the deployed
 * site instead.
 *
 * Exits non-zero if the page shows a fatal error, if any console error or
 * page error occurs, or if the expected content is missing. Writes a
 * screenshot to /tmp/qv-render.png.
 *
 * Playwright is not a dependency of this repo: it is resolved from the
 * shared install at ~/workspace/codegeist/video-recorder/node_modules
 * via createRequire (NODE_PATH does not work for ESM imports).
 *
 * Chromium cannot use the VM's egress proxy directly (it resolves only to
 * an IPv6 address, and the proxy MITM-signs TLS with its own CA), so the
 * script runs the same localhost TCP forwarder the video-recorder uses
 * (127.0.0.1:3129 -> proxy IPv6:3128) and launches Chromium through it
 * with ignoreHTTPSErrors. Without this, the app's RPC reads fail with
 * ERR_TUNNEL_CONNECTION_FAILED and the live totals show "…".
 */
import { createRequire } from "node:module";
import net from "node:net";
import dns from "node:dns/promises";

const require = createRequire("/home/hatch/workspace/codegeist/video-recorder/package.json");
const { chromium } = require("playwright");

async function startForwarder(localPort = 3129) {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || "";
  const u = new URL(raw);
  const target = await dns.lookup(u.hostname, { family: 6 });
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.address, port: Number(u.port) || 3128 });
    client.pipe(upstream);
    upstream.pipe(client);
    const onErr = () => { client.destroy(); upstream.destroy(); };
    client.on("error", onErr);
    upstream.on("error", onErr);
  });
  await new Promise((resolve, reject) => {
    server.listen(localPort, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  return server;
}

const url = process.argv[2] ?? "http://localhost:4173/qore-vest/";
const screenshotPath = process.argv[3] ?? "/tmp/qv-render.png";

const forwarder = await startForwarder();
const browser = await chromium.launch({
  proxy: { server: "http://127.0.0.1:3129", bypass: "localhost,127.0.0.1" },
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true, // egress proxy MITM-signs TLS (see header)
});
const page = await context.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`));

await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: screenshotPath, fullPage: true });

const text = await page.evaluate(() => document.body.innerText);
const checks = {
  "title QoreVest": text.includes("QoreVest"),
  "contract section": text.includes("Contract"),
  "contract address": text.includes("0x67e4862c388a5ead666f5ac340fe9ef2fc1f8f68"),
  "live total supply (1,000,000 QVEST)": text.includes("1,000,000.00 QVEST"),
  // Both demo schedules are fully claimed, so totalLocked is 0 — the read
  // succeeding (rather than showing "…") is what this check proves.
  "live locked total (0.00 QVEST, schedules fully claimed)": text.includes("locked in schedules: 0.00 QVEST"),
  "how it works": text.includes("How it works"),
  "connect prompt": text.includes("Connect a wallet"),
  "evidence section": text.includes("Verified on-chain evidence"),
  "no fatal error text": !/something went wrong|failed to load|white screen/i.test(text),
};
let ok = true;
for (const [name, passed] of Object.entries(checks)) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (!passed) ok = false;
}
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors) console.log(`  ${e}`);
  ok = false;
} else {
  console.log("PASS no console/page/request errors");
}
console.log(`screenshot: ${screenshotPath}`);
await browser.close();
forwarder.close();
process.exit(ok ? 0 : 1);
