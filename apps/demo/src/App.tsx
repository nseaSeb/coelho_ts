import { canonical, defaultSchema, extendSchema, hash, isBlank, reanchor, textLength, toHtml, toText, validate, type Node, type Thread } from "@coelho/core";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CommentedEditor, type LiveThread } from "./Comments.js";

// The default schema plus what an application adds: a mark with a class of
// its own. The editor, the page and the validator all read this one object.
const schema = extendSchema(defaultSchema(), {
  marks: { highlight: { class: "hl", render: ["mark", []] } },
});

const initial: Node = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "The document is the storage." }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "What you type here is stored as " },
        { type: "text", text: "JSON", marks: [{ type: "bold" }] },
        { type: "text", text: ", validated against a schema, and rendered by " },
        { type: "text", text: "@coelho/core", marks: [{ type: "code" }] },
        { type: "text", text: ". Try " },
        { type: "text", text: "# ", marks: [{ type: "code" }] },
        { type: "text", text: ", " },
        { type: "text", text: "- ", marks: [{ type: "code" }] },
        { type: "text", text: " or " },
        { type: "text", text: "> ", marks: [{ type: "code" }] },
        { type: "text", text: " at the start of a line." },
      ],
    },
    {
      type: "bullet_list",
      content: [
        { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "No HTML in the database." }] }] },
        {
          type: "list_item",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "A " },
                { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.test/?a=1&b=2" } }] },
                { type: "text", text: " keeps its href on the page, and loses it for a stranger." },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// One thread to start with, placed by its quote alone: `reanchor` finds it.
const initialThreads: Thread[] = [
  {
    id: "t_welcome",
    anchor: reanchor(initial, schema, { from: 0, to: 0, quote: "stored as JSON" }) ?? { from: 0, to: 0, quote: "stored as JSON" },
    resolved: false,
    comments: [
      {
        id: "c_welcome",
        author: "Sacha",
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "This comment is not in the document: look at " },
                { type: "text", text: "What the column holds", marks: [{ type: "italic" }] },
                { type: "text", text: ". It lives beside it, with a range and a quote." },
              ],
            },
          ],
        },
        createdAt: "2026-10-20T09:00:00.000Z",
      },
    ],
  },
];

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {hint === undefined ? null : <p>{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function App(): ReactNode {
  const [value, setValue] = useState<Node>(initial);
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [liveThreads, setLiveThreads] = useState<LiveThread[]>([]);
  const [digest, setDigest] = useState<string | null>(null);

  // Everything below the editor is recomputed from the stored tree on every
  // change: what the column holds, and what is derived from it on the way out.
  const result = useMemo(() => validate(value, schema), [value]);
  const stored = result.ok ? result.document : null;
  const bytes = stored === null ? "" : canonical(stored);

  useEffect(() => {
    let live = true;
    void hash(stored).then((h) => {
      if (live) setDigest(h);
    });
    return () => {
      live = false;
    };
  }, [stored]);

  const html = stored === null ? "" : toHtml(stored, schema);
  const untrusted = stored === null ? "" : toHtml(stored, schema, { policy: "untrusted" });

  return (
    <main>
      <h1>
        coelho_ts <span>structured rich text, the storage layer in TypeScript</span>
      </h1>

      <CommentedEditor
        schema={schema}
        value={value}
        onChange={setValue}
        threads={threads}
        onThreadsChange={setThreads}
        onLiveThreads={(live) => setLiveThreads((previous) => (JSON.stringify(previous) === JSON.stringify(live) ? previous : live))}
      />

      <div className="actions">
        <button
          type="button"
          title="Changes the stored document without going through the editor, as another session or a migration would"
          onClick={() =>
            setValue((current) => ({
              ...current,
              content: [{ type: "paragraph", content: [{ type: "text", text: "Another writer added this paragraph, outside the editor." }] }, ...(current.content ?? [])],
            }))
          }
        >
          Another writer adds a paragraph at the top
        </button>
        <span>The editor is reset to the new document; every thread finds its text again by its quote.</span>
      </div>

      <div className="status">
        {result.ok ? (
          <span className="ok">valid · {textLength(stored)} characters · {bytes.length} bytes · {isBlank(stored, schema) ? "blank" : "has content"}</span>
        ) : (
          <ul className="errors">
            {result.errors.map((error, index) => (
              <li key={index}>
                <code>{error.path.join(".") || "document"}</code> {error.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid">
        <Panel title="Rendered HTML" hint="toHtml(doc, schema) — what the page shows">
          <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        </Panel>
        <Panel title="Rendered as a stranger's comment" hint='toHtml(doc, schema, { policy: "untrusted" }) — links and images reduced to text'>
          <div className="prose" dangerouslySetInnerHTML={{ __html: untrusted }} />
        </Panel>
        <Panel title="HTML source" hint="escaped, never stored">
          <pre>{html}</pre>
        </Panel>
        <Panel title="What the column holds" hint={`canonical(doc) — sha256 ${digest ?? "null (nothing was agreed to)"}`}>
          <pre>{stored === null ? "—" : JSON.stringify(stored, null, 2)}</pre>
        </Panel>
        <Panel title="What the threads table holds" hint="beside the document, never inside it: the hash above does not move when you comment">
          <pre>{JSON.stringify(liveThreads.map(({ orphaned, ...thread }) => ({ ...thread, ...(orphaned ? { orphaned } : {}) })), null, 2)}</pre>
        </Panel>
        <Panel title="Plain text for a search index" hint="toText(doc, schema)">
          <pre>{stored === null ? "" : toText(stored, schema)}</pre>
        </Panel>
        <Panel title="Replace the stored document" hint="paste JSON here: the editor is controlled, and a hostile document is refused">
          <JsonInput value={value} onChange={setValue} />
        </Panel>
      </div>
    </main>
  );
}

function JsonInput({ value, onChange }: { value: Node; onChange: (node: Node) => void }): ReactNode {
  const [text, setText] = useState(() => JSON.stringify(value));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(value)), [value]);
  const apply = (): void => {
    try {
      const parsed = JSON.parse(text) as unknown;
      const checked = validate(parsed, schema);
      if (!checked.ok) {
        setProblem(checked.errors.map((e) => `${e.path.join(".") || "document"}: ${e.message}`).join("\n"));
        return;
      }
      setProblem(null);
      onChange(checked.document);
    } catch (error) {
      setProblem((error as Error).message);
    }
  };
  return (
    <div className="json-input">
      <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
      <div>
        <button type="button" onClick={apply}>
          Load into the editor
        </button>
        <button
          type="button"
          onClick={() =>
            setText(
              JSON.stringify({
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "click me", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
              }),
            )
          }
        >
          Paste a hostile document
        </button>
      </div>
      {problem === null ? null : <pre className="errors">{problem}</pre>}
    </div>
  );
}
