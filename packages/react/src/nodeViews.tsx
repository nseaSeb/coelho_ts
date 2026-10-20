import type { Node } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { createPortal } from "react-dom";
import type { ComponentType, ReactNode } from "react";

export interface NodeViewProps {
  node: Node;
  /** Whether ProseMirror has the node selected, as a whole. */
  selected: boolean;
  view: EditorView;
  /** The node's current position, for a component that changes it. */
  getPos: () => number | undefined;
  /** Changes some of the node's attributes, as one step of the document's history. */
  updateAttributes: (attrs: Record<string, unknown>) => void;
}

export type NodeViewComponents = Record<string, ComponentType<NodeViewProps>>;

interface Entry extends NodeViewProps {
  key: string;
  /** Where the component renders: the node's element for a leaf, the chrome beside the content otherwise. */
  target: HTMLElement;
  Component: ComponentType<NodeViewProps>;
}

/**
 * The React side of node views. ProseMirror creates, moves and destroys
 * the DOM element of each node; React only renders a component into it,
 * through a portal, from this store. A node with content keeps it
 * editable: the component draws around it, in its own element. The store is external so a node view
 * created while the editor builds itself — inside React's commit — only
 * schedules a render rather than needing one.
 */
export class NodeViewStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snapshot: Entry[] = [];
  private next = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Entry[] => this.snapshot;

  /** ProseMirror node view constructors, one per component, for `EditorView`'s `nodeViews`. */
  constructors(components: NodeViewComponents): Record<string, NodeViewConstructor> {
    const out: Record<string, NodeViewConstructor> = {};
    for (const [name, Component] of Object.entries(components)) {
      out[name] = (node, view, getPos) => this.create(node, view, getPos, Component);
    }
    return out;
  }

  private create(node: Node, view: EditorView, getPos: () => number | undefined, Component: ComponentType<NodeViewProps>): NodeView {
    const inline = node.isInline;
    const dom = document.createElement(inline ? "span" : "div");
    dom.className = `coelho-node-view coelho-node-view-${node.type.name}`;
    const key = `nv${(this.next += 1)}`;
    const updateAttributes = (attrs: Record<string, unknown>): void => {
      const pos = getPos();
      const current = this.entries.get(key)?.node;
      if (pos === undefined || current === undefined) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }));
    };

    // A leaf is all the component's. A node with content is split in two:
    // the chrome, where the component renders, and the content, which is
    // ProseMirror's alone and is in the DOM from the start, so the caret
    // can go there before React has rendered anything. React never renders
    // into the content, and ProseMirror never reads the chrome.
    let contentDOM: HTMLElement | undefined;
    let target = dom;
    if (node.isLeaf) {
      dom.setAttribute("contenteditable", "false");
    } else {
      target = document.createElement(inline ? "span" : "div");
      target.className = "coelho-node-view-chrome";
      target.setAttribute("contenteditable", "false");
      contentDOM = document.createElement(inline ? "span" : "div");
      contentDOM.className = "coelho-node-view-content";
      dom.append(target, contentDOM);
    }
    const inContent = (target: unknown): boolean => contentDOM !== undefined && target instanceof globalThis.Node && contentDOM.contains(target);

    syncAttributes(dom, node);
    this.set(key, { key, target, node, selected: false, view, getPos, updateAttributes, Component });
    return {
      dom,
      ...(contentDOM === undefined ? {} : { contentDOM }),
      update: (next) => {
        const entry = this.entries.get(key);
        if (entry === undefined || next.type !== entry.node.type) return false;
        if (next !== entry.node) {
          syncAttributes(dom, next);
          this.set(key, { ...entry, node: next });
        }
        return true;
      },
      selectNode: () => this.patch(key, { selected: true }),
      deselectNode: () => this.patch(key, { selected: false }),
      // What the component draws is not content: ProseMirror reads back only
      // what changes inside the content, and selections there.
      ignoreMutation: (mutation) => !inContent(mutation.target),
      // Events in the chrome (a select, a button) are the component's.
      stopEvent: (event) => contentDOM !== undefined && !inContent(event.target),
      destroy: () => {
        this.entries.delete(key);
        this.emit();
      },
    };
  }

  private patch(key: string, change: Partial<Entry>): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) this.set(key, { ...entry, ...change });
  }

  private set(key: string, entry: Entry): void {
    this.entries.set(key, entry);
    this.emit();
  }

  private emit(): void {
    this.snapshot = [...this.entries.values()];
    for (const listener of this.listeners) listener();
  }
}

/**
 * A node's plain attributes as `data-*` attributes of its element, so a
 * stylesheet can follow them, around the content too, which the component
 * cannot reach: `[data-kind="warning"] .coelho-node-view-content`.
 */
function syncAttributes(dom: HTMLElement, node: Node): void {
  for (const [name, value] of Object.entries(node.attrs)) {
    const attribute = `data-${name.replace(/[A-Z_]/g, (char) => `-${char.toLowerCase()}`).replace(/^-/, "")}`;
    if (value === null || value === undefined || typeof value === "object") dom.removeAttribute(attribute);
    else dom.setAttribute(attribute, String(value));
  }
}

/** The portals to render anywhere inside the React tree that owns the editor. */
export function renderPortals(entries: Entry[]): ReactNode {
  return entries.map(({ key, target, Component, node, selected, view, getPos, updateAttributes }) =>
    createPortal(<Component node={node} selected={selected} view={view} getPos={getPos} updateAttributes={updateAttributes} />, target, key),
  );
}
