import { diffDocuments, validate, type Node } from "@nseaprotector/coelho-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { schema } from "../server/schema.js";
import { Diff } from "../web/src/History.js";

const doc = (...content: unknown[]): Node => {
  const result = validate({ type: "doc", content }, schema);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.document;
};
const render = (before: Node, after: Node): string => renderToStaticMarkup(<Diff changes={diffDocuments(before, after, schema)} />);

describe("a version's changes, shown", () => {
  test("an edited heading stays a heading, its words marked", () => {
    const html = render(doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Old title" }] }), doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "New title" }] }));
    expect(html).toBe('<div class="diff prose"><h2 class="diff-changed"><del>Old</del><ins>New</ins><span> title</span></h2></div>');
  });

  test("edited code stays code", () => {
    const html = render(doc({ type: "code_block", content: [{ type: "text", text: "a = 1" }] }), doc({ type: "code_block", content: [{ type: "text", text: "a = 2" }] }));
    expect(html).toContain('<pre class="diff-changed"><code>');
  });

  test("the same words formatted differently show both, since no word changed", () => {
    const html = render(doc({ type: "paragraph", content: [{ type: "text", text: "Bold" }] }), doc({ type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }] }));
    expect(html).toContain('class="diff-restyled"');
    expect(html).toContain('<div class="diff-removed"><p>Bold</p></div><div class="diff-added"><p><strong>Bold</strong></p></div>');
  });

  test("words are text, never HTML", () => {
    const html = render(doc({ type: "paragraph", content: [{ type: "text", text: "a" }] }), doc({ type: "paragraph", content: [{ type: "text", text: "a <img src=x onerror=alert(1)>" }] }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
