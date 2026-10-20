import { collab } from "@nseaprotector/coelho-collab";
import { defaultSchema, toHtml, type Document, type ValidationError } from "@nseaprotector/coelho-core";
import { Toolbar, useCoelhoEditor } from "@nseaprotector/coelho-react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Plugin } from "prosemirror-state";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, currentUser, type Me } from "./api.js";
import { People, SignIn } from "./Auth.js";

// The schema the server stores under; the same object on both sides.
const schema = defaultSchema();

function pageName(): string {
  return decodeURIComponent(location.hash.slice(1)) || "welcome";
}

export function App(): ReactNode {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(() => void currentUser().then(setMe), []);
  useEffect(refresh, [refresh]);

  if (me === undefined) return <main className="placeholder">…</main>;
  if (me === null) return <SignIn onSignedIn={refresh} />;
  return <Workspace me={me} refresh={refresh} />;
}

function Workspace({ me, refresh }: { me: Me; refresh: () => void }): ReactNode {
  const [name, setName] = useState(pageName);
  const [showPeople, setShowPeople] = useState(false);
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
        <div className="account">
          <span className="me" style={{ borderColor: me.color }}>
            {me.name} <span className={`role ${me.role}`}>{me.role}</span>
          </span>
          {me.role === "admin" ? (
            <button type="button" onClick={() => setShowPeople((shown) => !shown)}>
              People
            </button>
          ) : null}
          <button type="button" onClick={() => void api("/api/logout", { body: {} }).then(refresh)}>
            Sign out
          </button>
        </div>
      </header>
      {showPeople ? <People me={me} onClose={() => setShowPeople(false)} /> : null}
      {/* A new page or a new role is a new room: everything below is rebuilt. */}
      <Page key={`${name}:${me.role}`} name={name} me={me} onReauthenticated={refresh} />
    </main>
  );
}

type Status = "connecting" | "connected" | "disconnected";

function Page({ name, me, onReauthenticated }: { name: string; me: Me; onReauthenticated: () => void }): ReactNode {
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
      // After a reconnection the role may have changed: ask who we are now.
      onAuthenticated: onReauthenticated,
      onAuthenticationFailed: onReauthenticated,
    });
    // The server stamps presence with the account anyway; this is what this tab shows meanwhile.
    next.setAwarenessField("user", { id: me.id, name: me.name, color: me.color });
    setProvider(next);
    return () => {
      next.destroy();
      setProvider(null);
      setSynced(false);
    };
    // The account is fixed for this page's lifetime: a new role remounts it.
  }, [name]);

  return (
    <div className="layout">
      <section className="writing">
        <div className="status">
          <span className={`dot ${status}`} /> {status}
          {status === "connected" && !synced ? " · loading the page…" : ""}
        </div>
        {me.role === "reader" ? <p className="readonly">You can read this page. An admin can let you edit it.</p> : null}
        {provider !== null && synced ? <Editor provider={provider} readOnly={me.role === "reader"} /> : <div className="placeholder">Opening “{name}”…</div>}
        <p className="hint">Open this page in another tab or browser: every writer edits the same page, live. Add <code>#another-name</code> to the URL for a new page.</p>
      </section>
      <Stored name={name} />
    </div>
  );
}

// The server already refuses a reader's changes; this keeps the editor from pretending otherwise.
const readOnly = [new Plugin({ props: { editable: () => false } })];

function Editor({ provider, readOnly: reading }: { provider: HocuspocusProvider; readOnly: boolean }): ReactNode {
  const setup = useMemo(() => collab({ doc: provider.document, awareness: provider.awareness as NonNullable<typeof provider.awareness> }), [provider]);
  const editor = useCoelhoEditor({ schema, setup, history: false, plugins: reading ? readOnly : undefined });
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
  updatedBy: string | null;
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
            <dt>by</dt>
            <dd>{page.updatedBy ?? "the server, when it seeded the page"}</dd>
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
