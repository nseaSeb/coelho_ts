import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { canonical, defaultSchema, extendSchema, hash, toHtml, toInlineHtml, toText, validate, type Schema } from "../src/index.js";

// The fixture is coelho's own: documents with the bytes the Elixir
// implementation produced from them. Every entry has to come out of this
// implementation identical, which is what makes the two interchangeable in
// front of the same database.
interface Entry {
  name: string;
  schema: string;
  document: unknown;
  canonical: string;
  hash: string;
  html: string;
  inline_html: string;
  text: string;
}

const entries = JSON.parse(readFileSync(new URL("../../../fixtures/corpus.json", import.meta.url), "utf8")) as Entry[];

// The schema coelho's corpus extends the default with: a mark drawn from its
// declaration, a void node standing for something the page substitutes, and
// a block with a class of its own.
const extended = extendSchema(defaultSchema(), {
  nodes: {
    variable: {
      group: "inline",
      inline: true,
      void: true,
      attrs: {
        name: { required: true, validate: { oneOf: ["number", "customer"] } },
        label: { default: null, validate: { nullable: "string" } },
      },
      class: "variable",
      render: ["span", [["data-variable", ""]]],
      editorText: "label",
    },
    callout: { content: "block+", group: "block", class: "callout", render: ["aside", []], parse: ["aside"] },
  },
  marks: { highlight: { class: "hl", render: ["mark", []] } },
});

const schemas: Record<string, Schema> = { default: defaultSchema(), extended };
const context = { resolve: { kept: "/attachments/kept" } };

describe.each(entries)("$name", (entry) => {
  const schema = schemas[entry.schema] as Schema;
  const result = validate(entry.document, schema);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const document = result.document;

  test("normalises to the bytes it did", () => {
    expect(canonical(document)).toBe(entry.canonical);
  });

  test("hashes to what was stored", async () => {
    expect(await hash(document)).toBe(entry.hash);
  });

  test("renders the same page", () => {
    expect(toHtml(document, schema, { context })).toBe(entry.html);
    expect(toInlineHtml(document, schema, { context })).toBe(entry.inline_html);
  });

  test("extracts the same text", () => {
    expect(toText(document, schema)).toBe(entry.text);
  });

  test("is unchanged by validating it again", () => {
    const again = validate(document, schema);
    expect(again).toEqual({ ok: true, document });
  });
});
