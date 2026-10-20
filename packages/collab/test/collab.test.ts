// @vitest-environment jsdom
import { defaultSchema, hash, toHtml, type Node as CoelhoNode } from "@coelho/core";
import { coelhoPlugins, proseMirrorSchemaFor } from "@coelho/prosemirror";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { undoCommand } from "y-prosemirror";
import { Awareness } from "y-protocols/awareness";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { collab, FIELD, LocalRelay, seed, snapshot } from "../src/index.js";

const schema = defaultSchema();
const pm = proseMirrorSchemaFor(schema);

const stored: CoelhoNode = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "The cat sat." }] },
    { type: "paragraph", content: [{ type: "text", text: "On the mat." }] },
  ],
};

beforeAll(() => {
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const empty = (): DOMRectList => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  for (const proto of [Element.prototype, Text.prototype, Range.prototype] as unknown as Array<Record<string, unknown>>) {
    proto.getClientRects = empty;
    proto.getBoundingClientRect = rect;
  }
  document.elementFromPoint = () => null;
});

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

interface Writer {
  doc: Y.Doc;
  view: EditorView;
}

/** A writer joins the room: their own Y.Doc, presence and editor, connected through the relay. */
function writer(relay: LocalRelay, name: string, seeded = false): Writer {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { name, color: "#b5442c" });
  if (seeded) seed(doc, schema, stored);
  relay.join(doc, awareness);
  const fresh = collab({ doc, awareness })(pm);
  const view = new EditorView(document.body.appendChild(document.createElement("div")), {
    state: EditorState.create({ doc: fresh.doc, plugins: [...fresh.plugins, ...coelhoPlugins(pm, { history: false })] }),
  });
  views.push(view);
  return { doc, view };
}

/** Where a word starts in this writer's document, which other writers' edits may have moved. */
function before(at: Writer, word: string): number {
  let found = -1;
  at.view.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText) {
      const index = (node.text ?? "").indexOf(word);
      if (index !== -1) found = pos + index;
    }
  });
  if (found === -1) throw new Error(`no ${word}`);
  return found;
}

function type(at: Writer, text: string, beforeWord: string): void {
  const { view } = at;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, before(at, beforeWord))).insertText(text));
}

const html = (at: Writer): string => toHtml(snapshot(at.doc, schema).document, schema);

describe("collaboration", () => {
  test("a room seeded once shows its document to whoever joins, once", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    expect(sacha.view.state.doc.textContent).toBe("The cat sat.On the mat.");
    expect(html(sacha)).toBe(html(camille));
    expect(() => seed(sacha.doc, schema, stored)).toThrow(/only once/);
  });

  test("each writer's typing reaches the other", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    type(camille, "big ", "cat");
    type(sacha, "soft ", "mat");
    expect(camille.view.state.doc.textContent).toBe("The big cat sat.On the soft mat.");
    expect(sacha.view.state.doc.textContent).toBe("The big cat sat.On the soft mat.");
  });

  test("two writers apart, then together again, store the same document, to the hash", async () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    relay.setOnline(false);
    type(camille, "big ", "cat");
    type(sacha, "fat ", "cat");
    type(sacha, "soft ", "mat");
    expect(camille.view.state.doc.textContent).not.toBe(sacha.view.state.doc.textContent);
    relay.setOnline(true);
    expect(camille.view.state.doc.textContent).toBe(sacha.view.state.doc.textContent);
    expect(camille.view.state.doc.textContent).toMatch(/^The (big fat|fat big) cat sat\.On the soft mat\.$/);
    const [a, b] = [snapshot(camille.doc, schema), snapshot(sacha.doc, schema)];
    expect(a.errors).toEqual([]);
    expect(await hash(a.document)).toBe(await hash(b.document));
  });

  test("undo is the writer's own: it never takes back what the other typed", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    type(camille, "big ", "cat");
    type(sacha, "soft ", "mat");
    undoCommand(camille.view.state, camille.view.dispatch);
    expect(camille.view.state.doc.textContent).toBe("The cat sat.On the soft mat.");
    expect(sacha.view.state.doc.textContent).toBe("The cat sat.On the soft mat.");
  });

  test("the shared document is not a trust boundary: what a peer writes past the editor is repaired when it is stored", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    // A peer writes into the shared document directly, as any client of the room could.
    const paragraph = sacha.doc.getXmlFragment(FIELD).get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).format(4, 3, { link: { href: "javascript:alert(1)" } });
    // The editor shows it, since y-prosemirror builds nodes without the attribute validators…
    expect(JSON.stringify(camille.view.state.doc.toJSON())).toContain("javascript:");
    // …and the stored document never holds it.
    const stored = snapshot(camille.doc, schema);
    expect(stored.errors.map((error) => error.message)).toEqual(['scheme "javascript" is not allowed']);
    expect(toHtml(stored.document, schema)).toBe("<p>The cat sat.</p><p>On the mat.</p>");
  });
});
