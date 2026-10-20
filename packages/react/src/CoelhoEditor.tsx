import type { Node as CoelhoNode, Schema as CoelhoSchema } from "@coelho/core";
import { setBlockType, toggleMark, wrapIn, wrapInList } from "@coelho/prosemirror";
import type { MarkType, NodeType } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import type { ReactNode } from "react";
import { useCoelhoEditor, type CoelhoEditor as Editor } from "./useCoelhoEditor.js";

export interface CoelhoEditorProps {
  schema: CoelhoSchema;
  value?: CoelhoNode | null;
  onChange?: (document: CoelhoNode) => void;
  /** Replaces the default toolbar; `null` removes it. */
  toolbar?: ((editor: Editor) => ReactNode) | null;
  className?: string;
}

/** React owns this element and the toolbar; ProseMirror owns the editable element inside. */
export function CoelhoEditor({ schema, value, onChange, toolbar, className }: CoelhoEditorProps): ReactNode {
  const editor = useCoelhoEditor({ schema, value, onChange });
  return (
    <div className={className ?? "coelho-editor"}>
      {toolbar === null ? null : toolbar === undefined ? <Toolbar editor={editor} /> : toolbar(editor)}
      <div ref={editor.ref} className="coelho-editor-content" />
    </div>
  );
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  return empty ? type.isInSet(state.storedMarks ?? $from.marks()) !== undefined : state.doc.rangeHasMark(from, to, type);
}

function blockActive(state: EditorState, type: NodeType, attrs: Record<string, unknown> = {}): boolean {
  const { $from, to } = state.selection;
  const node = $from.parent;
  return to <= $from.end() && node.hasMarkup(type, { ...node.attrs, ...attrs });
}

interface ButtonProps {
  editor: Editor;
  label: string;
  title: string;
  command: Command;
  active?: boolean;
}

function Button({ editor, label, title, command, active }: ButtonProps): ReactNode {
  const { view, state } = editor;
  const enabled = state !== null && command(state);
  return (
    <button
      type="button"
      title={title}
      disabled={!enabled}
      aria-pressed={active ?? false}
      onMouseDown={(event) => {
        event.preventDefault();
        if (view !== null) command(view.state, view.dispatch, view);
      }}
    >
      {label}
    </button>
  );
}

/** The default toolbar: only what the schema declares shows up. */
export function Toolbar({ editor }: { editor: Editor }): ReactNode {
  const { state, pmSchema } = editor;
  const { marks, nodes } = pmSchema;
  const mark = (name: string, label: string, title: string): ReactNode => {
    const type = marks[name];
    if (type === undefined) return null;
    return <Button key={name} editor={editor} label={label} title={title} command={toggleMark(type)} active={state !== null && markActive(state, type)} />;
  };
  const block = (name: string, label: string, title: string, attrs?: Record<string, unknown>): ReactNode => {
    const type = nodes[name];
    if (type === undefined) return null;
    return <Button key={`${name}${JSON.stringify(attrs ?? {})}`} editor={editor} label={label} title={title} command={setBlockType(type, attrs)} active={state !== null && blockActive(state, type, attrs)} />;
  };
  const wrap = (name: string, label: string, title: string, list: boolean): ReactNode => {
    const type = nodes[name];
    if (type === undefined) return null;
    return <Button key={name} editor={editor} label={label} title={title} command={list ? wrapInList(type) : wrapIn(type)} />;
  };
  return (
    <div className="coelho-toolbar" role="toolbar" aria-label="Formatting">
      {mark("bold", "B", "Bold (Mod-b)")}
      {mark("italic", "I", "Italic (Mod-i)")}
      {mark("underline", "U", "Underline (Mod-u)")}
      {mark("strike", "S", "Strikethrough")}
      {mark("code", "</>", "Code (Mod-`)")}
      {mark("highlight", "H", "Highlight")}
      <span className="coelho-toolbar-gap" />
      {block("paragraph", "¶", "Paragraph")}
      {block("heading", "H1", "Heading 1", { level: 1 })}
      {block("heading", "H2", "Heading 2", { level: 2 })}
      {block("heading", "H3", "Heading 3", { level: 3 })}
      {block("code_block", "{ }", "Code block")}
      <span className="coelho-toolbar-gap" />
      {wrap("bullet_list", "•", "Bullet list", true)}
      {wrap("ordered_list", "1.", "Ordered list", true)}
      {wrap("blockquote", "“", "Quote", false)}
    </div>
  );
}
