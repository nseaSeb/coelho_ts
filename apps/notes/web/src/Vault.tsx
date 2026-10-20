import { fromMarkdown } from "@nseaprotector/coelho-prosemirror";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { isPageName, schema } from "../../server/schema.js";
import { api, ApiError, type Me } from "./api.js";
import type { PageSummary } from "./Pages.js";

const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

/**
 * A vault's path as a page name. A part the app accepts is kept as it is,
 * so a page exported and imported again comes back to itself; only what a
 * page name cannot hold is replaced. macOS hands file names over
 * decomposed, so they are composed first: "é" is one letter, not two.
 */
export function pageNameOf(path: string): string {
  return path
    .normalize("NFC")
    .replace(/\.md$/i, "")
    .split("/")
    .map((part) => {
      const trimmed = part.trim();
      return SEGMENT.test(trimmed) ? trimmed : trimmed.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^[-_.]+|[-_.]+$/g, "");
    })
    .filter(Boolean)
    .join("/");
}

/**
 * Obsidian writes `[[Lyon]]` for `Cinémas/Lyon.md` as long as no other note
 * is called Lyon. A target without a folder is looked for among the notes
 * being imported and the pages that exist, by its last part, ignoring case
 * as Obsidian does; when there is no single one, it is taken as written.
 */
export function linkResolver(names: string[]): (target: string) => string {
  const byLast = new Map<string, string[]>();
  for (const name of names) {
    const last = (name.split("/").at(-1) ?? "").toLowerCase();
    byLast.set(last, [...new Set([...(byLast.get(last) ?? []), name])]);
  }
  return (target) => {
    const name = pageNameOf(target);
    if (name.includes("/")) return name;
    const candidates = byLast.get(name.toLowerCase()) ?? [];
    if (candidates.length === 1) return candidates[0] as string;
    return candidates.find((candidate) => candidate === name) ?? name;
  };
}

/**
 * Obsidian's properties, a YAML block at the very top of a note. Markdown
 * would read it as a rule and a heading; it is not part of the page, and
 * is left out.
 */
export function stripFrontmatter(markdown: string): string {
  const block = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(markdown);
  return block === null ? markdown : markdown.slice(block[0].length);
}

export interface VaultFile {
  path: string;
  text: string;
}

export interface Pending {
  pages: Array<{ name: string; document: unknown }>;
  /** Pages that exist and will be replaced. */
  replacing: string[];
  /** Files with no usable name. */
  skipped: string[];
  /** Files that would become a page another file of this import already is: the first one is kept. */
  clashes: string[];
}

/** What an import will do, read from the files before anything is sent. */
export function readVault(files: VaultFile[], existing: string[]): Pending {
  const named = files.map((file) => ({ ...file, name: pageNameOf(file.path) }));
  const resolve = linkResolver([...named.map((file) => file.name).filter(isPageName), ...existing]);
  const pending: Pending = { pages: [], replacing: [], skipped: [], clashes: [] };
  const first = new Map<string, string>();
  for (const file of named) {
    if (!isPageName(file.name)) {
      pending.skipped.push(file.path);
      continue;
    }
    const earlier = first.get(file.name);
    if (earlier !== undefined) {
      pending.clashes.push(`${file.path} (the same page as ${earlier})`);
      continue;
    }
    first.set(file.name, file.path);
    const document = fromMarkdown(stripFrontmatter(file.text), schema, { wikiLinks: { node: "page_link", attr: "name", resolve } });
    pending.pages.push({ name: file.name, document });
    if (existing.includes(file.name)) pending.replacing.push(file.name);
  }
  return pending;
}

