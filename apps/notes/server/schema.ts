import { defaultSchema, escape, extendSchema, tag, type Node } from "@nseaprotector/coelho-core";

/**
 * A page name: letters, digits and `-_.`, with `/` for folders, as
 * `siege/programmation`. It ends up in a URL and in a link's text, so the
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
