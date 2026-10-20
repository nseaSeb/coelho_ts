import { collab } from "@nseaprotector/coelho-collab";
import { toHtml, type Document, type ValidationError } from "@nseaprotector/coelho-core";
import { commentsPlugin, commentsState, createSuggestion, replaceSuggestion } from "@nseaprotector/coelho-prosemirror";
import { SuggestionMenu, Toolbar, useCoelhoEditor, useSuggestion, type NodeViewProps } from "@nseaprotector/coelho-react";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Plugin } from "prosemirror-state";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isPageName, NOT_WRITTEN, schema } from "../../server/schema.js";
import { api, collabUrl, currentUser, type Me } from "./api.js";
import { People, SignIn } from "./Auth.js";
import { History } from "./History.js";
import { Comments, Discussion } from "./Threads.js";
import { Sidebar, type Listing, type PageSummary } from "./Pages.js";

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
  const [listing, setListing] = useState<Listing>({ pages: [], missing: [] });
  // What `[[` offers: a page linked to and not written yet is a page to link to, not one to create.
  const linkable = useMemo(() => [...listing.pages, ...listing.missing].map((page) => page.name), [listing]);
  useEffect(() => {
    let live = true;
    const read = (): void => void api<Listing>("/api/pages").then((all) => live && setListing(all), () => {});
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
        <Sidebar listing={listing} current={name} me={me} />
        {isPageName(name) ? (
          <Page key={`${name}:${me.role}`} name={name} me={me} linkable={linkable} onReauthenticated={refresh} />
        ) : (
          <div className="placeholder">“{name}” is not a page name: letters, digits, - _ . and / for folders.</div>
        )}
      </div>
    </main>
  );
}

type Status = "connecting" | "connected" | "disconnected";

function Page({ name, me, linkable, onReauthenticated }: { name: string; me: Me; linkable: string[]; onReauthenticated: () => void }): ReactNode {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [synced, setSynced] = useState(false);
  // A reader opening a page nobody wrote: opening it would write it.
  const [unwritten, setUnwritten] = useState(false);
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [tab, setTab] = useState<SideTab>("page");

  // Created in an effect, not during render: StrictMode would otherwise
  // open a second connection and never close it. One socket carries the
  // page and its threads, a room of their own the server alone writes to.
  useEffect(() => {
    const socket = new HocuspocusProviderWebsocket({ url: collabUrl() });
    const next = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      onStatus: ({ status: now }) => setStatus(now as Status),
      onSynced: () => setSynced(true),
      // After a reconnection the role may have changed: ask who we are now.
      onAuthenticated: onReauthenticated,
      onAuthenticationFailed: ({ reason }) => (reason === NOT_WRITTEN ? setUnwritten(true) : onReauthenticated()),
    });
    // The server stamps presence with the account anyway; this is what this tab shows meanwhile.
    next.setAwarenessField("user", { id: me.id, name: me.name, color: me.color });
    next.attach();
    const threads = new Discussion(name, me, socket);
    setProvider(next);
    setDiscussion(threads);
    return () => {
      threads.destroy();
      next.destroy();
      socket.destroy();
      setProvider(null);
      setDiscussion(null);
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
        {unwritten ? (
          <div className="placeholder">“{name}” is not written yet. An editor or an admin can write it.</div>
        ) : provider !== null && synced && discussion !== null ? (
          <Editor provider={provider} readOnly={me.role === "reader"} linkable={linkable} discussion={discussion} onComment={() => setTab("comments")} />
        ) : (
          <div className="placeholder">Opening “{name}”…</div>
        )}
        <p className="hint">Open this page in another tab or browser: every writer edits the same page, live. Add <code>#another-name</code> to the URL for a new page.</p>
      </section>
      <Side name={name} me={me} tab={tab} setTab={setTab} discussion={discussion} />
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

interface EditorProps {
  provider: HocuspocusProvider;
  readOnly: boolean;
  linkable: string[];
  discussion: Discussion;
  onComment: () => void;
}

function Editor({ provider, readOnly: reading, linkable, discussion, onComment }: EditorProps): ReactNode {
  const setup = useMemo(() => collab({ doc: provider.document, awareness: provider.awareness as NonNullable<typeof provider.awareness> }), [provider]);
  // `[[` opens the list of pages; the plugins are made once for this editor.
  const [links] = useState(() => createSuggestion(["[["]));
  const [plugins] = useState(() => [
    // Placed after the collaboration plugins, as the threads' ranges need its binding.
    commentsPlugin({ schema, source: discussion.source }),
    ...(reading ? readOnly : []),
    links.plugin,
  ]);
  const editor = useCoelhoEditor({ schema, setup, history: false, plugins, nodeViews });
  // The discussion acts on the editor, and hears which thread the editor has active.
  useEffect(() => {
    discussion.view = editor.view;
  });
  const active = editor.state === null ? null : (commentsState(editor.state)?.active ?? null);
  useEffect(() => discussion.setActive(active), [discussion, active]);
  const known = useRef(linkable);
  known.current = linkable;
  const suggestion = useSuggestion<Choice>(editor, {
    keys: links.keys,
    items: (match) => {
      const query = match.query.toLowerCase();
      const found: Choice[] = known.current.filter((page) => page.toLowerCase().includes(query)).slice(0, 8).map((page) => ({ name: page, create: false }));
      const exact = known.current.includes(match.query);
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
      <div className="toolbar-row">
        <Toolbar editor={editor} />
        {/* A reader may comment too: commenting is not editing. */}
        <button
          type="button"
          className="comment-button"
          disabled={editor.state?.selection.empty ?? true}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (discussion.startDraft() !== null) onComment();
          }}
        >
          Comment
        </button>
      </div>
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

/** Beside the page: what is stored and who links here, or the page's history. */
type SideTab = "page" | "comments" | "history";

interface SideProps {
  name: string;
  me: Me;
  tab: SideTab;
  setTab: (tab: SideTab) => void;
  discussion: Discussion | null;
}

/** Beside the page: what is stored and who links here, the page's comments, or its history. */
function Side({ name, me, tab, setTab, discussion }: SideProps): ReactNode {
  const tabs: Array<[SideTab, string]> = [
    ["page", "Page"],
    ["comments", "Comments"],
    ["history", "History"],
  ];
  return (
    <aside className="stored">
      <div className="tabs side-tabs" role="tablist">
        {tabs.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "page" ? <Stored name={name} /> : tab === "history" ? <History key={name} name={name} me={me} /> : discussion === null ? null : <Comments discussion={discussion} me={me} />}
    </aside>
  );
}

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
    <>
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
    </>
  );
}
