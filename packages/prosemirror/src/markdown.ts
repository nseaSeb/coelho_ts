import { sanitize, type Document, type Schema as CoelhoSchema } from "@nseaprotector/coelho-core";
import MarkdownIt from "markdown-it";
import { DOMParser, Slice, type Fragment } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { proseMirrorSchemaFor } from "./schema.js";

/**
 * Parses HTML into an inert document: no script runs, no image loads, no
 * handler fires. Setting `innerHTML` on an element of the page instead
 * would fetch `<img src onerror>` the moment it is parsed.
 */
function inert(html: string): HTMLElement {
  const parsed = new globalThis.DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  return parsed.body;
}

/**
 * Imports HTML under the schema: what the schema's parse rules recognise is
 * kept, everything else is dropped, and the result is a document the
 * schema accepts. Needs a DOM (a browser, or jsdom).
 */
export function fromHtml(html: string, schema: CoelhoSchema): Document {
  return fromBody(inert(html), schema);
}

function fromBody(body: HTMLElement, schema: CoelhoSchema): Document {
  openRequiredFirst(body, schema);
  const doc = DOMParser.fromSchema(proseMirrorSchemaFor(schema)).parse(body);
  // Reading, not writing: the length bounds are not this import's to apply.
  return sanitize(doc.toJSON(), schema, { limits: { maxTextLength: Infinity, maxAttrLength: Infinity } });
}

/**
 * A node whose content must begin with a given node — a list item with its
 * paragraph — gets an empty one when the HTML opens it with another block:
 * `<li><hr></li>` is an item holding an empty paragraph and a rule, as the
 * editor would hold it. Left alone, ProseMirror's parser would close the
 * item and put the rule after the list.
 */
function openRequiredFirst(root: HTMLElement, schema: CoelhoSchema): void {
  const tagsOf = (rules: ReadonlyArray<string | readonly [string, unknown]>): string[] => rules.map((rule) => (typeof rule === "string" ? rule : rule[0]));
  const blockTags = new Set<string>();
  for (const spec of schema.nodes.values()) if (!spec.inline) for (const tag of tagsOf(spec.parse)) blockTags.add(tag.toUpperCase());
  for (const spec of schema.nodes.values()) {
    const ast = schema.content.get(spec.name);
    const first = ast?.kind === "seq" ? ast.items[0] : undefined;
    if (first?.kind !== "name" || !schema.nodes.has(first.name)) continue;
    const childTag = tagsOf((schema.nodes.get(first.name) as { parse: Array<string | [string, unknown]> }).parse)[0];
    if (childTag === undefined) continue;
    for (const tag of tagsOf(spec.parse)) {
      for (const element of Array.from(root.querySelectorAll(tag))) {
        let opening: ChildNode | null = element.firstChild;
        while (opening !== null && opening.nodeType === 3 && (opening.textContent ?? "").trim() === "") opening = opening.nextSibling;
        if (opening === null || opening.nodeType !== 1) continue;
        const name = (opening as Element).tagName;
        if (name !== childTag.toUpperCase() && blockTags.has(name)) element.insertBefore(element.ownerDocument.createElement(childTag), opening);
      }
    }
  }
}

// CommonMark, with GitHub's tables and strikethrough, and HTML passed
// through to the import, which decides what of it the schema keeps.
const markdownIt = new MarkdownIt("default", { html: true, linkify: false, typographer: false });
// markdown-it refuses `javascript:` links by leaving their Markdown as text.
// The schema refuses them too, keeping the link's words: let it decide, as
// it does for every other import.
markdownIt.validateLink = () => true;
// An image's alt is the plain text of its description. markdown-it 14 drops
// what was escaped in it (`\<`, `\``), which its parser leaves as
// `text_special` tokens that its own renderInlineAsText skips; and a code
// span's text belongs to the alt too.
type InlineToken = { type: string; content: string; children: InlineToken[] | null };
markdownIt.renderer.renderInlineAsText = function renderInlineAsText(tokens: InlineToken[]): string {
  let text = "";
  for (const token of tokens) {
    if (token.type === "image") text += renderInlineAsText(token.children ?? []);
    else if (token.type === "softbreak" || token.type === "hardbreak") text += "\n";
    else if (["text", "text_special", "code_inline", "html_inline", "html_block"].includes(token.type)) text += token.content;
  }
  return text;
} as typeof markdownIt.renderer.renderInlineAsText;

/**
 * Obsidian's `[[page]]` and `[[page|alias]]`, read as a node of the
 * schema's own when `fromMarkdown` is asked to: the node goes through the
 * import like any other, held to its attributes' validators. Not inside
 * code, and not when the brackets are escaped.
 */
export interface WikiLinks {
  /** The inline node a link becomes, such as `page_link`. */
  node: string;
  /** The attribute that holds the link's target. */
  attr: string;
  /** Turns a target as written into the one stored, as a vault's file names become page names. */
  resolve?: (target: string) => string;
}

interface Env {
  wikiLinks?: WikiLinks;
}

