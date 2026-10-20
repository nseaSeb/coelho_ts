import { safeUrl } from "./attr.js";
import { attr, escape, tag, voidTag } from "./render.js";
import { defineSchema, type Schema } from "./schema.js";
import type { AttrInput, DomAttrs, JsonValue, Mark, Node, NodeSpecInput, RenderAs, RenderContext } from "./types.js";

/**
 * The schema shipped by default: paragraphs, headings, lists, quotes, code
 * blocks, images, attachments, hard breaks and a horizontal rule; as marks
 * bold, italic, strike, underline, highlight, subscript, superscript, code
 * and link. It mirrors `Coelho.Schema.Default` byte for byte, which is what
 * the parity fixtures check.
 *
 * A link carries an `href` and a `title`, and nothing else: no `target`, no
 * `rel`. An application that wants them overrides the mark's render and
 * must set both.
 */
export interface DefaultSchemaOptions {
  /** How `align` reaches the DOM. Default: an inline `text-align` style. */
  align?: RenderAs;
  /** Declares `table`, `table_row`, `table_cell` and `table_header`. Default `false`. */
  tables?: boolean;
}

const ALIGNS = ["left", "center", "right", "justify"];
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;
const MAX_SPAN = 1000;

function alignAttr(renderAs: RenderAs): AttrInput {
  return { default: null, validate: { nullable: { oneOf: ALIGNS } }, renderAs };
}

function headingTag(node: Node | Mark): string {
  const level = attr(node, "level", 1);
  return `h${Number.isInteger(level) && (level as number) >= 1 && (level as number) <= 6 ? level : 1}`;
}

function language(value: unknown): null | string {
  if (typeof value !== "string") return "must be a string";
  return LANGUAGE.test(value) ? null : "must be the name of a language, without spaces";
}

function renderCodeBlock(node: Node | Mark, inner: string): string {
  const lang = attr(node, "language", null);
  const cls = typeof lang === "string" && LANGUAGE.test(lang) ? `language-${lang}` : null;
  return tag("pre", [], tag("code", [["class", cls]], inner));
}

function orderedListAttrs(node: Node | Mark): DomAttrs {
  const start = attr(node, "start", 1);
  return start === 1 ? [] : [["start", start as number]];
}

function imageAttrs(node: Node | Mark): DomAttrs {
  return [
    ["src", safeUrl(attr(node, "src", null))],
    ["alt", stringOrNull(attr(node, "alt", null))],
    ["title", stringOrNull(attr(node, "title", null))],
  ];
}

function linkAttrs(mark: Node | Mark): DomAttrs {
  return [
    ["href", safeUrl(attr(mark, "href", null))],
    ["title", stringOrNull(attr(mark, "title", null))],
  ];
}

function stringOrNull(value: JsonValue): string | null {
  return typeof value === "string" ? value : value === null ? null : String(value);
}

function present(value: JsonValue): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isImage(contentType: JsonValue): boolean {
  return typeof contentType === "string" && contentType.startsWith("image/");
}

function label(node: Node | Mark): string {
  return present(attr(node, "filename", null)) ?? String(attr(node, "key", "") ?? "");
}

function attachmentUrl(context: RenderContext, node: Node | Mark): string | null {
  const key = attr(node, "key", null);
  if (typeof key !== "string") return null;
  const resolve = context.resolve;
  const url = typeof resolve === "function" ? resolve(key) : resolve?.[key];
  return safeUrl(url ?? null);
}

function renderAttachment(node: Node | Mark, _inner: string, context: RenderContext): string {
  const url = attachmentUrl(context, node);
  let body: string;
  if (url === null) body = tag("span", [["class", "coelho-attachment-missing"]], escape(label(node)));
  else if (isImage(attr(node, "content_type", null))) body = voidTag("img", [["src", url], ["alt", stringOrNull(attr(node, "alt", null))]]);
  else body = tag("a", [["href", url]], escape(label(node)));
  return tag("figure", [["class", "coelho-attachment"]], body + figcaption(node));
}

function figcaption(node: Node | Mark): string {
  const caption = present(attr(node, "caption", null));
  return caption === null ? "" : tag("figcaption", [], escape(caption));
}

function withCaption(body: string, node: Node | Mark): string {
  const caption = present(attr(node, "caption", null));
  return caption === null ? body : `${body} ${escape(caption)}`;
}

function inlineAttachment(node: Node | Mark, _inner: string, context: RenderContext): string {
  const url = attachmentUrl(context, node);
  let body: string;
  if (url !== null && isImage(attr(node, "content_type", null))) body = voidTag("img", [["src", url], ["alt", stringOrNull(attr(node, "alt", null))]]);
  else if (url !== null) body = tag("a", [["href", url]], escape(label(node)));
  else body = tag("span", [["class", "coelho-attachment-missing"]], escape(label(node)));
  return withCaption(body, node);
}

function untrustedName(node: Node | Mark): string {
  return tag("span", [["class", "coelho-attachment-name"]], escape(label(node)));
}

function untrustedAttachment(node: Node | Mark): string {
  return tag("figure", [["class", "coelho-attachment"]], untrustedName(node) + figcaption(node));
}

function inlineUntrustedAttachment(node: Node | Mark): string {
  return withCaption(untrustedName(node), node);
}

