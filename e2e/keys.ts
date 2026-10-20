/**
 * The key that moves the caret to the end of the line. On macOS, End
 * scrolls the page to its bottom and leaves the caret where it is; the
 * line's end is Cmd+Right there.
 */
export const LINE_END = process.platform === "darwin" ? "Meta+ArrowRight" : "End";

/**
 * Paste as plain text. Chrome binds it to Ctrl+Shift+V on Linux and
 * Windows; headless Chromium on macOS binds no shortcut to it at all.
 */
export const PASTE_PLAIN = process.platform === "darwin" ? null : "Control+Shift+V";

/**
 * Lets the browser tell the editor where the caret went. Chrome reports a
 * caret moved by a key or a click with a selectionchange event, a moment
 * later; ProseMirror reads it then. Playwright types the next key at once,
 * faster than anyone could, so a paste right after would land where the
 * caret was before.
 */
export async function settle(page: { evaluate: (fn: () => Promise<void>) => Promise<void> }): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}
