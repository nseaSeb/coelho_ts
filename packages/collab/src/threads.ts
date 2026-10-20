import { sanitize, type Anchor, type Comment, type Schema, type Thread } from "@coelho/core";
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

export interface SharedThreadsOptions {
  /** The schema a comment's body is written under: read back through `sanitize`, since any peer can write any body. */
  bodies?: Schema;
  /** The name of the shared map. */
  name?: string;
}

/**
 * Comment threads shared through the same Yjs document as the text, in a
 * map beside it: the document, its canonical bytes and its hash are what
 * they would be without them. Each thread is a map of its own, and its
 * comments an array, so two replies posted at once are both kept.
 *
 * Like the text, the map is not a trust boundary: any peer can write
 * anything into it. Every read checks what it finds, an entry that is not
 * a thread is skipped, a comment that is not one is dropped, and a body is
 * repaired under `bodies` before it reaches a renderer.
 */
export function sharedThreads(doc: Y.Doc, author: string, options: SharedThreadsOptions = {}): SharedThreads {
  const threads = doc.getMap<unknown>(options.name ?? THREADS);
  const thread = (id: string): Y.Map<unknown> | undefined => {
    const entry = threads.get(id);
    return entry instanceof Y.Map ? entry : undefined;
  };
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const visible = (entry: Y.Map<unknown>): boolean => entry.get("draft") === undefined || entry.get("draft") === author;

  const comment = (value: unknown): Comment | null => {
    if (typeof value !== "object" || value === null) return null;
    const { id, author: by, createdAt, body } = value as Record<string, unknown>;
    if (typeof id !== "string" || typeof by !== "string") return null;
    return {
      id,
      author: by,
      createdAt: typeof createdAt === "string" ? createdAt : "",
      body: options.bodies === undefined ? (body as Comment["body"]) : sanitize(body, options.bodies),
    };
  };

  const read = (id: string, entry: Y.Map<unknown>): SharedThread => {
    const comments = entry.get("comments");
    return {
      id,
      anchor: { from: 0, to: 0, quote: text(entry.get("quote")), prefix: text(entry.get("prefix")), suffix: text(entry.get("suffix")) },
      resolved: entry.get("resolved") === true,
      comments: comments instanceof Y.Array ? comments.toArray().flatMap((value) => comment(value) ?? []) : [],
      draft: entry.get("draft") !== undefined,
    };
  };

  const list = (): SharedThread[] => {
    const out: Array<[number, SharedThread]> = [];
    for (const [id, entry] of threads.entries()) {
      if (entry instanceof Y.Map && visible(entry)) out.push([Number(entry.get("opened")) || 0, read(id, entry)]);
    }
    return out.sort(([a], [b]) => a - b).map(([, shared]) => shared);
  };

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
    reply: (id, posted) =>
      doc.transact(() => {
        const entry = thread(id);
        if (entry === undefined) return;
        let comments = entry.get("comments");
        if (!(comments instanceof Y.Array)) {
          comments = new Y.Array<Comment>();
          entry.set("comments", comments);
        }
        (comments as Y.Array<Comment>).push([posted]);
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
