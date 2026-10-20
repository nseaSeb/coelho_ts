import { safeUrl } from "./attr.js";
import { attr, toHtml } from "./render.js";
import { markSpec, nodeSpec, type Schema } from "./schema.js";
import type { JsonValue, Mark, MarkSpec, Node, NodeSpec, RenderContext } from "./types.js";

/**
 * Documents to Markdown: CommonMark with two GitHub extensions,
 * `~~strikethrough~~` and pipe tables. A port of `Coelho.Markdown.to_markdown`.
 *
 * Every character a writer typed comes back as that character: what would
 * be syntax is escaped, so a paragraph that starts with `#` stays a
 * paragraph. A mark is written with its delimiters (`**`, `*`, `~~`) where
 * CommonMark is certain to read them as such, and as the equivalent HTML
 * element where it would not. Underline, highlight, subscript and
 * superscript have no delimiters, so they are always their element.
 *
 * What Markdown cannot say is dropped or written another way: an empty
 * paragraph, a line break at the edge of one, alignment, a cell's span; a
 * cell holding more than one paragraph, an ordered list numbered past nine
 * digits and a heading holding a line break are written as HTML; an
 * attachment is a link to it, resolved through `context`, or its name.
 */
export interface MarkdownOptions {
  /** How an application's node is written, by name: the Markdown itself, escaped as it needs. */
  nodes?: Record<string, (node: Node, inner: string) => string>;
  /** The pair of strings a mark is wrapped in, by name: `{ highlight: ["==", "=="] }`. */
  marks?: Record<string, [open: string, close: string]>;
  context?: RenderContext;
}

interface State {
  schema: Schema;
  nodes: Record<string, (node: Node, inner: string) => string>;
  marks: Record<string, [string, string]>;
  context: RenderContext;
  variant: number;
  table: boolean;
}

export function toMarkdown(document: Node | null | undefined, schema: Schema, options: MarkdownOptions = {}): string {
  if (document === null || document === undefined) return "";
  const state: State = { schema, nodes: options.nodes ?? {}, marks: options.marks ?? {}, context: options.context ?? {}, variant: 0, table: false };
  return blocks(document, state).join("\n\n");
}

// -- Blocks -----------------------------------------------------------------

type ListKind = "bullet_list" | "ordered_list";

/** Two lists of one kind in a row are one list to Markdown, so the second gets the other marker. */
function blocks(node: Node, state: State): string[] {
  const out: string[] = [];
  let previous: [ListKind, number] | null = null;
  for (const child of node.content ?? []) {
    const kind = listKind(child, state);
    const variant: number = kind !== null && previous !== null && previous[0] === kind ? 1 - previous[1] : 0;
    const written = block(child, { ...state, variant });
    if (written === "") continue;
    out.push(written);
    previous = kind === null ? null : [kind, variant];
  }
  return out;
}

function listKind(node: Node, state: State): ListKind | null {
  const name = spec(state.schema, node.type).name;
  return name === "bullet_list" || name === "ordered_list" ? name : null;
}

