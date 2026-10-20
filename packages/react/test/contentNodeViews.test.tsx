// @vitest-environment jsdom
import { defaultSchema, extendSchema, validate, type Node } from "@nseaprotector/coelho-core";
import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { useCoelhoEditor, type CoelhoEditorHandle, type NodeViewProps } from "../src/index.js";

const schema = extendSchema(defaultSchema(), {
  nodes: {
    callout: {
      content: "paragraph+",
      group: "block",
      attrs: { kind: { default: "note", validate: { oneOf: ["note", "warning"] } } },
      render: ["aside", []],
      parse: ["aside"],
    },
  },
});

let renders = 0;
/** Chrome around the callout's text: an icon and a select, the text itself left to ProseMirror. */
function Callout({ node, updateAttributes }: NodeViewProps): ReactNode {
  renders += 1;
  return (
    <>
      <span className="icon">{node.attrs.kind === "warning" ? "!" : "i"}</span>
      <select aria-label="Kind" value={String(node.attrs.kind)} onChange={(event) => updateAttributes({ kind: event.target.value })}>
        <option value="note">note</option>
        <option value="warning">warning</option>
      </select>
    </>
  );
}
const nodeViews = { callout: Callout };

let handle: CoelhoEditorHandle | null = null;
let stored: Node | null = null;

function Harness({ initial }: { initial: Node }): ReactNode {
  const [value, setValue] = useState(initial);
  const editor = useCoelhoEditor({ schema, value, onChange: (doc) => ((stored = doc), setValue(doc)), nodeViews });
  handle = editor;
  return (
    <div>
      <div ref={editor.ref} />
      {editor.portals}
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
  handle = null;
  stored = null;
  document.body.innerHTML = "";
});

const callout: Node = { type: "doc", content: [{ type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "Mind the gap." }] }] }] };

function mount(): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => root?.render(<StrictMode><Harness initial={callout} /></StrictMode>));
  return container;
}

describe("a React node view with content", () => {
  test("draws its chrome with React, and keeps its text in ProseMirror's hands", () => {
    const container = mount();
    const view = container.querySelector(".coelho-node-view-callout") as HTMLElement;
    expect(view.querySelector(".coelho-node-view-chrome .icon")?.textContent).toBe("i");
    expect(view.querySelector(".coelho-node-view-chrome")?.getAttribute("contenteditable")).toBe("false");
    expect(view.querySelector(".coelho-node-view-content p")?.textContent).toBe("Mind the gap.");
  });

  test("its text is edited like any other, from the keyboard's DOM changes too", async () => {
    const container = mount();
    act(() => {
      const editor = handle!.view!;
      editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)).insertText("Please "));
    });
    expect(container.querySelector(".coelho-node-view-content p")?.textContent).toBe("Please Mind the gap.");
    // What a browser does when someone types: change the DOM, which ProseMirror reads back.
    await act(async () => {
      (container.querySelector(".coelho-node-view-content p") as HTMLElement).textContent = "Typed inside.";
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const result = validate(stored, schema);
    expect(result.ok && result.document.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Typed inside.");
  });

  test("its controls change the node's attributes, and what React draws is never read as content", async () => {
    const container = mount();
    const select = container.querySelector(".coelho-node-view-chrome select") as HTMLSelectElement;
    await act(async () => {
      select.value = "warning";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.querySelector(".coelho-node-view-chrome .icon")?.textContent).toBe("!");
    // The element carries it too, for a stylesheet to follow around the content.
    expect(container.querySelector(".coelho-node-view-callout")?.getAttribute("data-kind")).toBe("warning");
    const result = validate(stored, schema);
    expect(result.ok && result.document.content?.[0]).toEqual({ type: "callout", attrs: { kind: "warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Mind the gap." }] }] });
    // The icon's text never reached the document.
    expect(handle!.view!.state.doc.textContent).toBe("Mind the gap.");
  });

  test("the component re-renders when the node changes, not on every keystroke elsewhere", () => {
    const doc: Node = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before." }] }, ...(callout.content ?? [])] };
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root?.render(<Harness initial={doc} />));
    const before = renders;
    act(() => {
      const editor = handle!.view!;
      editor.dispatch(editor.state.tr.insertText("!", 8));
    });
    expect(renders).toBe(before);
  });
});
