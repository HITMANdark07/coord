import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { pwaManifest } from "./pwa-manifest";

// Dev only: the browser reaches the local daemon through this proxy (no CORS, no public port).
// The proxy only forwards: the browser sends the daemon token itself (from the `pnpm wto web`
// link), so a local process that can reach this port gains nothing. Phones use the relay (Phase 4).
const daemonProxy: ProxyOptions = {
  target: `http://127.0.0.1:${process.env.WTO_PORT ?? "4545"}`,
  ws: true,
  rewrite: (path) => path.replace(/^\/api/, ""),
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      manifest: pwaManifest,
    }),
  ],
  // strictPort: the daemon's origin allowlist names these ports, so don't silently move.
  server: { port: 5173, strictPort: true, proxy: { "/api": daemonProxy } },
  preview: { port: 4173, strictPort: true, proxy: { "/api": daemonProxy } },
});
