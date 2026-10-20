import type { Anchor, Comment, Thread } from "@coelho/core";
import type { AnchorSource } from "@coelho/prosemirror";
import * as Y from "yjs";
import { relativeAnchors, type RelativeRange } from "./anchors.js";

/** The name of the shared map holding comment threads, beside the document. */
export const THREADS = "coelho-threads";

export interface SharedThread extends Thread {
  /** Opened and not yet commented on: shown to its author alone. */
  draft: boolean;
}

export interface SharedThreads {
  /** For `commentsPlugin({ source })`: threads located by their relative ranges, listed from the shared map. */
  source: AnchorSource;
  /** Every thread this writer can see, in the order they were opened. */
  list(): SharedThread[];
  /** Opens a thread as a draft, before its range is recorded by `addComment`. */
  open(id: string, anchor: Anchor): void;
  /** Adds a comment; the first one publishes the draft. */
  reply(id: string, comment: Comment): void;
  resolve(id: string, resolved: boolean): void;
  remove(id: string): void;
  /** Calls `listener` after any change to the threads, from anyone. */
  subscribe(listener: () => void): () => void;
}

/**
 * Comment threads shared through the same Yjs document as the text, in a
 * map beside it: the document, its canonical bytes and its hash are what
 * they would be without them. Each thread is a map of its own, and its
 * comments an array, so two replies posted at once are both kept.
 */
export function sharedThreads(doc: Y.Doc, author: string, name = THREADS): SharedThreads {
  const threads = doc.getMap<Y.Map<unknown>>(name);
  const thread = (id: string): Y.Map<unknown> | undefined => threads.get(id);
  const visible = (entry: Y.Map<unknown>): boolean => entry.get("draft") === undefined || entry.get("draft") === author;

  const read = (id: string, entry: Y.Map<unknown>): SharedThread => ({
    id,
    anchor: { from: 0, to: 0, quote: String(entry.get("quote") ?? ""), prefix: String(entry.get("prefix") ?? ""), suffix: String(entry.get("suffix") ?? "") },
    resolved: entry.get("resolved") === true,
    comments: ((entry.get("comments") as Y.Array<Comment> | undefined)?.toArray() ?? []).map((comment) => ({ ...comment })),
    draft: entry.get("draft") !== undefined,
  });

  const list = (): SharedThread[] =>
    [...threads.entries()]
      .filter(([, entry]) => visible(entry))
      .sort(([, a], [, b]) => Number(a.get("opened") ?? 0) - Number(b.get("opened") ?? 0))
      .map(([id, entry]) => read(id, entry));

  const anchors = relativeAnchors({
    get: (id) => thread(id)?.get("range") as RelativeRange | undefined,
    set: (id, range) => thread(id)?.set("range", range),
  });

  return {
    source: { ...anchors, threads: () => list().map(({ id, anchor, resolved }) => ({ id, anchor, resolved })) },
    list,
    open: (id, anchor) =>
      doc.transact(() => {
        const entry = new Y.Map<unknown>();
        threads.set(id, entry);
        entry.set("quote", anchor.quote);
        entry.set("prefix", anchor.prefix ?? "");
        entry.set("suffix", anchor.suffix ?? "");
        entry.set("resolved", false);
        entry.set("draft", author);
        entry.set("opened", Date.now());
        entry.set("comments", new Y.Array<Comment>());
      }),
    reply: (id, comment) =>
      doc.transact(() => {
        const entry = thread(id);
        if (entry === undefined) return;
        (entry.get("comments") as Y.Array<Comment>).push([comment]);
        entry.delete("draft");
      }),
    resolve: (id, resolved) => thread(id)?.set("resolved", resolved),
    remove: (id) => threads.delete(id),
    subscribe: (listener) => {
      const observe = (): void => listener();
      threads.observeDeep(observe);
      return () => threads.unobserveDeep(observe);
    },
  };
}
