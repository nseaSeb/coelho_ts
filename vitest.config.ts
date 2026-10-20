import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./aliases.js";

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
