import { anchorAt, hash, toHtml, type Schema } from "@nseaprotector/coelho-core";
import { collab, FIELD, LocalRelay, seed, sharedThreads, snapshot, THREADS } from "@nseaprotector/coelho-collab";
import { addComment, commentsPlugin, commentsState, relocateComments, selectComment, setActiveComment } from "@nseaprotector/coelho-prosemirror";
import { Toolbar, useCoelhoEditor } from "@nseaprotector/coelho-react";
import type { Node } from "@nseaprotector/coelho-core";
import type { Command } from "prosemirror-state";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { commentSchema, ThreadCard } from "./Comments.js";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

interface Writer {
  name: string;
  color: string;
  doc: Y.Doc;
  awareness: Awareness;
}

const start: Node = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Programme de la semaine" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Two writers, one document. Type in either; go " },
        { type: "text", text: "offline", marks: [{ type: "bold" }] },
        { type: "text", text: ", type in both, and come back." },
      ],
    },
  ],
};

/**
 * A room: one shared document seeded once, and a writer per pane, each with
 * their own Y.Doc and presence, joined through a relay inside the page.
 */
function createRoom(schema: Schema): { relay: LocalRelay; writers: Writer[] } {
  const relay = new LocalRelay();
  const writers = [
    { name: "Camille", color: "#b5442c" },
    { name: "Sacha", color: "#2d6a9f" },
  ].map(({ name, color }, index) => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField("user", { name, color });
    if (index === 0) seed(doc, schema, start);
    relay.join(doc, awareness);
    return { name, color, doc, awareness };
  });
  return { relay, writers };
}

export function Collab({ schema }: { schema: Schema }): ReactNode {
  const [room] = useState(() => createRoom(schema));
  const online = useSyncExternalStore(
    (listener) => room.relay.subscribe(listener),
    () => room.relay.online,
  );
  const [, setVersion] = useState(0);
  const changed = (): void => setVersion((n) => n + 1);

  return (
    <section className="collab">
      <header>
        <h2>Two writers, one document</h2>
        <p>
          Yjs carries and merges; what is stored is still the validated document. Each pane is its own Y.Doc, joined by a relay inside this page —
          y-websocket or Hocuspocus, both MIT, do the same over a socket.
        </p>
      </header>
      <div className="actions">
        <button type="button" onClick={() => room.relay.setOnline(!online)} aria-pressed={!online}>
          {online ? "Go offline" : "Come back online"}
        </button>
        <span className={online ? "online" : "offline"}>{online ? "online: every keystroke reaches the other pane" : "offline: each pane goes on alone"}</span>
        <button
          type="button"
          title="Writes into Sacha's shared document directly, as any client of the room could"
          onClick={() => {
            const first = room.writers[1]?.doc.getXmlFragment(FIELD).toArray().find((node) => node instanceof Y.XmlElement && node.nodeName === "paragraph") as Y.XmlElement | undefined;
            const text = first?.toArray().find((node) => node instanceof Y.XmlText) as Y.XmlText | undefined;
            text?.format(0, Math.min(10, text.length), { link: { href: "javascript:alert(document.cookie)" } });
            changed();
          }}
        >
          A peer writes a javascript: link past the editor
        </button>
        <button
          type="button"
          title="Writes garbage into Sacha's shared threads directly, as any client of the room could"
          onClick={() => {
            const doc = room.writers[1]?.doc;
            if (doc === undefined) return;
            writeHostileThreads(doc);
            changed();
          }}
        >
          A peer writes hostile threads
        </button>
      </div>
      <div className="panes">
        {room.writers.map((writer) => (
          <Pane key={writer.name} schema={schema} writer={writer} onChange={changed} />
        ))}
      </div>
      <Stored schema={schema} writers={room.writers} />
    </section>
  );
}

