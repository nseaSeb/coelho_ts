import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { workspaceAliases } from "../../aliases.js";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves the demo under the repository's name.
  base: process.env.DEMO_BASE ?? "/",
  // One copy of yjs: two would break the instanceof checks it relies on,
  // the one marking undo transactions among them.
  resolve: { alias: workspaceAliases, dedupe: ["yjs"] },
  server: { port: 5180 },
});