function block(node: Node, state: State): string {
  const nodeSpecOf = spec(state.schema, node.type);
  const override = state.nodes[nodeSpecOf.name];
  if (override !== undefined) return override(node, inner(node, nodeSpecOf, state));
  switch (nodeSpecOf.name) {
    case "paragraph":
      return paragraph(trimEdges(node), state);
    case "heading": {
      const trimmed = trimEdges(node);
      return (trimmed.content ?? []).some((child) => child.type === "hard_break") ? htmlBlock(trimmed, state) : heading(trimmed, state);
    }
    case "blockquote":
      return prefixLines(blocks(node, state).join("\n\n"), "> ", ">");
    case "bullet_list": {
      const bullet = state.variant === 0 ? "- " : "* ";
      return list(node, () => bullet, state);
    }
    case "ordered_list": {
      const given = attr(node, "start", 1);
      const start = Number.isInteger(given) && (given as number) >= 0 ? (given as number) : 1;
      const last = start + (node.content ?? []).length - 1;
      if (last > 999_999_999) return htmlBlock(node, state);
      const delimiter = state.variant === 0 ? ". " : ") ";
      return list(node, (index) => `${start + index}${delimiter}`, state);
    }
    case "code_block": {
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
      const given = attr(node, "language", null);
      const language = typeof given === "string" && /^[\w+#.-]+$/.test(given) ? given : "";
      return `${fence}${language}\n${code}${code === "" ? "" : "\n"}${fence}`;
    }
    case "horizontal_rule":
      return "---";
    case "attachment": {
      const name = present(attr(node, "filename", null)) ?? present(attr(node, "key", null)) ?? "";
      const caption = present(attr(node, "caption", null));
      const url = attachmentUrl(state.context, node);
      const body = url === null ? paragraphText(name) : link(escape(name), url, null);
      return caption === null ? body : `${body}\n\n${paragraphText(caption)}`;
    }
    case "table":
      return table(node, state);
    default:
      if (nodeSpecOf.void) return paragraphText(leafText(node, nodeSpecOf));
      if (inlineContent(node, state)) return paragraph(node, state);
      return blocks(node, state).join("\n\n");
  }
}

function edge(node: Node): boolean {
  return node.type === "hard_break" || (node.type === "text" && typeof node.text === "string" && node.text.trim() === "");
}

/** A line break, or a run of spaces, at the edge of a paragraph is trailing whitespace to Markdown. */
function trimEdges(node: Node): Node {
  const content = [...(node.content ?? [])];
  while (content.length > 0 && edge(content[0] as Node)) content.shift();
  while (content.length > 0 && edge(content[content.length - 1] as Node)) content.pop();
  return { ...node, content };
}

/** What Markdown cannot say, taken out before a node is written as HTML: empty paragraphs a container does not need. */
function unsaid(node: Node): Node {
  if (node.type === "paragraph" || node.type === "heading") return trimEdges(node);
  if (!Array.isArray(node.content)) return node;
  const content = node.content.map(unsaid);
  const kept = content.filter(
    (child, index) => !((child.type === "paragraph" || child.type === "heading") && (child.content ?? []).length === 0 && !needed(node, child, index, content)),
  );
  return { ...node, content: kept };
}

function needed(node: Node, child: Node, index: number, content: Node[]): boolean {
  if (child.type !== "paragraph" || index !== 0) return false;
  if (node.type === "list_item") return true;
  if (node.type === "table_cell" || node.type === "table_header" || node.type === "blockquote") {
    return content.every((sibling) => sibling.type === "paragraph" && (sibling.content ?? []).length === 0);
  }
  return false;
}

function heading(node: Node, state: State): string {
  const given = attr(node, "level", 1);
  const level = Number.isInteger(given) && (given as number) >= 1 && (given as number) <= 6 ? (given as number) : 1;
  const text = keepEdgeWhitespace(escapeClosingHashes(escapeLineStarts(inline(node, state))));
  return text.trim() === "" ? "" : `${"#".repeat(level)} ${text}`;
}

function htmlBlock(node: Node, state: State): string {
  return toHtml(unsaid(node), state.schema, { context: state.context }).replaceAll("\n", "&#10;");
}

function inner(node: Node, nodeSpecOf: NodeSpec, state: State): string {
  if (nodeSpecOf.void) return "";
  if (nodeSpecOf.inline || inlineContent(node, state)) return inline(node, state);
  return blocks(node, state).join("\n\n");
}

function inlineContent(node: Node, state: State): boolean {
  return (node.content ?? []).some((child) => spec(state.schema, child.type).inline);
}

function list(node: Node, marker: (index: number) => string, state: State): string {
  const items = node.content ?? [];
  // A tight list keeps its items on consecutive lines, which is only safe
  // when each item is a paragraph, followed by nothing but lists that can
  // interrupt one.
  const tight = items.every((item) => {
    const [first, ...rest] = item.content ?? [];
    return first !== undefined && spec(state.schema, first.type).name === "paragraph" && rest.every((child) => interruptsParagraph(child, state));
  });
  const separator = tight ? "\n" : "\n\n";
  return items
    .map((item, index) => {
      const mark = marker(index);
      const body = blocks(item, state).join(separator);
      const pad = " ".repeat(mark.length);
      return opensEmpty(item) && body !== "" ? `${mark.trimEnd()}\n${pad}${indent(body, pad)}` : `${mark}${indent(body, pad)}`;
    })
    .join(separator);
}

function opensEmpty(item: Node): boolean {
  const first = item.content?.[0];
  return first?.type === "paragraph" && (trimEdges(first).content ?? []).length === 0;
}

function interruptsParagraph(node: Node, state: State): boolean {
  if (!opensWithText(node)) return false;
  const name = spec(state.schema, node.type).name;
  return name === "bullet_list" || (name === "ordered_list" && attr(node, "start", 1) === 1);
}

function opensWithText(list: Node): boolean {
  const first = list.content?.[0]?.content?.[0];
  return first?.type === "paragraph" && (trimEdges(first).content ?? []).length > 0;
}

// -- Tables -----------------------------------------------------------------

function table(node: Node, state: State): string {
  const rows = (node.content ?? []).map((row) => (row.content ?? []).map((one) => escapePipes(cell(one, state))));
  const [header, ...body] = rows;
  if (header === undefined) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]): string => `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
  return [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

/** A cell is one line: a paragraph is written as Markdown, anything else as HTML. */
function cell(node: Node, state: State): string {
  const inTable = { ...state, table: true };
  const content = unsaid(node).content ?? [];
  if (content.length === 1) {
    const only = content[0] as Node;
    return spec(state.schema, only.type).name === "paragraph" ? paragraph(trimEdges(only), inTable) : inlineHtml(only, inTable);
  }
  return content.map((child) => inlineHtml(child, inTable)).join("");
}

/** GitHub splits a row on any `|` not escaped by an odd run of backslashes. */
function escapePipes(text: string): string {
  let out = "";
  let escaped = false;
  for (const char of text) {
    if (char === "|" && !escaped) out += "\\|";
    else out += char;
    escaped = char === "\\" ? !escaped : false;
  }
  return out;
}

function inlineHtml(node: Node, state: State): string {
  return toHtml(unsaid(node), state.schema, { context: state.context })
    .split(/(<[^>]*>)/)
    .map((piece) => (piece.startsWith("<") ? piece.replaceAll("|", "&#124;") : entities(piece)))
    .join("");
}

function entities(text: string): string {
  return text
    .split(/(&#?\w+;)/)
    .map((piece) => (piece.startsWith("&") ? piece : [...piece].map(entity).join("")))
    .join("");
}

function entity(char: string): string {
  const code = char.codePointAt(0) as number;
  if (/^[a-zA-Z0-9 ]$/.test(char) || code >= 128) return char;
  return `&#${code};`;
}

