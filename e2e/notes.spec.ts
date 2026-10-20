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

/** Selects the first occurrence of `text` in the editor, as a drag over it would. */
async function selectText(page: Page, text: string): Promise<void> {
  await editor(page).evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at === -1) continue;
      (root as HTMLElement).focus();
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      return;
    }
    throw new Error(`no ${wanted}`);
  }, text);
  await settle(page);
}

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
  // Linked to and not written yet: in the tree already, marked, until it is opened.
  const inTree = page.getByRole("navigation", { name: "Pages" }).locator(`a[href="#${encodeURIComponent(name)}"]`);
  await expect(inTree).toHaveClass("missing", { timeout: 10_000 });

  await link.click();
  await expect(page).toHaveURL(new RegExp(`#${encodeURIComponent(name)}$`));
  await expect(editor(page).locator("h1")).toHaveText(name);
  await expect(page.locator(".backlinks")).toContainText("welcome");
  await expect(page.getByRole("navigation", { name: "Pages" })).toContainText(name.split("/")[1] as string);
  await expect(inTree).not.toHaveClass("missing", { timeout: 10_000 });
});

test("a page's history: what a version changed, and bringing it back for everyone", async ({ browser }, testInfo) => {
  const page = await account(browser, "Ada", "ada@example.test");
  const name = `history-${testInfo.repeatEachIndex}${testInfo.retry}`;
  await page.goto(`/#${name}`);
  await expect(editor(page).locator("h1")).toHaveText(name);
  await typeAtEnd(page, " A temporary line.");

  await page.getByRole("tab", { name: "History" }).click();
  const versions = page.getByRole("list", { name: "Versions" }).getByRole("button");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("Ada");

  // What Ada's version changed: her words, added to the seeded line.
  await versions.first().click();
  await expect(page.locator(".diff ins")).toHaveText(" A temporary line.");

  // The seeded version, compared with the page now, then brought back.
  await versions.last().click();
  await page.getByLabel("since then").check();
  await expect(page.locator(".diff ins")).toHaveText(" A temporary line.");
  await page.getByRole("button", { name: /^Restore version/ }).click();
  await expect(editor(page)).not.toContainText("A temporary line.");
  await expect(versions).toHaveCount(3);
  await expect(versions.first()).toContainText("restored from #");
});

test("comments: written through the server under each account, seen live by a reader who can answer", async ({ browser }, testInfo) => {
  const attempt = `${testInfo.repeatEachIndex}${testInfo.retry}`;
  const ada = await account(browser, "Ada", "ada@example.test");
  const name = `talk-${attempt}`;
  await ada.goto(`/#${name}`);
  await expect(editor(ada).locator("h1")).toHaveText(name);
  const lin = await account(browser, `Reader${attempt}`, `reader-${attempt}@example.test`);
  await lin.goto(`/#${name}`);
  await expect(editor(lin).locator("h1")).toHaveText(name);

  // Ada comments on a word.
  await selectText(ada, "Everyone");
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  await ada.getByLabel("Comment", { exact: true }).fill("Who is everyone?");
  await ada.getByRole("button", { name: "Comment", exact: true }).last().click();

  // The reader sees the word highlighted and the comment, under Ada's name.
  await expect(editor(lin).locator(".coelho-comment")).toHaveText("Everyone");
  await lin.getByRole("tab", { name: "Comments" }).click();
  const thread = lin.locator(".comments .thread").first();
  await expect(thread.locator(".comment")).toHaveCount(1);
  await expect(thread.locator(".comment strong")).toHaveText("Ada");
  await expect(thread.locator(".comment .body")).toHaveText("Who is everyone?");

  // A reader may answer, not manage the thread.
  await thread.click();
  await lin.getByLabel("Reply").fill("All of us.");
  await lin.getByRole("button", { name: "Reply" }).click();
  await expect(thread.locator(".comment")).toHaveCount(2);
  await expect(lin.getByRole("button", { name: "Resolve" })).toHaveCount(0);

  // Ada sees the answer, and resolves the thread for everyone.
  await ada.getByRole("tab", { name: "Comments" }).click();
  const hers = ada.locator(".comments .thread").first();
  await expect(hers.locator(".comment strong")).toHaveText(["Ada", `Reader${attempt}`]);
  await hers.click();
  await ada.getByRole("button", { name: "Resolve" }).click();
  await expect(lin.locator(".resolved-threads summary")).toHaveText("Resolved (1)");
});


test("a reader cannot open a page nobody wrote, and reads it once an editor has", async ({ browser }, testInfo) => {
  const attempt = `${testInfo.repeatEachIndex}${testInfo.retry}`;
  const admin = await account(browser, "Ada", "ada@example.test");
  const reader = await account(browser, `Sam${attempt}`, `sam-${attempt}@example.test`);
  const name = `drafts/plan-${attempt}`;
  await reader.goto(`/#${encodeURIComponent(name)}`);
  await expect(reader.getByText(`“${name}” is not written yet.`)).toBeVisible();
  await expect(reader.locator(".status")).toHaveCount(0);

  await admin.goto(`/#${encodeURIComponent(name)}`);
  await expect(editor(admin).locator("h1")).toHaveText(name);
  // The list of pages has it now: the reader's tab opens it, without a reload.
  await expect(editor(reader).locator("h1")).toHaveText(name, { timeout: 10_000 });
  await expect(reader.getByText("is not written yet")).toHaveCount(0);
});
