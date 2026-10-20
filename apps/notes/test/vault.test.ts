import { describe, expect, test } from "vitest";
import { isPageName } from "../server/schema.js";
import { pageNameOf } from "../web/src/Vault.js";

describe("a vault's files as pages", () => {
  test("keep their folders, and become names a link can hold", () => {
    expect(pageNameOf("Siège/Réunion du 20 octobre.md")).toBe("siege/reunion-du-20-octobre");
    expect(pageNameOf("Cinémas/Lyon Part-Dieu.md")).toBe("cinemas/lyon-part-dieu");
    expect(pageNameOf("notes.MD")).toBe("notes");
    expect(pageNameOf("  (draft) !.md")).toBe("draft");
    for (const name of ["siege/reunion-du-20-octobre", "cinemas/lyon-part-dieu", "notes", "draft"]) expect(isPageName(name)).toBe(true);
    expect(isPageName(pageNameOf("???.md"))).toBe(false);
  });
});
