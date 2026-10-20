import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { workspaceAliases } from "../../../aliases.js";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: workspaceAliases, dedupe: ["yjs"] },
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
  server: {
    port: 5181,
    // In development the server runs apart; in production it serves this app itself.
    proxy: {
      "/api": "http://localhost:1234",
      "/collab": { target: "ws://localhost:1234", ws: true },
    },
  },
});
