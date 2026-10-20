import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { LINE_END, settle } from "./keys.js";

// One in-memory server for the run: the first sign-up is the admin. The
// tests share it, so they run in order; a retry finds the accounts the
// first attempt made, which is why each one is made or signed in to.
test.describe.configure({ mode: "serial" });

const PASSWORD = "correct horse battery";
const contexts: BrowserContext[] = [];

test.afterEach(async () => {
  // Each closed page leaves the server: no stale cursor in the next test.
  for (const context of contexts.splice(0)) await context.close();
});

/** Signs up, or signs in when a previous attempt already made the account. */
async function account(browser: Browser, name: string, email: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const response = await page.request.post("/api/signup", { data: { name, email, password: PASSWORD } });
  if (response.status() === 409) await page.request.post("/api/login", { data: { email, password: PASSWORD } });
  else expect(response.status()).toBe(201);
  await page.goto("/");
  await expect(editor(page)).toBeVisible();
  return page;
}

const editor = (page: Page) => page.locator(".coelho-editor-content .ProseMirror");

async function typeAtEnd(page: Page, text: string): Promise<void> {
  await editor(page).locator("p").first().click();
  await page.keyboard.press(LINE_END);
  await settle(page);
  await page.keyboard.type(text);
}

test("the first account is the admin; a reader reads until made an editor, then writes live", async ({ browser }, testInfo) => {
  const admin = await account(browser, "Ada", "ada@example.test");
  await expect(admin.locator(".role")).toHaveText("admin");
  // A new reader on every attempt and repetition: one must not find them promoted already.
  const attempt = `${testInfo.repeatEachIndex}${testInfo.retry}`;
  const lin = `Lin${attempt}`;
  const reader = await account(browser, lin, `lin-${attempt}@example.test`);
  await expect(reader.locator(".role")).toHaveText("reader");
  await expect(reader.getByText("You can read this page.")).toBeVisible();
  await expect(editor(reader)).toHaveAttribute("contenteditable", "false");

  await typeAtEnd(admin, " Ada wrote this.");
  await expect(editor(reader)).toContainText("Ada wrote this.");

  await admin.getByRole("button", { name: "People" }).click();
  await admin.getByLabel(`Role of ${lin}`).selectOption("editor");
  await expect(reader.locator(".role")).toHaveText("editor");
  await expect(editor(reader)).toHaveAttribute("contenteditable", "true");

  await typeAtEnd(reader, ` ${lin} too.`);
  await expect(editor(admin)).toContainText(`${lin} too.`);
  await expect(editor(admin).locator(".ProseMirror-yjs-cursor")).toContainText(lin);
  // What the server stored, read back: the text, and who changed it last.
  await expect(admin.locator(".stored .prose")).toContainText(`${lin} too.`);
  await expect(admin.locator(".stored dd").first()).toHaveText(lin);
});

test("[[ links a page, the link opens it, and the new page knows who links to it", async ({ browser }, testInfo) => {
  const page = await account(browser, "Ada", "ada@example.test");
  // A page no earlier attempt made, so the list offers to create it.
  const name = `docs/install-${testInfo.repeatEachIndex}${testInfo.retry}`;
  await typeAtEnd(page, ` See [[${name}`);
  await expect(page.getByRole("option", { name: `create ${name}` })).toBeVisible();
  await page.keyboard.press("Enter");
  const link = editor(page).locator("a.page-link", { hasText: name });
  await expect(link).toBeVisible();

  await link.click();
  await expect(page).toHaveURL(new RegExp(`#${encodeURIComponent(name)}$`));
  await expect(editor(page).locator("h1")).toHaveText(name);
  await expect(page.locator(".backlinks")).toContainText("welcome");
  await expect(page.getByRole("navigation", { name: "Pages" })).toContainText(name.split("/")[1] as string);
});