function Pane({ schema, writer, onChange }: { schema: Schema; writer: Writer; onChange: () => void }): ReactNode {
  // Built once: the setup itself makes fresh collaboration plugins for every view.
  const [setup] = useState(() => collab({ doc: writer.doc, awareness: writer.awareness }));
  // Threads live in the same shared document as the text, beside it.
  const [threads] = useState(() => sharedThreads(writer.doc, writer.name, { bodies: commentSchema }));
  const [plugins] = useState(() => [commentsPlugin({ schema, source: threads.source })]);
  const editor = useCoelhoEditor({ schema, setup, plugins, history: false, onChange });
  const view = useRef(editor.view);
  view.current = editor.view;
  const [, setVersion] = useState(0);

  const run = (command: Command, focus = false): void => {
    const current = view.current;
    if (current === null || current.isDestroyed) return;
    command(current.state, current.dispatch, current);
    if (focus) current.focus();
  };

  // A change to the threads, from anyone, moves no text: the editor is told
  // to locate them again, once this change is over.
  useEffect(
    () =>
      threads.subscribe(() => {
        setVersion((n) => n + 1);
        queueMicrotask(() => run(relocateComments()));
        onChange();
      }),
    [threads],
  );

  const state = editor.state === null ? undefined : commentsState(editor.state);
  const active = state?.active ?? null;
  const list = threads.list();

  // A draft left without a first comment is not a thread.
  useEffect(() => {
    for (const thread of list) if (thread.draft && thread.comments.length === 0 && thread.id !== active) threads.remove(thread.id);
  });

  const open = (): void => {
    const current = view.current;
    if (current === null || current.state.selection.empty) return;
    const { from, to } = current.state.selection;
    const id = `t_${writer.name.toLowerCase()}_${Date.now().toString(36)}`;
    threads.open(id, anchorAt(current.state.doc.toJSON(), schema, from, to));
    run(addComment(id));
  };

  return (
    <div className="pane">
      <div className="pane-name" style={{ borderColor: writer.color }}>
        {writer.name}
      </div>
      <div className="coelho-editor">
        <div className="toolbar-row">
          <Toolbar editor={editor} />
          <button type="button" className="comment-button" disabled={editor.state?.selection.empty ?? true} onMouseDown={(event) => event.preventDefault()} onClick={open}>
            Comment
          </button>
        </div>
        <div ref={editor.ref} className="coelho-editor-content" />
        {editor.portals}
      </div>
      <div className="pane-threads">
        {list.map((thread) => {
          const anchor = state?.anchors.get(thread.id) ?? state?.lost.get(thread.id) ?? thread.anchor;
          return (
            <ThreadCard
              key={thread.id}
              thread={{ ...thread, anchor, orphaned: state !== undefined && !state.anchors.has(thread.id) }}
              active={thread.id === active}
              onSelect={() => run(state?.anchors.has(thread.id) ? selectComment(thread.id) : setActiveComment(thread.id), true)}
              onReply={(body) => threads.reply(thread.id, { id: `c_${Date.now().toString(36)}`, author: writer.name, body, createdAt: new Date().toISOString() })}
              onResolve={(resolved) => {
                threads.resolve(thread.id, resolved);
                if (resolved) run(setActiveComment(null));
              }}
              onDelete={() => threads.remove(thread.id)}
              onCancel={() => run(setActiveComment(null), true)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** What each writer's client would store: the shared document, validated, and its hash. */
function Stored({ schema, writers }: { schema: Schema; writers: Writer[] }): ReactNode {
  const snapshots = writers.map((writer) => snapshot(writer.doc, schema));
  const [digests, setDigests] = useState<Array<string | null>>([]);
  const key = snapshots.map((s) => JSON.stringify(s.document)).join("|");
  useEffect(() => {
    let live = true;
    void Promise.all(snapshots.map((s) => hash(s.document))).then((all) => {
      if (live) setDigests(all);
    });
    return () => {
      live = false;
    };
    // The snapshots are recomputed every render; the key says when they changed.
  }, [key]);
  const same = digests.length === writers.length && digests.every((digest) => digest === digests[0]);
  return (
    <div className="stored">
      <p className={same ? "ok" : "differ"}>
        {same ? `Both would store the same document: sha256 ${digests[0]?.slice(0, 16) ?? "…"}…` : "The two documents differ until they are back online."}
      </p>
      {snapshots.map((stored, index) => (
        <div key={writers[index]?.name} className="stored-one">
          <h3>{writers[index]?.name} would store</h3>
          {stored.errors.length > 0 ? (
            <pre className="errors">{stored.errors.map((error) => `${error.path.join(".")}: ${error.message} — repaired by sanitize`).join("\n")}</pre>
          ) : null}
          <div className="prose" dangerouslySetInnerHTML={{ __html: toHtml(stored.document, schema) }} />
        </div>
      ))}
    </div>
  );
}

/**
 * What a peer could write into the shared threads without the editor: an
 * entry that is not a thread, a thread whose range and comments are
 * nonsense, and a reply whose body holds a node no schema knows.
 */
export function writeHostileThreads(doc: Y.Doc): void {
  const threads = doc.getMap<unknown>(THREADS);
  doc.transact(() => {
    threads.set("not-a-thread", "just a string");
    const broken = new Y.Map<unknown>();
    threads.set("broken", broken);
    broken.set("quote", 42);
    broken.set("range", { from: "nowhere", to: [1, 2, 3], last: null });
    broken.set("comments", "not a list");
    const hostile = new Y.Map<unknown>();
    threads.set("hostile", hostile);
    hostile.set("quote", "Two writers");
    hostile.set("opened", 1);
    const comments = new Y.Array<unknown>();
    hostile.set("comments", comments);
    comments.push([
      { id: "x1", author: "Mallory", createdAt: "", body: { type: "doc", content: [{ type: "script", content: [{ type: "text", text: "alert(1)" }] }, { type: "paragraph", content: [{ type: "text", text: "Kept words." }] }] } },
      "not a comment",
    ]);
  });
}
