// @vitest-environment jsdom
import { defaultSchema, type Node as CoelhoNode } from "@nseaprotector/coelho-core";
import { addComment, coelhoPlugins, commentsPlugin, commentsState, proseMirrorSchemaFor } from "@nseaprotector/coelho-prosemirror";
import { EditorState, TextSelection, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { undoCommand } from "y-prosemirror";
import { Awareness } from "y-protocols/awareness";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { collab, LocalRelay, relativeAnchors, seed } from "../src/index.js";

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

function writer(relay: LocalRelay, options: { seeded?: boolean; comments?: "relative" | "quote" } = {}): EditorView {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  if (options.seeded) seed(doc, schema, stored);
  relay.join(doc, awareness);
  const fresh = collab({ doc, awareness })(pm);
  const comments: Plugin[] =
    options.comments === undefined ? [] : [commentsPlugin(options.comments === "relative" ? { schema, source: relativeAnchors() } : { schema })];
  const view = new EditorView(document.body.appendChild(document.createElement("div")), {
    state: EditorState.create({ doc: fresh.doc, plugins: [...fresh.plugins, ...comments, ...coelhoPlugins(pm, { history: false })] }),
  });
  views.push(view);
  return view;
}

function find(view: EditorView, word: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    const index = node.isText ? (node.text ?? "").indexOf(word) : -1;
    if (found === -1 && index !== -1) found = pos + index;
  });
  if (found === -1) throw new Error(`no ${word}`);
  return found;
}

function comment(view: EditorView, id: string, word: string): void {
  const from = find(view, word);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + word.length)));
  addComment(id)(view.state, view.dispatch);
}

function typeAt(view: EditorView, pos: number, text: string): void {
  view.dispatch(view.state.tr.insertText(text, pos));
}

const quoteOf = (view: EditorView, id: string): string | undefined => commentsState(view.state)?.anchors.get(id)?.quote;

describe("comment threads under collaboration", () => {
  test("stay on their words when another writer types inside them, which a quote alone cannot do", () => {
    const relay = new LocalRelay();
    const relative = writer(relay, { seeded: true, comments: "relative" });
    const quote = writer(relay, { comments: "quote" });
    const sacha = writer(relay);
    comment(relative, "t1", "cat");
    comment(quote, "t1", "cat");
    typeAt(sacha, find(sacha, "cat") + 1, "h");
    expect(sacha.state.doc.textContent).toContain("The chat sat.");
    expect(quoteOf(relative, "t1")).toBe("chat");
    // The quote "cat" is nowhere any more.
    expect(quoteOf(quote, "t1")).toBeUndefined();
    expect(commentsState(quote.state)?.lost.has("t1")).toBe(true);
  });

  test("follow their words when another writer types before them, and do not grow when one types right after", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, { seeded: true, comments: "relative" });
    const sacha = writer(relay);
    comment(camille, "t1", "cat");
    typeAt(sacha, find(sacha, "The"), "Look: ");
    typeAt(sacha, find(sacha, "cat") + 3, "s");
    expect(camille.state.doc.textContent).toContain("Look: The cats sat.");
    const anchor = commentsState(camille.state)?.anchors.get("t1");
    expect(anchor?.quote).toBe("cat");
    expect(camille.state.doc.textBetween(anchor!.from, anchor!.to)).toBe("cat");
  });

  test("are lost when another writer deletes their words, and come back when that writer undoes it", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, { seeded: true, comments: "relative" });
    const sacha = writer(relay);
    comment(camille, "t1", "cat");
    const at = find(sacha, "cat ");
    sacha.dispatch(sacha.state.tr.delete(at, at + 4));
    expect(camille.state.doc.textContent).toContain("The sat.");
    expect(commentsState(camille.state)?.anchors.has("t1")).toBe(false);
    expect(commentsState(camille.state)?.lost.has("t1")).toBe(true);
    undoCommand(sacha.state, sacha.dispatch);
    expect(camille.state.doc.textContent).toContain("The cat sat.");
    expect(quoteOf(camille, "t1")).toBe("cat");
  });

  test("leave the document and its hash alone: the thread is not in what is shared", () => {
    const relay = new LocalRelay();
    const camille = writer(relay, { seeded: true, comments: "relative" });
    const sacha = writer(relay);
    comment(camille, "t1", "cat");
    expect(sacha.state.doc.toJSON()).toEqual(camille.state.doc.toJSON());
    expect(JSON.stringify(camille.state.doc.toJSON())).not.toContain("t1");
  });
});
