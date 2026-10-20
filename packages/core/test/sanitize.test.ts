import { describe, expect, test } from "vitest";
import { defaultSchema, defineSchema, emptyDocument, extendSchema, sanitize, textLength, toHtml, toText, validate, type Limits, type Node } from "../src/index.js";
import { base, hostile, mutated } from "./hostile.js";

// Ported from coelho's test/coelho/sanitize_test.exs, case for case.
const schema = defaultSchema();

const doc = (content: unknown[]): Node => ({ type: "doc", content }) as Node;
const paragraph = (content: unknown): Node => ({ type: "paragraph", content }) as Node;
const text = (value: string, marks?: unknown[]): Node => (marks === undefined ? { type: "text", text: value } : ({ type: "text", text: value, marks } as Node));
const valid = (document: unknown): boolean => validate(document, schema).ok;
const html = (document: unknown): string => toHtml(sanitize(document, schema), schema);

describe("an attribute over the bound, on the way out", () => {
  test("is dropped, and a required one takes its node with it", () => {
    const long = "y".repeat(20_000);
    const document = doc([paragraph([text("kept"), { type: "image", attrs: { src: "/a.png", alt: long } }]), paragraph([{ type: "image", attrs: { src: `/${long}` } }])]);
    const cut = sanitize(document, schema);
    const inline = (cut.content ?? []).flatMap((block) => block.content ?? []);
    expect(inline.some((node) => node.type === "image" && node.attrs?.alt === undefined) || inline.every((node) => node.type !== "image")).toBe(true);
    expect(toText(cut, schema)).toContain("kept");

    const lifted = sanitize(document, schema, { limits: { maxAttrLength: Infinity } });
    const kept = (lifted.content ?? []).flatMap((block) => block.content ?? []);
    expect(kept.filter((node) => node.type === "image")).toHaveLength(2);
    expect(kept.some((node) => node.attrs?.alt === long)).toBe(true);
  });
});

describe("what it keeps", () => {
  test("a document that already validates comes back normalised and unchanged", () => {
    const result = validate(doc([paragraph([text("hello")])]), schema);
    if (!result.ok) throw new Error("expected a valid document");
    expect(sanitize(result.document, schema)).toEqual(result.document);
  });

  test("sanitising twice is sanitising once", () => {
    const once = sanitize(doc([{ type: "script", content: [text("x")] }, paragraph([text("kept", [{ type: "evil" }])])]), schema);
    expect(sanitize(once, schema)).toEqual(once);
  });
});

describe("what it removes", () => {
  test("a key the schema does not know", () => {
    const sanitized = sanitize(doc([{ ...paragraph([text("kept")]), onclick: "alert(1)" }]), schema);
    expect(sanitized.content?.[0]).not.toHaveProperty("onclick");
    expect(toText(sanitized, schema)).toBe("kept");
  });

  test("an attribute failing its validator, leaving the schema default", () => {
    expect(html(doc([{ type: "heading", attrs: { level: 99 }, content: [text("T")] }]))).toBe("<h1>T</h1>");
  });

  test("a link whose href the browser would execute, keeping the text", () => {
    expect(html(doc([paragraph([text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])])]))).toBe("<p>click</p>");
  });

  test("a mark the schema has never heard of, keeping the text", () => {
    expect(html(doc([paragraph([text("x", [{ type: "blink" }])])]))).toBe("<p>x</p>");
  });

  test("a node whose type is unknown, and the text inside it", () => {
    expect(html(doc([{ type: "script", content: [text("alert(1)")] }, paragraph([text("kept")])]))).toBe("<p>kept</p>");
  });

  test("a node whose content cannot satisfy its content expression", () => {
    expect(html(doc([{ type: "bullet_list", content: [] }, paragraph([text("kept")])]))).toBe("<p>kept</p>");
  });

  test("a mark sitting where the node forbids every mark", () => {
    expect(html(doc([{ type: "code_block", content: [text("x", [{ type: "bold" }])] }]))).toBe("<pre><code>x</code></pre>");
  });
});

describe("a repair the error path cannot express", () => {
  test("a node missing a required attribute goes, and its siblings stay", () => {
    expect(html(doc([paragraph([text("keep me"), { type: "image", attrs: { alt: "no src" } }])]))).toBe("<p>keep me</p>");
  });

  test("and it goes even when it also sits where the schema does not allow it", () => {
    expect(html(doc([paragraph([text("keep me")]), { type: "image", attrs: { alt: "no src" } }]))).toBe("<p>keep me</p>");
  });

  test("the same for an attachment with no key", () => {
    expect(html(doc([{ type: "attachment", attrs: { filename: "a.pdf" } }, paragraph([text("kept")])]))).toBe("<p>kept</p>");
  });

  test("one stray attribute does not cost the node its others", () => {
    expect(html(doc([{ type: "heading", attrs: { level: 3, onclick: "x" }, content: [text("T")] }]))).toBe("<h3>T</h3>");
  });
});

