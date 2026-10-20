import { defineSchema, isBlank, toHtml, validate, type Node, type Thread } from "@nseaprotector/coelho-core";
import { addComment, commentsPlugin, commentsState, createSuggestion, markdownPaste, removeComment, selectComment, setActiveComment, setCommentResolved } from "@nseaprotector/coelho-prosemirror";
import { CoelhoEditor, Toolbar, useCoelhoEditor } from "@nseaprotector/coelho-react";
import type { Schema } from "@nseaprotector/coelho-core";
import type { Command } from "prosemirror-state";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalloutChrome, MentionChip, Suggestions } from "./Suggestions.js";

/**
 * What a comment may hold: paragraphs, line breaks, and four marks. Kept
 * small on purpose, since it is written by whoever can comment, and
 * rendered with `policy: "untrusted"` all the same.
 */
export const commentSchema = defineSchema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block", render: ["p", []], parse: ["p"] },
    hard_break: { group: "inline", inline: true, void: true, render: ["br", []], toText: "\n", parse: ["br"] },
    text: { group: "inline", inline: true, text: true },
  },
  marks: {
    bold: { render: ["strong", []], parse: ["strong", "b"] },
    italic: { render: ["em", []], parse: ["em", "i"] },
    code: { code: true, render: ["code", []], parse: ["code"] },
    link: {
      attrs: { href: { required: true, validate: "safe_url" }, title: { default: null, validate: { nullable: "string" } } },
      render: ["a", (mark) => [["href", String(mark.attrs?.href ?? "")]]],
      parse: ["a"],
    },
  },
});

export interface LiveThread extends Thread {
  /** The thread's text was deleted from the document; it keeps what it said. */
  orphaned: boolean;
}

const AUTHORS = ["Camille", "Sacha", "Dominique"];

// Read once by the editor, so defined once.
const nodeViews = { mention: MentionChip, callout: CalloutChrome };

interface Props {
  schema: Schema;
  value: Node;
  onChange: (value: Node) => void;
  threads: Thread[];
  onThreadsChange: (update: (threads: Thread[]) => Thread[]) => void;
  /** Called on every render with the threads as the editor currently places them. */
  onLiveThreads: (threads: LiveThread[]) => void;
}

/** The editor with its discussion beside it: the document never learns that it is being commented on. */
export function CommentedEditor({ schema, value, onChange, threads, onThreadsChange, onLiveThreads }: Props): ReactNode {
  // What the plugin restores whenever the editor state is rebuilt: the
  // threads as the editor last placed them, found again by their quote.
  const live = useRef<LiveThread[]>(threads.map((thread) => ({ ...thread, orphaned: false })));
  const [suggestion] = useState(() => createSuggestion(["@", "/"]));
  const [plugins] = useState(() => [
    commentsPlugin({ schema, restore: () => live.current.map(({ id, anchor, resolved, orphaned }) => ({ id, anchor, resolved, lost: orphaned })) }),
    suggestion.plugin,
    markdownPaste(schema, { callouts: { node: "callout", attr: "kind" } }),
  ]);
  const editor = useCoelhoEditor({ schema, value, onChange, plugins, nodeViews });
  const [author, setAuthor] = useState(AUTHORS[0] as string);

  const state = editor.state === null ? undefined : commentsState(editor.state);
  const placed: LiveThread[] = threads.map((thread) => {
    const anchor = state?.anchors.get(thread.id);
    return { ...thread, anchor: anchor ?? state?.lost.get(thread.id) ?? thread.anchor, orphaned: state !== undefined && anchor === undefined };
  });
  useEffect(() => {
    live.current = placed;
    onLiveThreads(placed);
  });

  const run = (command: Command, focus = false): void => {
    const view = editor.view;
    if (view === null) return;
    command(view.state, view.dispatch, view);
    if (focus) view.focus();
  };

  const active = state?.active ?? null;

  // A thread opened and left without a first comment is not a thread.
  useEffect(() => {
    const abandoned = threads.filter((thread) => thread.comments.length === 0 && thread.id !== active);
    if (abandoned.length === 0) return;
    for (const thread of abandoned) run(removeComment(thread.id));
    onThreadsChange((all) => all.filter((thread) => !abandoned.includes(thread)));
  });

  const open = (): void => {
    const view = editor.view;
    if (view === null || view.state.selection.empty) return;
    const { from, to } = view.state.selection;
    const id = `t_${Date.now().toString(36)}`;
    onThreadsChange((all) => [...all, { id, anchor: { from, to, quote: view.state.doc.textBetween(from, to, "\n", "") }, resolved: false, comments: [] }]);
    run(addComment(id));
  };

  const sorted = [...placed].sort((a, b) => Number(a.orphaned) - Number(b.orphaned) || a.anchor.from - b.anchor.from);
  const selectionEmpty = editor.state?.selection.empty ?? true;

  return (
    <div className="workspace">
      <div className="coelho-editor">
        <div className="toolbar-row">
          <Toolbar editor={editor} />
          <button type="button" className="comment-button" disabled={selectionEmpty} onMouseDown={(event) => event.preventDefault()} onClick={open} title="Comment on the selection">
            Comment
          </button>
        </div>
        <div ref={editor.ref} className="coelho-editor-content" />
        {editor.portals}
        <Suggestions editor={editor} keys={suggestion.keys} />
      </div>

      <aside className="threads" aria-label="Comments">
        <header>
          <h2>Comments</h2>
          <label>
            as{" "}
            <select value={author} onChange={(event) => setAuthor(event.target.value)}>
              {AUTHORS.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        </header>
        {sorted.length === 0 ? <p className="empty">Select some text and press Comment.</p> : null}
        {sorted.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            active={thread.id === active}
            onSelect={() => run(thread.orphaned ? setActiveComment(thread.id) : selectComment(thread.id), !thread.orphaned)}
            onReply={(body) =>
              onThreadsChange((all) =>
                all.map((t) => (t.id === thread.id ? { ...t, comments: [...t.comments, { id: `c_${Date.now().toString(36)}`, author, body, createdAt: new Date().toISOString() }] } : t)),
              )
            }
            onResolve={(resolved) => {
              run(setCommentResolved(thread.id, resolved));
              if (resolved) run(setActiveComment(null));
              onThreadsChange((all) => all.map((t) => (t.id === thread.id ? { ...t, resolved } : t)));
            }}
            onDelete={() => {
              run(removeComment(thread.id));
              onThreadsChange((all) => all.filter((t) => t.id !== thread.id));
            }}
            onCancel={() => run(setActiveComment(null), true)}
          />
        ))}
      </aside>
    </div>
  );
}

