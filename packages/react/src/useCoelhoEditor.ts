import { canonical, type Node as CoelhoNode, type Schema as CoelhoSchema } from "@coelho/core";
import { coelhoPlugins, toProseMirrorSchema } from "@coelho/prosemirror";
import { Node, type Schema } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export interface UseCoelhoEditorOptions {
  schema: CoelhoSchema;
  /** The document to show. When it changes to something the editor does not hold, the editor is reset to it. */
  value?: CoelhoNode | null | undefined;
  /** Called with `doc.toJSON()` after every transaction that changed the document. */
  onChange?: ((document: CoelhoNode) => void) | undefined;
}

export interface CoelhoEditor {
  /** Put this on the element ProseMirror should own. React never renders into it. */
  ref: (element: HTMLElement | null) => void;
  /** The live view, or `null` before mount. */
  view: EditorView | null;
  /** The current editor state; re-renders the caller when it changes. */
  state: EditorState | null;
  pmSchema: Schema;
}

/**
 * ProseMirror inside React. The `EditorView` is created in a callback ref
 * and destroyed on unmount, which keeps StrictMode's double mount honest;
 * the state is exposed through `useSyncExternalStore`, so a toolbar
 * re-renders on selection changes without owning the view.
 */
export function useCoelhoEditor(options: UseCoelhoEditorOptions): CoelhoEditor {
  const { schema, value, onChange } = options;
  const pmSchema = useMemo(() => toProseMirrorSchema(schema), [schema]);
  const viewRef = useRef<EditorView | null>(null);
  const listeners = useRef(new Set<() => void>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [, setMounted] = useState(0);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);
  const state = useSyncExternalStore(subscribe, () => viewRef.current?.state ?? null, () => null);

  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (element === null) {
        viewRef.current?.destroy();
        viewRef.current = null;
        return;
      }
      const dispatchTransaction = (tr: Transaction): void => {
        const view = viewRef.current;
        if (view === null) return;
        view.updateState(view.state.apply(tr));
        for (const listener of listeners.current) listener();
        if (tr.docChanged) onChangeRef.current?.(view.state.doc.toJSON() as CoelhoNode);
      };
      viewRef.current = new EditorView(element, {
        state: EditorState.create({ doc: docFrom(pmSchema, value), plugins: coelhoPlugins(pmSchema) }),
        dispatchTransaction,
      });
      setMounted((n) => n + 1);
    },
    // The view is built once per schema; `value` is handled by the effect below.
    [pmSchema],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || value === undefined) return;
    if (canonical(view.state.doc.toJSON()) === canonical(value ?? emptyDoc(pmSchema))) return;
    view.updateState(EditorState.create({ doc: docFrom(pmSchema, value), plugins: view.state.plugins }));
    for (const listener of listeners.current) listener();
  }, [value, pmSchema]);

  return { ref, view: viewRef.current, state, pmSchema };
}

function docFrom(pmSchema: Schema, value: CoelhoNode | null | undefined): Node {
  if (value === null || value === undefined) return pmSchema.topNodeType.createAndFill() as Node;
  return Node.fromJSON(pmSchema, value);
}

function emptyDoc(pmSchema: Schema): CoelhoNode {
  return (pmSchema.topNodeType.createAndFill() as Node).toJSON() as CoelhoNode;
}
