import { sanitize, validate, type Document, type Node as CoelhoNode, type Schema as CoelhoSchema, type ValidationError } from "@coelho/core";
import { proseMirrorSchemaFor } from "@coelho/prosemirror";
import { keymap } from "prosemirror-keymap";
import type { Node, Schema } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import {
  initProseMirrorDoc,
  prosemirrorJSONToYXmlFragment,
  redoCommand,
  undoCommand,
  yCursorPlugin,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

/**
 * Collaborative editing over Yjs. The CRDT carries every writer's changes
 * and merges them; it is not the storage. What is stored stays coelho's
 * validated JSON, read out of the shared document with `snapshot` where it
 * is saved — on the server, since any peer can write anything into a
 * shared document.
 */

/** The name of the shared XML fragment holding the document. */
export const FIELD = "coelho";

/**
 * Puts a stored document into an empty shared document. Once per room:
 * seeding two docs from the same JSON and syncing them shows the content
 * twice, so one is seeded and the others receive it. Refuses a shared
 * document that already holds content.
 */
export function seed(doc: Y.Doc, schema: CoelhoSchema, document: unknown, field = FIELD): void {
  const fragment = doc.getXmlFragment(field);
  if (fragment.length > 0) throw new Error("coelho: this shared document already holds content; seed a room only once");
  prosemirrorJSONToYXmlFragment(proseMirrorSchemaFor(schema), sanitize(document, schema), fragment);
}

export interface Snapshot {
  document: Document;
  /** What did not validate, and was repaired by `sanitize`; empty when the shared document was valid. */
  errors: ValidationError[];
}

/**
 * The shared document as coelho's validated JSON, ready to store. Read
 * without ProseMirror, so reading changes nothing in the shared document.
 * A concurrent merge, or a peer writing past the editor, can leave
 * something the schema refuses: it is repaired, and reported.
 */
export function snapshot(doc: Y.Doc, schema: CoelhoSchema, field = FIELD): Snapshot {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(field)) as CoelhoNode;
  const result = validate(json, schema);
  return result.ok ? { document: result.document, errors: [] } : { document: sanitize(json, schema), errors: result.errors };
}

export interface CollabOptions {
  doc: Y.Doc;
  awareness: Awareness;
  field?: string;
}

/**
 * What an editor needs to join a shared document, built fresh for every
 * view: its first document, read from the shared one, and the sync, cursor
 * and undo plugins, with undo bound to the keys. Hand it to
 * `useCoelhoEditor({ setup, history: false })`. Undo is the writer's own:
 * it reverts what they did, never what others did.
 */
export function collab({ doc, awareness, field = FIELD }: CollabOptions): (pmSchema: Schema) => { doc: Node; plugins: Plugin[] } {
  return (pmSchema) => {
    const fragment = doc.getXmlFragment(field);
    // Built with the binding's own mapping, so the first render needs no
    // replacement of the whole document.
    const { doc: first, mapping } = initProseMirrorDoc(fragment, pmSchema);
    return {
      doc: first,
      plugins: [
        ySyncPlugin(fragment, { mapping }),
        markDestroyed(),
        yCursorPlugin(awareness),
        yUndoPlugin(),
        keymap({ "Mod-z": undoCommand, "Shift-Mod-z": redoCommand, "Mod-y": redoCommand }),
      ],
    };
  };
}

/**
 * y-prosemirror 1.3.7 defers some updates (a remote cursor moving) to a
 * timeout, and skips a view whose binding is `isDestroyed` — a flag its
 * `destroy()` never sets. A view destroyed in between, as React's
 * StrictMode does to every view once, then receives a transaction and
 * throws. This sets the flag.
 */
function markDestroyed(): Plugin {
  return new Plugin({
    view: (view) => ({
      destroy: () => {
        const binding = (ySyncPluginKey.getState(view.state) as { binding?: { isDestroyed?: boolean } } | undefined)?.binding;
        if (binding !== undefined) binding.isDestroyed = true;
      },
    }),
  });
}

export { relativeAnchors, type RangeStore, type RelativeRange } from "./anchors.js";
export { LocalRelay } from "./relay.js";
export { sharedThreads, THREADS, type SharedThread, type SharedThreads } from "./threads.js";
