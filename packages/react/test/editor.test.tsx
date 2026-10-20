// @vitest-environment jsdom
import { defaultSchema, validate, type Node, type ValidationError } from "@coelho/core";
import { undoDepth } from "prosemirror-history";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { CoelhoEditor, type CoelhoEditorHandle } from "../src/index.js";

const schema = defaultSchema();

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

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

// ProseMirror reads typed text from DOM mutations, which is what a browser produces.
async function type(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    const paragraph = container.querySelector(".ProseMirror p") as HTMLElement;
    paragraph.textContent = text;
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("a controlled editor", () => {
  test("keeps its history when the parent stores the validated document it emitted", async () => {
    let handle: CoelhoEditorHandle | null = null;
    let resets = 0;
    function Parent(): ReactNode {
      // The README's pattern: store what validate returns, feed it back.
      const [value, setValue] = useState<Node>({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] });
      return (
        <CoelhoEditor
          schema={schema}
          value={value}
          onChange={(document) => {
            const result = validate(document, schema);
            if (result.ok) setValue(result.document);
          }}
          toolbar={(editor) => {
            // A new view means the editor was rebuilt, and its history with it.
            if (handle?.view !== null && handle?.view !== undefined && editor.view !== handle.view) resets += 1;
            handle = editor;
            return null;
          }}
        />
      );
    }
    const container = mount(<Parent />);
    await type(container, "ab");
    await type(container, "abc");
    const state = (handle as CoelhoEditorHandle | null)?.state;
    expect(state?.doc.textContent).toBe("abc");
    expect(state !== null && state !== undefined && undoDepth(state)).toBeGreaterThan(0);
    expect(resets).toBe(0);
  });

  test("reports a repaired document once", () => {
    const reports: ValidationError[][] = [];
    const stored = { type: "doc", content: [{ type: "script" }, { type: "paragraph", content: [{ type: "text", text: "kept" }] }] } as Node;
    const container = mount(<CoelhoEditor schema={schema} value={stored} repair onInvalid={(errors) => reports.push(errors)} toolbar={null} />);
    expect(container.querySelector(".ProseMirror")?.textContent).toBe("kept");
    expect(reports).toHaveLength(1);
  });
});
