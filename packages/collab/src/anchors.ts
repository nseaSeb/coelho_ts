import type { AnchorSource } from "@coelho/prosemirror";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";

/** A thread's range as Yjs relative positions, in their JSON form, as they are stored beside the thread. */
export interface RelativeRange {
  from: unknown;
  /** The position after the range. When the range's text is deleted, it meets `from`. */
  to: unknown;
  /** The range's last character: text typed right after a thread does not join it. */
  last: unknown;
}

export interface RangeStore {
  get(id: string): RelativeRange | undefined;
  set(id: string, range: RelativeRange): void;
}

interface Binding {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Map<unknown, unknown>;
}

function bindingOf(state: Parameters<AnchorSource["locate"]>[0]): Binding | undefined {
  return (ySyncPluginKey.getState(state) as { binding?: Binding } | undefined)?.binding;
}

/**
 * Comment threads that survive other writers. A Yjs relative position
 * points at an item of the shared document rather than at an offset, so
 * text typed before a thread, or inside it, by anyone, leaves it on its
 * words; and y-prosemirror replacing the whole document on every remote
 * change does not lose it. Give it to `commentsPlugin({ source })`, placed
 * after the collaboration plugins.
 */
export function relativeAnchors(store: RangeStore = inMemory()): AnchorSource {
  return {
    isForeign: (tr) => (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true,
    track: (state, id, from, to) => {
      const binding = bindingOf(state);
      if (binding === undefined || to <= from) return;
      const relative = (pos: number): unknown => Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, binding.type, binding.mapping as never));
      store.set(id, { from: relative(from), to: relative(to), last: relative(to - 1) });
    },
    locate: (state, id) => {
      const binding = bindingOf(state);
      const range = store.get(id);
      if (binding === undefined || range === undefined) return undefined;
      const absolute = (json: unknown): number | null =>
        relativePositionToAbsolutePosition(binding.doc, binding.type, Y.createRelativePositionFromJSON(json), binding.mapping as never);
      const from = absolute(range.from);
      const end = absolute(range.to);
      const last = absolute(range.last);
      if (from === null || end === null || end <= from) return null;
      // A relative position whose item was deleted moves to the next one:
      // the range ends at its last character, or at its end if that went.
      return { from, to: last === null ? end : Math.min(last + 1, end) };
    },
  };
}

function inMemory(): RangeStore {
  const ranges = new Map<string, RelativeRange>();
  return { get: (id) => ranges.get(id), set: (id, range) => void ranges.set(id, range) };
}