// -- Inline -----------------------------------------------------------------

function paragraph(node: Node, state: State): string {
  return keepEdgeWhitespace(escapeLineStarts(inline(node, state)));
}

function paragraphText(text: string): string {
  return keepEdgeWhitespace(escapeLineStarts(escape(text)).replace(/^ +/, (spaces) => "&#32;".repeat(spaces.length)));
}

/**
 * CommonMark strips only spaces and tabs from the edges of a paragraph, a
 * heading or a cell; a no-break space, a narrow one or an em space is
 * content. JavaScript's `trim`, which some readers use (markdown-it among
 * them), strips those too, so one at an edge is written as its entity:
 * the same character to every reader. This is the one place where this
 * writer differs from coelho's, which leaves the character as it is.
 */
function keepEdgeWhitespace(text: string): string {
  // Within the whitespace at an edge, which may mix both kinds: CommonMark
  // strips the spaces and tabs past the last other character, so any other
  // one there becomes the edge, and is what a `trim` would take.
  const protect = (run: string): string => [...run].map((char) => (/[ \t\n\r\f\v]/.test(char) ? char : `&#${char.codePointAt(0)};`)).join("");
  return text.replace(/^\s+/u, protect).replace(/\s+$/u, protect);
}

interface MarkInfo {
  name: string;
  key: string;
  kind: "emphasis" | "fixed";
  open: string;
  close: string;
  tag?: string;
}

type Token = "break" | { kind: "text" | "atom"; value: string; marks: MarkInfo[] };
type Tree = "break" | { value: string } | { span: MarkInfo; children: Tree[] };

function inline(node: Node, state: State): string {
  let tokens = (node.content ?? []).flatMap((child) => tokensOf(child, state));
  if (state.table) tokens = tokens.map((token) => (token === "break" ? { kind: "atom", value: "<br>", marks: [] } : token));
  return renderSpans(group(tokens, 0), "edge", "edge");
}

