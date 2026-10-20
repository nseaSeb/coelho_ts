import {
  renderDom,
  sanitize,
  validate,
  validateAttr,
  type Attr,
  type Attrs,
  type JsonValue,
  type MarkSpec as CoelhoMarkSpec,
  type NodeSpec as CoelhoNodeSpec,
  type Schema as CoelhoSchema,
  type ValidationError,
  type Validator,
} from "@coelho/core";
import { Node, Schema, type AttributeSpec, type DOMOutputSpec, type MarkSpec, type NodeSpec, type TagParseRule } from "prosemirror-model";

// A node the editor cannot draw from a static `render` declaration, or that
// declares no HTML to import it from, is marked with its name and its
// attributes, so copy, paste and drag inside the editor bring it back whole.
const DATA_NODE = "data-coelho";
const DATA_ATTRS = "data-coelho-attrs";

/**
 * Builds the ProseMirror schema a coelho schema describes. The document the
 * editor produces (`doc.toJSON()`) is what `validate` from `@coelho/core`
 * accepts, and `toDOM` is derived from the same `render` declaration the
 * page uses, so the editor shows what the page will show.
 */
export function toProseMirrorSchema(schema: CoelhoSchema): Schema {
  const nodes: Record<string, NodeSpec> = {};
  for (const name of schema.nodeOrder) nodes[name] = nodeSpec(schema.nodes.get(name) as CoelhoNodeSpec);
  const marks: Record<string, MarkSpec> = {};
  for (const name of schema.markOrder) marks[name] = markSpec(schema.marks.get(name) as CoelhoMarkSpec);
  return new Schema({ topNode: schema.topNode, nodes, marks });
}

export type LoadResult = { ok: true; doc: Node; repaired?: ValidationError[] } | { ok: false; errors: ValidationError[] };

export interface LoadOptions {
  /**
   * Load a document that does not validate after putting it through
   * `sanitize`, instead of refusing it. The result then says what was wrong
   * in `repaired`. For rows written under an older or looser schema: an
   * editor that refuses them shows nothing, and saving it loses everything.
   */
  repair?: boolean;
}

/**
 * Turns a stored document into an editor document, or says why it cannot.
 * The document is validated first: `Node.fromJSON` throws on an unknown
 * type and silently accepts content its parent does not allow, and neither
 * belongs in an editor. `null` is the empty document.
 */
export function toProseMirrorDoc(pmSchema: Schema, schema: CoelhoSchema, value: unknown, options: LoadOptions = {}): LoadResult {
  if (value === null || value === undefined) return { ok: true, doc: pmSchema.topNodeType.createAndFill() as Node };
  const result = validate(value, schema);
  if (!result.ok && !options.repair) return result;
  const document = result.ok ? result.document : sanitize(value, schema);
  try {
    const doc = Node.fromJSON(pmSchema, document);
    doc.check();
    return result.ok ? { ok: true, doc } : { ok: true, doc, repaired: result.errors };
  } catch (error) {
    return { ok: false, errors: [{ path: [], message: (error as Error).message }] };
  }
}

function attrSpecs(spec: CoelhoNodeSpec | CoelhoMarkSpec): Record<string, AttributeSpec> {
  const attrs: Record<string, AttributeSpec> = {};
  for (const [name, attr] of Object.entries(spec.attrs)) attrs[name] = attr.required ? {} : { default: attr.default };
  return attrs;
}

function nodeSpec(spec: CoelhoNodeSpec): NodeSpec {
  const out: NodeSpec = { attrs: attrSpecs(spec) };
  if (spec.contentSource !== null) out.content = spec.contentSource;
  if (spec.group.length > 0) out.group = spec.group.join(" ");
  if (spec.marks !== "all") out.marks = spec.marks.join(" ");
  if (spec.inline) out.inline = true;
  if (spec.void) out.atom = true;
  if (spec.code) out.code = true;
  if (spec.text) return out;
  if (spec.void) out.selectable = !spec.inline || Object.keys(spec.attrs).length > 0;
  out.toDOM = (node) => toDom(node.attrs, spec, spec.inline, !spec.void);
  out.parseDOM = parseRules(spec, spec.inline);
  return out;
}

function markSpec(spec: CoelhoMarkSpec): MarkSpec {
  const out: MarkSpec = {
    attrs: attrSpecs(spec),
    toDOM: (mark) => toDom(mark.attrs, spec, true, true),
    parseDOM: parseRules(spec, true),
  };
  // Code is code: nothing else applies inside it, and typing rules leave it alone.
  if (spec.code) {
    out.code = true;
    out.excludes = "_";
  }
  // Typing at the end of a link must not extend where it points.
  if (Object.values(spec.attrs).some((attr) => isUrl(attr.validate))) out.inclusive = false;
  return out;
}

