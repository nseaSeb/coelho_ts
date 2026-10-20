import { CONTEXT, reanchor, type Anchor, type Node as CoelhoNode, type Schema as CoelhoSchema } from "@coelho/core";
import type { Node } from "prosemirror-model";
import { isHistoryTransaction } from "prosemirror-history";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** A thread's anchor as an application stores it, handed back when the editor (re)loads a document. */
export interface StoredAnchor {
  id: string;
  anchor: Anchor;
  resolved?: boolean;
  /**
   * The thread's text was deleted when it was stored. It is then only
   * brought back where the text around its quote agrees too, never on
   * another copy of the same words.
   */
  lost?: boolean;
}

/**
 * Where threads are when ranges cannot be mapped. A collaborative binding
 * replaces the whole document on every remote change, which collapses
 * every mapped range; a source that knows where each thread points in the
 * shared document (`@coelho/collab`'s Yjs relative positions) puts them
 * back. What it cannot place is looked for by its quote.
 */
export interface AnchorSource {
  /** Whether this transaction came from elsewhere, so ranges are to be located rather than mapped. */
  isForeign(tr: Transaction): boolean;
  /** Where a thread is now; `null` when its text is gone, `undefined` when the source has no record of it. */
  locate(state: EditorState, id: string): { from: number; to: number } | null | undefined;
  /** Records a new thread's range, in the state where it was opened. */
  track?(state: EditorState, id: string, from: number, to: number): void;
  /**
   * When threads are shared: every thread there is, with what it quoted
   * and whether it is resolved. Read on every change from elsewhere and on
   * `relocateComments`, so threads opened, resolved or deleted by others
   * appear, change and go.
   */
  threads?(): Array<{ id: string; anchor: Anchor; resolved: boolean }>;
}

export interface CommentsPluginOptions {
  /** The coelho schema of the document, used to find a quote again in a document that changed. */
  schema: CoelhoSchema;
  /** For collaborative editing: where threads are after a change from another writer. */
  source?: AnchorSource;
  /**
   * The anchors to restore whenever the editor state is created: on mount,
   * and when a controlled editor is reset to a document it did not
   * produce. Each one is found again by its quote if its range moved.
   */
  restore?: () => StoredAnchor[];
}

export interface CommentsState {
  /** Threads whose text is in the document, with their current range and quote. */
  anchors: ReadonlyMap<string, Anchor>;
  /** Threads whose text was deleted, with what it was. Undo brings them back. */
  lost: ReadonlyMap<string, Anchor>;
  active: string | null;
  resolved: ReadonlySet<string>;
  decorations: DecorationSet;
}

type Action =
  | { type: "add"; id: string; from: number; to: number }
  | { type: "remove"; id: string }
  | { type: "activate"; id: string | null }
  | { type: "resolve"; id: string; resolved: boolean }
  | { type: "relocate" };

const key = new PluginKey<CommentsState>("coelho-comments");

/**
 * Anchored comments as decorations, never as marks: the highlighted range
 * is drawn by the editor and mapped through every change, but nothing about
 * the discussion enters the document. Deleting the commented text loses
 * the anchor; undoing the deletion finds it again.
 */
export function commentsPlugin(options: CommentsPluginOptions): Plugin<CommentsState> {
  return new Plugin<CommentsState>({
    key,
    state: {
      init: (_config, state) => restore(state.doc, options),
      apply: (tr, previous, _old, state) => {
        const relocate = (tr.getMeta(key) as Action | undefined)?.type === "relocate";
        if (options.source !== undefined && (relocate || options.source.isForeign(tr))) return applyForeign(tr, previous, state, options);
        return apply(tr, previous, options.schema, state, options.source);
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations ?? null,
      handleClick: (view, pos) => {
        const state = key.getState(view.state);
        if (state === undefined) return false;
        const id = innermost(state, pos);
        if (id !== state.active) view.dispatch(view.state.tr.setMeta(key, { type: "activate", id } satisfies Action));
        return false;
      },
    },
  });
}

export function commentsState(state: EditorState): CommentsState | undefined {
  return key.getState(state);
}

/** Opens a thread on the selection. Not applicable to an empty selection. */
export function addComment(id: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty || key.getState(state) === undefined) return false;
    dispatch?.(state.tr.setMeta(key, { type: "add", id, from, to } satisfies Action));
    return true;
  };
}

