import { describe, expect, test } from "vitest";
import { roomOf } from "../server/schema.js";

describe("a room's name", () => {
  test("is a page, a page's threads, or nothing", () => {
    expect(roomOf("docs/intro")).toEqual({ kind: "page", page: "docs/intro" });
    expect(roomOf("docs/intro::threads")).toEqual({ kind: "threads", page: "docs/intro" });
    // Before, this one was taken for a page called "../../x::threads".
    expect(roomOf("../../x::threads")).toBeNull();
    expect(roomOf("../x")).toBeNull();
    expect(roomOf("a::threads::threads")).toBeNull();
  });
});
