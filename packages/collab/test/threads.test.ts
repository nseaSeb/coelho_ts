// @vitest-environment jsdom
import { anchorAt, defaultSchema, extendSchema, hash, type Comment, type Node as CoelhoNode } from "@nseaprotector/coelho-core";
import { addComment, coelhoPlugins, commentsPlugin, commentsState, proseMirrorSchemaFor, relocateComments } from "@nseaprotector/coelho-prosemirror";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Awareness } from "y-protocols/awareness";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { collab, LocalRelay, seed, sharedThreads, snapshot, THREADS, type SharedThreads } from "../src/index.js";

const schema = defaultSchema();
const pm = proseMirrorSchemaFor(schema);
const stored: CoelhoNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "The cat sat on the mat." }] }] };

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
  name: string;
  doc: Y.Doc;
  view: EditorView;
  threads: SharedThreads;
}

/** A writer whose editor relocates its threads whenever the shared ones change, as the demo does. */
function writer(relay: LocalRelay, name: string, seeded = false): Writer {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  if (seeded) seed(doc, schema, stored);
  relay.join(doc, awareness);
  const threads = sharedThreads(doc, name, { bodies: defaultSchema() });
  const fresh = collab({ doc, awareness })(pm);
  const view = new EditorView(document.body.appendChild(document.createElement("div")), {
    state: EditorState.create({ doc: fresh.doc, plugins: [...fresh.plugins, commentsPlugin({ schema, source: threads.source }), ...coelhoPlugins(pm, { history: false })] }),
  });
  threads.subscribe(() => queueMicrotask(() => relocateComments()(view.state, view.dispatch)));
  views.push(view);
  return { name, doc, view, threads };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function comment(author: Writer, id: string, word: string): void {
  const { view } = author;
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    const index = node.isText ? (node.text ?? "").indexOf(word) : -1;
    if (from === -1 && index !== -1) from = pos + index;
  });
  author.threads.open(id, anchorAt(view.state.doc.toJSON() as CoelhoNode, schema, from, from + word.length));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + word.length)));
  addComment(id)(view.state, view.dispatch);
}

const said = (author: string, text: string): Comment => ({
  id: `${author}-${text}`,
  author,
  createdAt: "2026-10-20T09:00:00.000Z",
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
});

const highlighted = (at: Writer, id: string): string | undefined => {
  const anchor = commentsState(at.view.state)?.anchors.get(id);
  return anchor === undefined ? undefined : at.view.state.doc.textBetween(anchor.from, anchor.to);
};

