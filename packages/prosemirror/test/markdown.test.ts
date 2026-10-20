// @vitest-environment jsdom
import { buildDefaultSchema, defaultSchema, extendSchema, toHtml, toMarkdown, toText, validate, type Node, type Schema } from "@coelho/core";
import { describe, expect, test } from "vitest";
import { fromHtml, fromMarkdown } from "../src/index.js";

// Ported from coelho's test/coelho/markdown_test.exs. The oracle is the
// same: Markdown has to say what HTML says. Both go back through one import
// (fromHtml), so whitespace and what the schema keeps are normalised the
// same way, and any difference is the Markdown's fault.

const schema = defaultSchema();
const tables = buildDefaultSchema({ tables: true });

const t = (text: string, marks: string[] = []): Node => ({ type: "text", text, marks: marks.map((type) => ({ type })) }) as Node;
const p = (content: unknown[]): Node => ({ type: "paragraph", content }) as Node;
const doc = (content: unknown[]): Node => ({ type: "doc", content }) as Node;
const li = (content: unknown[]): Node => ({ type: "list_item", content }) as Node;

function valid(document: unknown, under: Schema = schema): Node {
  const result = validate(document, under);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.document;
}

function md(content: unknown[], under: Schema = schema, options: Parameters<typeof toMarkdown>[2] = {}): string {
  return toMarkdown(valid(doc(content), under), under, options);
}

// -- What Markdown cannot say, taken out before the comparison ---------------

function edge(node: Node): boolean {
  return node.type === "hard_break" || (node.type === "text" && (node.text ?? "").trim() === "");
}

function blank(paragraph: Node): boolean {
  return (paragraph.content ?? []).every((child) => (child.type === "text" ? (child.text ?? "").trim() === "" : child.type === "hard_break"));
}

function required(node: Node, child: Node, index: number, content: Node[]): boolean {
  if (child.type !== "paragraph" || index !== 0) return false;
  if (node.type === "list_item") return true;
  if (["table_cell", "table_header", "blockquote"].includes(node.type)) return content.every((sibling) => sibling.type === "paragraph" && blank(sibling));
  return false;
}

function expressible(node: Node): Node {
  if (node.type === "paragraph" || node.type === "heading") {
    const content = [...(node.content ?? [])];
    while (content.length > 0 && edge(content[0] as Node)) content.shift();
    while (content.length > 0 && edge(content[content.length - 1] as Node)) content.pop();
    return { ...node, content: content.map(expressible) };
  }
  if (node.type === "image") return { ...node, attrs: { alt: "", ...(node.attrs ?? {}) } };
  if (!Array.isArray(node.content)) return node;
  const content = node.content.map(expressible);
  return { ...node, content: content.filter((child, index) => !((child.type === "paragraph" || child.type === "heading") && blank(child) && !required(node, child, index, content))) };
}

/** CommonMark percent-encodes a destination where it has to; a URL comes back as the same URL, written otherwise. */
function sameUrls(node: Node): Node {
  const out: Node = { ...node };
  if (node.attrs !== undefined) {
    out.attrs = Object.fromEntries(Object.entries(node.attrs).map(([key, value]) => [key, (key === "href" || key === "src") && typeof value === "string" ? safeDecode(value) : value]));
  }
  if (node.marks !== undefined) out.marks = node.marks.map((mark) => sameUrls(mark as Node));
  if (node.content !== undefined) out.content = node.content.map(sameUrls);
  return out;
}

