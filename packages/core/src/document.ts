import { sameJson, validateAttr } from "./attr.js";
import { buildLimits, contentMatches, emptyDocument, markAllowed, markIndex, markSpec, nodeSpec, specOf, type Schema } from "./schema.js";
import type { Attr, Attrs, Document, JsonValue, Limits, Mark, MarkSpec, Node, NodeSpec, ValidationError } from "./types.js";

export type ValidationResult = { ok: true; document: Document } | { ok: false; errors: ValidationError[] };

const NODE_KEYS = new Set(["type", "attrs", "content", "marks", "text"]);
const MARK_KEYS = new Set(["type", "attrs"]);

type Path = Array<string | number>;

function error(rpath: Path, message: string): ValidationError {
  return { path: [...rpath].reverse(), message };
}

/**
 * Validates a document against a schema and returns its canonical form.
 *
 * Strict on purpose: an unknown node, mark or attribute, or an attribute
 * failing its validator, rejects the document and says where. What comes
 * back is canonical — marks in declaration order, defaults dropped,
 * adjacent text runs merged — so the same rich text is always the same
 * bytes, which is what `hash` relies on.
 */
export function validate(document: unknown, schema: Schema): ValidationResult {
  const limitError = checkLimits(document, schema.limits);
  if (limitError !== null) return { ok: false, errors: [limitError] };
  const [stripped, versionErrors] = checkVersion(document, schema);
  const [normalised, type, errors] = validateNode(stripped, schema, [], "all", 0);
  const rootErrors = type !== null && type !== schema.topNode ? [error([], `document must be a ${schema.topNode}, got ${type}`)] : [];
  const all = [...versionErrors, ...rootErrors, ...errors];
  if (all.length > 0 || normalised === null) return { ok: false, errors: all };
  return { ok: true, document: stampVersion(normalised, schema) as Document };
}

function checkVersion(document: unknown, schema: Schema): [unknown, ValidationError[]] {
  if (!isObject(document) || !Object.hasOwn(document, "schema_version")) return [document, []];
  const { schema_version: given, ...rest } = document;
  if (schema.version === null) {
    return [rest, [error([], 'document carries "schema_version" but the schema declares no version')]];
  }
  if (given === schema.version) return [rest, []];
  return [rest, [error([], `document was written under schema version ${JSON.stringify(given)}, and this schema is version ${schema.version}; see migrate`)]];
}

function stampVersion(document: Node, schema: Schema): Node {
  return schema.version === null ? document : { ...document, schema_version: schema.version } as Node;
}

function checkLimits(document: unknown, limits: Limits): ValidationError | null {
  let nodes = 0;
  let text = 0;
  const walk = (node: unknown, depth: number): string | null => {
    if (!isObject(node)) return null;
    if (depth > limits.maxDepth) return `document is nested more than ${limits.maxDepth} levels deep`;
    nodes += 1;
    if (nodes > limits.maxNodes) return `document holds more than ${limits.maxNodes} nodes`;
    if (typeof node.text === "string") {
      text += characters(node.text);
      if (text > limits.maxTextLength) return `document holds more than ${limits.maxTextLength} characters of text`;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const message = walk(child, depth + 1);
        if (message !== null) return message;
      }
    }
    return null;
  };
  const message = walk(document, 0);
  return message === null ? null : error([], message);
}

function validateNode(node: unknown, schema: Schema, rpath: Path, allowedMarks: "all" | string[], depth: number): [Node | null, string | null, ValidationError[]] {
  if (depth > schema.limits.maxDepth) return [null, null, [error(rpath, `document is nested more than ${schema.limits.maxDepth} levels deep`)]];
  if (!isObject(node)) return [null, null, [error(rpath, "expected an object")]];
  if (!Object.hasOwn(node, "type")) return [null, null, [error(rpath, 'missing "type"')]];
  const type = node.type;
  const spec = typeof type === "string" ? nodeSpec(schema, type) : undefined;
  if (spec === undefined) return [null, null, [error(rpath, `unknown node type ${JSON.stringify(type)}`)]];

  const unknownErrors = unknownKeyErrors(node, NODE_KEYS, rpath);
  const [attrs, attrErrors] = validateAttrs(node, spec, schema.limits, rpath);
  const [text, textErrors] = validateText(node, spec, rpath);
  const [marks, markErrors] = validateMarks(node, spec, allowedMarks, schema, rpath);
  const [content, contentErrors] = validateContent(node, spec, schema, rpath, depth);

  const normalised: Node = { type: spec.name };
  if (Object.keys(attrs).length > 0) normalised.attrs = attrs;
  if (marks.length > 0) normalised.marks = marks;
  if (content.length > 0) normalised.content = content;
  if (text !== null) normalised.text = text;
  return [normalised, spec.name, [...unknownErrors, ...attrErrors, ...textErrors, ...markErrors, ...contentErrors]];
}

