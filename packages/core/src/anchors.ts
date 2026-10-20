import { names } from "./contentExpression.js";
import { specOf, type Schema } from "./schema.js";
import type { Node, NodeSpec } from "./types.js";

/**
 * Where a comment points: a range in ProseMirror positions over the
 * document, and the text it covered when it was last seen. Stored beside
 * the document, never inside it, so the document a reader agreed to has
 * the same hash with or without the discussion around it.
 *
 * Positions are exact while the document is only edited through the
 * editor, which maps them through every change. The quote is what finds
 * the range again when the document changed elsewhere: another writer, a
 * migration, a paste into the JSON.
 */
export interface Anchor {
  from: number;
  to: number;
  quote: string;
  /**
   * The text just before and just after the quote, as the W3C Web
   * Annotation TextQuoteSelector keeps it. A short quote (a word) occurs
   * many times; its context says which occurrence was meant.
   */
  prefix?: string;
  suffix?: string;
}

/** How much context an anchor keeps on each side, in positions. */
export const CONTEXT = 32;

export interface ReanchorOptions {
  /**
   * Refuse an occurrence whose context does not mostly agree with the
   * anchor's. For a thread whose text was deleted: bringing it back on any
   * other copy of the same word would attach it to text nobody commented on.
   */
  requireContext?: boolean;
}

/** The size of a node in ProseMirror positions: a text's UTF-16 length, 1 for a leaf, its content plus 2 otherwise. */
export function nodeSize(node: Node, schema: Schema): number {
  if (typeof node.text === "string") return node.text.length;
  if (isLeaf(node, specOf(schema, node))) return 1;
  return 2 + contentSize(node, schema);
}

/** The size of a node's content, which is the largest valid position inside the document when given the top node. */
export function contentSize(node: Node, schema: Schema): number {
  return (node.content ?? []).reduce((sum, child) => sum + nodeSize(child, schema), 0);
}

function isLeaf(node: Node, spec: NodeSpec | undefined): boolean {
  return spec === undefined ? !Array.isArray(node.content) : spec.contentSource === null;
}

const textblocks = new WeakMap<Schema, Map<string, boolean>>();

/** Whether a node holds inline content directly, which is what ProseMirror calls a textblock. */
function isTextblock(schema: Schema, spec: NodeSpec): boolean {
  let cache = textblocks.get(schema);
  if (cache === undefined) {
    cache = new Map();
    textblocks.set(schema, cache);
  }
  const known = cache.get(spec.name);
  if (known !== undefined) return known;
  let answer = false;
  const ast = schema.content.get(spec.name);
  if (!spec.inline && ast !== undefined) {
    // ProseMirror reads this off the first type the expression can start with;
    // a group expands to its members in declaration order.
    const first = names(ast)[0];
    const type = first === undefined ? undefined : schema.nodes.has(first) ? first : schema.nodeOrder.find((name) => schema.groups.get(first)?.has(name));
    answer = type !== undefined && (schema.nodes.get(type)?.inline ?? false);
  }
  cache.set(spec.name, answer);
  return answer;
}

type Visit = (node: Node, spec: NodeSpec | undefined, pos: number) => boolean | void;

/** `Fragment.nodesBetween`, over JSON. */
function nodesBetween(parent: Node, schema: Schema, from: number, to: number, visit: Visit, start = 0): void {
  const children = parent.content ?? [];
  for (let i = 0, pos = 0; pos < to && i < children.length; i += 1) {
    const child = children[i] as Node;
    const spec = specOf(schema, child);
    const end = pos + nodeSize(child, schema);
    if (end > from && visit(child, spec, start + pos) !== false && Array.isArray(child.content) && child.content.length > 0) {
      const inner = pos + 1;
      nodesBetween(child, schema, Math.max(0, from - inner), Math.min(contentSize(child, schema), to - inner), visit, start + inner);
    }
    pos = end;
  }
}

/**
 * The text between two positions, exactly as ProseMirror's
 * `doc.textBetween(from, to, blockSeparator, "")` answers it, so a quote
 * taken in the editor and one taken here on the stored JSON are the same
 * string.
 */
export function textBetween(document: Node, schema: Schema, from: number, to: number, blockSeparator = "\n"): string {
  let text = "";
  forEachText(document, schema, from, to, blockSeparator, (piece) => {
    text += piece;
  });
  return text;
}

/** Calls `emit` with each piece of text, and the position of its first character or `null` for a separator. */
function forEachText(document: Node, schema: Schema, from: number, to: number, blockSeparator: string, emit: (piece: string, pos: number | null) => void): void {
  let first = true;
  nodesBetween(document, schema, from, to, (node, spec, pos) => {
    const isText = typeof node.text === "string";
    const piece = isText ? (node.text as string).slice(Math.max(from, pos) - pos, to - pos) : "";
    const block = spec !== undefined && !spec.inline;
    if (block && isTextblock(schema, spec) && blockSeparator !== "") {
      if (first) first = false;
      else emit(blockSeparator, null);
    }
    if (piece !== "") emit(piece, Math.max(from, pos));
  });
}

/** An anchor over a range, its quote taken from the document. */
export function anchorAt(document: Node, schema: Schema, from: number, to: number): Anchor {
  const size = contentSize(document, schema);
  return {
    from,
    to,
    quote: textBetween(document, schema, from, to),
    prefix: textBetween(document, schema, Math.max(0, from - CONTEXT), from),
    suffix: textBetween(document, schema, to, Math.min(size, to + CONTEXT)),
  };
}

/**
 * Finds where an anchor points in a document that may have changed since.
 * Every occurrence of the quote is a candidate; the one whose surrounding
 * text agrees most with the anchor's prefix and suffix wins, and distance
 * from where it was only breaks ties. `null` when the quote is nowhere, or
 * when `requireContext` is set and no occurrence's context agrees.
 */
export function reanchor(document: Node, schema: Schema, anchor: Anchor, options: ReanchorOptions = {}): Anchor | null {
  if (anchor.quote === "") return null;
  const size = contentSize(document, schema);
  const prefix = anchor.prefix ?? "";
  const suffix = anchor.suffix ?? "";
  const best = Math.max(0, prefix.length) + Math.max(0, suffix.length);

  // The whole document as text, and the position of every character in it.
  let text = "";
  const positions: Array<number | null> = [];
  forEachText(document, schema, 0, size, "\n", (piece, pos) => {
    text += piece;
    for (let i = 0; i < piece.length; i += 1) positions.push(pos === null ? null : pos + i);
  });

  let chosen: { anchor: Anchor; score: number; distance: number } | null = null;
  for (let index = text.indexOf(anchor.quote); index !== -1; index = text.indexOf(anchor.quote, index + 1)) {
    const span = positions.slice(index, index + anchor.quote.length);
    const from = span.find((pos) => pos !== null);
    const last = span.findLast((pos) => pos !== null);
    if (from == null || last == null) continue;
    const to = last + 1;
    const found = anchorAt(document, schema, from, to);
    const score = commonSuffix(found.prefix ?? "", prefix) + commonPrefix(found.suffix ?? "", suffix);
    const distance = Math.abs(from - anchor.from);
    if (chosen === null || score > chosen.score || (score === chosen.score && distance < chosen.distance)) {
      chosen = { anchor: found, score, distance };
    }
  }
  if (chosen === null) return null;
  // Mostly agreeing: at least half of the context the anchor had.
  if (options.requireContext && (best === 0 || chosen.score * 2 < best)) return null;
  return chosen.anchor;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}
