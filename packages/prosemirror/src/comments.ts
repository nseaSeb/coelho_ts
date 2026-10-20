import { reanchor, type Anchor, type Node as CoelhoNode, type Schema as CoelhoSchema } from "@coelho/core";
import type { Node } from "prosemirror-model";
import { isHistoryTransaction } from "prosemirror-history";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** A thread's anchor as an application stores it, handed back when the editor (re)loads a document. */
export interface StoredAnchor {
  id: string;
  anchor: Anchor;
  resolved?: boolean;
}

export interface CommentsPluginOptions {
  /** The coelho schema of the document, used to find a quote again in a document that changed. */
  schema: CoelhoSchema;
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
  | { type: "resolve"; id: string; resolved: boolean };

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
      apply: (tr, previous) => apply(tr, previous, options.schema),
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
  for (const { id, anchor, resolved: isResolved } of stored) {
    if (isResolved) resolved.add(id);
    const found = reanchor(json, options.schema, anchor);
    if (found === null) lost.set(id, anchor);
    else anchors.set(id, found);
  }
  return build(doc, anchors, lost, null, resolved);
}

function apply(tr: Transaction, previous: CommentsState, schema: CoelhoSchema): CommentsState {
  const action = tr.getMeta(key) as Action | undefined;
  if (!tr.docChanged && action === undefined) return previous;

  let active = previous.active;
  const resolved = new Set(previous.resolved);
  const lost = new Map(previous.lost);
  const ranges = new Map<string, { from: number; to: number }>();
  for (const decoration of previous.decorations.map(tr.mapping, tr.doc).find()) {
    ranges.set((decoration.spec as { id: string }).id, { from: decoration.from, to: decoration.to });
  }
  // A decoration whose text was deleted is gone from the mapped set; what it
  // covered is remembered, so an undo can put the thread back.
  for (const [id, anchor] of previous.anchors) if (!ranges.has(id)) lost.set(id, anchor);

  if (action?.type === "add") {
    ranges.set(action.id, { from: action.from, to: action.to });
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
      const found = reanchor(json, schema, { ...anchor, from: tr.mapping.map(anchor.from, -1), to: tr.mapping.map(anchor.to, 1) });
      if (found !== null) {
        ranges.set(id, found);
        lost.delete(id);
      }
    }
  }

  const anchors = new Map<string, Anchor>();
  for (const [id, { from, to }] of ranges) anchors.set(id, { from, to, quote: tr.doc.textBetween(from, to, "\n", "") });
  if (active !== null && !anchors.has(active) && !lost.has(active)) active = null;
  return build(tr.doc, anchors, lost, active, resolved);
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
