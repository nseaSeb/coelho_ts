import { hash, toHtml, type Schema } from "@coelho/core";
import { collab, FIELD, LocalRelay, seed, snapshot } from "@coelho/collab";
import { Toolbar, useCoelhoEditor } from "@coelho/react";
import type { Node } from "@coelho/core";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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
  // Built once: the setup itself makes fresh plugins for every view.
  const [setup] = useState(() => collab({ doc: writer.doc, awareness: writer.awareness }));
  const editor = useCoelhoEditor({ schema, setup, history: false, onChange });
  return (
    <div className="pane">
      <div className="pane-name" style={{ borderColor: writer.color }}>
        {writer.name}
      </div>
      <div className="coelho-editor">
        <Toolbar editor={editor} />
        <div ref={editor.ref} className="coelho-editor-content" />
        {editor.portals}
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