function unknownKeyErrors(node: Record<string, unknown>, allowed: Set<string>, rpath: Path): ValidationError[] {
  return Object.keys(node).filter((key) => !allowed.has(key)).map((key) => error(rpath, `unknown key ${JSON.stringify(key)}`));
}

function validateAttrs(node: Record<string, unknown>, spec: NodeSpec | MarkSpec, limits: Limits, rpath: Path): [Attrs, ValidationError[]] {
  const given = Object.hasOwn(node, "attrs") ? node.attrs : {};
  if (!isObject(given)) return [{}, [error(["attrs", ...rpath], "expected an object")]];
  const errors: ValidationError[] = [];
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(spec.attrs, key)) errors.push(error([key, "attrs", ...rpath], `unknown attribute ${JSON.stringify(key)}`));
  }
  const attrs: Attrs = {};
  for (const [name, attribute] of Object.entries(spec.attrs)) {
    const attrPath = [name, "attrs", ...rpath];
    if (!Object.hasOwn(given, name)) {
      if (attribute.required) errors.push(error(attrPath, "is required"));
      continue;
    }
    const value = given[name];
    const bound = withinBounds(value, limits);
    if (bound !== null) {
      errors.push(error(attrPath, bound));
      continue;
    }
    const message = validateAttr(attribute.validate, value);
    if (message !== null) {
      errors.push(error(attrPath, message));
      continue;
    }
    if (!attribute.required && sameJson(value, attribute.default)) continue;
    attrs[name] = value as JsonValue;
  }
  return [attrs, errors];
}

/** An attribute value is bounded in characters and in nesting, the way the document itself is. */
function withinBounds(value: unknown, limits: Limits): string | null {
  const result = spend(value, limits.maxAttrLength, limits.maxDepth);
  if (result === "over") return `carries more than ${limits.maxAttrLength} characters`;
  if (result === "deep") return `is nested more than ${limits.maxDepth} levels deep`;
  return null;
}

type Budget = number | "over" | "deep";

function spend(value: unknown, budget: Budget, depth: number): Budget {
  if (depth < 0) return "deep";
  if (typeof budget !== "number") return budget;
  if (typeof value === "string") return take(budget, characters(value));
  if (Array.isArray(value)) {
    let left: Budget = budget;
    for (const child of value) {
      left = spend(child, take(left, 1), depth - 1);
      if (typeof left !== "number") return left;
    }
    return left;
  }
  if (isObject(value)) {
    let left: Budget = budget;
    for (const [key, child] of Object.entries(value)) {
      left = spend(child, take(take(left, characters(key)), 1), depth - 1);
      if (typeof left !== "number") return left;
    }
    return left;
  }
  return take(budget, 1);
}

function take(budget: Budget, cost: number): Budget {
  if (typeof budget !== "number") return budget;
  return budget - cost < 0 ? "over" : budget - cost;
}

function validateText(node: Record<string, unknown>, spec: NodeSpec, rpath: Path): [string | null, ValidationError[]] {
  if (spec.text) {
    if (!Object.hasOwn(node, "text")) return [null, [error(["text", ...rpath], "is required")]];
    const text = node.text;
    if (typeof text !== "string") return [null, [error(["text", ...rpath], "must be a string")]];
    if (text === "") return [null, [error(["text", ...rpath], "must not be empty")]];
    return [text, []];
  }
  return Object.hasOwn(node, "text") ? [null, [error(["text", ...rpath], "only a text node may carry text")]] : [null, []];
}

