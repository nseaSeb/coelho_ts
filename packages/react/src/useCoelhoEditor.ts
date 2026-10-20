import { canonical, type Node as CoelhoNode, type Schema as CoelhoSchema, type ValidationError } from "@coelho/core";
import { coelhoPlugins, toProseMirrorDoc, toProseMirrorSchema } from "@coelho/prosemirror";
import type { Node, Schema } from "prosemirror-model";
import { EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export interface UseCoelhoEditorOptions {
  /**
   * The schema the editor is built from. Keep its identity stable — define
   * it at module level or memoize it: a new schema object rebuilds the
   * editor, and with it the selection, the focus and the undo history.
   */
  schema: CoelhoSchema;
  /** The document to show. When it changes to something the editor does not hold, the editor is reset to it. */
  value?: CoelhoNode | null | undefined;
  /** Called with `doc.toJSON()` after every transaction that changed the document. */
  onChange?: ((document: CoelhoNode) => void) | undefined;
  /**
   * Called when `value` does not validate against the schema. The editor
   * then starts empty, or keeps what it holds, instead of loading it.
   * Defaults to a `console.error`.
   */
  onInvalid?: ((errors: ValidationError[]) => void) | undefined;
  /**
   * Plugins added after coelho's own, such as `commentsPlugin`. Read once,
   * when the editor is built: keep the array's identity stable.
   */
  plugins?: Plugin[] | undefined;
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
  const { schema, value, onChange, onInvalid } = options;
  const pluginsRef = useRef(options.plugins);
  pluginsRef.current = options.plugins;
  const pmSchema = useMemo(() => toProseMirrorSchema(schema), [schema]);
  const viewRef = useRef<EditorView | null>(null);
  const listeners = useRef(new Set<() => void>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onInvalidRef = useRef(onInvalid);
  onInvalidRef.current = onInvalid;
  const valueRef = useRef(value);
  valueRef.current = value;
  // The last document handed to `onChange`. When it comes back as `value`,
  // the editor already holds it and nothing needs comparing.
  const lastEmitted = useRef<CoelhoNode | null>(null);
  const [, setMounted] = useState(0);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);
  const state = useSyncExternalStore(subscribe, () => viewRef.current?.state ?? null, () => null);

  const load = useCallback(
    (document: CoelhoNode | null | undefined): Node | null => {
      const loaded = toProseMirrorDoc(pmSchema, schema, document);
      if (loaded.ok) return loaded.doc;
      (onInvalidRef.current ?? reportInvalid)(loaded.errors);
      return null;
    },
    [pmSchema, schema],
  );

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
        if (tr.docChanged) {
          const json = view.state.doc.toJSON() as CoelhoNode;
          lastEmitted.current = json;
          onChangeRef.current?.(json);
        }
      };
      const doc = load(valueRef.current) ?? (pmSchema.topNodeType.createAndFill() as Node);
      viewRef.current = new EditorView(element, {
        state: EditorState.create({ doc, plugins: [...coelhoPlugins(pmSchema), ...(pluginsRef.current ?? [])] }),
        dispatchTransaction,
      });
      setMounted((n) => n + 1);
    },
    [pmSchema, load],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || value === undefined || value === lastEmitted.current) return;
    if (value !== null && canonical(view.state.doc.toJSON()) === canonical(value)) return;
    const doc = load(value);
    if (doc === null) return;
    view.updateState(EditorState.create({ doc, plugins: view.state.plugins }));
    for (const listener of listeners.current) listener();
  }, [value, load]);

  const previousSchema = useRef(schema);
  useEffect(() => {
    if (previousSchema.current === schema) return;
    previousSchema.current = schema;
    console.warn(
      "coelho: the schema passed to the editor changed identity, so the editor was rebuilt and lost its selection and history. " +
        "Define the schema outside the component, or memoize it.",
    );
  }, [schema]);

  return { ref, view: viewRef.current, state, pmSchema };
}

function reportInvalid(errors: ValidationError[]): void {
  console.error("coelho: the document given to the editor does not validate, and was not loaded", errors);
}
