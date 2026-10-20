// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { App } from "../src/App.js";

// The editor needs a few layout calls jsdom does not implement; their
// answers do not matter here, only that they exist.
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  const empty = (): DOMRectList => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  // ProseMirror measures text nodes as well as elements when it scrolls the selection into view.
  for (const proto of [Element.prototype, Text.prototype] as unknown as Array<Record<string, unknown>>) {
    proto.getClientRects = empty;
    proto.getBoundingClientRect = rect;
  }
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => {};
  document.elementFromPoint = () => null;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<App />));
  return container;
}

function threadsColumn(container: HTMLElement): unknown[] {
  const panel = [...container.querySelectorAll(".panel")].find((p) => p.textContent?.startsWith("What the threads table holds"));
  return JSON.parse(panel?.querySelector("pre")?.textContent ?? "[]") as unknown[];
}

// A highlight crossing a mark boundary is drawn as one span per text run.
function highlighted(container: HTMLElement, id: string): string {
  return [...container.querySelectorAll(`.coelho-comment[data-thread="${id}"]`)].map((span) => span.textContent).join("");
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

describe("the demo", () => {
  test("draws the starting thread over its quote, outside the stored document", () => {
    const container = mount();
    expect(highlighted(container, "t_welcome")).toBe("stored as JSON");
    expect(threadsColumn(container)).toMatchObject([{ id: "t_welcome", anchor: { quote: "stored as JSON" } }]);
    const column = [...container.querySelectorAll(".panel")].find((p) => p.textContent?.startsWith("What the column holds"));
    expect(column?.textContent).not.toContain("t_welcome");
  });

  test("keeps the thread on its text when another writer changes the document", () => {
    const container = mount();
    const before = threadsColumn(container) as Array<{ anchor: { from: number } }>;
    act(() => button(container, "Another writer adds a paragraph at the top").click());
    const after = threadsColumn(container) as Array<{ anchor: { from: number; quote: string } }>;
    expect(after[0]?.anchor.quote).toBe("stored as JSON");
    expect(after[0]?.anchor.from).toBeGreaterThan(before[0]?.anchor.from ?? Infinity);
    expect(highlighted(container, "t_welcome")).toBe("stored as JSON");
  });

  test("activates a thread from its card and resolves it", () => {
    const container = mount();
    act(() => (container.querySelector(".thread") as HTMLElement).click());
    expect(container.querySelector(".thread.active")).not.toBeNull();
    expect(container.querySelector(".coelho-comment-active")).not.toBeNull();
    act(() => button(container, "Resolve").click());
    expect(container.querySelector(".coelho-comment-resolved")).not.toBeNull();
    expect(threadsColumn(container)).toMatchObject([{ resolved: true }]);
  });

  // ProseMirror reads the DOM selection on `selectionchange`, and typed text
  // from DOM mutations: both are what a browser produces, and jsdom has both.
  async function select(container: HTMLElement, text: string, occurrence = 0): Promise<void> {
    const editable = container.querySelector(".workspace .ProseMirror") as HTMLElement;
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(text) ?? -1;
      if (index === -1) continue;
      if (seen++ < occurrence) continue;
      editable.focus();
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const selection = document.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      return;
    }
    throw new Error(`no text ${text}`);
  }

  function submit(container: HTMLElement): void {
    const primary = container.querySelector(".thread.active .composer-actions .primary") as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    primary.click();
  }

  async function type(editable: HTMLElement, text: string): Promise<void> {
    await act(async () => {
      const paragraph = editable.querySelector("p") as HTMLElement;
      paragraph.textContent = text;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  test("comments on a selection, from the button to the stored thread", async () => {
    const container = mount();
    await select(container, "No HTML");
    await act(async () => button(container, "Comment").click());
    const composer = container.querySelector(".thread.active .comment-editor .ProseMirror") as HTMLElement;
    expect(composer).not.toBeNull();
    await type(composer, "Not even a sanitised one?");
    await act(async () => submit(container));
    const thread = (threadsColumn(container) as Array<{ anchor: { quote: string }; comments: Array<{ body: unknown }> }>).find((t) => t.anchor.quote === "No HTML");
    expect(thread?.comments).toHaveLength(1);
    expect(JSON.stringify(thread?.comments[0]?.body)).toContain("Not even a sanitised one?");
    expect(highlighted(container, (thread as unknown as { id: string }).id)).toBe("No HTML");
  });

  test("drops a thread left without a first comment", async () => {
    const container = mount();
    await select(container, "No HTML");
    await act(async () => button(container, "Comment").click());
    expect(threadsColumn(container)).toHaveLength(2);
    await act(async () => button(container, "Cancel").click());
    expect(threadsColumn(container)).toHaveLength(1);
    expect(container.querySelectorAll(".coelho-comment[data-thread]").length).toBeGreaterThan(0);
    expect([...container.querySelectorAll(".coelho-comment")].every((span) => span.getAttribute("data-thread") === "t_welcome")).toBe(true);
  });

  test("keeps a one-word thread on its own occurrence when another writer inserts the same word above", async () => {
    const container = mount();
    // "the" in the heading; the paragraph the other writer adds also says "the".
    await select(container, "the");
    await act(async () => button(container, "Comment").click());
    const composer = container.querySelector(".thread.active .comment-editor .ProseMirror") as HTMLElement;
    await type(composer, "Which one?");
    await act(async () => submit(container));
    const id = (threadsColumn(container) as Array<{ id: string; anchor: { quote: string } }>).find((t) => t.anchor.quote === "the")?.id as string;
    const heading = (): Element | null => container.querySelector(`.workspace h2 .coelho-comment[data-thread="${id}"]`);
    expect(heading()).not.toBeNull();
    act(() => button(container, "Another writer adds a paragraph at the top").click());
    expect(heading()).not.toBeNull();
  });
});
