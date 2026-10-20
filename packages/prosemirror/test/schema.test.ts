// @vitest-environment jsdom
import { defaultSchema, extendSchema, validate } from "@nseaprotector/coelho-core";
import { DOMParser, DOMSerializer, Node } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { insertHardBreak, toProseMirrorDoc, toProseMirrorSchema } from "../src/index.js";

const schema = extendSchema(defaultSchema(), {
  nodes: {
    variable: {
      group: "inline",
      inline: true,
      void: true,
      attrs: { name: { required: true, validate: { oneOf: ["number", "customer"] } } },
      render: ["span", [["data-variable", ""]]],
    },
  },
  marks: { comment: { attrs: { thread: { required: true, validate: "string" } }, render: (_mark, inner) => `<span>${inner}</span>` } },
});
const pm = toProseMirrorSchema(schema);

function parse(html: string): Node {
  const element = document.createElement("div");
  element.innerHTML = html;
  return DOMParser.fromSchema(pm).parse(element);
}

function roundTrip(doc: Node): Node {
  const element = document.createElement("div");
  element.appendChild(DOMSerializer.fromSchema(pm).serializeFragment(doc.content));
  return DOMParser.fromSchema(pm).parse(element);
}

describe("pasting HTML", () => {
  test("reads a numeric attribute as a number, so the document still validates", () => {
    const doc = parse('<ol start="3"><li><p>x</p></li></ol>');
    expect(doc.firstChild?.attrs.start).toBe(3);
    expect(validate(doc.toJSON(), schema).ok).toBe(true);
  });

  test("keeps the text of a link a browser would execute, and drops the link", () => {
    const doc = parse('<p><a href="javascript:alert(1)">click</a></p>');
    expect(validate(doc.toJSON(), schema)).toEqual({
      ok: true,
      document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "click" }] }] },
    });
  });
});

describe("copy and paste inside the editor", () => {
  test("brings back a node that declares no HTML to import it from", () => {
    const doc = Node.fromJSON(pm, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Invoice " }, { type: "variable", attrs: { name: "number" } }] },
        { type: "attachment", attrs: { key: "k", filename: "dot.png", content_type: "image/png", byte_size: 70 } },
      ],
    });
    expect(roundTrip(doc).toJSON()).toEqual(doc.toJSON());
  });

  test("keeps a code block's language and its whitespace", () => {
    const doc = Node.fromJSON(pm, {
      type: "doc",
      content: [{ type: "code_block", attrs: { language: "elixir" }, content: [{ type: "text", text: "  if a do\n    :ok\n  end" }] }],
    });
    expect(roundTrip(doc).toJSON()).toEqual(doc.toJSON());
  });

  test("draws a mark rendered by a function inline, and brings it back", () => {
    const doc = Node.fromJSON(pm, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "noted", marks: [{ type: "comment", attrs: { thread: "t1" } }] }] }],
    });
    const element = document.createElement("div");
    element.appendChild(DOMSerializer.fromSchema(pm).serializeFragment(doc.content));
    expect(element.querySelector("[data-coelho=comment]")?.tagName).toBe("SPAN");
    expect(roundTrip(doc).toJSON()).toEqual(doc.toJSON());
  });
});

describe("mark behaviour", () => {
  test("a link does not grow when typing at its end", () => {
    expect(pm.marks.link?.spec.inclusive).toBe(false);
  });

  test("nothing else applies inside code", () => {
    expect(pm.marks.code?.excludes(pm.marks.bold!)).toBe(true);
    expect(pm.marks.bold?.excludes(pm.marks.italic!)).toBe(false);
  });
});

describe("loading a stored document", () => {
  test("refuses what does not validate instead of throwing", () => {
    expect(toProseMirrorDoc(pm, schema, { type: "doc", content: [{ type: "sparkle" }] }).ok).toBe(false);
    expect(toProseMirrorDoc(pm, schema, { type: "doc", content: [] }).ok).toBe(false);
  });

  test("repairs what does not, when asked, and says what was wrong", () => {
    const stored = { type: "doc", content: [{ type: "script", content: [{ type: "text", text: "x" }] }, { type: "paragraph", content: [{ type: "text", text: "kept" }] }] };
    const loaded = toProseMirrorDoc(pm, schema, stored, { repair: true });
    expect(loaded.ok && loaded.doc.textContent).toBe("kept");
    expect(loaded.ok && loaded.repaired?.[0]?.message).toBe('unknown node type "script"');
  });

  test("does not truncate a row over the length bounds while repairing it", () => {
    const bounded = extendSchema(schema, { limits: { maxTextLength: 10 } });
    const long = "a".repeat(40);
    const stored = { type: "doc", content: [{ type: "script" }, { type: "paragraph", content: [{ type: "text", text: long }] }] };
    const loaded = toProseMirrorDoc(toProseMirrorSchema(bounded), bounded, stored, { repair: true });
    expect(loaded.ok && loaded.doc.textContent).toBe(long);
  });

  test("loads what does, and an absent document as empty", () => {
    const loaded = toProseMirrorDoc(pm, schema, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] });
    expect(loaded.ok && loaded.doc.textContent).toBe("hi");
    const empty = toProseMirrorDoc(pm, schema, null);
    expect(empty.ok && validate(empty.doc.toJSON(), schema).ok).toBe(true);
  });
});

describe("Shift-Enter", () => {
  function press(json: unknown, position: number): EditorState {
    const doc = Node.fromJSON(pm, json);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, position) });
    const handled = insertHardBreak(pm)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(handled).toBe(true);
    return state;
  }

  test("is a newline inside code", () => {
    const state = press({ type: "doc", content: [{ type: "code_block", content: [{ type: "text", text: "ab" }] }] }, 2);
    expect(state.doc.toJSON()).toEqual({ type: "doc", content: [{ type: "code_block", attrs: { language: null }, content: [{ type: "text", text: "a\nb" }] }] });
  });

  test("is a hard break inside a paragraph", () => {
    const state = press({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "ab" }] }] }, 2);
    expect(state.doc.firstChild?.child(1).type.name).toBe("hard_break");
  });
});
