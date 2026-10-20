import type { Node as CoelhoNode, Schema as CoelhoSchema, ValidationError } from "@nseaprotector/coelho-core";
import type { Node, Schema } from "prosemirror-model";
import { EditorState, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { coelhoPlugins } from "./plugins.js";
import { proseMirrorSchemaFor, toProseMirrorDoc } from "./schema.js";

export interface CreateEditorOptions {
  schema: CoelhoSchema;
  /** The document to start from; `null` or absent is the empty document. */
  value?: CoelhoNode | null;
  /** Called with `doc.toJSON()` after every change to the document. */
  onChange?: (document: CoelhoNode) => void;
  /** Called with every transaction, for a toolbar that follows the selection. */
  onTransaction?: (state: EditorState) => void;
  /** Called when a document does not validate. Defaults to a `console.error`. */
  onInvalid?: (errors: ValidationError[]) => void;
  /** Load a document that does not validate after repairing it with `sanitize`, instead of refusing it. */
  repair?: boolean;
  /** Plugins placed before coelho's own, so one that handles a key is asked first. */
  plugins?: Plugin[];
  /** ProseMirror's undo history; on by default, off for collaborative editing. */
  history?: boolean;
  /** For collaboration: the first document and the plugins, from `collab()` in `@nseaprotector/coelho-collab`. */
  setup?: (pmSchema: Schema) => { doc?: Node; plugins?: Plugin[] };
}

export interface CoelhoEditor {
  view: EditorView;
  /** The document as `onChange` hands it out. */
  getDocument(): CoelhoNode;
  /**
   * Replaces the document, unless it is the one the editor holds already.
   * Returns false when it does not validate, in which case nothing changes.
   */
  setDocument(document: CoelhoNode | null): boolean;
  destroy(): void;
}

/**
 * The editor without a framework: mount it on an element, hand it a
 * document, and hear about changes. What a Vue or Angular component wraps,
 * and what `@nseaprotector/coelho-react` wraps for React.
 */
export function createEditor(element: HTMLElement, options: CreateEditorOptions): CoelhoEditor {
  const pmSchema = proseMirrorSchemaFor(options.schema);
  const report = options.onInvalid ?? ((errors: ValidationError[]) => console.error("coelho: the document does not validate", errors));

  const load = (document: CoelhoNode | null | undefined): Node | null => {
    const loaded = toProseMirrorDoc(pmSchema, options.schema, document, { repair: options.repair ?? false });
    if (!loaded.ok) {
      report(loaded.errors);
      return null;
    }
    if (loaded.repaired !== undefined) report(loaded.repaired);
    return loaded.doc;
  };

  const fresh = options.setup?.(pmSchema) ?? {};
  const doc = fresh.doc ?? load(options.value) ?? (pmSchema.topNodeType.createAndFill() as Node);
  const plugins = [...(fresh.plugins ?? []), ...(options.plugins ?? []), ...coelhoPlugins(pmSchema, { history: options.history ?? true })];

  const view: EditorView = new EditorView(element, {
    state: EditorState.create({ doc, plugins }),
    dispatchTransaction(tr) {
      if (view.isDestroyed) return;
      view.updateState(view.state.apply(tr));
      options.onTransaction?.(view.state);
      if (tr.docChanged) options.onChange?.(view.state.doc.toJSON() as CoelhoNode);
    },
  });

  return {
    view,
    getDocument: () => view.state.doc.toJSON() as CoelhoNode,
    setDocument: (document) => {
      const loaded = toProseMirrorDoc(pmSchema, options.schema, document, { repair: options.repair ?? false });
      if (loaded.ok && loaded.doc.eq(view.state.doc)) return true;
      const next = load(document);
      if (next === null) return false;
      view.updateState(EditorState.create({ doc: next, plugins: view.state.plugins }));
      options.onTransaction?.(view.state);
      return true;
    },
    destroy: () => view.destroy(),
  };
}