function safeDecode(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function backFromMarkdown(document: Node, under: Schema): void {
  const markdown = toMarkdown(document, under);
  const expressed = validate(expressible(document), under);
  if (!expressed.ok) return;
  const viaHtml = fromHtml(toHtml(expressed.document, under), under);
  expect(sameUrls(fromMarkdown(markdown, under)), `Markdown:\n${markdown}`).toEqual(sameUrls(viaHtml));
}

function cases(under: Schema, list: Array<[unknown[], string]>): void {
  for (const [content, markdown] of list) {
    const document = valid(doc(content), under);
    expect(toMarkdown(document, under)).toBe(markdown);
    backFromMarkdown(document, under);
  }
}

describe("toMarkdown", () => {
  test("writes the shipped blocks and marks", () => {
    expect(
      md([
        { type: "heading", attrs: { level: 2 }, content: [t("Notes")] },
        p([t("Fixed "), t("three", ["bold"]), t(" bugs", ["bold"]), t(" and "), t("one", ["italic"])]),
        p([t("gone", ["strike"]), t(" and "), t("code", ["code"])]),
        { type: "horizontal_rule" },
      ]),
    ).toBe("## Notes\n\nFixed **three bugs** and *one*\n\n~~gone~~ and `code`\n\n---");
  });

  test("is nothing for nothing", () => {
    expect(toMarkdown(null, schema)).toBe("");
  });

  test("escapes what Markdown would read as syntax", () => {
    expect(md([p([t("# not a heading")])])).toBe("\\# not a heading");
    expect(md([p([t("1. not a list")])])).toBe("1\\. not a list");
    expect(md([p([t("*a* _b_ `c` [d](e) <f> & | ~")])])).toBe("\\*a\\* \\_b\\_ \\`c\\` \\[d\\](e) \\<f\\> \\& \\| \\~");
  });

  test("writes a span as HTML where its delimiters would not count", () => {
    expect(md([p([t("a"), t("*b", ["bold"])])])).toBe("a<strong>\\*b</strong>");
    expect(md([p([t("x"), t(" spaced ", ["italic"]), t("y")])])).toBe("x<em> spaced </em>y");
  });

  test("comes back as it went, at the edges of what Markdown can say", () => {
    const link = (text: string): Node => ({ type: "text", text, marks: [{ type: "link", attrs: { href: "/a" } }] });
    cases(schema, [
      [[{ type: "heading", attrs: { level: 2 }, content: [t("C#")] }], "## C\\#"],
      [[p([t("look!"), link("x")])], "look\\![x](</a>)"],
      [[p([t("a"), { type: "hard_break" }, t("  b")])], "a\\\n&#32;&#32;b"],
      [[p([t("a", ["bold"]), t("b", ["italic"])])], "<strong>a</strong>*b*"],
    ]);
  });

  test("comes back as it went, in tables, lists and around empty blocks", () => {
    const list = (type: string, items: unknown[][]): Node => ({ type, content: items.map(li) }) as Node;
    const cell = (type: string, content: unknown[]): Node => ({ type, content: [p(content)] }) as Node;
    const table = (cells: unknown[]): Node =>
      ({ type: "table", content: [{ type: "table_row", content: [cell("table_header", [t("h")])] }, { type: "table_row", content: [cell("table_cell", cells)] }] }) as Node;
    const href: Node = { type: "text", text: "l", marks: [{ type: "link", attrs: { href: "/a|b" } }] };
    cases(tables, [
      [[list("bullet_list", [[p([t("a")])]]), p([]), list("bullet_list", [[p([t("b")])]])], "- a\n\n* b"],
      [[list("bullet_list", [[p([t("a")]), { type: "ordered_list", attrs: { start: 3 }, content: [li([p([t("b")])])] }]])], "- a\n\n  3. b"],
      [[table([t("a|b", ["code"])])], "| h |\n| --- |\n| <code>a&#124;b</code> |"],
      [[table([t("\\|", ["code"])])], "| h |\n| --- |\n| <code>&#92;&#124;</code> |"],
      [[table([href])], "| h |\n| --- |\n| [l](</a%7Cb>) |"],
      [[table([{ type: "text", text: "l", marks: [{ type: "link", attrs: { href: "/a", title: "t|u" } }] }])], '| h |\n| --- |\n| [l](</a> "t&#124;u") |'],
      [[table([t("x\\|y")])], "| h |\n| --- |\n| x\\\\&#124;y |"],
      [[table([t("x"), { type: "hard_break" }, t("y")])], "| h |\n| --- |\n| x<br>y |"],
      [[p([t("x\\!"), href])], "x\\\\\\![l](</a|b>)"],
      [[p([{ type: "hard_break" }, t("x"), { type: "hard_break" }])], "x"],
      [[{ type: "heading", attrs: { level: 1 }, content: [t("x"), { type: "hard_break" }] }], "# x"],
    ]);
  });

  test("comes back as it went, with empty items, cells holding blocks, and long numbers", () => {
    const empty = p([]);
    const ul = (items: unknown[][]): Node => ({ type: "bullet_list", content: items.map(li) }) as Node;
    const ol = (start: number, items: unknown[][]): Node => ({ type: "ordered_list", attrs: { start }, content: items.map(li) }) as Node;
    const header = (content: unknown[]): Node => ({ type: "table", content: [{ type: "table_row", content: [{ type: "table_header", content }] }] }) as Node;
    const code: Node = { type: "code_block", attrs: { language: "elixir" }, content: [t("x |\\| y\nz")] };
    cases(tables, [
      [[ul([[p([t("a")])], [empty]])], "- a\n- "],
      [[ul([[p([t("a")]), ul([[empty]])]])], "- a\n\n  - "],
      [[ul([[p([t("a")]), ol(1, [[empty]])]])], "- a\n\n  1. "],
      [[{ type: "heading", attrs: { level: 1 }, content: [t("a #  ")] }], "# a \\#  "],
      [[ol(999_999_999, [[p([t("a")])], [p([t("b")])]])], '<ol start="999999999"><li><p>a</p></li><li><p>b</p></li></ol>'],
      [[header([p([t("a\\")]), ul([[p([t("b")])]])])], "| <p>a&#92;</p><ul><li><p>b</p></li></ul> |\n| --- |"],
      [[header([code])], '| <pre><code class="language-elixir">x &#124;&#92;&#124; y&#10;z</code></pre> |\n| --- |'],
      [[p([{ type: "text", text: "]:", marks: [{ type: "link", attrs: { href: "/a" } }, { type: "code" }] }])], "[<code>&#93;&#58;</code>](</a>)"],
    ]);
  });

  test("comes back as it went, with a rule opening an item and entities in links", () => {
    cases(schema, [
      [[{ type: "bullet_list", content: [li([p([]), { type: "horizontal_rule" }])] }], "-\n  ---"],
      [[{ type: "bullet_list", content: [li([p([]), { type: "bullet_list", content: [li([p([]), { type: "bullet_list", content: [li([p([])])] }])] }])] }], "-\n  -\n    - "],
      [[p([{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "/?a=1&copy;b", title: "&amp; me" } }] }])], '[x](</?a=1&#38;copy;b> "&#38;amp; me")'],
      [[p([{ type: "image", attrs: { src: "/i&lt;", alt: "a", title: "&lt;" } }])], '![a](</i&#38;lt;> "&#38;lt;")'],
    ]);
  });

  test("writes a mark Markdown has no delimiters for as its element, and reads it back", () => {
    for (const [mark, tag] of [["underline", "u"], ["highlight", "mark"], ["subscript", "sub"], ["superscript", "sup"]] as const) {
      const document = valid(doc([p([t("a"), t("b", [mark])])]));
      const markdown = toMarkdown(document, schema);
      expect(markdown).toBe(`a<${tag}>b</${tag}>`);
      expect(fromMarkdown(markdown, schema)).toEqual(document);
    }
  });

  test("writes a redeclared shipped mark the way it writes one of the application's", () => {
    const redeclared = extendSchema(defaultSchema(), { marks: { highlight: { render: ["span", []] } } });
    expect(md([p([t("hi", ["highlight"])])], redeclared)).toBe("hi");
  });

  test("keeps an attachment's leading spaces from making it code", () => {
    expect(md([{ type: "attachment", attrs: { key: "k", filename: "    plan" } }])).toBe("&#32;&#32;&#32;&#32;plan");
  });

  test("keeps an attachment's name a name when it looks like a block", () => {
    for (const name of ["1. report.pdf", "- notes", "# draft"]) {
      const back = fromMarkdown(md([{ type: "attachment", attrs: { key: "k", filename: name } }]), schema);
      expect(back.content?.map((node) => node.type)).toEqual(["paragraph"]);
      expect(toText(back, schema)).toContain(name);
    }
  });

  test("does not let a span's delimiters run into an override's", () => {
    const spoiler = extendSchema(defaultSchema(), { marks: { spoiler: {} } });
    expect(md([p([t("a", ["spoiler"]), t("b", ["bold"])])], spoiler, { marks: { spoiler: ["*", "*"] } })).toBe("*a*<strong>b</strong>");
  });

  test("fences code with more backticks than it holds, and keeps its language", () => {
    expect(md([{ type: "code_block", attrs: { language: "elixir" }, content: [t('IO.puts("```")')] }])).toBe('````elixir\nIO.puts("```")\n````');
    expect(md([p([t("a `b` c", ["code"])])])).toBe("``a `b` c``");
  });

  test("nests lists and quotes by indentation, and keeps an ordered list's start", () => {
    expect(
      md([
        { type: "ordered_list", attrs: { start: 3 }, content: [li([p([t("three")]), { type: "bullet_list", content: [li([p([t("nested")])])] }]), li([p([t("four")])])] },
        { type: "blockquote", content: [p([t("quoted")]), p([t("again")])] },
      ]),
    ).toBe("3. three\n   - nested\n4. four\n\n> quoted\n>\n> again");
  });

  test("gives two lists in a row different markers", () => {
    const list = (type: string): Node => ({ type, content: [li([p([t("x")])])] }) as Node;
    expect(md([list("bullet_list"), list("bullet_list"), list("bullet_list")])).toBe("- x\n\n* x\n\n- x");
    expect(md([list("ordered_list"), list("ordered_list")])).toBe("1. x\n\n1) x");
  });

  test("writes a table as a pipe table, its first row the header", () => {
    const cell = (type: string, text: string): Node => ({ type, content: [p([t(text)])] }) as Node;
    const table = {
      type: "table",
      content: [
        { type: "table_row", content: [cell("table_header", "a | b"), cell("table_header", "c")] },
        { type: "table_row", content: [cell("table_cell", "1"), cell("table_cell", "2")] },
      ],
    };
    expect(md([table], tables)).toBe("| a &#124; b | c |\n| --- | --- |\n| 1 | 2 |");
  });

  test("writes a heading holding a line break as Coelho's own HTML", () => {
    expect(md([{ type: "heading", attrs: { level: 3 }, content: [t("a <b>"), { type: "hard_break" }, t("c")] }])).toBe("<h3>a &lt;b&gt;<br>c</h3>");
  });

  test("links an attachment through the resolver, or names it", () => {
    const attachment = { type: "attachment", attrs: { key: "k1", filename: "plan [v2].pdf", caption: "# Q3" } };
    expect(md([attachment], schema, { context: { resolve: (key) => `/files/${key}` } })).toBe("[plan \\[v2\\].pdf](</files/k1>)\n\n\\# Q3");
    expect(md([attachment])).toBe("plan \\[v2\\].pdf\n\n\\# Q3");
  });

  test("takes the application's own nodes and marks", () => {
    const own = extendSchema(defaultSchema(), {
      nodes: {
        mention: { group: "inline", inline: true, void: true, attrs: { handle: { required: true } }, toText: (node) => `_${String(node.attrs?.handle)}` },
        callout: { group: "block", content: "inline*" },
      },
      marks: { spoiler: {} },
    });
    const content = [p([{ type: "mention", attrs: { handle: "ada" } }, t(" "), t("hi", ["spoiler"])]), { type: "callout", content: [t("# careful")] }];
    expect(md(content, own)).toBe("\\_ada hi\n\n\\# careful");
    expect(md(content, own, { nodes: { mention: (node) => `@${String(node.attrs?.handle)}` }, marks: { spoiler: ["==", "=="] } })).toBe("@ada ==hi==\n\n\\# careful");
  });
});