describe("what it falls back to", () => {
  test("a document that is not a document at all", () => {
    for (const hostile of [null, "", {}, [], 42, { type: "script" }]) {
      const sanitized = sanitize(hostile, schema);
      expect(valid(sanitized)).toBe(true);
      expect(toText(sanitized, schema)).toBe("");
    }
  });

  test("a tree of nothing the schema knows", () => {
    expect(sanitize(doc(Array.from({ length: 10 }, () => ({ type: "script" }))), schema)).toEqual(emptyDocument(schema));
  });
});

describe("the postcondition", () => {
  test("whatever goes in, what comes out validates", () => {
    const hostile = [
      doc([paragraph([{ type: "text" }])]),
      doc([paragraph("not a list")]),
      doc([paragraph([{ ...text("x"), marks: "not a list" }])]),
      doc([{ type: "paragraph", attrs: "not a map", content: [] }]),
      doc([{ type: "list_item", content: [paragraph([text("x")])] }]),
      { type: "paragraph", content: [text("a top node in the wrong place")] },
    ];
    for (const document of hostile) expect(valid(sanitize(document, schema)), JSON.stringify(document)).toBe(true);
  });
});

describe("schema versions", () => {
  test("a document from another version is repaired, not emptied", () => {
    const v2 = extendSchema(defaultSchema(), { version: 2 });
    const sanitized = sanitize({ ...doc([paragraph([text("kept")])]), schema_version: 1 }, v2) as Node & { schema_version?: number };
    expect(sanitized.schema_version).toBe(2);
    expect(toText(sanitized, v2)).toBe("kept");
  });

  test("and what the new schema no longer knows is what goes", () => {
    const v2 = defineSchema({
      version: 2,
      nodes: { doc: { content: "block+" }, paragraph: { content: "inline*", group: "block", render: ["p", []] }, text: { group: "inline", inline: true, text: true } },
    });
    const v1 = { ...doc([{ type: "heading", content: [text("gone")] }, paragraph([text("kept")])]), schema_version: 1 };
    expect(toText(sanitize(v1, v2), v2)).toBe("kept");
  });
});