describe("shared threads", () => {
  test("a thread opened by one writer appears to the other on its words, once it has a comment", async () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    comment(camille, "t1", "cat");
    await settle();
    // A draft is its author's alone.
    expect(camille.threads.list().map((t) => t.id)).toEqual(["t1"]);
    expect(sacha.threads.list()).toEqual([]);
    expect(highlighted(sacha, "t1")).toBeUndefined();

    camille.threads.reply("t1", said("Camille", "Which cat?"));
    await settle();
    expect(sacha.threads.list().map((t) => [t.id, t.comments.map((c) => c.author)])).toEqual([["t1", ["Camille"]]]);
    expect(highlighted(sacha, "t1")).toBe("cat");
  });

  test("keeps both replies posted at once, offline", async () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    comment(camille, "t1", "cat");
    camille.threads.reply("t1", said("Camille", "Which cat?"));
    await settle();
    relay.setOnline(false);
    camille.threads.reply("t1", said("Camille", "The grey one."));
    sacha.threads.reply("t1", said("Sacha", "The one on the mat."));
    relay.setOnline(true);
    await settle();
    const replies = (at: Writer): string[] => at.threads.list()[0]?.comments.map((c) => c.author) ?? [];
    expect(replies(camille)).toHaveLength(3);
    expect(replies(sacha)).toEqual(replies(camille));
  });

  test("resolving and deleting reach every writer, and the document and its hash never change", async () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    const before = await hash(snapshot(camille.doc, schema).document);
    comment(camille, "t1", "cat");
    camille.threads.reply("t1", said("Camille", "Which cat?"));
    await settle();
    sacha.threads.resolve("t1", true);
    await settle();
    expect(commentsState(camille.view.state)?.resolved.has("t1")).toBe(true);
    expect(await hash(snapshot(camille.doc, schema).document)).toBe(before);
    sacha.threads.remove("t1");
    await settle();
    expect(camille.threads.list()).toEqual([]);
    expect(commentsState(camille.view.state)?.anchors.size).toBe(0);
  });

  test("a shared thread follows its words through the other writer's typing", async () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    comment(camille, "t1", "cat");
    camille.threads.reply("t1", said("Camille", "Which cat?"));
    await settle();
    const { view } = sacha;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText) at = pos + (node.text ?? "").indexOf("cat") + 1;
    });
    view.dispatch(view.state.tr.insertText("h", at));
    await settle();
    expect(highlighted(camille, "t1")).toBe("chat");
    expect(highlighted(sacha, "t1")).toBe("chat");
  });

  test("are not a trust boundary: what a peer writes into them past the editor breaks nothing, and is repaired", async () => {
    const relay = new LocalRelay();
    const camille = writer(relay, "Camille", true);
    const sacha = writer(relay, "Sacha");
    const threads = sacha.doc.getMap<unknown>(THREADS);
    sacha.doc.transact(() => {
      threads.set("not-a-thread", "just a string");
      const broken = new Y.Map<unknown>();
      threads.set("broken", broken);
      broken.set("quote", 42);
      broken.set("range", { from: "nowhere", to: [1, 2, 3], last: null });
      broken.set("comments", "not a list");
      const hostile = new Y.Map<unknown>();
      threads.set("hostile", hostile);
      hostile.set("quote", "cat");
      const comments = new Y.Array<unknown>();
      hostile.set("comments", comments);
      comments.push([{ id: "x", author: "Mallory", body: { type: "doc", content: [{ type: "script" }, { type: "paragraph", content: [{ type: "text", text: "Kept words." }] }] } }, "not a comment"]);
    });
    await settle();

    // Camille's editor still takes remote typing and relocates threads.
    const { view } = sacha;
    view.dispatch(view.state.tr.insertText("Look: ", 1));
    await settle();
    expect(camille.view.state.doc.textContent).toBe("Look: The cat sat on the mat.");

    const listed = camille.threads.list();
    expect(listed.map((thread) => thread.id).sort()).toEqual(["broken", "hostile"]);
    const hostile = listed.find((thread) => thread.id === "hostile");
    expect(hostile?.comments).toEqual([{ id: "x", author: "Mallory", createdAt: "", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Kept words." }] }] } }]);
    // Threads with no usable range are not placed on a guess: a bare quote
    // with no context around it could be any "cat".
    expect(commentsState(camille.view.state)?.anchors.has("hostile")).toBe(false);
    expect(commentsState(camille.view.state)?.anchors.has("broken")).toBe(false);
    // And a reply still lands on a thread whose comments were not a list.
    camille.threads.reply("broken", said("Camille", "Repaired."));
    await settle();
    expect(sacha.threads.list().find((thread) => thread.id === "broken")?.comments.map((c) => c.author)).toEqual(["Camille"]);
  });
});

describe("placing threads", () => {
  test("reads where they are, in the order they were opened, drafts of others left out, and no comment body", () => {
    let checked = 0;
    const bodies = extendSchema(defaultSchema(), {
      nodes: { probe: { group: "inline", inline: true, void: true, attrs: { n: { validate: () => (checked++, null) } } } },
    });
    const doc = new Y.Doc();
    const mine = sharedThreads(doc, "Ada", { bodies });
    const theirs = sharedThreads(doc, "Lin", { bodies });
    mine.open("second", { from: 0, to: 0, quote: "b" });
    theirs.open("hidden", { from: 0, to: 0, quote: "c" });
    mine.reply("second", { id: "c1", author: "Ada", createdAt: "", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "probe", attrs: { n: 1 } }] }] } });
    const map = doc.getMap<Y.Map<unknown>>(THREADS);
    map.get("second")?.set("opened", 2);
    mine.open("first", { from: 0, to: 0, quote: "a" });
    map.get("first")?.set("opened", 1);
    expect(mine.source.threads().map((thread) => thread.id)).toEqual(["first", "second"]);
    expect(mine.places()).toEqual(mine.list().map(({ id, anchor, resolved }) => ({ id, anchor, resolved })));
    checked = 0;
    mine.source.threads();
    expect(checked).toBe(0);
    mine.list();
    expect(checked).toBeGreaterThan(0);
  });
});
