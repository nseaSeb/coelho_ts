import { LINE_END, settle } from "./keys.js";
import { expect, test, type Browser, type Page } from "@playwright/test";

// One run, one in-memory server: the first sign-up is the admin.
test.describe.configure({ mode: "serial" });

async function signUp(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("tab", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`${name.toLowerCase()}@example.test`);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create the account" }).click();
  await expect(page.locator(".coelho-editor-content .ProseMirror")).toBeVisible();
  return page;
}

const editor = (page: Page) => page.locator(".coelho-editor-content .ProseMirror");

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).locator("p").first().click();
  await page.keyboard.press(LINE_END);
  await settle(page);
  await page.keyboard.type(text);
}

test("the first account is the admin; a reader reads until made an editor, then writes live", async ({ browser }) => {
  const admin = await signUp(browser, "Ada");
  await expect(admin.locator(".role")).toHaveText("admin");
  const reader = await signUp(browser, "Lin");
  await expect(reader.locator(".role")).toHaveText("reader");
  await expect(reader.getByText("You can read this page.")).toBeVisible();
  await expect(editor(reader)).toHaveAttribute("contenteditable", "false");

  await typeAtEnd(admin, " Ada wrote this.");
  await expect(editor(reader)).toContainText("Ada wrote this.");

  await admin.getByRole("button", { name: "People" }).click();
  await admin.getByLabel("Role of Lin").selectOption("editor");
  await expect(reader.locator(".role")).toHaveText("editor");
  await expect(editor(reader)).toHaveAttribute("contenteditable", "true");

  await typeAtEnd(reader, " Lin too.");
  await expect(editor(admin)).toContainText("Lin too.");
  await expect(editor(admin).locator(".ProseMirror-yjs-cursor")).toContainText("Lin");
  // What the server stored, read back, says who changed it last.
  await expect(admin.locator(".stored")).toContainText("Lin too.");
});

test("[[ links a page, the link opens it, and the new page knows who links to it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByLabel("Email").fill("ada@example.test");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(editor(page)).toBeVisible();

  await typeAtEnd(page, " See [[docs/install");
  const option = page.getByRole("option", { name: "create docs/install" });
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  const link = editor(page).locator("a.page-link", { hasText: "docs/install" });
  await expect(link).toBeVisible();

  await link.click();
  await expect(page).toHaveURL(/#docs%2Finstall$/);
  await expect(editor(page).locator("h1")).toHaveText("docs/install");
  await expect(page.locator(".backlinks")).toContainText("welcome");
  await expect(page.getByRole("navigation", { name: "Pages" })).toContainText("install");
});
