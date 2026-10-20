import { useState, type FormEvent, type ReactNode } from "react";
import { isPageName } from "../../server/schema.js";

export interface PageSummary {
  name: string;
  updatedBy: string | null;
  updatedAt: string;
}

interface Folder {
  pages: PageSummary[];
  folders: Map<string, Folder>;
}

/** `siege/programme` lives in the folder `siege`: the tree is read off the names. */
function treeOf(pages: PageSummary[]): Folder {
  const root: Folder = { pages: [], folders: new Map() };
  for (const page of pages) {
    const parts = page.name.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (next === undefined) {
        next = { pages: [], folders: new Map() };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.pages.push(page);
  }
  return root;
}

function Branch({ folder, current }: { folder: Folder; current: string }): ReactNode {
  return (
    <ul>
      {[...folder.folders].map(([name, child]) => (
        <li key={`folder:${name}`} className="folder">
          <span>{name}/</span>
          <Branch folder={child} current={current} />
        </li>
      ))}
      {folder.pages.map((page) => (
        <li key={page.name}>
          <a href={`#${encodeURIComponent(page.name)}`} aria-current={page.name === current ? "page" : undefined} title={page.updatedBy === null ? undefined : `last changed by ${page.updatedBy}`}>
            {page.name.split("/").at(-1)}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Sidebar({ pages, current }: { pages: PageSummary[]; current: string }): ReactNode {
  const [draft, setDraft] = useState("");
  const valid = isPageName(draft);
  const create = (event: FormEvent): void => {
    event.preventDefault();
    if (valid) {
      location.hash = encodeURIComponent(draft);
      setDraft("");
    }
  };
  return (
    <nav className="sidebar" aria-label="Pages">
      <h2>Pages</h2>
      <Branch folder={treeOf(pages)} current={current} />
      <form onSubmit={create}>
        <input value={draft} onChange={(event) => setDraft(event.target.value.trim())} placeholder="new page, or folder/page" aria-label="New page name" aria-invalid={draft !== "" && !valid} />
        <button type="submit" disabled={!valid}>
          Open
        </button>
      </form>
      {draft !== "" && !valid ? <p className="small muted">Letters, digits, - _ . and / for folders.</p> : null}
    </nav>
  );
}
