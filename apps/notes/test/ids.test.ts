import { describe, expect, test } from "vitest";
import { isId } from "../server/ids.js";
import { byCodePoint } from "../server/store.js";

describe("a row id", () => {
  test("is a bigint, up to Postgres's largest, and nothing else", () => {
    expect(isId("1")).toBe(true);
    expect(isId("9223372036854775807")).toBe(true);
    expect(isId("9223372036854775808")).toBe(false);
    expect(isId("99999999999999999999")).toBe(false);
    expect(isId("")).toBe(false);
    expect(isId("-1")).toBe(false);
    expect(isId("1e3")).toBe(false);
  });
});

describe("code point order", () => {
  test("is the order of the letters, a letter beyond U+FFFF after one inside it, and a prefix first", () => {
    expect(["𠀀", "Ａ", "a", "B", "ab", "a𠀀", "aＡ"].sort(byCodePoint)).toEqual(["B", "a", "ab", "aＡ", "a𠀀", "Ａ", "𠀀"]);
    expect(byCodePoint("same", "same")).toBe(0);
  });
});
