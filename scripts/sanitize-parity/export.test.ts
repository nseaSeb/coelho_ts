import { writeFileSync } from "node:fs";
import { buildDefaultSchema, canonical, defaultSchema, sanitize, toMarkdown, validate } from "../../packages/core/src/index.js";
import { hostile, mutated } from "../../packages/core/test/hostile.js";
import { generator } from "../../packages/prosemirror/test/markdownDocuments.js";
import { expect, test } from "vitest";

// Writes generated cases with what this implementation makes of them, for
// compare.exs to replay through coelho's Elixir. Run on demand:
//   SANITIZE_PARITY_OUT=/tmp/cases.json pnpm vitest run scripts/sanitize-parity
const out = process.env.SANITIZE_PARITY_OUT;

test.skipIf(out === undefined)("export parity cases", () => {
  const schema = defaultSchema();
  const tables = buildDefaultSchema({ tables: true });
  const sanitizeCases = [
    ...Array.from({ length: 500 }, (_, i) => ({ name: `hostile ${i + 1}`, input: hostile(i + 1) })),
    ...Array.from({ length: 300 }, (_, i) => ({ name: `mutated ${i + 1}`, input: mutated(i + 1) })),
  ].map((entry) => ({ kind: "sanitize", ...entry, expected: canonical(sanitize(entry.input, schema)) }));
  const markdownCases = Array.from({ length: 800 }, (_, i) => {
    const result = validate(generator(i + 1).document(), tables);
    return result.ok ? { kind: "markdown", name: `markdown ${i + 1}`, input: result.document, expected: toMarkdown(result.document, tables) } : null;
  }).filter((entry) => entry !== null);
  writeFileSync(out as string, JSON.stringify([...sanitizeCases, ...markdownCases]));
  expect(markdownCases.length).toBeGreaterThan(400);
});
