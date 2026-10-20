import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./aliases.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/*/test/**/*.test.tsx", "scripts/**/*.test.ts"],
  },
});