interface CardProps {
  thread: LiveThread;
  active: boolean;
  onSelect: () => void;
  onReply: (body: Node) => void;
  onResolve: (resolved: boolean) => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function ThreadCard({ thread, active, onSelect, onReply, onResolve, onDelete, onCancel }: CardProps): ReactNode {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  const classes = ["thread", active ? "active" : "", thread.resolved ? "resolved" : "", thread.orphaned ? "orphaned" : ""].filter(Boolean).join(" ");
  return (
    <article ref={card} className={classes} onClick={active ? undefined : onSelect}>
      <blockquote title={thread.orphaned ? "This text was deleted from the document" : "Jump to the text"}>
        {thread.orphaned ? <span className="tag">deleted</span> : null}
        {thread.resolved ? <span className="tag">resolved</span> : null}“{thread.anchor.quote}”
      </blockquote>
      {thread.comments.map((comment) => (
        <div key={comment.id} className="comment">
          <div className="meta">
            <strong>{comment.author}</strong> <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          </div>
          <div className="body" dangerouslySetInnerHTML={{ __html: toHtml(comment.body, commentSchema, { policy: "untrusted" }) }} />
        </div>
      ))}
      {active ? (
        <Composer
          first={thread.comments.length === 0}
          onSubmit={onReply}
          onCancel={onCancel}
          actions={
            thread.comments.length === 0 ? null : (
              <>
                <button type="button" onClick={() => onResolve(!thread.resolved)}>
                  {thread.resolved ? "Reopen" : "Resolve"}
                </button>
                <button type="button" className="danger" onClick={onDelete}>
                  Delete
                </button>
              </>
            )
          }
        />
      ) : null}
    </article>
  );
}

function Composer({ first, onSubmit, onCancel, actions }: { first: boolean; onSubmit: (body: Node) => void; onCancel: () => void; actions: ReactNode }): ReactNode {
  const [draft, setDraft] = useState<Node | null>(null);
  const checked = draft === null ? null : validate(draft, commentSchema);
  const ready = checked !== null && checked.ok && !isBlank(checked.document, commentSchema);
  const submit = (): void => {
    if (checked === null || !checked.ok || !ready) return;
    onSubmit(checked.document);
    setDraft(null);
  };
  return (
    <div className="composer" onClick={(event) => event.stopPropagation()}>
      <div
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") onCancel();
        }}
      >
        <CoelhoEditor schema={commentSchema} value={draft} onChange={setDraft} toolbar={null} className="comment-editor" />
      </div>
      <div className="composer-actions">
        <button type="button" className="primary" disabled={!ready} onClick={submit} title="Mod-Enter">
          {first ? "Comment" : "Reply"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <span className="spacer" />
        {actions}
      </div>
    </div>
  );
}
