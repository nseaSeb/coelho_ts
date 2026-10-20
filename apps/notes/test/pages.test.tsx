import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { linkedFrom, Sidebar, type PageSummary } from "../web/src/Pages.js";

const page = (name: string): PageSummary => ({ name, updatedBy: null, updatedAt: "2026-10-20T09:00:00.000Z" });
const me = { id: "u1", email: "a@example.test", name: "Ada", role: "editor" as const, color: "#000" };

describe("pages linked to and not written yet", () => {
  test("stand in the tree, in their folder, marked and saying who links to them", () => {
    const missing = [
      { name: "docs/install", linkedFrom: ["welcome"], linkCount: 1 },
      { name: "ideas/later", linkedFrom: ["welcome"], linkCount: 1 },
    ];
    const html = renderToStaticMarkup(<Sidebar listing={{ pages: [page("docs/intro"), page("welcome")], missing }} current="welcome" me={me} />);
    expect(html).toContain('<li class="folder"><span>docs/</span><ul><li><a href="#docs%2Finstall" class="missing" title="not written yet; linked from welcome">install</a></li><li><a href="#docs%2Fintro">intro</a></li></ul></li>');
    expect(html).toContain('<span>ideas/</span><ul><li><a href="#ideas%2Flater" class="missing"');
    expect(html).not.toContain('href="#welcome" class="missing"');
  });

  test("name the first pages that link to them, and how many more", () => {
    expect(linkedFrom({ name: "x", linkedFrom: ["a", "b", "c", "d", "e"], linkCount: 12 })).toBe("not written yet; linked from a, b, c, d, e and 7 more");
  });
});
