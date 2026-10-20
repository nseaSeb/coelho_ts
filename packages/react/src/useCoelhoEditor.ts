import type { Node as CoelhoNode, Schema as CoelhoSchema, ValidationError } from "@coelho/core";
import { coelhoPlugins, toProseMirrorDoc, toProseMirrorSchema } from "@coelho/prosemirror";
import type { Node, Schema } from "prosemirror-model";
import { EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { NodeViewStore, renderPortals, type NodeViewComponents } from "./nodeViews.js";

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
   * Load a `value` that does not validate after repairing it with
   * `sanitize`, rather than refusing it. `onInvalid` is still told what was
   * wrong. The repaired document reaches `onChange` only once it is edited.
   */
  repair?: boolean | undefined;
  /**
   * Plugins added to coelho's own, such as `commentsPlugin`, and placed
   * before them, so a plugin that handles a key is asked before the keymap.
   * Read once, when the editor is built: keep the array's identity stable.
   */
  plugins?: Plugin[] | undefined;
  /**
   * React components drawing leaf nodes in the editor, by node name. The
   * page still renders those nodes from the schema; this is how the editor
   * shows them. Read once, when the editor is built.
   */
  nodeViews?: NodeViewComponents | undefined;
}

export interface CoelhoEditor {
  /** Put this on the element ProseMirror should own. React never renders into it. */
  ref: (element: HTMLElement | null) => void;
  /** The live view, or `null` before mount. */
  view: EditorView | null;
  /** The current editor state; re-renders the caller when it changes. */
  state: EditorState | null;
  pmSchema: Schema;
  /** The node views' portals. `CoelhoEditor` renders them; a caller using the hook directly renders this anywhere in its tree. */
  portals: ReactNode;
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
  const nodeViewsRef = useRef(options.nodeViews);
  nodeViewsRef.current = options.nodeViews;
  const [store] = useState(() => new NodeViewStore());
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const pmSchema = useMemo(() => toProseMirrorSchema(schema), [schema]);
  const viewRef = useRef<EditorView | null>(null);
  const listeners = useRef(new Set<() => void>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onInvalidRef = useRef(onInvalid);
  onInvalidRef.current = onInvalid;
  const repairRef = useRef(options.repair);
  repairRef.current = options.repair;
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

  // The value a problem was last reported for, so one bad document is
  // reported once, however many times it is looked at.
  const reportedFor = useRef<unknown>(undefined);
  const load = useCallback(
    (document: CoelhoNode | null | undefined, current?: Node): Node | null => {
      const loaded = toProseMirrorDoc(pmSchema, schema, document, { repair: repairRef.current ?? false });
      // Compared as ProseMirror documents, which fill in default attributes:
      // a validated document omits them and `toJSON` spells them out, so the
      // two JSON forms of one document never match byte for byte.
      if (loaded.ok && current !== undefined && loaded.doc.eq(current)) return null;
      const problems = loaded.ok ? loaded.repaired : loaded.errors;
      if (problems !== undefined && reportedFor.current !== document) {
        reportedFor.current = document;
        (onInvalidRef.current ?? (loaded.ok ? reportRepaired : reportInvalid))(problems);
      }
      return loaded.ok ? loaded.doc : null;
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
        // The application's plugins come first, so one that handles a key
        // (a suggestion list taking Enter) is asked before the keymap.
        state: EditorState.create({ doc, plugins: [...(pluginsRef.current ?? []), ...coelhoPlugins(pmSchema)] }),
        nodeViews: store.constructors(nodeViewsRef.current ?? {}),
        dispatchTransaction,
      });
      setMounted((n) => n + 1);
    },
    [pmSchema, load, store],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || value === undefined || value === lastEmitted.current) return;
    const doc = load(value, view.state.doc);
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

  const portals = useMemo(() => renderPortals(entries), [entries]);
  return { ref, view: viewRef.current, state, pmSchema, portals };
}

function reportInvalid(errors: ValidationError[]): void {
  console.error("coelho: the document given to the editor does not validate, and was not loaded", errors);
}

function reportRepaired(errors: ValidationError[]): void {
  console.warn("coelho: the document given to the editor did not validate, and was repaired with sanitize", errors);
}
