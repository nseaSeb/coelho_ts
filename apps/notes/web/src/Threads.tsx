import { relativeAnchors, sharedThreads, THREADS, type RelativeRange, type SharedThread, type SharedThreads } from "@nseaprotector/coelho-collab";
import { toHtml, type Anchor, type Node } from "@nseaprotector/coelho-core";
import { addComment, commentsState, relocateComments, removeComment, selectComment, setActiveComment, type AnchorSource } from "@nseaprotector/coelho-prosemirror";
import { HocuspocusProvider, type HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { EditorView } from "prosemirror-view";
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import * as Y from "yjs";
import { commentSchema, threadsRoomOf } from "../../server/schema.js";
import { api, ApiError, type Me } from "./api.js";

const path = (name: string): string => `/api/pages/${encodeURIComponent(name)}/threads`;

/** Typed text as a comment: paragraphs on blank lines, line breaks within them. */
export function bodyOf(text: string): Node {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      type: "paragraph",
      content: paragraph.split("\n").flatMap((line, at): Node[] => [...(at > 0 ? [{ type: "hard_break" }] : []), ...(line === "" ? [] : [{ type: "text", text: line }])]),
    }));
  return { type: "doc", content: paragraphs.length === 0 ? [{ type: "paragraph" }] : paragraphs };
}

interface Draft {
  anchor: Anchor;
}

/**
 * A page's discussion: its threads room, read live and never written to by
 * this tab; the editor's highlights, located through the threads' ranges;
 * and the actions, which go to the server, who writes them for everyone
 * under this account's name.
 */
