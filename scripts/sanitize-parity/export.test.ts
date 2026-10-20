import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { canonical, defaultSchema, sanitize } from "../../packages/core/src/index.js";
import { hostile, mutated } from "../../packages/core/test/hostile.js";

// Writes the fuzz cases with what this implementation makes of them, for
// compare.exs to replay through coelho's Elixir sanitize. Run on demand:
//   SANITIZE_PARITY_OUT=/tmp/cases.json pnpm vitest run scripts/sanitize-parity
const out = process.env.SANITIZE_PARITY_OUT;

test.skipIf(out === undefined)("export sanitize cases", () => {
  const schema = defaultSchema();
  const cases = [
    ...Array.from({ length: 500 }, (_, i) => ({ name: `hostile ${i + 1}`, input: hostile(i + 1) })),
    ...Array.from({ length: 300 }, (_, i) => ({ name: `mutated ${i + 1}`, input: mutated(i + 1) })),
  ].map((entry) => ({ ...entry, canonical: canonical(sanitize(entry.input, schema)) }));
  writeFileSync(out as string, JSON.stringify(cases));
  expect(cases).toHaveLength(800);
});
