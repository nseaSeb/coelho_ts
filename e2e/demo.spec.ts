import { LINE_END, PASTE_PLAIN, settle } from "./keys.js";
import { expect, test, type Page } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const editor = (page: Page) => page.locator(".workspace .ProseMirror");
const panel = (page: Page, title: string) => page.locator(".panel").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).locator("pre, .prose").first();

/** Puts the caret at the end of a line of the editor that contains `text`. */
async function caretAfter(page: Page, text: string): Promise<void> {
  await editor(page).getByText(text, { exact: false }).first().click();
  await page.keyboard.press(LINE_END);
  await settle(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
});

test("the @ list opens under the caret, and a choice becomes a mention", async ({ page }) => {
  await caretAfter(page, "No HTML in the database.");
  await page.keyboard.type(" @ca");
  const list = page.getByRole("listbox", { name: "People" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveText([/Camille Durand/]);

  const caret = await page.evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { left: rect.left, bottom: rect.bottom };
  });
  const box = (await list.boundingBox())!;
  // Just under the line being typed, starting near the @.
  expect(box.y).toBeGreaterThanOrEqual(caret.bottom - 1);
  expect(box.y - caret.bottom).toBeLessThan(24);
  expect(Math.abs(box.x - caret.left)).toBeLessThan(60);

  const chips = page.locator(".workspace .mention-chip");
  await expect(chips).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(chips).toHaveCount(2);
  await expect(panel(page, "Markdown")).toContainText("No HTML in the database. @Camille Durand");
});

test("Escape closes the list and leaves the text", async ({ page }) => {
  await caretAfter(page, "No HTML in the database.");
  await page.keyboard.type(" @sa");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(panel(page, "Markdown")).toContainText("No HTML in the database. @sa");
});

test("copy and paste inside the editor keeps marks", async ({ page }) => {
  // The link, not the bold word: that one sits in a comment thread, whose
  // card scrolls into view when it is clicked, under the next click.
  await editor(page).locator("a", { hasText: "link" }).dblclick();
  await page.keyboard.press("ControlOrMeta+C");
  await caretAfter(page, "No HTML in the database.");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(panel(page, "Markdown")).toContainText("No HTML in the database.[link](<https://example.test/?a=1&#38;b=2>)");
});

test("pasted Markdown arrives formatted", async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText("**bold** and `code`"));
  await caretAfter(page, "No HTML in the database.");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(panel(page, "HTML source")).toContainText("database.<strong>bold</strong> and <code>code</code>");
});

test("a plain-text paste keeps Markdown as it was typed", async ({ page }) => {
  test.skip(PASTE_PLAIN === null, "headless Chromium on macOS has no plain-text paste shortcut; runs on Linux");
  await page.evaluate(() => navigator.clipboard.writeText("**bold** and `code`"));
  await caretAfter(page, "No HTML in the database.");
  await page.keyboard.press(PASTE_PLAIN as string);
  await expect(panel(page, "HTML source")).toContainText("database.**bold** and `code`");
});

test("two writers: what one types reaches the other, with a named cursor", async ({ page }) => {
  const [camille, sacha] = [page.locator(".collab .pane").nth(0), page.locator(".collab .pane").nth(1)];
  await camille.locator(".ProseMirror p").first().click();
  await page.keyboard.press(LINE_END);
  await settle(page);
  await page.keyboard.type(" Camille was here.");
  await expect(sacha.locator(".ProseMirror")).toContainText("Camille was here.");
  await expect(sacha.locator(".ProseMirror-yjs-cursor")).toContainText("Camille");
  // What each would store has it at the end of the line, where the caret
  // was put (the editor's own text also holds the other's cursor label),
  // and the two are the same document.
  const stored = page.locator(".stored-one .prose p:first-of-type");
  await expect(stored).toHaveCount(2);
  for (const paragraph of await stored.all()) await expect(paragraph).toHaveText(/ Camille was here\.$/);
  await expect(page.locator(".stored .ok")).toContainText("Both would store the same document");
});