function untrustedImage(node: Node | Mark): string {
  const alt = present(attr(node, "alt", null));
  return alt === null ? "" : tag("span", [["class", "coelho-image-alt"]], escape(alt));
}

function attachmentText(node: Node): string {
  const text = present(attr(node, "caption", null)) ?? present(attr(node, "filename", null));
  return text === null ? "" : `${text}\n`;
}

function span(value: unknown): null | string {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_SPAN
    ? null
    : `must be a whole number of cells, from 1 to ${MAX_SPAN}`;
}

function cellAttrs(node: Node | Mark): DomAttrs {
  const spanOf = (name: string): number | null => {
    const value = attr(node, name, 1);
    return Number.isInteger(value) && (value as number) > 1 && (value as number) <= MAX_SPAN ? (value as number) : null;
  };
  return [["colspan", spanOf("colspan")], ["rowspan", spanOf("rowspan")]];
}

function tableNodes(): Record<string, NodeSpecInput> {
  const cell: NodeSpecInput = {
    content: "block+",
    attrs: { colspan: { default: 1, validate: span }, rowspan: { default: 1, validate: span } },
  };
  return {
    table: { content: "table_row+", group: "block", render: ["table", []], parse: ["table"] },
    table_row: { content: "(table_cell | table_header)+", render: ["tr", []], parse: ["tr"] },
    table_cell: { ...cell, render: ["td", cellAttrs], parse: ["td"] },
    table_header: { ...cell, render: ["th", cellAttrs], parse: ["th"] },
  };
}

export function buildDefaultSchema(options: DefaultSchemaOptions = {}): Schema {
  const align = options.align ?? { style: "text-align" };
  return defineSchema({
    topNode: "doc",
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "inline*", group: "block", attrs: { align: alignAttr(align) }, render: ["p", []], parse: ["p"] },
      heading: {
        content: "inline*",
        group: "block",
        attrs: { level: { default: 1, validate: { oneOf: [1, 2, 3, 4, 5, 6] } }, align: alignAttr(align) },
        render: [headingTag, []],
        parse: ["h1", "h2", "h3", "h4", "h5", "h6"],
      },
      blockquote: { content: "block+", group: "block", render: ["blockquote", []], parse: ["blockquote"] },
      bullet_list: { content: "list_item+", group: "block", render: ["ul", []], parse: ["ul"] },
      ordered_list: {
        content: "list_item+",
        group: "block",
        attrs: { start: { default: 1, validate: "integer" } },
        render: ["ol", orderedListAttrs],
        parse: ["ol"],
      },
      list_item: { content: "paragraph block*", attrs: { align: alignAttr(align) }, render: ["li", []], parse: ["li"] },
      code_block: {
        content: "text*",
        group: "block",
        marks: "none",
        code: true,
        attrs: { language: { default: null, validate: { nullable: language } } },
        render: renderCodeBlock,
        renderUntrusted: renderCodeBlock,
        parse: ["pre"],
      },
      horizontal_rule: { group: "block", void: true, render: ["hr", []], parse: ["hr"] },
      image: {
        group: "inline",
        inline: true,
        void: true,
        attrs: {
          src: { required: true, validate: "safe_url" },
          alt: { default: null, validate: { nullable: "string" } },
          title: { default: null, validate: { nullable: "string" } },
        },
        render: ["img", imageAttrs],
        renderUntrusted: untrustedImage,
        parse: ["img"],
      },
      attachment: {
        group: "block",
        void: true,
        attrs: {
          key: { required: true, validate: "string" },
          filename: { default: null, validate: { nullable: "string" } },
          content_type: { default: null, validate: { nullable: "string" } },
          byte_size: { default: null, validate: { nullable: "integer" } },
          alt: { default: null, validate: { nullable: "string" } },
          caption: { default: null, validate: { nullable: "string" } },
        },
        render: renderAttachment,
        renderInline: inlineAttachment,
        renderUntrusted: untrustedAttachment,
        renderUntrustedInline: inlineUntrustedAttachment,
        toText: attachmentText,
      },
      hard_break: { group: "inline", inline: true, void: true, render: ["br", []], toText: "\n", parse: ["br"] },
      text: { group: "inline", inline: true, text: true },
      ...(options.tables ? tableNodes() : {}),
    },
    marks: {
      bold: { render: ["strong", []], parse: ["strong", "b"] },
      italic: { render: ["em", []], parse: ["em", "i"] },
      strike: { render: ["s", []], parse: ["s", "del", "strike"] },
      underline: { render: ["u", []], parse: ["u"] },
      highlight: { render: ["mark", []], parse: ["mark"] },
      subscript: { render: ["sub", []], parse: ["sub"] },
      superscript: { render: ["sup", []], parse: ["sup"] },
      code: { code: true, render: ["code", []], parse: ["code"] },
      link: {
        attrs: {
          href: { required: true, validate: "safe_url" },
          title: { default: null, validate: { nullable: "string" } },
        },
        render: ["a", linkAttrs],
        parse: ["a"],
      },
    },
  });
}

let cached: Schema | undefined;

/** The default schema, built once. */
export function defaultSchema(): Schema {
  cached ??= buildDefaultSchema();
  return cached;
}
