import { collab } from "@nseaprotector/coelho-collab";
import { defaultSchema, toHtml, type Document, type ValidationError } from "@nseaprotector/coelho-core";
import { Toolbar, useCoelhoEditor } from "@nseaprotector/coelho-react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useMemo, useState, type ReactNode } from "react";

// The schema the server stores under; the same object on both sides.
const schema = defaultSchema();

const people = ["Camille", "Sacha", "Dominique", "Alex", "Noa", "Éloïse"];
const colors = ["#b5442c", "#2d6a9f", "#2d7a3e", "#8a4fb5", "#b5862c", "#2c9fa0"];

/** A name and a colour for this tab, so the other writers can tell who is where. */
const me = (() => {
  const index = Math.floor(Math.random() * people.length);
  return { name: people[index] as string, color: colors[index] as string };
})();

function pageName(): string {
  return decodeURIComponent(location.hash.slice(1)) || "welcome";
}

export function App(): ReactNode {
  const [name, setName] = useState(pageName);
  useEffect(() => {
    const onHash = (): void => setName(pageName());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <main>
      <header>
        <h1>
          coelho notes <span>collaborative pages, stored validated</span>
        </h1>
        <span className="me" style={{ borderColor: me.color }}>
          you are {me.name}
        </span>
      </header>
      {/* One page at a time: a new name is a new room. */}
      <Page key={name} name={name} />
    </main>
  );
}

type Status = "connecting" | "connected" | "disconnected";

function Page({ name }: { name: string }): ReactNode {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [synced, setSynced] = useState(false);

  // Created in an effect, not during render: StrictMode would otherwise
  // open a second connection and never close it.
  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
    const next = new HocuspocusProvider({
      url,
      name,
      onStatus: ({ status: now }) => setStatus(now as Status),
      onSynced: () => setSynced(true),
    });
    next.setAwarenessField("user", me);
    setProvider(next);
    return () => {
      next.destroy();
      setProvider(null);
      setSynced(false);
    };
  }, [name]);

  return (
    <div className="layout">
      <section className="writing">
        <div className="status">
          <span className={`dot ${status}`} /> {status}
          {status === "connected" && !synced ? " · loading the page…" : ""}
        </div>
        {provider !== null && synced ? <Editor provider={provider} /> : <div className="placeholder">Opening “{name}”…</div>}
        <p className="hint">Open this page in another tab or browser: every writer edits the same page, live. Add <code>#another-name</code> to the URL for a new page.</p>
      </section>
      <Stored name={name} />
    </div>
  );
}

function Editor({ provider }: { provider: HocuspocusProvider }): ReactNode {
  const setup = useMemo(() => collab({ doc: provider.document, awareness: provider.awareness as NonNullable<typeof provider.awareness> }), [provider]);
  const editor = useCoelhoEditor({ schema, setup, history: false });
  return (
    <div className="coelho-editor">
      <Toolbar editor={editor} />
      <div ref={editor.ref} className="coelho-editor-content" />
      {editor.portals}
    </div>
  );
}

interface StoredPage {
  body: Document;
  hash: string | null;
  text: string;
  errors: ValidationError[];
  updatedAt: string;
}

/** What Postgres holds for this page: read back from the server, never from this tab. */
function Stored({ name }: { name: string }): ReactNode {
  const [page, setPage] = useState<StoredPage | null>(null);
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      const response = await fetch(`/api/pages/${encodeURIComponent(name)}`);
      if (live) setPage(response.ok ? ((await response.json()) as StoredPage) : null);
    };
    void read();
    const timer = setInterval(() => void read(), 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [name]);

  return (
    <aside className="stored">
      <h2>What the server stored</h2>
      {page === null ? (
        <p className="muted">Nothing yet: a page is stored a moment after it changes.</p>
      ) : (
        <>
          <dl>
            <dt>sha256</dt>
            <dd>
              <code>{page.hash?.slice(0, 24) ?? "null"}…</code>
            </dd>
            <dt>stored</dt>
            <dd>{new Date(page.updatedAt).toLocaleTimeString()}</dd>
          </dl>
          {page.errors.length > 0 ? (
            <pre className="errors">{page.errors.map((error) => `${error.path.join(".")}: ${error.message} — repaired`).join("\n")}</pre>
          ) : null}
          <div className="prose" dangerouslySetInnerHTML={{ __html: toHtml(page.body, schema) }} />
        </>
      )}
    </aside>
  );
}