describe("fromMarkdown", () => {
  test("imports under the schema, which keeps what it allows and nothing else", () => {
    const document = fromMarkdown("# Hi\n\n**bold** <script>alert(1)</script> [x](javascript:alert(1))", schema);
    expect(toHtml(document, schema)).toBe("<h1>Hi</h1><p><strong>bold</strong> x</p>");
  });

  test("keeps straight quotes, as they were typed", () => {
    expect(toText(fromMarkdown(`He said "it's fine"`, schema), schema)).toContain(`He said "it's fine"`);
  });

  test("never runs what it parses", () => {
    let fired = false;
    (globalThis as { pwned?: () => void }).pwned = () => (fired = true);
    fromMarkdown('<img src="x" onerror="pwned()"> and <svg onload="pwned()">', schema);
    fromHtml('<img src="x" onerror="pwned()">', schema);
    expect(fired).toBe(false);
  });
});

// -- Properties --------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Mostly what Markdown reads as syntax: delimiters at the edges of marks,
// line-start markers after line breaks, backslashes, backticks in code.
const HOSTILE = ["*", "**", "_", "__", "`", "``", "```", "~", "~~", "#", "##", "-", "--", "---", "+", "=", "==", ">", "|", "[", "]", "(", ")", "!", "&", "\\", "<", "1.", "1)", "2.", "a", "b", "word", ".", ",", ":", "\\!", " ", "  ", "x y"];
const HOSTILE_MARKS = [
  { type: "bold" },
  { type: "italic" },
  { type: "strike" },
  { type: "code" },
  { type: "link", attrs: { href: "/a(b)?c=*d*" } },
  { type: "link", attrs: { href: "/a|b" } },
  { type: "link", attrs: { href: "/?a=1&copy;b&amp;c", title: "&amp;amp; me" } },
];

