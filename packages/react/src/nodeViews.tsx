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
}

export type NodeViewComponents = Record<string, ComponentType<NodeViewProps>>;

interface Entry extends NodeViewProps {
  key: string;
  dom: HTMLElement;
  Component: ComponentType<NodeViewProps>;
}

/**
 * The React side of node views. ProseMirror creates, moves and destroys
 * the DOM element of each node; React only renders a component into it,
 * through a portal, from this store. The store is external so a node view
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
    if (!node.isLeaf) throw new Error(`coelho: a React node view draws a leaf node, and ${node.type.name} has content`);
    const dom = document.createElement(node.isInline ? "span" : "div");
    dom.className = `coelho-node-view coelho-node-view-${node.type.name}`;
    dom.contentEditable = "false";
    const key = `nv${(this.next += 1)}`;
    this.set(key, { key, dom, node, selected: false, view, getPos, Component });
    return {
      dom,
      update: (next) => {
        const entry = this.entries.get(key);
        if (entry === undefined || next.type !== entry.node.type) return false;
        if (next !== entry.node) this.set(key, { ...entry, node: next });
        return true;
      },
      selectNode: () => this.patch(key, { selected: true }),
      deselectNode: () => this.patch(key, { selected: false }),
      // The component draws; ProseMirror must not read its DOM back as content.
      ignoreMutation: () => true,
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

/** The portals to render anywhere inside the React tree that owns the editor. */
export function renderPortals(entries: Entry[]): ReactNode {
  return entries.map(({ key, dom, Component, node, selected, view, getPos }) =>
    createPortal(<Component node={node} selected={selected} view={view} getPos={getPos} />, dom, key),
  );
}
