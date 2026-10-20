import { describe, expect, test } from "vitest";
import { defaultSchema, defineSchema, hash, isBlank, toHtml, validate } from "../src/index.js";

const schema = defaultSchema();

function paragraph(...content: unknown[]): unknown {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

describe("validate", () => {
  test("refuses an unknown node and says where", () => {
    const result = validate(paragraph({ type: "sparkle", text: "x" }), schema);
    expect(result).toEqual({ ok: false, errors: [{ path: ["content", 0, "content", 0], message: 'unknown node type "sparkle"' }] });
  });

  test("refuses a link a browser would execute", () => {
    const result = validate(paragraph({ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toEqual({ path: ["content", 0, "content", 0, "marks", 0, "attrs", "href"], message: 'scheme "javascript" is not allowed' });
  });

  test("refuses marks a node does not allow", () => {
    const result = validate({ type: "doc", content: [{ type: "code_block", content: [{ type: "text", text: "x", marks: [{ type: "bold"}] }] }] }, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toBe('mark "bold" is not allowed on this node');
  });

  test("refuses content that does not satisfy the expression", () => {
    const result = validate({ type: "doc", content: [{ type: "bullet_list", content: [{ type: "paragraph" }] }] }, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toEqual({ path: ["content", 0, "content"], message: "bullet_list must hold list_item+, got paragraph" });
  });

  test("merges adjacent text runs and drops a duplicated mark", () => {
    const result = validate(paragraph({ type: "text", text: "a", marks: [{ type: "bold" }, { type: "bold" }] }, { type: "text", text: "b", marks: [{ type: "bold" }] }), schema);
    expect(result).toEqual({ ok: true, document: paragraph({ type: "text", text: "ab", marks: [{ type: "bold" }] }) });
  });

  test("stamps and checks the schema version", () => {
    const versioned = defineSchema({ version: 2, nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" } } });
    const ok = validate({ type: "doc", content: [{ type: "paragraph" }] }, versioned);
    expect(ok).toEqual({ ok: true, document: { type: "doc", content: [{ type: "paragraph" }], schema_version: 2 } });
    const stale = validate({ type: "doc", schema_version: 1, content: [{ type: "paragraph" }] }, versioned);
    expect(stale.ok).toBe(false);
  });

  test("refuses a document over the schema's bounds", () => {
    const small = defineSchema({ limits: { maxTextLength: 3 }, nodes: { doc: { content: "text*" } } });
    const result = validate({ type: "doc", content: [{ type: "text", text: "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧" }] }, small);
    expect(result).toEqual({ ok: false, errors: [{ path: [], message: "document holds more than 3 characters of text" }] });
  });
});

describe("hash", () => {
  test("is null for anything empty, and the documented digest otherwise", async () => {
    expect(await hash({ type: "doc", content: [{ type: "paragraph" }] })).toBeNull();
    expect(await hash(paragraph({ type: "text", text: "hi" }))).toBe("00dc4439f0dcbb463ab186b5b8f81b68e50d70a7b1e3538b86a13e532a17a65d");
  });
});

describe("isBlank", () => {
  test("sees through empty structure but not through a void node", () => {
    expect(isBlank({ type: "doc", content: [{ type: "paragraph", content: [{ type: "hard_break" }] }] }, schema)).toBe(true);
    expect(isBlank({ type: "doc", content: [{ type: "horizontal_rule" }] }, schema)).toBe(false);
  });
});

describe("untrusted rendering", () => {
  test("keeps the words of a stranger and drops where they point", () => {
    const document = paragraph(
      { type: "text", text: "see", marks: [{ type: "link", attrs: { href: "https://evil.test" } }] },
      { type: "image", attrs: { src: "https://evil.test/track.gif", alt: "a dot" } },
    );
    expect(toHtml(document, schema, { policy: "untrusted" })).toBe('<p>see<span class="coelho-image-alt">a dot</span></p>');
    expect(toHtml(document, schema)).toBe('<p><a href="https://evil.test">see</a><img src="https://evil.test/track.gif" alt="a dot"></p>');
  });
});