function generator(seed: number) {
  const next = random(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const many = <T,>(min: number, max: number, make: () => T): T[] => Array.from({ length: int(min, max) }, make);

  const text = (): string => many(1, 6, () => pick(HOSTILE)).join("");
  const marks = (): unknown[] => [...new Set(many(0, 3, () => pick(HOSTILE_MARKS)))];
  const inline = (): unknown => {
    const roll = next();
    if (roll < 0.7) return { type: "text", text: text(), marks: marks() };
    if (roll < 0.85) return { type: "hard_break" };
    const alt = text();
    return { type: "image", attrs: { src: "/i*_[x].png&lt;", alt, title: `${alt}&lt;` } };
  };
  const paragraph = (): unknown => ({ type: "paragraph", content: many(1, 6, inline) });
  const maybeEmpty = (): unknown => (next() < 0.8 ? paragraph() : { type: "paragraph", content: [] });
  const list = (depth: number): unknown => {
    const type = pick(["bullet_list", "ordered_list"]);
    const items = many(1, 3, () => item(depth));
    return type === "ordered_list" ? { type, attrs: { start: next() < 0.85 ? int(0, 4) : 999_999_999 }, content: items } : { type, content: items };
  };
  const item = (depth: number): unknown => {
    const first = maybeEmpty();
    if (depth === 0) return { type: "list_item", content: [first] };
    const roll = next();
    const nested =
      roll < 0.25 ? null : roll < 0.5 ? list(depth - 1) : roll < 0.75 ? { type: "horizontal_rule" } : { type: "code_block", content: [{ type: "text", text: text() }] };
    return { type: "list_item", content: nested === null ? [first] : [first, nested] };
  };
  const cell = (): unknown[] => {
    const roll = next();
    if (roll < 4 / 7) return [maybeEmpty()];
    if (roll < 5 / 7) return [paragraph(), paragraph()];
    if (roll < 6 / 7) {
      const value = text();
      return [{ type: "code_block", attrs: { language: "elixir" }, content: [{ type: "text", text: `${value}\n${value}` }] }];
    }
    return [list(0)];
  };
  const table = (): unknown => {
    const width = int(1, 3);
    const rows = many(1, 3, () => Array.from({ length: width }, cell));
    const row = (cells: unknown[][], type: string): unknown => ({ type: "table_row", content: cells.map((content) => ({ type, content })) });
    const [header, ...body] = rows;
    return { type: "table", content: [row(header as unknown[][], "table_header"), ...body.map((cells) => row(cells, "table_cell"))] };
  };
  const blockOf = (): unknown => {
    switch (int(0, 7)) {
      case 0:
        return paragraph();
      case 1:
        return { type: "paragraph", content: [] };
      case 2:
        return { type: "heading", attrs: { level: int(1, 6) }, content: many(1, 4, inline) };
      case 3:
        return list(2);
      case 4:
        return { type: "blockquote", content: many(1, 2, paragraph) };
      case 5:
        return { type: "code_block", content: [{ type: "text", text: text() }] };
      case 6:
        return { type: "horizontal_rule" };
      default:
        return table();
    }
  };
  return { text, document: (): Node => ({ type: "doc", content: many(1, 5, blockOf) }) as Node };
}

describe("properties", () => {
  test("what Markdown reads as syntax comes back as the characters that were typed", () => {
    // MARKDOWN_SEEDS=5000 for a longer search.
    const seeds = Number(process.env.MARKDOWN_SEEDS ?? 500);
    let checked = 0;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const original = validate(generator(seed).document(), tables);
      if (!original.ok) continue;
      checked += 1;
      backFromMarkdown(original.document, tables);
    }
    expect(checked).toBeGreaterThan(300);
  });

  test("an attachment's name and caption come back as the words they were", () => {
    const words = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");
    for (let seed = 1; seed <= 200; seed += 1) {
      const gen = generator(seed);
      const name = gen.text();
      const caption = seed % 3 === 0 ? null : gen.text();
      const attrs = caption === null ? { key: "k", filename: name } : { key: "k", filename: name, caption };
      const document = valid(doc([{ type: "attachment", attrs }]));
      const back = fromMarkdown(toMarkdown(document, schema), schema);
      const expected = [name, caption].filter((value): value is string => value !== null && words(value) !== "").map(words);
      const got = (back.content ?? []).map((block) => words(toText(doc([block]), schema))).filter((value) => value !== "");
      expect(got, `seed ${seed}: ${JSON.stringify(attrs)}`).toEqual(expected);
    }
  });
});