describe("limits", () => {
  const bounded = (limits: Partial<Limits>) => extendSchema(defaultSchema(), { limits });
  const repeat = <T,>(count: number, make: () => T): T[] => Array.from({ length: count }, make);

  test("a document with too many nodes is refused, not counted out", () => {
    const result = validate(doc(repeat(20, () => paragraph([text("x")]))), bounded({ maxNodes: 10 }));
    expect(!result.ok && result.errors.length === 1 && result.errors[0]?.message).toContain("more than 10 nodes");
  });

  test("a document nested deeper than the bound is refused", () => {
    let deep: Node = paragraph([text("x")]);
    for (let i = 0; i < 10; i += 1) deep = { type: "blockquote", content: [deep] };
    const result = validate(doc([deep]), bounded({ maxDepth: 5 }));
    expect(!result.ok && result.errors[0]?.message).toContain("more than 5 levels");
  });

  test("a bound on text counts characters, not bytes", () => {
    const document = doc([paragraph([text("é".repeat(7))])]);
    expect(validate(document, bounded({ maxTextLength: 10 })).ok).toBe(true);
    expect(validate(document, bounded({ maxTextLength: 6 })).ok).toBe(false);
  });

  test("the bound counts the whole document, not one node", () => {
    const document = doc(repeat(4, () => paragraph([text("aaaaa")])));
    expect(validate(document, bounded({ maxTextLength: 10 })).ok).toBe(false);
    expect(validate(document, bounded({ maxTextLength: 20 })).ok).toBe(true);
  });

  test("Infinity lifts a bound", () => {
    expect(validate(doc(repeat(50, () => paragraph([text("x")]))), bounded({ maxNodes: Infinity })).ok).toBe(true);
  });

  test("sanitising a document over the node bound cuts it to fit", () => {
    const limited = bounded({ maxNodes: 10 });
    const sanitized = sanitize(doc(repeat(20, () => paragraph([text("x")]))), limited);
    expect(validate(sanitized, limited)).toEqual({ ok: true, document: sanitized });
    expect(sanitized.content).toHaveLength(5);
  });

  const nested = (inner: Node): Node => ({ type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph" }, inner] }] });

  test("what is nested too deep is dropped, and what stands beside it stays", () => {
    const limited = bounded({ maxDepth: 6 });
    const sanitized = sanitize(doc([paragraph([text("beside it")]), nested(nested(nested(paragraph([text("too deep")]))))]), limited);
    expect(validate(sanitized, limited)).toEqual({ ok: true, document: sanitized });
    expect(sanitized.content?.map((node) => node.type)).toEqual(["paragraph", "bullet_list"]);
    expect(textLength(sanitized)).toBe("beside it".length);
  });

  test("a document nested to exactly the bound is kept whole", () => {
    const limited = bounded({ maxDepth: 6 });
    const document = doc([nested(nested(paragraph([text("deep enough")])))]);
    expect(validate(document, limited).ok).toBe(true);
    expect(sanitize(document, limited).content).toEqual(document.content);
  });

  test("sanitising a document over the length bound truncates the text, by characters", () => {
    const limited = bounded({ maxTextLength: 400 });
    const sanitized = sanitize(doc([paragraph([text("a".repeat(500))])]), limited);
    expect(textLength(sanitized)).toBe(400);
    expect(validate(sanitized, limited)).toEqual({ ok: true, document: sanitized });
    expect(textLength(sanitize(doc([paragraph([text("é".repeat(500))])]), limited))).toBe(400);
    // A grapheme of several code points is one character, and is never cut in half.
    const flags = sanitize(doc([paragraph([text("🇫🇷".repeat(10))])]), bounded({ maxTextLength: 3 }));
    expect(flags.content?.[0]?.content?.[0]?.text).toBe("🇫🇷🇫🇷🇫🇷");
  });

  test("what is under the bound is kept whole, and only what crosses it is cut", () => {
    const sanitized = sanitize(doc([paragraph([text("a".repeat(300))]), paragraph([text("b".repeat(200))]), paragraph([text("never reached")])]), bounded({ maxTextLength: 400 }));
    expect(sanitized.content).toEqual([paragraph([text("a".repeat(300))]), paragraph([text("b".repeat(100))]), { type: "paragraph" }]);
  });

  test("cutting to fit is idempotent, like every other repair", () => {
    const limited = bounded({ maxTextLength: 400 });
    const once = sanitize(doc([paragraph([text("a".repeat(500))])]), limited);
    expect(sanitize(once, limited)).toEqual(once);
  });

  test("limits lifts a bound for this call alone", () => {
    const sanitized = sanitize(doc([{ type: "script", content: [text("x")] }, paragraph([text("a".repeat(500))])]), bounded({ maxTextLength: 400 }), { limits: { maxTextLength: Infinity } });
    expect(textLength(sanitized)).toBe(500);
    expect(sanitized.content).toHaveLength(1);
  });

  test("limits can tighten a bound too, and the schema is not changed by it", () => {
    const limited = bounded({ maxTextLength: 400 });
    const document = doc([paragraph([text("a".repeat(300))])]);
    expect(textLength(sanitize(document, limited, { limits: { maxTextLength: 100 } }))).toBe(100);
    expect(textLength(sanitize(document, limited))).toBe(300);
  });

  test("limits refuses a bound the schema itself would refuse", () => {
    expect(() => sanitize(doc([]), schema, { limits: { maxWords: 10 } as Partial<Limits> })).toThrow(/unknown limit/);
  });
});

describe("on random hostile trees", () => {
  test("what comes out always validates, and sanitising it again changes nothing", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const once = sanitize(hostile(seed), schema);
      expect(validate(once, schema), `seed ${seed}`).toEqual({ ok: true, document: once });
      expect(sanitize(once, schema), `seed ${seed}`).toEqual(once);
      expect(() => toHtml(once, schema)).not.toThrow();
    }
  });

  test("a few mutations of a valid document lose only what they touched", () => {
    // Repairs are local: the blocks nobody touched survive.
    const whole = textLength(base());
    let partial = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const once = sanitize(mutated(seed), schema);
      expect(validate(once, schema), `seed ${seed}`).toEqual({ ok: true, document: once });
      expect(sanitize(once, schema), `seed ${seed}`).toEqual(once);
      const length = textLength(once);
      expect(length, `seed ${seed}`).toBeGreaterThan(0);
      if (length < whole) partial += 1;
    }
    // Some repairs cost text (an unknown node takes its text with it), none cost all of it.
    expect(partial).toBeGreaterThan(0);
  });
});
