import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The public REST APIs send no CORS headers, so the browser reaches them
// through the dev (and preview) server: /lcd-testnet is forwarded to the
// testnet REST endpoint (see REST_PROXY in src/App.tsx). In production,
// serve the app behind a proxy that does the same.
const rest = (target: string) => ({
  target,
  changeOrigin: true,
  rewrite: (p: string) => p.replace(/^\/lcd-testnet/, ""),
});
const proxy = {
  "/lcd-testnet": rest("https://api-testnet.qore.host"),
};

export default defineConfig({
  plugins: [react()],
  // The live demo is served from the /qore-vest/ subpath on GitHub Pages —
  // WITHOUT this base, a plain `npm run build` emits root-absolute asset
  // URLs (/assets/...) that 404 on the live site. (Quantum Flip broke its
  // demo this way on 15 Nov 2026; the base is part of the config here from
  // day one so it cannot happen again.)
  base: "/qore-vest/",
  server: { port: 5174, proxy },
  preview: { proxy },
});
