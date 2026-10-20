import { describe, expect, test } from "vitest";
import { anchorAt, contentSize, defaultSchema, reanchor, textBetween, type Node } from "../src/index.js";

const schema = defaultSchema();

function paragraph(text: string): Node {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

const doc: Node = {
  type: "doc",
  content: [paragraph("The cat sat."), { type: "bullet_list", content: [{ type: "list_item", content: [paragraph("on the mat")] }] }],
};

describe("positions", () => {
  test("measure the document the way ProseMirror does", () => {
    // paragraph: 1 + 12 + 1, bullet_list > list_item > paragraph: 1 + 1 + 1 + 10 + 1 + 1 + 1
    expect(contentSize(doc, schema)).toBe(14 + 16);
  });

  test("give the text between them, blocks separated", () => {
    expect(textBetween(doc, schema, 5, 8)).toBe("cat");
    expect(textBetween(doc, schema, 9, 23)).toBe("sat.\non the");
  });
});

describe("reanchor", () => {
  const anchor = anchorAt(doc, schema, 5, 8);

  test("keeps a range whose text is still there", () => {
    expect(reanchor(doc, schema, anchor)).toEqual({ from: 5, to: 8, quote: "cat" });
  });

  test("follows its quote when the document changed elsewhere", () => {
    const edited: Node = { ...doc, content: [paragraph("Another writer was here."), ...(doc.content ?? [])] };
    const moved = reanchor(edited, schema, anchor);
    expect(moved).toEqual({ from: 31, to: 34, quote: "cat" });
    expect(textBetween(edited, schema, 31, 34)).toBe("cat");
  });

  test("picks the occurrence closest to where it was", () => {
    const twice: Node = { type: "doc", content: [paragraph("cat one"), paragraph("cat two"), paragraph("cat three")] };
    expect(reanchor(twice, schema, { from: 10, to: 13, quote: "cat" })).toEqual({ from: 10, to: 13, quote: "cat" });
    expect(reanchor(twice, schema, { from: 12, to: 15, quote: "cat" })?.from).toBe(10);
  });

  test("finds a quote spanning blocks", () => {
    const quote = textBetween(doc, schema, 9, 23);
    const edited: Node = { ...doc, content: [paragraph("x"), ...(doc.content ?? [])] };
    const found = reanchor(edited, schema, { from: 9, to: 23, quote });
    expect(found !== null && textBetween(edited, schema, found.from, found.to)).toBe(quote);
  });

  test("is null when the text was deleted", () => {
    expect(reanchor({ type: "doc", content: [paragraph("The dog sat.")] }, schema, anchor)).toBeNull();
  });
});
