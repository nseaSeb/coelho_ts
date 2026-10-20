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
});