function validateMarks(node: Record<string, unknown>, spec: NodeSpec, allowedMarks: "all" | string[], schema: Schema, rpath: Path): [Mark[], ValidationError[]] {
  const marks = Object.hasOwn(node, "marks") ? node.marks : [];
  if (!Array.isArray(marks)) return [[], [error(["marks", ...rpath], "expected a list")]];
  if (marks.length === 0) return [[], []];
  if (!spec.inline) return [[], [error(["marks", ...rpath], "marks are only allowed on inline nodes")]];
  const kept: Mark[] = [];
  const errors: ValidationError[] = [];
  marks.forEach((mark, index) => {
    const result = validateMark(mark, allowedMarks, schema, [index, "marks", ...rpath]);
    if ("mark" in result) {
      if (!kept.some((existing) => existing.type === result.mark.type)) kept.push(result.mark);
    } else {
      errors.push(...result.errors);
    }
  });
  const ranked = kept.map((mark, index) => ({ mark, rank: markIndex(schema, mark.type), index }));
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return [ranked.map(({ mark }) => mark), errors];
}

function validateMark(mark: unknown, allowedMarks: "all" | string[], schema: Schema, rpath: Path): { mark: Mark } | { errors: ValidationError[] } {
  if (!isObject(mark)) return { errors: [error(rpath, "expected an object")] };
  if (!Object.hasOwn(mark, "type")) return { errors: [error(rpath, 'missing "type"')] };
  const type = mark.type;
  const spec = typeof type === "string" ? markSpec(schema, type) : undefined;
  if (spec === undefined) return { errors: [error(rpath, `unknown mark type ${JSON.stringify(type)}`)] };
  if (!markAllowed(allowedMarks, spec.name)) return { errors: [error(rpath, `mark ${JSON.stringify(type)} is not allowed on this node`)] };
  const [attrs, attrErrors] = validateAttrs(mark, spec, schema.limits, rpath);
  const errors = [...unknownKeyErrors(mark, MARK_KEYS, rpath), ...attrErrors];
  if (errors.length > 0) return { errors };
  const normalised: Mark = { type: spec.name };
  if (Object.keys(attrs).length > 0) normalised.attrs = attrs;
  return { mark: normalised };
}

function validateContent(node: Record<string, unknown>, spec: NodeSpec, schema: Schema, rpath: Path, depth: number): [Node[], ValidationError[]] {
  const children = Object.hasOwn(node, "content") ? node.content : [];
  if (!Array.isArray(children)) return [[], [error(["content", ...rpath], "expected a list")]];
  const nodes: Node[] = [];
  const types: Array<string | null> = [];
  const errors: ValidationError[] = [];
  children.forEach((child, index) => {
    const [normalised, type, childErrors] = validateNode(child, schema, [index, "content", ...rpath], spec.marks, depth + 1);
    if (normalised !== null) nodes.push(normalised);
    types.push(type);
    errors.push(...childErrors);
  });
  return [mergeText(nodes), [...errors, ...contentErrors(spec, children, types, schema, rpath)]];
}

function contentErrors(spec: NodeSpec, children: unknown[], types: Array<string | null>, schema: Schema, rpath: Path): ValidationError[] {
  if (spec.contentSource === null) {
    return children.length === 0 ? [] : [error(["content", ...rpath], `${spec.name} cannot hold content`)];
  }
  if (types.some((type) => type === null)) return [];
  if (contentMatches(schema, spec, types as string[])) return [];
  return [error(["content", ...rpath], `${spec.name} must hold ${spec.contentSource}, got ${types.length === 0 ? "nothing" : (types as string[]).join(" ")}`)];
}

/** Adjacent text nodes carrying the same marks become one. */
function mergeText(children: Node[]): Node[] {
  const out: Node[] = [];
  for (const node of children) {
    const previous = out[out.length - 1];
    if (node.type === "text" && previous?.type === "text" && sameJson(node.marks ?? [], previous.marks ?? [])) {
      out[out.length - 1] = { ...previous, text: (previous.text ?? "") + (node.text ?? "") };
    } else {
      out.push(node);
    }
  }
  return out;
}

export interface SanitizeOptions {
  /**
   * Overrides the schema's limits for this call alone. A bound is a bound
   * on writing; reading what is already stored is a different question, and
   * cutting it to fit loses text nobody asked to lose:
   * `{ maxTextLength: Infinity, maxAttrLength: Infinity }` keeps the
   * structure cleaned and the length alone.
   */
  limits?: Partial<Limits>;
}

/** How many times a document is pruned and revalidated before it is given up on. */
const SANITIZE_PASSES = 8;

