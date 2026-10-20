import { defineSchema, defaultSchema, escape, extendSchema, tag, type Node } from "@nseaprotector/coelho-core";

/**
 * A page name: letters, digits and `-_.`, with `/` for folders, as
 * `docs/getting-started`. It ends up in a URL and in a link's text, so the
 * schema holds it to this; a link to anything else is not a link.
 */
export const PAGE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*(\/[\p{L}\p{N}][\p{L}\p{N}_.-]*)*$/u;

export function isPageName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && PAGE_NAME.test(value);
}

function renderLink(node: { attrs?: Record<string, unknown> }): string {
  const name = String(node.attrs?.name ?? "");
  return tag("a", [["class", "page-link"], ["href", `#${encodeURIComponent(name)}`]], escape(name));
}

/**
 * The schema every page is written under, on the server as in the browser:
 * coelho's default, and a link to another page, `[[name]]`.
 */
export const schema = extendSchema(defaultSchema(), {
  nodes: {
    page_link: {
      group: "inline",
      inline: true,
      void: true,
      attrs: { name: { required: true, validate: (value) => (isPageName(value) ? null : "must be a page name") } },
      render: renderLink,
      renderUntrusted: renderLink,
      toText: (node) => String(node.attrs?.name ?? ""),
    },
  },
});

/** The pages a document links to, each once, in the order they first appear. */
export function linksOf(document: Node): string[] {
  const names: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === "page_link" && isPageName(node.attrs?.name) && !names.includes(node.attrs.name)) names.push(node.attrs.name);
    for (const child of node.content ?? []) walk(child);
  };
  walk(document);
  return names;
}

/** What an empty page starts as. Seeded by the server, once, when a page is first opened. */
export function firstPage(name: string): Node {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: name }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Everyone with this page open edits it together. Type " },
          { type: "text", text: "[[", marks: [{ type: "code" }] },
          { type: "text", text: " to link another page." },
        ],
      },
    ],
  };
}

/**
 * What a comment may hold: paragraphs, line breaks, bold, italic, code and
 * links. Small on purpose, and rendered as a stranger's text all the same.
 */
export const commentSchema = defineSchema({
  limits: { maxTextLength: 5000, maxNodes: 500 },
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block", render: ["p", []], parse: ["p"] },
    hard_break: { group: "inline", inline: true, void: true, render: ["br", []], toText: "\n", parse: ["br"] },
    text: { group: "inline", inline: true, text: true },
  },
  marks: {
    bold: { render: ["strong", []], parse: ["strong", "b"] },
    italic: { render: ["em", []], parse: ["em", "i"] },
    code: { code: true, render: ["code", []], parse: ["code"] },
    link: { attrs: { href: { required: true, validate: "safe_url" } }, render: ["a", (mark) => [["href", String(mark.attrs?.href ?? "")]]], parse: ["a"] },
  },
});

/**
 * The room a page's comment threads live in, beside the page's own. Every
 * client reads it and none writes to it: the server does, for whoever is
 * signed in, so a comment's author is the account that posted it.
 */
export const THREADS_ROOM = "::threads";

/** Why a reader cannot open a page: it does not exist, and opening it would write it. */
export const NOT_WRITTEN = "not written yet";

export function threadsRoomOf(name: string): string {
  return `${name}${THREADS_ROOM}`;
}

/**
 * What a room is: a page, a page's threads, or nothing the server serves.
 * Every hook asks this once, so no room is ever taken for a page because
 * one of them forgot to ask: `../x::threads` is neither.
 */
export type Room = { kind: "page"; page: string } | { kind: "threads"; page: string };

export function roomOf(room: string): Room | null {
  if (!room.endsWith(THREADS_ROOM)) return isPageName(room) ? { kind: "page", page: room } : null;
  const page = room.slice(0, -THREADS_ROOM.length);
  return isPageName(page) ? { kind: "threads", page } : null;
}
