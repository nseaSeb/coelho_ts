// @vitest-environment jsdom
import { defaultSchema, validate, type Node as CoelhoNode, type ValidationError } from "@nseaprotector/coelho-core";
import { afterEach, describe, expect, test } from "vitest";
import { createEditor, type CoelhoEditor } from "../src/index.js";

const schema = defaultSchema();
const hello: CoelhoNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

const editors: CoelhoEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function mount(options: Partial<Parameters<typeof createEditor>[1]> = {}): CoelhoEditor {
  const editor = createEditor(document.body.appendChild(document.createElement("div")), { schema, ...options });
  editors.push(editor);
  return editor;
}

describe("createEditor", () => {
  test("mounts a document, and reports every change as a document coelho validates", () => {
    const changes: CoelhoNode[] = [];
    const editor = mount({ value: hello, onChange: (document) => changes.push(document) });
    expect(editor.view.dom.textContent).toBe("Hello");
    editor.view.dispatch(editor.view.state.tr.insertText(", world", 6));
    expect(changes).toHaveLength(1);
    const result = validate(changes[0], schema);
    expect(result.ok && result.document).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello, world" }] }] });
    expect(editor.getDocument()).toEqual(changes[0]);
  });

  test("replaces its document, keeps it when it is the same one, and refuses one that does not validate", () => {
    const errors: ValidationError[][] = [];
    const editor = mount({ value: hello, onInvalid: (found) => errors.push(found) });
    const before = editor.view.state;
    expect(editor.setDocument(hello)).toBe(true);
    expect(editor.view.state).toBe(before);
    expect(editor.setDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Bye" }] }] })).toBe(true);
    expect(editor.view.dom.textContent).toBe("Bye");
    expect(editor.setDocument({ type: "doc", content: [{ type: "script" }] } as unknown as CoelhoNode)).toBe(false);
    expect(editor.view.dom.textContent).toBe("Bye");
    expect(errors).toHaveLength(1);
  });

  test("repairs a stored row when asked, and says what was wrong", () => {
    const errors: ValidationError[][] = [];
    const editor = mount({ value: { type: "doc", content: [{ type: "script" }, { type: "paragraph", content: [{ type: "text", text: "kept" }] }] } as unknown as CoelhoNode, repair: true, onInvalid: (found) => errors.push(found) });
    expect(editor.view.dom.textContent).toBe("kept");
    expect(errors[0]?.[0]?.message).toBe('unknown node type "script"');
  });

  test("ignores what is dispatched after it is destroyed", () => {
    const editor = mount({ value: hello });
    const tr = editor.view.state.tr.insertText("!");
    editor.destroy();
    expect(() => editor.view.dispatch(tr)).not.toThrow();
  });
});
