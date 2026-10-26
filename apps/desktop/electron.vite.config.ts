import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages are devDependencies on purpose: electron-vite bundles them (they ship as TS source)
// instead of leaving them as runtime requires.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
