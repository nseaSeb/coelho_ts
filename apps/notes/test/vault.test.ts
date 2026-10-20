// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { isPageName } from "../server/schema.js";
import { snippetOf } from "../server/store.js";
import { linkResolver, pageNameOf, readVault, stripFrontmatter } from "../web/src/Vault.js";

describe("a vault's files as pages", () => {
  test("keep a name the app accepts as it is, so an exported page comes back to itself", () => {
    expect(pageNameOf("Équipe/Onboarding.md")).toBe("Équipe/Onboarding");
    expect(pageNameOf("projects/sprint-42.md")).toBe("projects/sprint-42");
    // macOS hands names over decomposed: é is e and an accent.
    expect(pageNameOf("E\u0301quipe/Onboarding.md")).toBe("Équipe/Onboarding");
  });

  test("replace only what a page name cannot hold", () => {
    expect(pageNameOf("Équipe/Réunion du 20 octobre.md")).toBe("Équipe/Réunion-du-20-octobre");
    expect(pageNameOf("  (draft) !.md")).toBe("draft");
    expect(isPageName(pageNameOf("???.md"))).toBe(false);
  });

  test("leave out the properties at the top of a note, and only there", () => {
    expect(stripFrontmatter("---\ntags: notes\naliases: [Start]\n---\n# Start\n")).toBe("# Start\n");
    expect(stripFrontmatter("---\n---\nbody")).toBe("body");
    expect(stripFrontmatter("text\n\n---\n\nmore")).toBe("text\n\n---\n\nmore");
  });
});

describe("links in a vault", () => {
  test("a link without a folder finds its note by its last part, as Obsidian does", () => {
    const resolve = linkResolver(["Équipe/Onboarding", "Équipe/Planning", "a/Dup", "b/Dup", "Dup"]);
    expect(resolve("Onboarding")).toBe("Équipe/Onboarding");
    expect(resolve("onboarding")).toBe("Équipe/Onboarding");
    expect(resolve("Projets/Roadmap")).toBe("Projets/Roadmap");
    // Several candidates: the one with no folder, if there is one; otherwise as written.
    expect(resolve("Dup")).toBe("Dup");
    expect(resolve("Inconnue")).toBe("Inconnue");
  });
});

describe("reading a vault", () => {
  test("gives pages, links resolved, properties left out, and says what clashes, is skipped or replaced", () => {
    const pending = readVault(
      [
        { path: "Équipe/Onboarding.md", text: "---\ntags: notes\n---\nVoir [[Planning#Semaine|le planning]] et [[Projets]].\n" },
        { path: "Équipe/Planning.md", text: "# Planning\n" },
        { path: "a b.md", text: "first" },
        { path: "a-b.md", text: "second" },
        { path: "???.md", text: "nameless" },
      ],
      ["Projets", "Équipe/Planning"],
    );
    expect(pending.pages.map((page) => page.name)).toEqual(["Équipe/Onboarding", "Équipe/Planning", "a-b"]);
    expect(pending.replacing).toEqual(["Équipe/Planning"]);
    expect(pending.clashes).toEqual(["a-b.md (the same page as a b.md)"]);
    expect(pending.skipped).toEqual(["???.md"]);
    const onboarding = JSON.stringify(pending.pages[0]?.document);
    expect(onboarding).not.toContain("tags");
    expect(onboarding).toContain('{"type":"page_link","attrs":{"name":"Équipe/Planning"}}');
    expect(onboarding).toContain('{"type":"page_link","attrs":{"name":"Projets"}}');
  });
});

describe("search snippets", () => {
  test("mark the words that start with what was searched, and are not empty when only the name matched", () => {
    expect(snippetOf("Reading the Markdown guide tonight", ["own"])).toBe("Reading the Markdown guide tonight");
    expect(snippetOf("Reading the Markdown guide tonight", ["mark"])).toBe("Reading the \u0001Markdown\u0002 guide tonight");
    expect(snippetOf("Notes from the meeting", ["sprint"])).toBe("Notes from the meeting");
  });
});
