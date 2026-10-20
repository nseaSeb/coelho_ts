// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { App } from "../src/App.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const empty = (): DOMRectList => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  for (const proto of [Element.prototype, Text.prototype, Range.prototype] as unknown as Array<Record<string, unknown>>) {
    proto.getClientRects = empty;
    proto.getBoundingClientRect = rect;
  }
  Element.prototype.scrollIntoView = () => {};
  document.elementFromPoint = () => null;
});

let root: Root | null = null;
afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  // Let y-prosemirror's deferred updates fire against the unmounted views.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<StrictMode><App /></StrictMode>));
  return container;
}

const panes = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll(".collab .pane .ProseMirror")] as HTMLElement[];
const button = (container: HTMLElement, label: RegExp): HTMLButtonElement => [...container.querySelectorAll(".collab button")].find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement;

// What a browser produces when a writer types: a DOM mutation ProseMirror reads back.
async function retype(pane: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    (pane.querySelector("p") as HTMLElement).textContent = text;
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("two writers in the demo", () => {
  test("both panes show the seeded document once, under StrictMode", async () => {
    const container = mount();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const [camille, sacha] = panes(container);
    expect(camille?.querySelectorAll("h3")).toHaveLength(1);
    expect(sacha?.textContent).toBe(camille?.textContent);
    expect(container.querySelector(".stored .ok")?.textContent).toMatch(/same document/);
  });

  test("what one writes reaches the other, and offline they diverge until they are back", async () => {
    const container = mount();
    const [camille, sacha] = panes(container) as [HTMLElement, HTMLElement];
    await retype(camille, "Camille was here.");
    expect(sacha.querySelector("p")?.textContent).toBe("Camille was here.");

    act(() => button(container, /Go offline/).click());
    await retype(sacha, "Sacha, offline.");
    expect(camille.querySelector("p")?.textContent).toBe("Camille was here.");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(container.querySelector(".stored .differ")).not.toBeNull();

    act(() => button(container, /Come back online/).click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(camille.querySelector("p")?.textContent).toBe(sacha.querySelector("p")?.textContent);
    expect(container.querySelector(".stored .ok")).not.toBeNull();
  });

  test("a link a peer writes past the editor is in the panes, and never in what is stored", async () => {
    const container = mount();
    await act(async () => {
      button(container, /javascript: link/).click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // The mark is in the shared document and in both editors, drawn without
    // its href: the editor renders links through safeUrl too.
    for (const pane of panes(container)) {
      const link = pane.querySelector("a");
      expect(link).not.toBeNull();
      expect(link?.hasAttribute("href")).toBe(false);
    }
    const errors = [...container.querySelectorAll(".stored .errors")].map((pre) => pre.textContent);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('scheme "javascript" is not allowed');
    expect(container.querySelector('.stored a[href^="javascript:"]')).toBeNull();
  });
});
