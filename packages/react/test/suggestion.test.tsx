// @vitest-environment jsdom
import { defaultSchema, escape, extendSchema, tag, toHtml, validate, type Node } from "@coelho/core";
import { createSuggestion, replaceSuggestion, type SuggestionKeys } from "@coelho/prosemirror";
import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { SuggestionMenu, useCoelhoEditor, useSuggestion, type CoelhoEditorHandle, type NodeViewProps } from "../src/index.js";

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

const names = ["Camille", "Carla", "Sacha"];

function Chip({ node, selected }: NodeViewProps): ReactNode {
  return <b className={selected ? "chip selected" : "chip"}>{String(node.attrs.label)}</b>;
}
const nodeViews = { mention: Chip };

let handle: CoelhoEditorHandle | null = null;
let stored: Node | null = null;

function Harness({ initial }: { initial: Node }): ReactNode {
  const [{ plugin, keys }] = useState(() => createSuggestion(["@"]));
  const [plugins] = useState(() => [plugin]);
  const [value, setValue] = useState<Node>(initial);
  const editor = useCoelhoEditor({ schema, value, onChange: (doc) => ((stored = doc), setValue(doc)), plugins, nodeViews });
  handle = editor;
  return (
    <div>
      <div ref={editor.ref} />
      {editor.portals}
      <Menu editor={editor} keys={keys} />
    </div>
  );
}

function Menu({ editor, keys }: { editor: CoelhoEditorHandle; keys: SuggestionKeys }): ReactNode {
  const suggestion = useSuggestion(editor, {
    keys,
    items: (match) => names.filter((name) => name.toLowerCase().startsWith(match.query.toLowerCase())),
    onSelect: (name) => {
      const view = editor.view;
      if (view !== null) replaceSuggestion(editor.pmSchema.nodes.mention!.create({ id: name.toLowerCase(), label: name }))(view.state, view.dispatch);
    },
  });
  return (
    <SuggestionMenu suggestion={suggestion} label="People">
      {(name) => name}
    </SuggestionMenu>
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
  handle = null;
  stored = null;
  document.body.innerHTML = "";
});

function mount(initial: Node): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<StrictMode><Harness initial={initial} /></StrictMode>));
  return container;
}

const empty: Node = { type: "doc", content: [{ type: "paragraph" }] };

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

describe("node views", () => {
  test("draw a node with a React component, while the page keeps the schema's rendering", () => {
    const doc: Node = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { id: "camille", label: "Camille" } }] }] };
    const container = mount(doc);
    const chip = container.querySelector(".ProseMirror .coelho-node-view-mention b.chip");
    expect(chip?.textContent).toBe("Camille");
    expect(toHtml(doc, schema)).toBe('<p>Ask <span class="mention">@Camille</span></p>');
  });
});

describe("suggestions", () => {
  test("list what matches the query, move with the arrows, and choose with Enter", () => {
    const container = mount(empty);
    type("Hi @ca");
    const options = (): string[] => [...container.querySelectorAll('[role="option"]')].map((option) => `${option.textContent}${option.getAttribute("aria-selected") === "true" ? "*" : ""}`);
    expect(options()).toEqual(["Camille*", "Carla"]);
    const dom = handle!.view!.dom;
    expect(dom.getAttribute("role")).toBe("textbox");
    expect(dom.getAttribute("aria-multiline")).toBe("true");
    expect(dom.getAttribute("aria-controls")).toBe(container.querySelector('[role="listbox"]')?.id);
    expect(dom.getAttribute("aria-activedescendant")).toBe(container.querySelector('[aria-selected="true"]')?.id);

    key("ArrowDown");
    expect(options()).toEqual(["Camille", "Carla*"]);
    key("Enter");

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(dom.hasAttribute("aria-activedescendant")).toBe(false);
    expect(dom.hasAttribute("aria-controls")).toBe(false);
    expect(dom.hasAttribute("aria-autocomplete")).toBe(false);
    expect(container.querySelector(".coelho-node-view-mention b")?.textContent).toBe("Carla");
    const result = validate(stored, schema);
    expect(result.ok && result.document.content?.[0]?.content).toEqual([
      { type: "text", text: "Hi " },
      { type: "mention", attrs: { id: "carla", label: "Carla" } },
      { type: "text", text: " " },
    ]);
  });

  test("close on Escape without touching the text", () => {
    const container = mount(empty);
    type("@s");
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    key("Escape");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(handle!.view!.state.doc.textContent).toBe("@s");
  });

  test("choose with a click, which keeps the editor's range", () => {
    const container = mount(empty);
    type("@sa");
    const option = container.querySelector('[role="option"]') as HTMLElement;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => option.click());
    expect(container.querySelector(".coelho-node-view-mention b")?.textContent).toBe("Sacha");
  });

  test("show nothing when nothing matches, and let Enter through", () => {
    const container = mount(empty);
    type("@zz");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    key("Enter");
    expect(handle!.view!.state.doc.childCount).toBe(2);
  });
});
