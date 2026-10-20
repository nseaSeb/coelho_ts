import { collab } from "@nseaprotector/coelho-collab";
import { toHtml, type Document, type ValidationError } from "@nseaprotector/coelho-core";
import { createSuggestion, replaceSuggestion } from "@nseaprotector/coelho-prosemirror";
import { SuggestionMenu, Toolbar, useCoelhoEditor, useSuggestion, type NodeViewProps } from "@nseaprotector/coelho-react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Plugin } from "prosemirror-state";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isPageName, schema } from "../../server/schema.js";
import { api, currentUser, type Me } from "./api.js";
import { People, SignIn } from "./Auth.js";
import { Sidebar, type PageSummary } from "./Pages.js";

// The schema comes from the server's own module: what this editor writes is what the server validates.

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
  const [pages, setPages] = useState<PageSummary[]>([]);
  useEffect(() => {
    let live = true;
    const read = (): void => void api<PageSummary[]>("/api/pages").then((all) => live && setPages(all), () => {});
    read();
    const timer = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [name]);
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
      <div className="frame">
        <Sidebar pages={pages} current={name} me={me} />
        {isPageName(name) ? (
          <Page key={`${name}:${me.role}`} name={name} me={me} pages={pages} onReauthenticated={refresh} />
        ) : (
          <div className="placeholder">“{name}” is not a page name: letters, digits, - _ . and / for folders.</div>
        )}
      </div>
    </main>
  );
}

type Status = "connecting" | "connected" | "disconnected";

function Page({ name, me, pages, onReauthenticated }: { name: string; me: Me; pages: PageSummary[]; onReauthenticated: () => void }): ReactNode {
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
        {provider !== null && synced ? <Editor provider={provider} readOnly={me.role === "reader"} pages={pages} /> : <div className="placeholder">Opening “{name}”…</div>}
        <p className="hint">Open this page in another tab or browser: every writer edits the same page, live. Add <code>#another-name</code> to the URL for a new page.</p>
      </section>
      <Stored name={name} />
    </div>
  );
}

// The server already refuses a reader's changes; this keeps the editor from pretending otherwise.
const readOnly = [new Plugin({ props: { editable: () => false } })];

/** A link to another page, as the editor draws it: a link you can follow. */
function PageLink({ node, selected }: NodeViewProps): ReactNode {
  const name = String(node.attrs.name);
  return (
    <a className={selected ? "page-link selected" : "page-link"} href={`#${encodeURIComponent(name)}`} contentEditable={false}>
      {name}
    </a>
  );
}
const nodeViews = { page_link: PageLink };

type Choice = { name: string; create: boolean };

function Editor({ provider, readOnly: reading, pages }: { provider: HocuspocusProvider; readOnly: boolean; pages: PageSummary[] }): ReactNode {
  const setup = useMemo(() => collab({ doc: provider.document, awareness: provider.awareness as NonNullable<typeof provider.awareness> }), [provider]);
  // `[[` opens the list of pages; the plugin is made once for this editor.
  const [links] = useState(() => createSuggestion(["[["]));
  const [plugins] = useState(() => (reading ? [...readOnly, links.plugin] : [links.plugin]));
  const editor = useCoelhoEditor({ schema, setup, history: false, plugins, nodeViews });
  const known = useRef(pages);
  known.current = pages;
  const suggestion = useSuggestion<Choice>(editor, {
    keys: links.keys,
    items: (match) => {
      const query = match.query.toLowerCase();
      const found: Choice[] = known.current.filter((page) => page.name.toLowerCase().includes(query)).slice(0, 8).map((page) => ({ name: page.name, create: false }));
      const exact = known.current.some((page) => page.name === match.query);
      return isPageName(match.query) && !exact ? [...found, { name: match.query, create: true }] : found;
    },
    onSelect: (choice) => {
      const view = editor.view;
      const type = editor.pmSchema.nodes.page_link;
      if (view !== null && type !== undefined) replaceSuggestion(type.create({ name: choice.name }))(view.state, view.dispatch, view);
      view?.focus();
    },
  });
  return (
    <div className="coelho-editor">
      <Toolbar editor={editor} />
      <div ref={editor.ref} className="coelho-editor-content" />
      {editor.portals}
      <SuggestionMenu suggestion={suggestion} label="Link a page">
        {(choice, active) => (
          <span className={active ? "suggestion active" : "suggestion"}>
            {choice.create ? <em>create </em> : null}
            {choice.name}
          </span>
        )}
      </SuggestionMenu>
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
  const [backlinks, setBacklinks] = useState<PageSummary[]>([]);
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      const [response, linking] = await Promise.all([
        fetch(`/api/pages/${encodeURIComponent(name)}`),
        api<PageSummary[]>(`/api/pages/${encodeURIComponent(name)}/backlinks`).catch(() => []),
      ]);
      if (!live) return;
      setPage(response.ok ? ((await response.json()) as StoredPage) : null);
      setBacklinks(linking);
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
      <h2>Linked from</h2>
      {backlinks.length === 0 ? (
        <p className="muted small">No page links here yet.</p>
      ) : (
        <ul className="backlinks">
          {backlinks.map((other) => (
            <li key={other.name}>
              <a href={`#${encodeURIComponent(other.name)}`}>{other.name}</a>
            </li>
          ))}
        </ul>
      )}
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