function isUrl(validator: Validator | null): boolean {
  if (validator === "safe_url") return true;
  return typeof validator === "object" && validator !== null && "nullable" in validator && isUrl(validator.nullable);
}

function toDom(attrs: Attrs, spec: CoelhoNodeSpec | CoelhoMarkSpec, inline: boolean, hole: boolean): DOMOutputSpec {
  const rendered = renderDom({ type: spec.name, attrs }, spec);
  const [tag, domAttrs] = rendered ?? [spec.code && !inline ? "pre" : inline ? "span" : "div", []];
  const out: Record<string, string> = {};
  for (const [name, value] of domAttrs) {
    if (value === null || value === undefined || value === false) continue;
    out[name] = value === true ? "" : String(value);
  }
  for (const [name, value] of Object.entries(spec.editorAttrs)) out[name] = value;
  if (spec.class !== null && !("class" in out)) out.class = spec.class;
  if (rendered === null || spec.parse.length === 0) {
    out[DATA_NODE] = spec.name;
    const present = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== null && value !== undefined));
    if (Object.keys(present).length > 0) out[DATA_ATTRS] = JSON.stringify(present);
  }
  if ("void" in spec && spec.void && spec.editorText !== null) {
    const text = attrs[spec.editorText];
    if (typeof text === "string") out["data-text"] = text;
  }
  if (spec.code && tag === "pre") return hole ? ["pre", out, ["code", 0]] : ["pre", out];
  return hole ? [tag, out, 0] : [tag, out];
}

function parseRules(spec: CoelhoNodeSpec | CoelhoMarkSpec, inline: boolean): TagParseRule[] {
  const whitespace: Partial<TagParseRule> = spec.code && !inline ? { preserveWhitespace: "full" } : {};
  const rules: TagParseRule[] = [
    {
      tag: `[${DATA_NODE}="${spec.name}"]`,
      priority: 60,
      ...whitespace,
      getAttrs: (dom: HTMLElement) => {
        const raw = dom.getAttribute(DATA_ATTRS);
        if (raw === null) return holdAttrs(spec, {});
        try {
          const given = JSON.parse(raw) as unknown;
          return typeof given === "object" && given !== null && !Array.isArray(given) ? holdAttrs(spec, given as Record<string, unknown>) : false;
        } catch {
          return false;
        }
      },
    },
  ];
  for (const rule of spec.parse) {
    const [tag, custom] = typeof rule === "string" ? [rule, null] : rule;
    const heading = /^h([1-6])$/.exec(tag);
    rules.push({
      tag,
      ...whitespace,
      getAttrs: (dom: HTMLElement) => {
        const domAttrs: Record<string, string> = {};
        for (const attribute of Array.from(dom.attributes)) domAttrs[attribute.name] = attribute.value;
        const given: Record<string, unknown> = custom === null ? {} : { ...custom(domAttrs) };
        if (custom === null) for (const name of Object.keys(spec.attrs)) if (name in domAttrs) given[name] = domAttrs[name];
        if (heading !== null && "level" in spec.attrs && !("level" in given)) given.level = Number(heading[1]);
        return holdAttrs(spec, given);
      },
    });
  }
  return rules;
}

/**
 * What the DOM offered, held to the schema: a value failing its validator
 * is dropped so the default applies, and a required one failing refuses
 * the rule, so a pasted `javascript:` link becomes plain text.
 */
function holdAttrs(spec: CoelhoNodeSpec | CoelhoMarkSpec, given: Record<string, unknown>): Attrs | false {
  const out: Attrs = {};
  for (const [name, attr] of Object.entries(spec.attrs)) {
    const value = given[name] === undefined ? undefined : coerce(attr, given[name]);
    if (value === undefined) {
      if (attr.required) return false;
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** DOM attributes are strings; the schema may want a number or a boolean. */
function coerce(attr: Attr, raw: unknown): JsonValue | undefined {
  if (validateAttr(attr.validate, raw) === null) return raw as JsonValue;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed !== "" && Number.isFinite(Number(trimmed)) && validateAttr(attr.validate, Number(trimmed)) === null) return Number(trimmed);
  if ((trimmed === "true" || trimmed === "false") && validateAttr(attr.validate, trimmed === "true") === null) return trimmed === "true";
  return undefined;
}