export function removeComment(id: string): Command {
  return meta({ type: "remove", id });
}

export function setActiveComment(id: string | null): Command {
  return meta({ type: "activate", id });
}

/** Locates every thread again, from the source: for a change to the threads themselves, which moves no text. */
export function relocateComments(): Command {
  return meta({ type: "relocate" });
}

export function setCommentResolved(id: string, resolved: boolean): Command {
  return meta({ type: "resolve", id, resolved });
}

/** Selects a thread's text, scrolls to it and makes the thread active. */
export function selectComment(id: string): Command {
  return (state, dispatch) => {
    const anchor = key.getState(state)?.anchors.get(id);
    if (anchor === undefined) return false;
    dispatch?.(
      state.tr
        .setSelection(TextSelection.create(state.doc, anchor.from, anchor.to))
        .setMeta(key, { type: "activate", id } satisfies Action)
        .scrollIntoView(),
    );
    return true;
  };
}

function meta(action: Action): Command {
  return (state, dispatch) => {
    if (key.getState(state) === undefined) return false;
    dispatch?.(state.tr.setMeta(key, action));
    return true;
  };
}

function restore(doc: Node, options: CommentsPluginOptions): CommentsState {
  const stored = options.restore?.() ?? [];
  const json = doc.toJSON() as CoelhoNode;
  const anchors = new Map<string, Anchor>();
  const lost = new Map<string, Anchor>();
  const resolved = new Set<string>();
  for (const { id, anchor, resolved: isResolved, lost: wasLost } of stored) {
    if (isResolved) resolved.add(id);
    const found = reanchor(json, options.schema, anchor, { requireContext: wasLost ?? false });
    if (found === null) lost.set(id, anchor);
    else anchors.set(id, found);
  }
  return build(doc, anchors, lost, null, resolved);
}

/**
 * A change from another writer: every range is located again — by the
 * source, or by its quote and context when the source cannot place it —
 * instead of being mapped through a replacement of the whole document.
 */
function applyForeign(tr: Transaction, previous: CommentsState, state: EditorState, options: CommentsPluginOptions): CommentsState {
  const source = options.source as AnchorSource;
  const anchors = new Map<string, Anchor>();
  const lost = new Map<string, Anchor>();
  const listed = source.threads?.();
  const known = (id: string, fallback: Anchor): Anchor => previous.anchors.get(id) ?? previous.lost.get(id) ?? fallback;
  const entries: Array<[string, Anchor]> = listed === undefined ? [...previous.anchors, ...previous.lost] : listed.map(({ id, anchor }) => [id, known(id, anchor)]);
  const resolved = listed === undefined ? new Set(previous.resolved) : new Set(listed.filter((thread) => thread.resolved).map((thread) => thread.id));
  let json: CoelhoNode | null = null;
  for (const [id, anchor] of entries) {
    const located = source.locate(state, id);
    if (located != null && located.from < located.to && located.to <= tr.doc.content.size) {
      anchors.set(id, anchorIn(tr.doc, located.from, located.to));
      continue;
    }
    json ??= tr.doc.toJSON() as CoelhoNode;
    const found = reanchor(json, options.schema, anchor, { requireContext: true });
    if (found === null) lost.set(id, anchor);
    else anchors.set(id, anchorIn(tr.doc, found.from, found.to));
  }
  const active = previous.active !== null && (anchors.has(previous.active) || lost.has(previous.active)) ? previous.active : null;
  return build(tr.doc, anchors, lost, active, resolved);
}