describe("pasting Markdown", () => {
  // What a browser hands the editor on a paste: an event carrying the
  // clipboard's plain text and no HTML, as a terminal or a text editor puts there.
  function paste(view: { dom: HTMLElement }, text: string): void {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/plain"], getData: (type: string) => (type === "text/plain" ? text : "") } });
    view.dom.dispatchEvent(event);
  }

  test("arrives formatted, and the plain-text paste keeps it plain", async () => {
    const { EditorState } = await import("prosemirror-state");
    const { EditorView } = await import("prosemirror-view");
    const { Node: PMNode } = await import("prosemirror-model");
    const { markdownPaste, toProseMirrorSchema } = await import("../src/index.js");
    const pm = toProseMirrorSchema(schema);
    const make = (): InstanceType<typeof EditorView> => {
      const host = document.body.appendChild(document.createElement("div"));
      return new EditorView(host, { state: EditorState.create({ doc: PMNode.fromJSON(pm, { type: "doc", content: [{ type: "paragraph" }] }), plugins: [markdownPaste()] }) });
    };

    const view = make();
    paste(view, "**bold** and `code`\n\n- one\n- two");
    expect(toHtml(valid(view.state.doc.toJSON()), schema)).toBe("<p><strong>bold</strong> and <code>code</code></p><ul><li><p>one</p></li><li><p>two</p></li></ul>");

    // pasteText is ProseMirror's plain-text paste, what Shift-paste does.
    const plain = make();
    plain.pasteText("**bold**", new Event("paste") as ClipboardEvent);
    expect(toHtml(valid(plain.state.doc.toJSON()), schema)).toBe("<p>**bold**</p>");
  });
});
