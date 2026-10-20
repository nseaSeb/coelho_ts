import { classKey, renderValues, safeUrl } from "./attr.js";
import { markIndex, markSpec, nodeSpec, type Schema } from "./schema.js";
import type { Attr, DomAttrValue, DomAttrs, JsonValue, Mark, MarkSpec, Node, NodeSpec, Render, RenderContext, RenderFn } from "./types.js";

export { safeUrl };

export type Policy = "trusted" | "untrusted";

export interface RenderOptions {
  /** Per-node render overrides, by node name. */
  nodes?: Record<string, Render | null>;
  /** Per-mark render overrides, by mark name. */
  marks?: Record<string, Render | null>;
  context?: RenderContext;
  /** `untrusted` for content from people you do not trust: references are reduced to their text. */
  policy?: Policy;
}

export interface InlineRenderOptions extends RenderOptions {
  /** What separates two blocks once unwrapped: a space by default, or `br`, or escaped text. */
  separator?: "space" | "br" | string | { safe: string };
}

interface State {
  nodes: Record<string, Render | null>;
  marks: Record<string, Render | null>;
  context: RenderContext;
  policy: Policy;
  separator: string;
}

const HTML_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const UNTRUSTED_ATTRS = new Set(["class", "title", "lang", "dir", "role", "colspan", "rowspan", "headers", "scope", "start", "reversed", "type", "value"]);
const UNTRUSTED_ATTR_PREFIXES = ["aria-"];
const UNTRUSTED_TAGS = new Set(
  (
    "p div span section article aside header footer main nav " +
    "h1 h2 h3 h4 h5 h6 hgroup blockquote pre code kbd samp var " +
    "ul ol li dl dt dd figure figcaption hr br wbr " +
    "table caption colgroup col thead tbody tfoot tr td th " +
    "strong em b i u s del ins mark sub sup small abbr cite q dfn time"
  ).split(" "),
);

/** Renders a document to HTML. Give it a validated or sanitized document. */
export function toHtml(document: Node | null | undefined, schema: Schema, options: RenderOptions = {}): string {
  return renderNode(document, schema, state(options));
}

/**
 * Renders a document where only inline elements are legal: a table cell, a
 * button, a `<title>`. Blocks are unwrapped and separated.
 */
export function toInlineHtml(document: Node | null | undefined, schema: Schema, options: InlineRenderOptions = {}): string {
  return inlineNode(document, schema, state(options))[1];
}

function state(options: InlineRenderOptions): State {
  const policy = options.policy ?? "trusted";
  if (policy !== "trusted" && policy !== "untrusted") throw new Error(`policy must be "trusted" or "untrusted", got ${JSON.stringify(policy)}`);
  return {
    nodes: options.nodes ?? {},
    marks: options.marks ?? {},
    context: options.context ?? {},
    policy,
    separator: separator(options.separator ?? "space"),
  };
}

function separator(value: NonNullable<InlineRenderOptions["separator"]>): string {
  if (value === "space") return " ";
  if (value === "br") return "<br>";
  if (typeof value === "string") return escape(value);
  return value.safe;
}

/** Reads an attribute off a node or a mark, with the schema default in hand: a default is never stored. */
export function attr(node: Node | Mark, name: string, fallback: JsonValue = null): JsonValue {
  const attrs = node.attrs;
  if (attrs !== undefined && attrs !== null && typeof attrs === "object" && Object.hasOwn(attrs, name)) {
    return attrs[name] as JsonValue;
  }
  return fallback;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML, attribute values included. */
export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

/** Builds an element from a tag, an attribute list and rendered children. */
export function tag(name: string, attrs: DomAttrs, inner: string): string {
  return `<${name}${attributes(attrs)}>${inner}</${name}>`;
}

/** Builds a childless element, self-closing only if HTML says it is. */
export function voidTag(name: string, attrs: DomAttrs): string {
  return HTML_VOID.has(name) ? `<${name}${attributes(attrs)}>` : tag(name, attrs, "");
}

function attributes(attrs: DomAttrs): string {
  let out = "";
  for (const [name, value] of attrs) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) out += ` ${name}`;
    else out += ` ${name}="${escape(String(value))}"`;
  }
  return out;
}

