// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { isPageName } from "../server/schema.js";
import { snippetOf } from "../server/store.js";
import { linkResolver, pageNameOf, readVault, stripFrontmatter } from "../web/src/Vault.js";

describe("a vault's files as pages", () => {
  test("keep a name the app accepts as it is, so an exported page comes back to itself", () => {
    expect(pageNameOf("Cinémas/Lyon.md")).toBe("Cinémas/Lyon");
    expect(pageNameOf("siege/semaine-42.md")).toBe("siege/semaine-42");
    // macOS hands names over decomposed: é is e and an accent.
    expect(pageNameOf("Cinémas/Lyon.md")).toBe("Cinémas/Lyon");
  });

  test("replace only what a page name cannot hold", () => {
    expect(pageNameOf("Siège/Réunion du 20 octobre.md")).toBe("Siège/Réunion-du-20-octobre");
    expect(pageNameOf("  (draft) !.md")).toBe("draft");
    expect(isPageName(pageNameOf("???.md"))).toBe(false);
  });

  test("leave out the properties at the top of a note, and only there", () => {
    expect(stripFrontmatter("---\ntags: cinema\naliases: [Lyon]\n---\n# Lyon\n")).toBe("# Lyon\n");
    expect(stripFrontmatter("---\n---\nbody")).toBe("body");
    expect(stripFrontmatter("text\n\n---\n\nmore")).toBe("text\n\n---\n\nmore");
  });
});

describe("links in a vault", () => {
  test("a link without a folder finds its note by its last part, as Obsidian does", () => {
    const resolve = linkResolver(["Cinémas/Lyon", "Cinémas/Nantes", "a/Dup", "b/Dup", "Dup"]);
    expect(resolve("Lyon")).toBe("Cinémas/Lyon");
    expect(resolve("lyon")).toBe("Cinémas/Lyon");
    expect(resolve("Siège/Planning")).toBe("Siège/Planning");
    // Several candidates: the one with no folder, if there is one; otherwise as written.
    expect(resolve("Dup")).toBe("Dup");
    expect(resolve("Inconnue")).toBe("Inconnue");
  });
});

describe("reading a vault", () => {
  test("gives pages, links resolved, properties left out, and says what clashes, is skipped or replaced", () => {
    const pending = readVault(
      [
        { path: "Cinémas/Lyon.md", text: "---\ntags: salle\n---\nVoir [[Nantes#Horaires|les horaires]] et [[Siège]].\n" },
        { path: "Cinémas/Nantes.md", text: "# Nantes\n" },
        { path: "a b.md", text: "first" },
        { path: "a-b.md", text: "second" },
        { path: "???.md", text: "nameless" },
      ],
      ["Siège", "Cinémas/Nantes"],
    );
    expect(pending.pages.map((page) => page.name)).toEqual(["Cinémas/Lyon", "Cinémas/Nantes", "a-b"]);
    expect(pending.replacing).toEqual(["Cinémas/Nantes"]);
    expect(pending.clashes).toEqual(["a-b.md (the same page as a b.md)"]);
    expect(pending.skipped).toEqual(["???.md"]);
    const lyon = JSON.stringify(pending.pages[0]?.document);
    expect(lyon).not.toContain("tags");
    expect(lyon).toContain('{"type":"page_link","attrs":{"name":"Cinémas/Nantes"}}');
    expect(lyon).toContain('{"type":"page_link","attrs":{"name":"Siège"}}');
  });
});

describe("search snippets", () => {
  test("mark the words that start with what was searched, and are not empty when only the name matched", () => {
    expect(snippetOf("Projection de Dune ce soir", ["une"])).toBe("Projection de Dune ce soir");
    expect(snippetOf("Projection de Dune ce soir", ["dun"])).toBe("Projection de \u0001Dune\u0002 ce soir");
    expect(snippetOf("Le programme de la salle", ["semaine"])).toBe("Le programme de la salle");
  });
});