function tokensOf(node: Node, state: State): Token[] {
  const nodeSpecOf = spec(state.schema, node.type);
  const marks = marksOf(node, state);
  const override = state.nodes[nodeSpecOf.name];
  if (override !== undefined) return [{ kind: "atom", value: override(node, inner(node, nodeSpecOf, state)), marks }];
  if (nodeSpecOf.text) return textTokens(node.text ?? "", marks, state.table);
  if (nodeSpecOf.name === "hard_break") return ["break"];
  if (nodeSpecOf.name === "image") return [{ kind: "atom", value: image(node, state.table), marks }];
  if (nodeSpecOf.void) {
    // An inline node of the application's own: what its toText says.
    const text = leafText(node, nodeSpecOf);
    return text === "" ? [] : textTokens(text, marks, state.table);
  }
  return (node.content ?? []).flatMap((child) => tokensOf(child, state)).map((token) => (token === "break" ? token : { ...token, marks: [...marks, ...token.marks] }));
}

function image(node: Node, table: boolean): string {
  const alt = present(attr(node, "alt", null)) ?? "";
  const src = safeUrl(attr(node, "src", null)) ?? "";
  return `!${link(escape(alt, table), src, present(attr(node, "title", null)), table)}`;
}

/** Code is a span of its own, written whole: nothing inside it is escaped and no other mark starts or ends inside it. */
function textTokens(raw: string, marks: MarkInfo[], table: boolean): Token[] {
  const text = raw.replace(/\r\n|\n|\r|\t/g, " ");
  const code = marks.some((mark) => mark.name === "code");
  const others = marks.filter((mark) => mark.name !== "code");
  if (code) {
    // Inside a link's text too: a `]` in it would end the text early.
    return [{ kind: "atom", value: codeSpan(text, table || others.some((mark) => mark.name === "link")), marks: others }];
  }
  return [{ kind: "text", value: escapeTrailingBang(escape(text, table)), marks }];
}

const ELEMENTS: Record<string, string> = { underline: "u", highlight: "mark", subscript: "sub", superscript: "sup" };

/** Marks with their delimiters, outermost first: the schema's order, which a validated document keeps. */
function marksOf(node: Node, state: State): MarkInfo[] {
  return (node.marks ?? []).map((mark) => {
    const markSpecOf = specOfMark(state.schema, mark.type);
    return { ...delimiters(markSpecOf, mark, state), name: markSpecOf.name, key: JSON.stringify([mark.type, mark.attrs ?? null]) };
  });
}

function delimiters(markSpecOf: MarkSpec, mark: Mark, state: State): Omit<MarkInfo, "name" | "key"> {
  const override = state.marks[markSpecOf.name];
  if (override !== undefined) return { kind: "fixed", open: override[0], close: override[1] };
  switch (markSpecOf.name) {
    case "bold":
      return { kind: "emphasis", open: "**", close: "**", tag: "strong" };
    case "italic":
      return { kind: "emphasis", open: "*", close: "*", tag: "em" };
    case "strike":
      return { kind: "emphasis", open: "~~", close: "~~", tag: "del" };
    case "link":
      return { kind: "fixed", open: "[", close: linkTail(mark, state.table) };
    default: {
      // A shipped mark Markdown has no delimiters for is its element, while
      // it is still the shipped mark: a redeclared one has its own render.
      const tag = ELEMENTS[markSpecOf.name];
      const render = markSpecOf.render;
      if (tag !== undefined && Array.isArray(render) && render[0] === tag && Array.isArray(render[1]) && render[1].length === 0) {
        return { kind: "fixed", open: `<${tag}>`, close: `</${tag}>` };
      }
      return { kind: "fixed", open: "", close: "" };
    }
  }
}

function linkTail(mark: Mark, table: boolean): string {
  return destination(safeUrl(attr(mark, "href", null)) ?? "", present(attr(mark, "title", null)), table);
}

/** Consecutive tokens sharing the mark at `depth` become one span of it. */
function group(tokens: Token[], depth: number): Tree[] {
  const out: Tree[] = [];
  let i = 0;
  while (i < tokens.length) {
    const mark = markAt(tokens[i] as Token, depth);
    let j = i + 1;
    while (j < tokens.length && markAt(tokens[j] as Token, depth)?.key === mark?.key) j += 1;
    const chunk = tokens.slice(i, j);
    if (mark === undefined) out.push(...chunk.map((token): Tree => (token === "break" ? "break" : { value: token.value })));
    else out.push({ span: mark, children: group(chunk, depth + 1) });
    i = j;
  }
  return out;
}

