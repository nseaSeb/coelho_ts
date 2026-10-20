import { fileURLToPath } from "node:url";

// The workspace packages point their exports at `dist/`, which is what a
// consumer installs. Inside the repo, the demo and the tests read the
// sources instead, so nothing has to be built before `pnpm dev` or `pnpm test`.
const source = (name: string): string => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export const workspaceAliases = {
  "@coelho/core": source("core"),
  "@coelho/prosemirror": source("prosemirror"),
  "@coelho/react": source("react"),
  "@coelho/collab": source("collab"),
};