function renderNode(node: Node | null | undefined, schema: Schema, state: State): string {
  if (node === null || node === undefined) return "";
  const spec = fetchNodeSpec(schema, node.type);
  const render = resolveRender(state.nodes, spec, state.policy);
  const inner = spec.text ? escape(typeof node.text === "string" ? node.text : "") : children(node, schema, state);
  return applyMarks(renderWith(node, spec, render, inner, state.context), node, schema, state);
}

function children(node: Node, schema: Schema, state: State): string {
  return (node.content ?? []).map((child) => renderNode(child, schema, state)).join("");
}

function renderWith(node: Node | Mark, spec: NodeSpec | MarkSpec, render: Render | { untrusted: [DomRenderTag, DomRenderAttrs] } | null, inner: string, context: RenderContext): string {
  if (render === null) return inner;
  if (typeof render === "function") return render(node, inner, context);
  const isVoid = "void" in spec && spec.void;
  if (!Array.isArray(render)) {
    const [tagName, attrs] = render.untrusted;
    return untrustedElement(resolveTag(tagName, node), attrs, node, spec, inner, context, isVoid);
  }
  const [tagName, attrs] = render;
  const resolved = resolveTag(tagName, node);
  return isVoid
    ? voidTag(resolved, elementAttrs(attrs, node, spec, context))
    : tag(resolved, elementAttrs(attrs, node, spec, context), inner);
}

type DomRenderTag = string | ((node: Node | Mark) => string);
type DomRenderAttrs = DomAttrs | ((node: Node | Mark, context: RenderContext) => DomAttrs);

function untrustedElement(tagName: string, attrs: DomRenderAttrs, node: Node | Mark, spec: NodeSpec | MarkSpec, inner: string, context: RenderContext, isVoid: boolean): string {
  if (!UNTRUSTED_TAGS.has(tagName)) return inner;
  const kept = withClass(mergeAttrs(resolveAttrs(attrs, node, context).filter(([name]) => untrustedAttr(name)), attrDom(node, spec.attrs)), spec.class);
  return isVoid ? voidTag(tagName, kept) : tag(tagName, kept, inner);
}