function markAt(token: Token, depth: number): MarkInfo | undefined {
  return token === "break" ? undefined : token.marks[depth];
}

type Around = "edge" | "delimiter" | "space" | "span" | "other" | { char: string };

/**
 * `**`, `*` and `~~` only count as delimiters when the characters around
 * them allow it: CommonMark's flanking rules. A span is written with them
 * when that is certain, and as `<strong>`, `<em>`, `<del>` otherwise.
 */
function renderSpans(children: Tree[], outerBefore: Around, outerAfter: Around): string {
  let out = "";
  children.forEach((child, index) => {
    const before: Around = out === "" ? outerBefore : isSpace(lastGrapheme(out)) ? "space" : { char: lastGrapheme(out) as string };
    const next = children[index + 1];
    const after: Around =
      next === undefined ? outerAfter : next === "break" ? "space" : "span" in next ? "span" : isSpace(firstGrapheme(next.value)) ? "space" : "other";
    out += lineStart(out, outerBefore, renderChild(child, before, after));
  });
  return out;
}

/** Markdown drops the spaces a line begins with, after a line break too: written as the entity, a space is kept. */
function lineStart(out: string, outerBefore: Around, written: string): string {
  const atLineStart = out.endsWith("\\\n") || (out === "" && outerBefore === "edge");
  return atLineStart ? written.replace(/^ +/, (spaces) => "&#32;".repeat(spaces.length)) : written;
}

function renderChild(child: Tree, before: Around, after: Around): string {
  if (child === "break") return "\\\n";
  if ("value" in child) return child.value;
  const mark = child.span;
  const inside = renderSpans(child.children, "delimiter", "delimiter");
  if (mark.kind === "emphasis") {
    return delimitersHold(inside, before, after) ? `${mark.open}${inside}${mark.close}` : `<${mark.tag}>${inside}</${mark.tag}>`;
  }
  return `${mark.open}${inside}${mark.close}`;
}

/**
 * The opening delimiter is left-flanking when the character after it is a
 * letter or digit, or punctuation after a space or the edge; the closing
 * one mirrors it. A span that begins or ends with a space has no delimiter
 * that counts at all. And no run of `*` or `~` may touch another.
 */
function delimitersHold(inside: string, before: Around, after: Around): boolean {
  const first = firstGrapheme(inside);
  const last = lastGrapheme(inside);
  return (
    !isSpace(first) &&
    !isSpace(last) &&
    (isWord(first) || before === "edge" || before === "space") &&
    (isWord(last) || after === "edge" || after === "space") &&
    !(typeof before === "object" && ["*", "~", "_"].includes(before.char)) &&
    after !== "span"
  );
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /^\s$/u.test(char);
}

function isWord(char: string | undefined): boolean {
  return char !== undefined && /^[\p{L}\p{N}]$/u.test(char);
}

let segmenter: Intl.Segmenter | undefined;

function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].map(({ segment }) => segment);
}

function firstGrapheme(text: string): string | undefined {
  return text === "" ? undefined : graphemes(text)[0];
}

function lastGrapheme(text: string): string | undefined {
  return text === "" ? undefined : graphemes(text).at(-1);
}

/**
 * In a table cell a code span cannot escape a `|` for every backslash
 * before it, so it is `<code>`, its punctuation written as entities.
 */