/** Search as you type: words are prefixes, matches come back marked by the server and are shown as text. */
export function Search(): ReactNode {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ name: string; snippet: string }>>([]);
  useEffect(() => {
    if (query.trim() === "") return void setHits([]);
    let live = true;
    const timer = setTimeout(() => {
      api<Array<{ name: string; snippet: string }>>(`/api/search?q=${encodeURIComponent(query)}`).then((found) => live && setHits(found), () => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <div className="search">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search the pages" />
      {query.trim() !== "" ? (
        <ul>
          {hits.length === 0 ? <li className="muted small">Nothing found.</li> : null}
          {hits.map((hit) => (
            <li key={hit.name}>
              <a href={`#${encodeURIComponent(hit.name)}`}>{hit.name}</a>
              <p className="snippet">{marked(hit.snippet)}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** \u0001…\u0002 around each match: split into text and <mark>, never parsed as HTML. */
function marked(snippet: string): ReactNode[] {
  // eslint-disable-next-line no-control-regex
  return snippet.split(/(\u0001[^\u0002]*\u0002)/).map((piece, index) =>
    piece.startsWith("\u0001") ? <mark key={index}>{piece.slice(1, -1)}</mark> : <span key={index}>{piece}</span>,
  );
}

/** The vault in and out: a ZIP of Markdown files, and Markdown files or a vault folder back in. Pages per request: the server takes up to 500, and 8 MB. */
const BATCH = 100;
const MAX_BYTES = 7_500_000;

export function Vault({ me, pages }: { me: Me; pages: PageSummary[] }): ReactNode {
  const [pending, setPending] = useState<Pending | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.name.toLowerCase().endsWith(".md"));
    event.target.value = "";
    const relative = (file: File): string => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    // A folder comes with its own name first: the vault's, not a folder of it.
    const root = relative(files[0] ?? new File([], "")).split("/")[0] ?? "";
    const inFolder = files.length > 0 && files.every((file) => relative(file).startsWith(`${root}/`));
    const vault = await Promise.all(files.map(async (file) => ({ path: inFolder ? relative(file).slice(root.length + 1) : relative(file), text: await file.text() })));
    setReport(null);
    setError(null);
    setPending(readVault(vault, pages.map((page) => page.name)));
  };

  const send = async (): Promise<void> => {
    if (pending === null || busy) return;
    setBusy(true);
    setError(null);
    let imported = 0;
    const repaired: string[] = [];
    const refused: string[] = [];
    const failed: string[] = [];
    try {
      for (let at = 0; at < pending.pages.length; at += BATCH) {
        const batch = pending.pages.slice(at, at + BATCH);
        if (new TextEncoder().encode(JSON.stringify({ pages: batch })).length > MAX_BYTES) {
          throw new ApiError(`pages ${at + 1} to ${at + batch.length} are over 7.5 MB together: import them in smaller groups`);
        }
        const result = await api<{ imported: string[]; repaired: string[]; refused: string[]; failed?: string[] }>("/api/import", { body: { pages: batch } });
        imported += result.imported.length;
        repaired.push(...result.repaired);
        refused.push(...result.refused);
        failed.push(...(result.failed ?? []));
      }
      setPending(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "the server did not answer");
    } finally {
      setBusy(false);
      const parts = [`${imported} imported`];
      if (repaired.length > 0) parts.push(`${repaired.length} repaired`);
      if (refused.length > 0) parts.push(`refused: ${refused.join(", ")}`);
      if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
      setReport(imported + refused.length + failed.length > 0 ? `${parts.join("; ")}.` : null);
    }
  };

  return (
    <div className="vault">
      <h2>Vault</h2>
      <a className="button" href="/api/export" download>
        Export as Markdown (.zip)
      </a>
      {me.role === "reader" ? null : (
        <>
          <label className="button">
            Import .md files
            <input type="file" accept=".md,text/markdown" multiple hidden onChange={(event) => void read(event)} />
          </label>
          <label className="button">
            Import a vault folder
            <input type="file" multiple hidden onChange={(event) => void read(event)} {...{ webkitdirectory: "" }} />
          </label>
        </>
      )}
      {pending === null ? null : (
        <div className="pending">
          <p className="small">
            {pending.pages.length} page{pending.pages.length === 1 ? "" : "s"} read
            {pending.replacing.length > 0 ? `; ${pending.replacing.length} will replace an existing page (${pending.replacing.join(", ")})` : ""}
            {pending.clashes.length > 0 ? `; left out, a page twice: ${pending.clashes.join(", ")}` : ""}
            {pending.skipped.length > 0 ? `; skipped, no usable name: ${pending.skipped.join(", ")}` : ""}. Properties at the top of a note are left out.
          </p>
          <button type="button" className="primary" disabled={pending.pages.length === 0 || busy} onClick={() => void send()}>
            {busy ? "Importing…" : "Import"}
          </button>
          <button type="button" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {error === null ? null : (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {report === null ? null : <p className="small muted">{report}</p>}
    </div>
  );
}