export class Discussion {
  readonly provider: HocuspocusProvider;
  readonly shared: SharedThreads;
  readonly source: AnchorSource;
  view: EditorView | null = null;
  active: string | null = null;
  readonly drafts = new Map<string, Draft>();
  private readonly pending = new Map<string, RelativeRange>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** `socket` is the page's own: the threads come over the same connection. */
  constructor(
    readonly name: string,
    readonly me: Me,
    socket: HocuspocusProviderWebsocket,
  ) {
    this.provider = new HocuspocusProvider({ websocketProvider: socket, name: threadsRoomOf(name) });
    this.provider.attach();
    this.shared = sharedThreads(this.provider.document, me.name, { bodies: commentSchema });
    const map = this.provider.document.getMap<unknown>(THREADS);
    const anchors = relativeAnchors({
      get: (id) => {
        const entry = map.get(id);
        return (entry instanceof Y.Map ? (entry.get("range") as RelativeRange | undefined) : undefined) ?? this.pending.get(id);
      },
      // A new thread's range stays here until the server has it.
      set: (id, range) => void this.pending.set(id, range),
    });
    // Asked on every change to the page, someone else's typing included:
    // where each thread is and whether it is open, never its comments.
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    this.source = {
      ...anchors,
      threads: () => [
        ...[...map.entries()].flatMap(([id, entry]) =>
          entry instanceof Y.Map
            ? [{ id, anchor: { from: 0, to: 0, quote: text(entry.get("quote")), prefix: text(entry.get("prefix")), suffix: text(entry.get("suffix")) }, resolved: entry.get("resolved") === true }]
            : [],
        ),
        ...[...this.drafts].map(([id, draft]) => ({ id, anchor: draft.anchor, resolved: false })),
      ],
    };
    // Someone else's comment moves no text: the editor places threads again once the change is in.
    this.shared.subscribe(() => {
      queueMicrotask(() => this.run((view) => relocateComments()(view.state, view.dispatch)));
      this.changed();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  destroy(): void {
    this.provider.destroy();
  }

  threads(): Array<SharedThread & { authorId: string | null }> {
    const map = this.provider.document.getMap<unknown>(THREADS);
    return this.shared.list().map((thread) => {
      const entry = map.get(thread.id);
      const authorId = entry instanceof Y.Map ? entry.get("authorId") : null;
      return { ...thread, authorId: typeof authorId === "string" ? authorId : null };
    });
  }

  private run(command: (view: EditorView) => void): void {
    if (this.view !== null && !this.view.isDestroyed) command(this.view);
  }

  /** Opens a draft on the editor's selection; `null` when nothing is selected. */
  startDraft(): string | null {
    const view = this.view;
    if (view === null || view.state.selection.empty) return null;
    const id = `draft_${Date.now().toString(36)}`;
    addComment(id)(view.state, view.dispatch);
    const anchor = commentsState(view.state)?.anchors.get(id);
    if (anchor === undefined) return null;
    this.drafts.set(id, { anchor });
    this.active = id;
    this.changed();
    return id;
  }

  cancelDraft(id: string): void {
    this.drafts.delete(id);
    this.pending.delete(id);
    this.run((view) => removeComment(id)(view.state, view.dispatch));
    this.changed();
  }

  async submitDraft(id: string, text: string): Promise<void> {
    const draft = this.drafts.get(id);
    const range = this.pending.get(id);
    // Kept, with what was typed, for the person to try again.
    if (draft === undefined || range === undefined) throw new ApiError("this comment lost its place in the page: select the words again");
    const { quote, prefix = "", suffix = "" } = draft.anchor;
    const { id: created } = await api<{ id: string }>(path(this.name), { body: { anchor: { quote, prefix, suffix }, range, body: bodyOf(text) } });
    this.cancelDraft(id);
    this.active = created;
    this.changed();
  }

  reply = (id: string, text: string): Promise<unknown> => api(`${path(this.name)}/${id}/comments`, { body: { body: bodyOf(text) } });
  resolve = (id: string, resolved: boolean): Promise<unknown> => api(`${path(this.name)}/${id}`, { method: "PATCH", body: { resolved } });
  remove = (id: string): Promise<unknown> => api(`${path(this.name)}/${id}`, { method: "DELETE", body: {} });

  /** Shows a thread's words in the editor, selected, and the thread as the one being read. */
  select(id: string): void {
    this.active = id;
    this.run((view) => (commentsState(view.state)?.anchors.has(id) ? selectComment(id) : setActiveComment(id))(view.state, view.dispatch));
    this.changed();
  }

  /** The editor says which thread was clicked. */
  setActive(id: string | null): void {
    if (id === this.active || id === null) return;
    this.active = id;
    this.changed();
  }
}

export function useDiscussion(discussion: Discussion): void {
  useSyncExternalStore(discussion.subscribe, discussion.getSnapshot, discussion.getSnapshot);
}

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

function Composer({ label, onSubmit, onCancel }: { label: string; onSubmit: (text: string) => Promise<void>; onCancel?: () => void }): ReactNode {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setText("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "the server did not answer");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <textarea
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
          if (event.key === "Escape") onCancel?.();
        }}
        rows={3}
      />
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={busy || text.trim() === ""}>
          {label}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error === null ? null : (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The page's threads: a draft being written, the open ones, then the resolved ones. */
export function Comments({ discussion, me }: { discussion: Discussion; me: Me }): ReactNode {
  useDiscussion(discussion);
  const threads = discussion.threads();
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const [error, setError] = useState<string | null>(null);
  const attempt = (action: Promise<unknown>): void => {
    setError(null);
    action.catch((caught: Error) => setError(caught.message));
  };

  const card = (thread: (typeof threads)[number]): ReactNode => {
    const active = thread.id === discussion.active;
    const mayManage = me.role !== "reader" || thread.authorId === me.id;
    return (
      <article key={thread.id} className={`thread${active ? " active" : ""}${thread.resolved ? " resolved" : ""}`} onClick={() => !active && discussion.select(thread.id)}>
        <blockquote>“{thread.anchor.quote}”</blockquote>
        {thread.comments.map((comment) => (
          <div key={comment.id} className="comment">
            <div className="meta">
              <strong>{comment.author}</strong> <time dateTime={comment.createdAt}>{when(comment.createdAt)}</time>
            </div>
            <div className="body" dangerouslySetInnerHTML={{ __html: toHtml(comment.body, commentSchema, { policy: "untrusted" }) }} />
          </div>
        ))}
        {active ? (
          <div onClick={(event) => event.stopPropagation()}>
            <Composer label="Reply" onSubmit={async (text) => void (await discussion.reply(thread.id, text))} />
            {mayManage ? (
              <div className="thread-actions">
                <button type="button" onClick={() => attempt(discussion.resolve(thread.id, !thread.resolved))}>
                  {thread.resolved ? "Reopen" : "Resolve"}
                </button>
                <button type="button" className="danger" onClick={() => attempt(discussion.remove(thread.id))}>
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <div className="comments">
      {[...discussion.drafts].map(([id, draft]) => (
        <article key={id} className="thread active draft">
          <blockquote>“{draft.anchor.quote}”</blockquote>
          <Composer label="Comment" onSubmit={(text) => discussion.submitDraft(id, text)} onCancel={() => discussion.cancelDraft(id)} />
        </article>
      ))}
      {open.length === 0 && discussion.drafts.size === 0 ? <p className="muted small">No comment yet. Select some text and press Comment.</p> : null}
      {open.map(card)}
      {resolved.length > 0 ? (
        <details className="resolved-threads">
          <summary>Resolved ({resolved.length})</summary>
          {resolved.map(card)}
        </details>
      ) : null}
      {error === null ? null : (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
