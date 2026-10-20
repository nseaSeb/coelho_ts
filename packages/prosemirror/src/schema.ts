import { renderDom, type Attrs, type MarkSpec as CoelhoMarkSpec, type NodeSpec as CoelhoNodeSpec, type Schema as CoelhoSchema } from "@coelho/core";
import { Schema, type AttributeSpec, type DOMOutputSpec, type MarkSpec, type NodeSpec, type TagParseRule } from "prosemirror-model";

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
  out.toDOM = (node) => toDom(node.attrs, spec, !spec.void);
  out.parseDOM = parseRules(spec);
  return out;
}

function markSpec(spec: CoelhoMarkSpec): MarkSpec {
  return {
    attrs: attrSpecs(spec),
    toDOM: (mark) => toDom(mark.attrs, spec, true),
    parseDOM: parseRules(spec),
  };
}

function toDom(attrs: Attrs, spec: CoelhoNodeSpec | CoelhoMarkSpec, hole: boolean): DOMOutputSpec {
  const node = { type: spec.name, attrs };
  const rendered = renderDom(node, spec);
  const [tag, domAttrs] = rendered ?? fallbackDom(spec, attrs);
  const out: Record<string, string> = {};
  for (const [name, value] of domAttrs) {
    if (value === null || value === undefined || value === false) continue;
    out[name] = value === true ? "" : String(value);
  }
  for (const [name, value] of Object.entries(spec.editorAttrs)) out[name] = value;
  if (spec.class !== null && !("class" in out)) out.class = spec.class;
  if (tag === "pre") return ["pre", out, ["code", 0]];
  return hole ? [tag, out, 0] : [tag, out];
}

/** What to draw for a node whose render is a function: the page decides there, the editor needs a box. */
function fallbackDom(spec: CoelhoNodeSpec | CoelhoMarkSpec, attrs: Attrs): [string, Array<[string, string | null]>] {
  if (spec.name === "code_block") return ["pre", []];
  if ("void" in spec && spec.void) {
    const text = spec.editorText !== null ? attrs[spec.editorText] : null;
    return [spec.inline ? "span" : "div", [["data-coelho", spec.name], ["data-text", typeof text === "string" ? text : null]]];
  }
  return ["inline" in spec && spec.inline ? "span" : "div", [["data-coelho", spec.name]]];
}

function parseRules(spec: CoelhoNodeSpec | CoelhoMarkSpec): TagParseRule[] {
  const attrNames = Object.keys(spec.attrs);
  return spec.parse.map((rule) => {
    const [tag, getAttrs] = typeof rule === "string" ? [rule, null] : rule;
    const heading = /^h([1-6])$/.exec(tag);
    return {
      tag,
      getAttrs: (dom: HTMLElement) => {
        if (getAttrs !== null) {
          const given: Record<string, string> = {};
          for (const attribute of Array.from(dom.attributes)) given[attribute.name] = attribute.value;
          return getAttrs(given);
        }
        const attrs: Attrs = {};
        for (const name of attrNames) if (dom.hasAttribute(name)) attrs[name] = dom.getAttribute(name) as string;
        if (heading !== null && "level" in spec.attrs) attrs.level = Number(heading[1]);
        return attrs;
      },
    };
  });
}
