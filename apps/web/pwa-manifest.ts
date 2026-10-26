import type { ManifestOptions } from "vite-plugin-pwa";

/** Web app manifest: what makes the PWA installable on phones (PRD FR-47). */
export const pwaManifest: Partial<ManifestOptions> = {
  name: "Worktree Orchestrator",
  short_name: "wto",
  description: "Run and steer coding agents in parallel worktrees",
  theme_color: "#4f46e5",
  background_color: "#ffffff",
  display: "standalone",
  start_url: "/",
  icons: [
    { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
    { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
    { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
