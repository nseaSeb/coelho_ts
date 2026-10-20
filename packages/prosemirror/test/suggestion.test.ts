import { defaultSchema, extendSchema, tag, escape } from "@nseaprotector/coelho-core";
import { Node } from "prosemirror-model";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { clearSuggestion, createSuggestion, dismissSuggestion, replaceSuggestion, suggestionState, toProseMirrorSchema } from "../src/index.js";

const schema = extendSchema(defaultSchema(), {
  nodes: {
    mention: {
      group: "inline",
      inline: true,
      void: true,
      attrs: { id: { required: true, validate: "string" }, label: { default: null, validate: { nullable: "string" } } },
      render: (node) => tag("span", [["class", "mention"]], escape(`@${String(node.attrs?.label)}`)),
    },
  },
});
const pm = toProseMirrorSchema(schema);

function start(json: unknown = { type: "doc", content: [{ type: "paragraph" }] }): EditorState {
  const { plugin } = createSuggestion(["@", "/"]);
  const doc = Node.fromJSON(pm, json);
  return EditorState.create({ doc, plugins: [plugin], selection: TextSelection.atEnd(doc) });
}

function typed(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

function run(state: EditorState, command: Command): EditorState {
  let next = state;
  expect(command(state, (tr) => (next = state.apply(tr)))).toBe(true);
  return next;
}

describe("suggestion", () => {
  test("opens on a trigger that starts a word, and follows the query", () => {
    let state = typed(start(), "Hello @");
    expect(suggestionState(state)).toEqual({ trigger: "@", query: "", from: 7, to: 8 });
    state = typed(state, "ca");
    expect(suggestionState(state)).toEqual({ trigger: "@", query: "ca", from: 7, to: 10 });
  });

  test("does not open in the middle of a word: a@b is an address", () => {
    expect(suggestionState(typed(start(), "mail a@b"))).toBeNull();
  });

  test("closes at the first space", () => {
    expect(suggestionState(typed(start(), "@camille "))).toBeNull();
  });

  test("does not open inside code", () => {
    const code = start({ type: "doc", content: [{ type: "code_block" }] });
    expect(suggestionState(typed(code, "@x"))).toBeNull();
    let marked = start();
    marked = marked.apply(marked.tr.addStoredMark(pm.marks.code!.create()).insertText("@x"));
    expect(suggestionState(marked)).toBeNull();
  });

  test("stays closed after Escape until the writer starts again elsewhere", () => {
    let state = run(typed(start(), "@ca"), dismissSuggestion());
    expect(suggestionState(state)).toBeNull();
    state = typed(state, "m");
    expect(suggestionState(state)).toBeNull();
    state = typed(state, " /h");
    expect(suggestionState(state)).toMatchObject({ trigger: "/", query: "h" });
  });

  test("replaces exactly the trigger and the query with a node and a space", () => {
    const state = run(typed(start(), "Hi @cam"), replaceSuggestion(pm.nodes.mention!.create({ id: "u1", label: "Camille" })));
    expect(state.doc.toJSON()).toEqual({
      type: "doc",
      content: [{ type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: "u1", label: "Camille" } }, { type: "text", text: " " }] }],
    });
    expect(state.selection.from).toBe(state.doc.content.size - 1);
    expect(suggestionState(state)).toBeNull();
  });

  test("clears a command's trigger without inserting anything", () => {
    const state = run(typed(start(), "/head"), clearSuggestion());
    expect(state.doc.textContent).toBe("");
    expect(suggestionState(state)).toBeNull();
  });
});
