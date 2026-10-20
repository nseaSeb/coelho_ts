import { renderDom, validateAttr, type Schema as CoelhoSchema } from "@nseaprotector/coelho-core";
import type { Node } from "prosemirror-model";
import type { EditorView, NodeView, NodeViewConstructor } from "prosemirror-view";
import { memo, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface NodeViewProps {
  node: Node;
  /** Whether ProseMirror has the node selected, as a whole. */
  selected: boolean;
  view: EditorView;
  /** The node's current position, for a component that changes it. */
  getPos: () => number | undefined;
  /**
   * Changes some of the node's attributes, as one step of the document's
   * history. Each value is held to the schema's validator for it, and an
   * unknown name or a refused value throws: the editor must never hold a
   * document the schema would refuse to load.
   */
  updateAttributes: (attrs: Record<string, unknown>) => void;
}

export type NodeViewComponents = Record<string, ComponentType<NodeViewProps>>;

interface Entry extends NodeViewProps {
  key: string;
  /** Where the component renders: the node's element for a leaf, the chrome beside the content otherwise. */
  target: HTMLElement;
  Component: ComponentType<NodeViewProps>;
}

/** What a click, a key or a drag on these, inside the chrome, belongs to the component, not to ProseMirror. */
const INTERACTIVE = "input, select, textarea, button, a[href], [contenteditable=true], [data-node-view-events]";

/** Attributes coelho's own import reads off an element; a node's attributes never overwrite them. */
const RESERVED = new Set(["data-coelho", "data-coelho-attrs", "data-text"]);

/**
 * The React side of node views. ProseMirror creates, moves and destroys
 * the DOM element of each node; React only renders a component into it,
 * through a portal, from this store. A node with content keeps it
 * editable: the component draws around it, in its own element.
 */
export class NodeViewStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snapshot: Entry[] = [];
  private next = 0;

  /** `schema` is read when it is needed: the editor's schema may be another object by then. */
  constructor(private readonly schema: () => CoelhoSchema) {}

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
    const base = `coelho-node-view coelho-node-view-${node.type.name}`;
    const key = `nv${(this.next += 1)}`;

    const updateAttributes = (attrs: Record<string, unknown>): void => {
      const pos = getPos();
      // The node as the document holds it now, not as this view last saw it.
      const current = pos === undefined ? null : view.state.doc.nodeAt(pos);
      if (pos === undefined || current === null || current.type !== node.type) return;
      const spec = this.schema().nodes.get(node.type.name);
      for (const [name, value] of Object.entries(attrs)) {
        const attr = spec?.attrs[name];
        if (attr === undefined) throw new Error(`coelho: ${node.type.name} has no attribute ${JSON.stringify(name)}`);
        const refused = validateAttr(attr.validate, value);
        if (refused !== null) throw new Error(`coelho: ${node.type.name}.${name} ${refused}`);
      }
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
    const inContent = (at: unknown): boolean => contentDOM !== undefined && at instanceof globalThis.Node && contentDOM.contains(at);
    const interactive = (at: unknown): boolean => at instanceof Element && at.closest(INTERACTIVE) !== null && target.contains(at);

    this.dress(dom, base, node);
    this.set(key, { key, target, node, selected: false, view, getPos, updateAttributes, Component });
    return {
      dom,
      ...(contentDOM === undefined ? {} : { contentDOM }),
      update: (next) => {
        const entry = this.entries.get(key);
        if (entry === undefined || next.type !== entry.node.type) return false;
        if (next === entry.node) return true;
        // Typing inside the content changes the node, not what the
        // component draws from it: its attributes and marks. Only those
        // render it again.
        if (contentDOM !== undefined && next.sameMarkup(entry.node)) {
          this.entries.set(key, { ...entry, node: next });
          return true;
        }
        this.dress(dom, base, next);
        this.set(key, { ...entry, node: next });
        return true;
      },
      selectNode: () => this.patch(key, { selected: true }),
      deselectNode: () => this.patch(key, { selected: false }),
      // What the component draws is not content: ProseMirror reads back only
      // what changes inside the content, and selections there.
      ignoreMutation: (mutation) => !inContent(mutation.target),
      // A select or a button in the chrome keeps its events; a click on an
      // icon, or beside the content, is ProseMirror's, to place the caret or
      // select the node.
      stopEvent: (event) => interactive(event.target),
      destroy: () => {
        this.entries.delete(key);
        this.emit();
      },
    };
  }

  /**
   * The element as the page would dress it, its class from the schema's
   * render, so one stylesheet serves both; and its plain attributes as
   * `data-*`, for what a class does not say.
   */
  private dress(dom: HTMLElement, base: string, node: Node): void {
    const spec = this.schema().nodes.get(node.type.name);
    const rendered = spec === undefined ? null : renderDom({ type: node.type.name, attrs: node.attrs }, spec);
    const classes = rendered?.[1].find(([name]) => name === "class")?.[1];
    dom.className = typeof classes === "string" && classes !== "" ? `${base} ${classes}` : base;
    for (const [name, value] of Object.entries(node.attrs)) {
      const attribute = `data-${name.replace(/[A-Z_]/g, (char) => (char === "_" ? "-" : `-${char.toLowerCase()}`)).replace(/^-/, "")}`;
      if (RESERVED.has(attribute)) continue;
      if (value === null || value === undefined || value === false || typeof value === "object") dom.removeAttribute(attribute);
      else dom.setAttribute(attribute, value === true ? "" : String(value));
    }
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

/** One node view's component, rendered again only when its own entry changed. */
const Rendered = memo(function Rendered({ entry }: { entry: Entry }): ReactNode {
  const { Component, node, selected, view, getPos, updateAttributes } = entry;
  return <Component node={node} selected={selected} view={view} getPos={getPos} updateAttributes={updateAttributes} />;
});

/** The portals to render anywhere inside the React tree that owns the editor. */
export function renderPortals(entries: Entry[]): ReactNode {
  return entries.map((entry) => createPortal(<Rendered entry={entry} />, entry.target, entry.key));
}