function untrustedAttr(name: string): boolean {
  return UNTRUSTED_ATTRS.has(name) || UNTRUSTED_ATTR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function resolveTag(tagName: DomRenderTag, node: Node | Mark): string {
  return typeof tagName === "function" ? tagName(node) : tagName;
}

function resolveAttrs(attrs: DomRenderAttrs, node: Node | Mark, context: RenderContext): DomAttrs {
  return typeof attrs === "function" ? attrs(node, context) : attrs;
}

function elementAttrs(attrs: DomRenderAttrs, node: Node | Mark, spec: NodeSpec | MarkSpec, context: RenderContext): DomAttrs {
  return withClass(mergeAttrs(resolveAttrs(attrs, node, context), attrDom(node, spec.attrs)), spec.class);
}

/** The DOM attributes an attribute's `renderAs` declaration produces. */
function attrDom(node: Node | Mark, attrs: Record<string, Attr>): DomAttrs {
  const out: DomAttrs = [];
  for (const [name, spec] of Object.entries(attrs)) {
    if (spec.renderAs === null) continue;
    const value = attr(node, name, spec.default);
    if ("class" in spec.renderAs) {
      const cls = spec.renderAs.class[classKey(value)];
      if (cls !== undefined) out.push(["class", cls]);
    } else if (typeof value === "string" && (renderValues(spec) ?? []).includes(value)) {
      out.push(["style", `${spec.renderAs.style}:${value}`]);
    }
  }
  return out;
}

const SEPARATORS: Record<string, string> = { class: " ", style: ";" };

function mergeAttrs(attrs: DomAttrs, additions: DomAttrs): DomAttrs {
  if (additions.length === 0) return attrs;
  const out: DomAttrs = attrs.map(([name, value]) => [name, value]);
  for (const [name, value] of additions) {
    const index = out.findIndex(([existing]) => existing === name);
    if (index === -1) {
      out.push([name, value]);
      continue;
    }
    const existing = out[index] as [string, DomAttrValue];
    const sep = SEPARATORS[name];
    const joined =
      typeof existing[1] === "string" && existing[1] !== "" && sep !== undefined && typeof value === "string"
        ? `${existing[1]}${sep}${value}`
        : value;
    out[index] = [name, joined];
  }
  return out;
}

function withClass(attrs: DomAttrs, cls: string | null): DomAttrs {
  return cls === null ? attrs : mergeAttrs(attrs, [["class", cls]]);
}

function applyMarks(inner: string, node: Node, schema: Schema, state: State): string {
  const marks = node.marks ?? [];
  let out = inner;
  for (let i = marks.length - 1; i >= 0; i -= 1) out = renderMark(marks[i] as Mark, out, schema, state);
  return out;
}

function renderMark(mark: Mark, inner: string, schema: Schema, state: State): string {
  const spec = fetchMarkSpec(schema, mark.type);
  return renderWith(mark, spec, resolveRender(state.marks, spec, state.policy), inner, state.context);
}

type Resolved = Render | { untrusted: [DomRenderTag, DomRenderAttrs] } | null;

function resolveRender(overrides: Record<string, Render | null>, spec: NodeSpec | MarkSpec, policy: Policy): Resolved {
  if (Object.hasOwn(overrides, spec.name)) return overrides[spec.name] ?? null;
  if (policy === "trusted") return spec.render;
  if (spec.renderUntrusted !== null) return spec.renderUntrusted;
  if (hasUrlAttr(spec)) return null;
  return untrusted(spec.render);
}

function untrusted(render: Render | null): Resolved {
  return Array.isArray(render) ? { untrusted: render } : null;
}

function hasUrlAttr(spec: NodeSpec | MarkSpec): boolean {
  return Object.values(spec.attrs).some((attribute) => isUrl(attribute.validate));
}

function isUrl(validator: Attr["validate"]): boolean {
  if (validator === "safe_url") return true;
  return typeof validator === "object" && validator !== null && "nullable" in validator && isUrl(validator.nullable);
}

const childrenOnly: RenderFn = (_node, inner) => inner;

function inlineRender(spec: NodeSpec, state: State): Resolved {
  if (Object.hasOwn(state.nodes, spec.name)) return state.nodes[spec.name] ?? null;
  if (state.policy === "trusted") return spec.renderInline;
  if (spec.renderUntrustedInline !== null) return spec.renderUntrustedInline;
  if (spec.renderUntrusted !== null) return spec.inline ? spec.renderUntrusted : null;
  if (hasUrlAttr(spec)) return null;
  if (spec.renderInline === null) return null;
  return Array.isArray(spec.renderInline) ? { untrusted: spec.renderInline } : childrenOnly;
}

/** Returns `[isBlock, html]`: whether a separator belongs around it, and what it rendered to. */
function inlineNode(node: Node | null | undefined, schema: Schema, state: State): [boolean, string] {
  if (node === null || node === undefined) return [false, ""];
  const spec = fetchNodeSpec(schema, node.type);
  if (spec.text) return [false, renderNode(node, schema, state)];
  const render = inlineRender(spec, state);
  if (render !== null) {
    const body = renderWith(node, spec, render, inlineChildren(node, schema, state), state.context);
    return [!spec.inline, spec.inline ? applyMarks(body, node, schema, state) : body];
  }
  if (spec.inline) return [false, renderNode(node, schema, state)];
  return [true, inlineChildren(node, schema, state)];
}

function inlineChildren(node: Node, schema: Schema, state: State): string {
  const parts = (node.content ?? []).map((child) => inlineNode(child, schema, state)).filter(([, html]) => html !== "");
  let out = "";
  for (let i = 0; i < parts.length; i += 1) {
    const [isBlock, html] = parts[i] as [boolean, string];
    out += html;
    const next = parts[i + 1];
    if (next !== undefined && (isBlock || next[0])) out += state.separator;
  }
  return out;
}

function fetchNodeSpec(schema: Schema, type: string): NodeSpec {
  const spec = nodeSpec(schema, type);
  if (spec === undefined) throw new Error(`unknown node type ${JSON.stringify(type)}: render a validated or sanitized document`);
  return spec;
}

function fetchMarkSpec(schema: Schema, type: string): MarkSpec {
  const spec = markSpec(schema, type);
  if (spec === undefined) throw new Error(`unknown mark type ${JSON.stringify(type)}: render a validated or sanitized document`);
  return spec;
}

export { markIndex as _markIndex };
