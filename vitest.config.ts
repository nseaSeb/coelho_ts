import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./aliases.js";

export default defineConfig({
  resolve: { alias: workspaceAliases, dedupe: ["yjs"] },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
