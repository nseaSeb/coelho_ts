import { defaultSchema, type Node } from "@nseaprotector/coelho-core";

/** The schema every page is written under, on the server as in the browser. */
export const schema = defaultSchema();

/** What an empty page starts as. Seeded by the server, once, when a page is first opened. */
export function firstPage(name: string): Node {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: name }] },
      { type: "paragraph", content: [{ type: "text", text: "Everyone with this page open edits it together. What is stored is the validated document, never HTML." }] },
    ],
  };
}