function apply(tr: Transaction, previous: CommentsState, schema: CoelhoSchema, state: EditorState, source?: AnchorSource): CommentsState {
  const action = tr.getMeta(key) as Action | undefined;
  if (!tr.docChanged && action === undefined) return previous;

  let active = previous.active;
  const resolved = new Set(previous.resolved);
  // A lost anchor keeps following the document, so the position an undo
  // hands back to it is where its text would now be.
  const lost = new Map<string, Anchor>();
  for (const [id, anchor] of previous.lost) lost.set(id, { ...anchor, from: tr.mapping.map(anchor.from, -1), to: tr.mapping.map(anchor.to, 1) });
  const ranges = new Map<string, { from: number; to: number }>();
  for (const decoration of previous.decorations.map(tr.mapping, tr.doc).find()) {
    ranges.set((decoration.spec as { id: string }).id, { from: decoration.from, to: decoration.to });
  }
  // A decoration whose text was deleted is gone from the mapped set; what it
  // covered is remembered, so an undo can put the thread back.
  for (const [id, anchor] of previous.anchors) {
    if (!ranges.has(id)) lost.set(id, { ...anchor, from: tr.mapping.map(anchor.from, -1), to: tr.mapping.map(anchor.to, 1) });
  }

  if (action?.type === "add") {
    ranges.set(action.id, { from: action.from, to: action.to });
    source?.track?.(state, action.id, action.from, action.to);
    lost.delete(action.id);
    active = action.id;
  } else if (action?.type === "remove") {
    ranges.delete(action.id);
    lost.delete(action.id);
    resolved.delete(action.id);
    if (active === action.id) active = null;
  } else if (action?.type === "activate") {
    active = action.id;
  } else if (action?.type === "resolve") {
    if (action.resolved) resolved.add(action.id);
    else resolved.delete(action.id);
  }

  if (lost.size > 0 && isHistoryTransaction(tr)) {
    const json = tr.doc.toJSON() as CoelhoNode;
    for (const [id, anchor] of lost) {
      const found = reanchor(json, schema, anchor, { requireContext: true });
      if (found !== null) {
        ranges.set(id, found);
        lost.delete(id);
      }
    }
  }

  const anchors = new Map<string, Anchor>();
  for (const [id, { from, to }] of ranges) anchors.set(id, anchorIn(tr.doc, from, to));
  if (active !== null && !anchors.has(active) && !lost.has(active)) active = null;
  return build(tr.doc, anchors, lost, active, resolved);
}

function anchorIn(doc: Node, from: number, to: number): Anchor {
  return {
    from,
    to,
    quote: doc.textBetween(from, to, "\n", ""),
    prefix: doc.textBetween(Math.max(0, from - CONTEXT), from, "\n", ""),
    suffix: doc.textBetween(to, Math.min(doc.content.size, to + CONTEXT), "\n", ""),
  };
}

function build(doc: Node, anchors: Map<string, Anchor>, lost: Map<string, Anchor>, active: string | null, resolved: Set<string>): CommentsState {
  const decorations = [...anchors].map(([id, { from, to }]) => {
    const classes = ["coelho-comment"];
    if (id === active) classes.push("coelho-comment-active");
    if (resolved.has(id)) classes.push("coelho-comment-resolved");
    return Decoration.inline(from, to, { class: classes.join(" "), "data-thread": id }, { id, inclusiveStart: false, inclusiveEnd: false });
  });
  return { anchors, lost, active, resolved, decorations: DecorationSet.create(doc, decorations) };
}

/** The thread whose range is the narrowest around a position, so a reply nested in a longer comment can be reached. */
function innermost(state: CommentsState, pos: number): string | null {
  let best: { id: string; size: number } | null = null;
  for (const [id, { from, to }] of state.anchors) {
    if (from <= pos && pos <= to && !state.resolved.has(id) && (best === null || to - from < best.size)) best = { id, size: to - from };
  }
  return best?.id ?? null;
}
