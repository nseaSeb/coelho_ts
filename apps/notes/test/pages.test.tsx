import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { missingOf, Sidebar, type PageSummary } from "../web/src/Pages.js";

const page = (name: string, links: string[] = []): PageSummary => ({ name, updatedBy: null, updatedAt: "2026-10-20T09:00:00.000Z", links });

describe("pages linked to and not written yet", () => {
  test("are each listed once, with the pages that link to them", () => {
    expect(missingOf([page("welcome", ["docs/install", "team"]), page("team", ["docs/install"]), page("docs/intro", ["docs/install"])])).toEqual([
      { name: "docs/install", linkedFrom: ["welcome", "team", "docs/intro"] },
    ]);
  });

  test("stand in the tree, in their folder, marked and saying who links to them", () => {
    const html = renderToStaticMarkup(<Sidebar pages={[page("docs/intro"), page("welcome", ["docs/install", "ideas/later"])]} current="welcome" me={{ id: "u1", email: "a@example.test", name: "Ada", role: "editor", color: "#000" }} />);
    expect(html).toContain('<li class="folder"><span>docs/</span><ul><li><a href="#docs%2Finstall" class="missing" title="not written yet; linked from welcome">install</a></li><li><a href="#docs%2Fintro">intro</a></li></ul></li>');
    expect(html).toContain('<span>ideas/</span><ul><li><a href="#ideas%2Flater" class="missing"');
    expect(html).not.toContain('href="#welcome" class="missing"');
  });
});