/**
 * Turns anything into a document the schema accepts, without failing.
 *
 * `validate` is the boundary at the keyboard: it says no, and says where.
 * This is the boundary at the screen. A stored document is not revalidated
 * when it is read, so a row written under a looser schema, by a direct SQL
 * write, or by an older version of the application would otherwise reach a
 * page unchecked. What falls outside the schema is removed, from the
 * gentlest repair to the harshest:
 *
 * - a key the schema does not know is dropped;
 * - an attribute failing its validator is dropped, so the default applies;
 * - a mark that is unknown, not allowed, or whose attributes fail is
 *   dropped, and the text it covered stays;
 * - a node whose type is unknown, or whose content cannot satisfy its
 *   expression, is dropped whole, with the text inside it;
 * - a document over the schema's bounds is cut to fit them;
 * - what cannot be repaired at all becomes the empty document.
 *
 * A document stamped with another schema version is repaired against this
 * one and restamped. It is idempotent: sanitising twice is sanitising once,
 * and a document that validates comes back normalised and unchanged.
 */
export function sanitize(document: unknown, schema: Schema, options: SanitizeOptions = {}): Document {
  const bounded = options.limits === undefined ? schema : { ...schema, limits: buildLimits(schema.limits, options.limits) };
  const [trimmed] = trim(reshape(document, bounded.limits.maxDepth, 0), bounded.limits, { nodes: 0, text: 0 });
  return repair(trimmed ?? {}, bounded, SANITIZE_PASSES);
}

function repair(document: unknown, schema: Schema, passes: number): Document {
  const result = validate(document, schema);
  if (result.ok) return result.document;
  if (passes <= 0) return emptyFor(schema);
  const pruned = prune(document as Node, result.errors, "gently");
  if (pruned === "root") return emptyFor(schema);
  if (!sameJson(pruned, document)) return repair(pruned, schema, passes - 1);
  // Nothing an error path names could be removed gently, typically a
  // required attribute that is missing: the node carrying it goes instead.
  const harsher = prune(document as Node, result.errors, "node");
  if (harsher === "root" || sameJson(harsher, document)) return emptyFor(schema);
  return repair(harsher, schema, passes - 1);
}

function emptyFor(schema: Schema): Document {
  const result = validate(emptyDocument(schema), schema);
  return result.ok ? result.document : ({ type: schema.topNode } as Document);
}

/** Keeps only what a node or a mark can carry, in the shape it must carry it. */
function reshape(node: unknown, maxDepth: number, depth: number): Record<string, unknown> {
  if (!isObject(node) || depth > maxDepth) return {};
  const out: Record<string, unknown> = {};
  for (const key of NODE_KEYS) if (Object.hasOwn(node, key)) out[key] = node[key];
  if (Object.hasOwn(out, "attrs") && !isObject(out.attrs)) out.attrs = {};
  if (Object.hasOwn(out, "marks")) {
    out.marks = Array.isArray(out.marks) ? out.marks.map(reshapeMark) : [];
  }
  if (Object.hasOwn(out, "content")) {
    if (Array.isArray(out.content)) {
      out.content = out.content.map((child) => reshape(child, maxDepth, depth + 1)).filter((child) => Object.keys(child).length > 0);
    } else {
      delete out.content;
    }
  }
  return out;
}

function reshapeMark(mark: unknown): Record<string, unknown> {
  if (!isObject(mark)) return {};
  const out: Record<string, unknown> = {};
  for (const key of MARK_KEYS) if (Object.hasOwn(mark, key)) out[key] = mark[key];
  if (Object.hasOwn(out, "attrs") && !isObject(out.attrs)) out.attrs = {};
  return out;
}

interface Count {
  nodes: number;
  text: number;
}