function codeSpan(text: string, asElement: boolean): string {
  if (asElement) {
    const encoded = [...text]
      .map((char) => {
        const code = char.codePointAt(0) as number;
        const punctuation = (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
        return punctuation ? `&#${code};` : char;
      })
      .join("");
    return `<code>${encoded}</code>`;
  }
  const fence = "`".repeat(longestRun(text, "`") + 1);
  // CommonMark strips one space from each side of content that has one on
  // both, and a backtick against the fence would lengthen it: a space on
  // both sides answers both. Content that is only spaces is never stripped.
  const pad = text.replace(/^ +| +$/g, "") !== "" && (/^[` ]/.test(text) || /[` ]$/.test(text)) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

// -- Pieces -----------------------------------------------------------------

function leafText(node: Node, nodeSpecOf: NodeSpec): string {
  if (nodeSpecOf.toText === null) return "";
  return (typeof nodeSpecOf.toText === "function" ? nodeSpecOf.toText(node) : nodeSpecOf.toText).trim();
}

function link(text: string, url: string, title: string | null, table = false): string {
  return `[${text}${destination(url, title, table)}`;
}

/** `](<url> "title")`: the angle brackets let a destination hold spaces and parentheses. */
function destination(url: string, title: string | null, table: boolean): string {
  const quoted = title === null ? "" : ` "${escapeTitle(title, table)}"`;
  return `](<${escapeUrl(url, table)}>${quoted})`;
}

/** CommonMark decodes entities in a title, so a typed `&` is one itself. */
function escapeTitle(title: string, table: boolean): string {
  return title
    .replaceAll("&", "&#38;")
    .replace(/[\\"]/g, (char) => `\\${char}`)
    .replaceAll("|", table ? "&#124;" : "|")
    .replace(/\r\n|\n|\r/g, " ");
}

/** Inside `<…>` only the brackets and a line break end a destination; an entity would be decoded. */
function escapeUrl(url: string, table: boolean): string {
  const piped = table ? url.replaceAll("|", "%7C") : url;
  return piped
    .replaceAll("&", "&#38;")
    .replaceAll("\\", "\\\\")
    .replace(/[<>\n]/g, (char) => (char === "\n" ? "%0A" : `\\${char}`));
}

const ESCAPED = new Set(["\\", "`", "*", "_", "[", "]", "<", ">", "~", "|", "&"]);

/**
 * What CommonMark reads as syntax anywhere in a line. Escaping too much is
 * safe and too little is not; what is only syntax at the start of a line is
 * `escapeLineStarts`'s.
 */
function escape(text: string, table = false): string {
  let out = "";
  for (const char of text.replace(/\r\n|\n|\r|\t/g, " ")) {
    if (char === "|" && table) out += "&#124;";
    else if (ESCAPED.has(char)) out += `\\${char}`;
    else out += char;
  }
  return out;
}

/** `![` opens an image, and a link may follow a text node: only its last `!` needs escaping. */
function escapeTrailingBang(text: string): string {
  return text.endsWith("!") ? `${text.slice(0, -1)}\\!` : text;
}

/** A line that would open a block instead of continuing the paragraph. */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^([\t\n\v\f\r ]*)(#|>|\+|-|=|\d{1,9}[.)])([\s\S]*)$/.exec(line);
      if (match === null) return line;
      const [, space, mark, rest] = match as unknown as [string, string, string, string];
      const numbered = /^(\d+)([.)])$/.exec(mark);
      return `${space}${numbered === null ? `\\${mark}` : `${numbered[1]}\\${numbered[2]}`}${rest}`;
    })
    .join("\n");
}

/** `## Title ##` has a closing sequence, which CommonMark strips: a heading ending in `#` would lose it. */
function escapeClosingHashes(text: string): string {
  const match = /^([\s\S]*?)(\\?)#(\s*)$/u.exec(text);
  return match !== null && match[2] === "" ? `${match[1]}\\#${match[3]}` : text;
}

function prefixLines(text: string, prefix: string, empty: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? empty : `${prefix}${line}`))
    .join("\n");
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${by}${line}`))
    .join("\n");
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

function present(value: JsonValue): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function attachmentUrl(context: RenderContext, node: Node): string | null {
  const key = attr(node, "key", null);
  if (typeof key !== "string") return null;
  const resolve = context.resolve;
  return safeUrl((typeof resolve === "function" ? resolve(key) : resolve?.[key]) ?? null);
}

function spec(schema: Schema, type: string): NodeSpec {
  const found = nodeSpec(schema, type);
  if (found === undefined) throw new Error(`cannot write unknown node type ${JSON.stringify(type)} as Markdown`);
  return found;
}

function specOfMark(schema: Schema, type: string): MarkSpec {
  const found = markSpec(schema, type);
  if (found === undefined) throw new Error(`cannot write unknown mark type ${JSON.stringify(type)} as Markdown`);
  return found;
}
