// @vitest-environment jsdom
import { defaultSchema, validate, type Node } from "@nseaprotector/coelho-core";
import { createSuggestion } from "@nseaprotector/coelho-prosemirror";
import { useCoelhoEditor, type CoelhoEditorHandle } from "@nseaprotector/coelho-react";
import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, test } from "vitest";
import { matching, Suggestions } from "../src/Suggestions.js";

const schema = defaultSchema();
let handle: CoelhoEditorHandle | null = null;

function Harness(): ReactNode {
  const [suggestion] = useState(() => createSuggestion(["@", "/"]));
  const [plugins] = useState(() => [suggestion.plugin]);
  const [value, setValue] = useState<Node>({ type: "doc", content: [{ type: "paragraph" }] });
  const editor = useCoelhoEditor({ schema, value, onChange: setValue, plugins });
  handle = editor;
  return (
    <div>
      <div ref={editor.ref} />
      <Suggestions editor={editor} keys={suggestion.keys} />
    </div>
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const empty = (): DOMRectList => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  for (const proto of [Element.prototype, Text.prototype, Range.prototype] as unknown as Array<Record<string, unknown>>) {
    proto.getClientRects = empty;
    proto.getBoundingClientRect = rect;
  }
  document.elementFromPoint = () => null;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<StrictMode><Harness /></StrictMode>));
  return container;
}

function type(text: string): void {
  act(() => {
    const view = handle!.view!;
    view.dispatch(view.state.tr.insertText(text));
  });
}

function key(name: string): void {
  act(() => {
    handle!.view!.dom.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

test("/ turns the line into the chosen block, and the command's text is gone", () => {
  const container = mount();
  type("Programme /head");
  const options = [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  expect(options).toEqual(["Heading 1#", "Heading 2##", "Heading 3###"]);
  key("ArrowDown");
  key("Enter");
  const result = validate(handle!.view!.state.doc.toJSON(), schema);
  expect(result.ok && result.document.content).toEqual([{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Programme " }] }]);
});

test("/ wraps the line in a list", () => {
  const container = mount();
  type("/bul");
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
  key("Enter");
  expect(handle!.view!.state.doc.firstChild?.type.name).toBe("bullet_list");
  expect(handle!.view!.state.doc.textContent).toBe("");
});

test("@ matches any word of a name from its start, ignoring case and accents", () => {
  expect(matching("elo").map((person) => person.name)).toEqual(["Éloïse Moreau"]);
  expect(matching("MAR").map((person) => person.name)).toEqual(["Sacha Martin"]);
  expect(matching("ille")).toEqual([]);
});