/** Cuts a document to its bounds: nodes past `maxNodes` go, text past `maxTextLength` is truncated. */
function trim(node: Record<string, unknown>, limits: Limits, count: Count): [Record<string, unknown> | null, Count] {
  if (count.nodes + 1 > limits.maxNodes) return [null, count];
  const room = limits.maxTextLength === Infinity ? Infinity : Math.max(limits.maxTextLength - count.text, 0);
  let out = node;
  let next: Count = { nodes: count.nodes + 1, text: count.text };
  if (typeof node.text === "string") {
    if (room === 0) return [null, count];
    const length = characters(node.text);
    if (length <= room) {
      next = { nodes: next.nodes, text: next.text + length };
    } else {
      out = { ...node, text: firstCharacters(node.text, room) };
      next = { nodes: next.nodes, text: next.text + room };
    }
  }
  if (!Array.isArray(out.content)) return [out, next];
  const kept: Record<string, unknown>[] = [];
  for (const child of out.content as Record<string, unknown>[]) {
    const [trimmed, after] = trim(child, limits, next);
    next = after;
    if (trimmed !== null) kept.push(trimmed);
  }
  return [{ ...out, content: kept }, next];
}

type Action = { kind: "dropAttr"; key: string } | { kind: "dropAttrs" } | { kind: "dropMark"; index: number } | { kind: "dropMarks" } | { kind: "dropChild"; index: number };
type Operation = { path: number[]; action: Action };

/**
 * Turns each error into the smallest removal that addresses it, and applies
 * them all at once. `"node"` removes the node an error is about instead.
 * An error about the top node itself is no instruction; only when every
 * error is one does the whole document go.
 */
function prune(document: Node, errors: ValidationError[], how: "gently" | "node"): Node | "root" {
  const operations: Operation[] = [];
  for (const error of errors) {
    const operation = instruction(error.path, how);
    if (operation !== null) operations.push(operation);
  }
  return operations.length === 0 ? "root" : applyOperations(document, operations);
}

function instruction(path: Array<string | number>, how: "gently" | "node"): Operation | null {
  const indices: number[] = [];
  let i = 0;
  while (path[i] === "content" && typeof path[i + 1] === "number") {
    indices.push(path[i + 1] as number);
    i += 2;
  }
  const tail = path.slice(i);
  if (how === "gently") {
    if (tail[0] === "attrs" && tail.length === 2) return { path: indices, action: { kind: "dropAttr", key: String(tail[1]) } };
    if (tail[0] === "attrs" && tail.length === 1) return { path: indices, action: { kind: "dropAttrs" } };
    if (tail[0] === "marks" && typeof tail[1] === "number") return { path: indices, action: { kind: "dropMark", index: tail[1] } };
    if (tail[0] === "marks") return { path: indices, action: { kind: "dropMarks" } };
  }
  if (indices.length === 0) return null;
  return { path: indices.slice(0, -1), action: { kind: "dropChild", index: indices[indices.length - 1] as number } };
}

function applyOperations(node: Node, operations: Operation[]): Node {
  const here = operations.filter((operation) => operation.path.length === 0).map((operation) => operation.action);
  const deeper = operations.filter((operation) => operation.path.length > 0);
  let out: Node = { ...node };

  if (here.some((action) => action.kind === "dropAttrs")) delete out.attrs;
  if (here.some((action) => action.kind === "dropMarks")) delete out.marks;
  const droppedAttrs = new Set(here.flatMap((action) => (action.kind === "dropAttr" ? [action.key] : [])));
  if (out.attrs !== undefined && droppedAttrs.size > 0) {
    out.attrs = Object.fromEntries(Object.entries(out.attrs).filter(([key]) => !droppedAttrs.has(key)));
  }
  const droppedMarks = new Set(here.flatMap((action) => (action.kind === "dropMark" ? [action.index] : [])));
  if (out.marks !== undefined && droppedMarks.size > 0) out.marks = out.marks.filter((_, index) => !droppedMarks.has(index));

  if (out.content !== undefined && deeper.length > 0) {
    out = {
      ...out,
      content: out.content.map((child, index) => {
        const mine = deeper.filter((operation) => operation.path[0] === index).map((operation) => ({ ...operation, path: operation.path.slice(1) }));
        return mine.length === 0 ? child : applyOperations(child, mine);
      }),
    };
  }
  const droppedChildren = new Set(here.flatMap((action) => (action.kind === "dropChild" ? [action.index] : [])));
  if (out.content !== undefined && droppedChildren.size > 0) out.content = out.content.filter((_, index) => !droppedChildren.has(index));
  return out;
}

let segmenter: Intl.Segmenter | undefined;

/** Characters as a person counts them: graphemes, so a flag or a family is one. */
export function characters(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].length;
}

/** The first `count` characters, counted as `characters` counts them, so a flag is never cut in half. */
function firstCharacters(text: string, count: number): string {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let out = "";
  let taken = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (taken === count) break;
    out += segment;
    taken += 1;
  }
  return out;
}

