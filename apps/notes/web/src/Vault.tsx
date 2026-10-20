import { fromMarkdown } from "@nseaprotector/coelho-prosemirror";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { isPageName, schema } from "../../server/schema.js";
import { api, type Me } from "./api.js";
import type { PageSummary } from "./Pages.js";

/** A vault's file or folder name as a page name: what Obsidian allows, held to what a link can hold. */
export function pageNameOf(path: string): string {
  return path
    .replace(/\.md$/i, "")
    .split("/")
    .map((part) =>
      part
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
        .replace(/^[-_.]+|[-_.]+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
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

interface Pending {
  pages: Array<{ name: string; document: unknown }>;
  replacing: string[];
  skipped: string[];
}

/** The vault in and out: a ZIP of Markdown files, and Markdown files or a vault folder back in. */
export function Vault({ me, pages }: { me: Me; pages: PageSummary[] }): ReactNode {
  const [pending, setPending] = useState<Pending | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const read = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.name.toLowerCase().endsWith(".md"));
    event.target.value = "";
    // A folder comes with its own name first: the vault's, not a folder of it.
    const pathOf = (file: File): string => {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return relative.includes("/") && files.every((other) => ((other as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").startsWith(relative.split("/")[0] + "/"))
        ? relative.split("/").slice(1).join("/")
        : relative;
    };
    const read: Pending = { pages: [], replacing: [], skipped: [] };
    for (const file of files) {
      const name = pageNameOf(pathOf(file));
      if (!isPageName(name)) {
        read.skipped.push(file.name);
        continue;
      }
      const document = fromMarkdown(await file.text(), schema, { wikiLinks: { node: "page_link", attr: "name", resolve: pageNameOf } });
      read.pages.push({ name, document });
      if (pages.some((page) => page.name === name)) read.replacing.push(name);
    }
    setReport(null);
    setPending(read);
  };

  const send = async (): Promise<void> => {
    if (pending === null) return;
    const result = await api<{ imported: string[]; repaired: string[]; refused: string[] }>("/api/import", { body: { pages: pending.pages } });
    setPending(null);
    setReport(`${result.imported.length} imported${result.repaired.length > 0 ? `, ${result.repaired.length} repaired` : ""}${result.refused.length > 0 ? `, ${result.refused.length} refused` : ""}.`);
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
            {pending.skipped.length > 0 ? `; skipped, no usable name: ${pending.skipped.join(", ")}` : ""}.
          </p>
          <button type="button" className="primary" disabled={pending.pages.length === 0} onClick={() => void send()}>
            Import
          </button>
          <button type="button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {report === null ? null : <p className="small muted">{report}</p>}
    </div>
  );
}
