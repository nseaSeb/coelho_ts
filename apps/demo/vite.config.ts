import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { workspaceAliases } from "../../aliases.js";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases },
  server: { port: 5180 },
});
