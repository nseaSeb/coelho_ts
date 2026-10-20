import { contentSize, defaultSchema, reanchor, textBetween, type Node as CoelhoNode } from "@coelho/core";
import { Node } from "prosemirror-model";
import { history, undo } from "prosemirror-history";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { addComment, commentsPlugin, commentsState, removeComment, setCommentResolved, toProseMirrorSchema, type StoredAnchor } from "../src/index.js";

const schema = defaultSchema();
const pm = toProseMirrorSchema(schema);

const json: CoelhoNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "The " },
        { type: "text", text: "cat", marks: [{ type: "bold" }] },
        { type: "text", text: " sat" },
        { type: "hard_break" },
        { type: "text", text: "on the mat." },
      ],
    },
    { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "horizontal_rule" },
    { type: "code_block", content: [{ type: "text", text: "a\nb" }] },
  ],
};

function editor(stored: StoredAnchor[] = [], doc: CoelhoNode = json): EditorState {
  return EditorState.create({ doc: Node.fromJSON(pm, doc), plugins: [history(), commentsPlugin({ schema, restore: () => stored })] });
}

function run(state: EditorState, build: (state: EditorState) => Transaction): EditorState {
  return state.apply(build(state));
}

function comment(state: EditorState, id: string, from: number, to: number): EditorState {
  const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  let next = selected;
  expect(addComment(id)(selected, (tr) => (next = selected.apply(tr)))).toBe(true);
  return next;
}

describe("positions agree with ProseMirror", () => {
  test("on every range of a document with marks, leaves, lists and code", () => {
    const doc = Node.fromJSON(pm, json);
    expect(contentSize(json, schema)).toBe(doc.content.size);
    for (let from = 0; from <= doc.content.size; from += 1) {
      for (let to = from; to <= doc.content.size; to += 1) {
        expect(textBetween(json, schema, from, to)).toBe(doc.textBetween(from, to, "\n", ""));
      }
    }
  });
});

describe("comments plugin", () => {
  test("opens a thread on the selection and keeps the document untouched", () => {
    const state = comment(editor(), "t1", 12, 15);
    expect(commentsState(state)?.anchors.get("t1")).toEqual({ from: 12, to: 15, quote: "cat" });
    expect(state.doc.toJSON()).toEqual(Node.fromJSON(pm, json).toJSON());
  });

  test("follows its text when something is typed before it, and does not grow when typing at its end", () => {
    let state = comment(editor(), "t1", 12, 15);
    state = run(state, (s) => s.tr.insertText("Big ", 8));
    expect(commentsState(state)?.anchors.get("t1")).toEqual({ from: 16, to: 19, quote: "cat" });
    state = run(state, (s) => s.tr.insertText("s", 19));
    expect(commentsState(state)?.anchors.get("t1")?.quote).toBe("cat");
  });

  test("loses a thread whose text is deleted, and finds it again on undo", () => {
    let state = comment(editor(), "t1", 12, 15);
    state = run(state, (s) => s.tr.delete(8, 19));
    expect(commentsState(state)?.anchors.has("t1")).toBe(false);
    expect(commentsState(state)?.lost.get("t1")?.quote).toBe("cat");
    let undone = state;
    undo(state, (tr) => (undone = state.apply(tr)));
    expect(commentsState(undone)?.anchors.get("t1")).toEqual({ from: 12, to: 15, quote: "cat" });
  });

  test("does not reattach a lost thread to the same word typed again", () => {
    let state = comment(editor(), "t1", 12, 15);
    state = run(state, (s) => s.tr.delete(12, 15));
    state = run(state, (s) => s.tr.insertText("cat", 12));
    expect(commentsState(state)?.anchors.has("t1")).toBe(false);
  });

  test("restores stored anchors, by quote when the document changed elsewhere", () => {
    const stored = [{ id: "t1", anchor: { from: 12, to: 15, quote: "cat" }, resolved: true }];
    const edited = { ...json, content: [{ type: "paragraph", content: [{ type: "text", text: "Inserted elsewhere." }] }, ...(json.content ?? [])] };
    const state = editor(stored, edited);
    const anchor = commentsState(state)?.anchors.get("t1");
    expect(anchor?.quote).toBe("cat");
    expect(anchor).toEqual(reanchor(edited, schema, stored[0]!.anchor));
    expect(commentsState(state)?.resolved.has("t1")).toBe(true);
  });

  test("resolves and removes", () => {
    let state = comment(editor(), "t1", 12, 15);
    setCommentResolved("t1", true)(state, (tr) => (state = state.apply(tr)));
    expect(commentsState(state)?.decorations.find()[0]?.spec.id).toBe("t1");
    expect(commentsState(state)?.resolved.has("t1")).toBe(true);
    removeComment("t1")(state, (tr) => (state = state.apply(tr)));
    expect(commentsState(state)?.anchors.size).toBe(0);
  });
});