/** The characters of text in a document, what an editor's counter shows. */
export function textLength(document: unknown): number {
  if (!isObject(document)) return 0;
  let count = typeof document.text === "string" ? characters(document.text) : 0;
  if (Array.isArray(document.content)) for (const child of document.content) count += textLength(child);
  return count;
}

/**
 * Whether a document would put nothing on the page: no text anywhere, and
 * no void node with something to show. An inline void node without
 * attributes is punctuation and does not count.
 */
export function isBlank(document: unknown, schema: Schema): boolean {
  return !visible(document, schema);
}

function visible(node: unknown, schema: Schema): boolean {
  if (!isObject(node)) return false;
  if (typeof node.text === "string" && node.text !== "") return true;
  const spec = specOf(schema, node);
  if (spec?.void && !(spec.inline && Object.keys(spec.attrs).length === 0)) return true;
  return Array.isArray(node.content) && node.content.some((child) => visible(child, schema));
}

/**
 * A byte-for-byte stable serialisation: sorted keys, no whitespace, and
 * only the escapes JSON requires. Give it a validated document, since
 * mark order and dropped defaults are what make it stable.
 */
export function canonical(document: unknown): string {
  return encode(document);
}

function encode(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : shortFloat(value);
  if (typeof value === "string") return `"${escapeJson(value)}"`;
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${encode(key)}:${encode(child)}`).join(",")}}`;
  }
  return encode(String(value));
}

/** The shortest decimal that round-trips, as Erlang's `float_to_binary(:short)` prints it. */
function shortFloat(value: number): string {
  const text = String(value);
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
}

// eslint-disable-next-line no-control-regex
const JSON_ESCAPE = /["\\\n\r\t\x00-\x1f]/g;

function escapeJson(text: string): string {
  return text.replace(JSON_ESCAPE, (char) => {
    switch (char) {
      case '"':
        return '\\"';
      case "\\":
        return "\\\\";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

export type HashAlgorithm = "SHA-256" | "SHA-384" | "SHA-512" | "SHA-1";

/**
 * The hex digest of `canonical`, or `null` for a document with nothing in
 * it: no text and no node carrying attributes. Every such document, an
 * empty paragraph or three hard breaks, answers `null`, because nothing was
 * agreed to.
 */
export async function hash(document: unknown, algorithm: HashAlgorithm = "SHA-256"): Promise<string | null> {
  if (isEmpty(document)) return null;
  const bytes = new TextEncoder().encode(canonical(document));
  const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isEmpty(node: unknown): boolean {
  if (!isObject(node)) return true;
  const text = Object.hasOwn(node, "text") ? node.text : "";
  if (text !== "") return false;
  const attrs = Object.hasOwn(node, "attrs") ? node.attrs : {};
  if (!isObject(attrs) || Object.keys(attrs).length > 0) return false;
  const content = Object.hasOwn(node, "content") ? node.content : [];
  return Array.isArray(content) && content.every(isEmpty);
}

/**
 * The plain text of a document, for a search index: blocks are separated
 * by newlines, and a node with `toText` in its spec contributes what that
 * says.
 */
export function toText(document: unknown, schema: Schema): string {
  const text = textOf(document, schema);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function textOf(node: unknown, schema: Schema): string {
  const spec = specOf(schema, node);
  if (spec === undefined) return "";
  const typed = node as Node;
  if (spec.toText !== null) return typeof spec.toText === "function" ? spec.toText(typed) : spec.toText;
  if (spec.text) return typeof typed.text === "string" ? typed.text : "";
  const children = Array.isArray(typed.content) ? typed.content : [];
  if (spec.inline) return children.map((child) => textOf(child, schema)).join("");
  if (children.length === 0) return "\n";
  let out = "";
  let i = 0;
  while (i < children.length) {
    const block = isBlock(children[i], schema);
    let chunk = "";
    while (i < children.length && isBlock(children[i], schema) === block) {
      chunk += textOf(children[i], schema);
      i += 1;
    }
    out += block ? chunk : `${chunk}\n`;
  }
  return out;
}

function isBlock(node: unknown, schema: Schema): boolean {
  const spec = specOf(schema, node);
  return spec !== undefined && !spec.inline;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { Attr };
