import type { Node } from "@coelho/core";

// Documents made mostly of what Markdown reads as syntax, for the Markdown
// properties and for the export that replays them through coelho's Elixir
// to_markdown. A port of the hostile generators in coelho's markdown_test.exs,
// with the Unicode whitespace and punctuation French text holds.

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Mostly what Markdown reads as syntax: delimiters at the edges of marks,
// line-start markers after line breaks, backslashes, backticks in code.
export const HOSTILE = [
  // What CommonMark's flanking rules ask of Unicode: whitespace and
  // punctuation beyond ASCII, as French text holds them.
  "\u00a0",
  "\u202f",
  "«",
  "»",
  "’",
  "e\u0301",
  "é",
  "😀",
  "👨‍👩‍👧",
  "*", "**", "_", "__", "`", "``", "```", "~", "~~", "#", "##", "-", "--", "---", "+", "=", "==", ">", "|", "[", "]", "(", ")", "!", "&", "\\", "<", "1.", "1)", "2.", "a", "b", "word", ".", ",", ":", "\\!", " ", "  ", "x y"];
const HOSTILE_MARKS = [
  { type: "bold" },
  { type: "italic" },
  { type: "strike" },
  { type: "code" },
  { type: "link", attrs: { href: "/a(b)?c=*d*" } },
  { type: "link", attrs: { href: "/a|b" } },
  { type: "link", attrs: { href: "/?a=1&copy;b&amp;c", title: "&amp;amp; me" } },
];

export function generator(seed: number) {
  const next = random(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const many = <T,>(min: number, max: number, make: () => T): T[] => Array.from({ length: int(min, max) }, make);

  const text = (): string => many(1, 6, () => pick(HOSTILE)).join("");
  const marks = (): unknown[] => [...new Set(many(0, 3, () => pick(HOSTILE_MARKS)))];
  const inline = (): unknown => {
    const roll = next();
    if (roll < 0.7) return { type: "text", text: text(), marks: marks() };
    if (roll < 0.85) return { type: "hard_break" };
    const alt = text();
    return { type: "image", attrs: { src: "/i*_[x].png&lt;", alt, title: `${alt}&lt;` } };
  };
  const paragraph = (): unknown => ({ type: "paragraph", content: many(1, 6, inline) });
  const maybeEmpty = (): unknown => (next() < 0.8 ? paragraph() : { type: "paragraph", content: [] });
  const list = (depth: number): unknown => {
    const type = pick(["bullet_list", "ordered_list"]);
    const items = many(1, 3, () => item(depth));
    return type === "ordered_list" ? { type, attrs: { start: next() < 0.85 ? int(0, 4) : 999_999_999 }, content: items } : { type, content: items };
  };
  const item = (depth: number): unknown => {
    const first = maybeEmpty();
    if (depth === 0) return { type: "list_item", content: [first] };
    const roll = next();
    const nested =
      roll < 0.25 ? null : roll < 0.5 ? list(depth - 1) : roll < 0.75 ? { type: "horizontal_rule" } : { type: "code_block", content: [{ type: "text", text: text() }] };
    return { type: "list_item", content: nested === null ? [first] : [first, nested] };
  };
  const cell = (): unknown[] => {
    const roll = next();
    if (roll < 4 / 7) return [maybeEmpty()];
    if (roll < 5 / 7) return [paragraph(), paragraph()];
    if (roll < 6 / 7) {
      const value = text();
      return [{ type: "code_block", attrs: { language: "elixir" }, content: [{ type: "text", text: `${value}\n${value}` }] }];
    }
    return [list(0)];
  };
  const table = (): unknown => {
    const width = int(1, 3);
    const rows = many(1, 3, () => Array.from({ length: width }, cell));
    const row = (cells: unknown[][], type: string): unknown => ({ type: "table_row", content: cells.map((content) => ({ type, content })) });
    const [header, ...body] = rows;
    return { type: "table", content: [row(header as unknown[][], "table_header"), ...body.map((cells) => row(cells, "table_cell"))] };
  };
  const blockOf = (): unknown => {
    switch (int(0, 7)) {
      case 0:
        return paragraph();
      case 1:
        return { type: "paragraph", content: [] };
      case 2:
        return { type: "heading", attrs: { level: int(1, 6) }, content: many(1, 4, inline) };
      case 3:
        return list(2);
      case 4:
        return { type: "blockquote", content: many(1, 2, paragraph) };
      case 5:
        return { type: "code_block", content: [{ type: "text", text: text() }] };
      case 6:
        return { type: "horizontal_rule" };
      default:
        return table();
    }
  };
  return { text, document: (): Node => ({ type: "doc", content: many(1, 5, blockOf) }) as Node };
}

