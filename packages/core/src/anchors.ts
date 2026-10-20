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
  return { from, to, quote: textBetween(document, schema, from, to) };
}

/**
 * Finds where an anchor points in a document that may have changed since:
 * its own range when the quote is still there, otherwise the occurrence of
 * the quote closest to where it was. `null` when the quote is nowhere,
 * which is a thread whose text was deleted.
 */
export function reanchor(document: Node, schema: Schema, anchor: Anchor): Anchor | null {
  const size = contentSize(document, schema);
  const inRange = anchor.from >= 0 && anchor.from < anchor.to && anchor.to <= size;
  if (inRange && textBetween(document, schema, anchor.from, anchor.to) === anchor.quote) return { ...anchor };
  if (anchor.quote === "") return null;

  // The whole document as text, and the position of every character in it.
  let text = "";
  const positions: Array<number | null> = [];
  forEachText(document, schema, 0, size, "\n", (piece, pos) => {
    text += piece;
    for (let i = 0; i < piece.length; i += 1) positions.push(pos === null ? null : pos + i);
  });

  let best: Anchor | null = null;
  for (let index = text.indexOf(anchor.quote); index !== -1; index = text.indexOf(anchor.quote, index + 1)) {
    const span = positions.slice(index, index + anchor.quote.length);
    const firstPos = span.find((pos) => pos !== null);
    const lastPos = span.findLast((pos) => pos !== null);
    if (firstPos == null || lastPos == null) continue;
    const candidate = { from: firstPos, to: lastPos + 1, quote: anchor.quote };
    if (best === null || Math.abs(candidate.from - anchor.from) < Math.abs(best.from - anchor.from)) best = candidate;
  }
  return best;
}