markdownIt.inline.ruler.before("link", "coelho_wikilink", (state, silent) => {
  const wikiLinks = (state.env as Env).wikiLinks;
  if (wikiLinks === undefined || state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) return false;
  const end = state.src.indexOf("]]", state.pos + 2);
  if (end === -1) return false;
  const inner = state.src.slice(state.pos + 2, end);
  if (inner.includes("\n") || inner.includes("[")) return false;
  // `[[page#heading]]` and `[[page^block]]` point into a page: the link is to the page.
  const written = ((inner.split("|")[0] ?? "").split(/[#^]/)[0] ?? "").trim();
  const target = written === "" ? "" : (wikiLinks.resolve?.(written) ?? written);
  if (target === "") return false;
  if (!silent) {
    const attrs = JSON.stringify({ [wikiLinks.attr]: target }).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const token = state.push("html_inline", "", 0);
    // The link's own words inside: a leaf node ignores them, and a link the
    // schema refuses leaves them as text rather than losing them.
    const words = state.src.slice(state.pos, end + 2).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    token.content = `<span data-coelho="${wikiLinks.node.replace(/[^\w-]/g, "")}" data-coelho-attrs="${attrs}">${words}</span>`;
  }
  state.pos = end + 2;
  return true;
});

function markdownToHtml(markdown: string, env: Env = {}): string {
  // A hard line break's newline would read as a space at the start of the
  // next line, and a fenced block's content always ends with a newline
  // that is the fence's, not the code's.
  return markdownIt.render(markdown, env).replaceAll("<br>\n", "<br>").replace(/\n<\/code><\/pre>/g, "</code></pre>");
}

/**
 * Markdown to a document, through HTML: the schema decides what is kept
 * exactly as it does for imported HTML. The inverse of `toMarkdown` from
 * `@nseaprotector/coelho-core`, up to what Markdown cannot say.
 */
/**
 * Obsidian's callouts, `> [!warning]` and its lines, read as a node of the
 * schema's own: the kind becomes the attribute, held to its validator like
 * any other (one the schema refuses leaves the default), and the quote's
 * blocks its content. Any other quote stays a quote.
 */
export interface Callouts {
  /** The block node a callout becomes, such as `callout`. */
  node: string;
  /** The attribute that holds its kind. */
  attr: string;
}

export interface MarkdownImportOptions {
  wikiLinks?: WikiLinks;
  callouts?: Callouts;
}

const CALLOUT = /^\[!([\w-]+)\][+-]?[ \t]*\n?/;

function liftCallouts(body: HTMLElement, callouts: Callouts | undefined): void {
  if (callouts === undefined) return;
  for (const quote of Array.from(body.querySelectorAll("blockquote"))) {
    const first = quote.firstElementChild;
    const text = first?.tagName === "P" ? first.firstChild : null;
    const marker = text?.nodeType === 3 ? CALLOUT.exec(text.textContent ?? "") : null;
    if (first === null || text === null || marker === null) continue;
    text.textContent = (text.textContent ?? "").slice(marker[0].length);
    if ((first.textContent ?? "").trim() === "" && first.children.length === 0) first.remove();
    const callout = quote.ownerDocument.createElement("div");
    callout.setAttribute("data-coelho", callouts.node);
    callout.setAttribute("data-coelho-attrs", JSON.stringify({ [callouts.attr]: (marker[1] ?? "").toLowerCase() }));
    callout.append(...Array.from(quote.childNodes));
    quote.replaceWith(callout);
  }
}

export function fromMarkdown(markdown: string, schema: CoelhoSchema, options: MarkdownImportOptions = {}): Document {
  const body = inert(markdownToHtml(markdown, options.wikiLinks === undefined ? {} : { wikiLinks: options.wikiLinks }));
  liftCallouts(body, options.callouts);
  return fromBody(body, schema);
}

/**
 * Pasting plain text reads it as Markdown, so `**bold**` and `- items`
 * arrive formatted. Text that says nothing in Markdown is left to
 * ProseMirror's own plain-text paste, which gives it the marks at the
 * cursor: a word pasted into a bold run stays bold, a URL pasted into a
 * link stays in it. Nothing is parsed inside code, inline or block, and
 * Shift-paste keeps everything plain.
 */
export function markdownPaste(schema: CoelhoSchema, options: { callouts?: Callouts } = {}): Plugin {
  const parsed = new WeakSet<Fragment>();
  return new Plugin({
    props: {
      clipboardTextParser: (text, $context, plain) => {
        if (plain || $context.marks().some((mark) => mark.type.spec.code)) return null as unknown as Slice;
        const body = inert(markdownToHtml(text));
        if (saysNothing(body, text)) return null as unknown as Slice;
        liftCallouts(body, options.callouts);
        openRequiredFirst(body, schema);
        const slice = DOMParser.fromSchema($context.doc.type.schema).parseSlice(body, { context: $context });
        parsed.add(slice.content);
        return slice;
      },
      // ProseMirror opens a pasted slice as deep as it goes, so a paste
      // starting with a list would pour its first item into the paragraph at
      // the cursor and lose the bullet. For a slice read from Markdown, only
      // a paragraph at an edge stays open, to run into the text around the
      // cursor; anything else is pasted whole.
      transformPasted: (slice) => {
        if (!parsed.has(slice.content)) return slice;
        const first = slice.content.firstChild;
        const last = slice.content.lastChild;
        return new Slice(slice.content, first?.isTextblock && slice.openStart > 0 ? 1 : 0, last?.isTextblock && slice.openEnd > 0 ? 1 : 0);
      },
    },
  });
}

/** Paragraphs of plain text whose words are exactly what was typed: no syntax, no escape. */
function saysNothing(body: HTMLElement, text: string): boolean {
  const blocks = Array.from(body.children);
  if (!blocks.every((block) => block.tagName === "P" && block.children.length === 0)) return false;
  const typed = text.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/).map((paragraph) => paragraph.trim());
  return blocks.length === typed.length && blocks.every((block, index) => block.textContent === typed[index]);
}
