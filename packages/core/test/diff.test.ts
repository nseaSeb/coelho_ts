import { describe, expect, test } from "vitest";
import { defaultSchema, diffDocuments, diffWords, validate, type Node } from "../src/index.js";

const schema = defaultSchema();
const p = (text: string): Node => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (text: string): Node => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const doc = (...blocks: Node[]): Node => {
  const result = validate({ type: "doc", content: blocks }, schema);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.document;
};
const kinds = (changes: ReturnType<typeof diffDocuments>): string[] => changes.map((change) => change.kind);

describe("diffDocuments", () => {
  test("is all the same for the same document", () => {
    const d = doc(h("Title"), p("One."), p("Two."));
    expect(kinds(diffDocuments(d, d, schema))).toEqual(["same", "same", "same"]);
  });

  test("finds added and removed blocks among the kept ones", () => {
    const before = doc(h("Title"), p("One."), p("Two."), p("Three."));
    const after = doc(h("Title"), p("Two."), p("Three."), p("Four."));
    expect(kinds(diffDocuments(before, after, schema))).toEqual(["same", "removed", "same", "same", "added"]);
  });

  test("shows an edited block word by word", () => {
    const changes = diffDocuments(doc(p("The quick fox jumps.")), doc(p("The slow red fox jumps.")), schema);
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(change?.kind).toBe("changed");
    if (change?.kind !== "changed") return;
    expect(change.words).toEqual([
      { kind: "same", text: "The " },
      { kind: "removed", text: "quick" },
      { kind: "added", text: "slow red" },
      { kind: "same", text: " fox jumps." },
    ]);
  });

  test("a block of another kind is replaced, not edited", () => {
    expect(kinds(diffDocuments(doc(p("Title")), doc(h("Title")), schema))).toEqual(["removed", "added"]);
  });

  test("a change of marks alone is a change", () => {
    const bold = doc({ type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }] });
    const changes = diffDocuments(doc(p("Bold")), bold, schema);
    expect(kinds(changes)).toEqual(["changed"]);
    if (changes[0]?.kind === "changed") expect(changes[0].words).toEqual([{ kind: "same", text: "Bold" }]);
  });

  test("everything is added to an empty document, and removed from it", () => {
    const d = doc(p("One."), p("Two."));
    expect(kinds(diffDocuments(null, d, schema))).toEqual(["added", "added"]);
    expect(kinds(diffDocuments(d, null, schema))).toEqual(["removed", "removed"]);
  });
});

describe("diffWords", () => {
  test("gives the text back exactly, spaces included", () => {
    const words = diffWords("a  b\nc", "a  x\nc") ?? [];
    expect(words.filter((w) => w.kind !== "added").map((w) => w.text).join("")).toBe("a  b\nc");
    expect(words.filter((w) => w.kind !== "removed").map((w) => w.text).join("")).toBe("a  x\nc");
  });

  test("gives up on texts too large to compare word by word", () => {
    expect(diffWords("w ".repeat(2000), "v ".repeat(2000))).toBeNull();
  });
});

describe("on large documents", () => {
  test("a long paragraph with one word changed is still compared word by word", () => {
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`);
    const before = words.join(" ");
    const after = [...words.slice(0, 400), "CHANGED", ...words.slice(401)].join(" ");
    const changes = diffWords(before, after);
    expect(changes?.filter((change) => change.kind !== "same")).toEqual([
      { kind: "removed", text: "word400" },
      { kind: "added", text: "CHANGED" },
    ]);
  });

  test("two large, mostly different versions are shown replaced, without a table the size of both", () => {
    const many = (prefix: string): Node => doc(...Array.from({ length: 1500 }, (_, i) => p(`${prefix} ${i}`)));
    const started = Date.now();
    const changes = diffDocuments(many("a"), many("b"), schema);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(changes.filter((change) => change.kind === "removed")).toHaveLength(1500);
    expect(changes.filter((change) => change.kind === "added")).toHaveLength(1500);
  });
});

