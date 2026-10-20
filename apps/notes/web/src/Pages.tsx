import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { isPageName } from "../../server/schema.js";
import type { Missing } from "../../server/store.js";
import type { Me } from "./api.js";
import { Search, Vault } from "./Vault.js";

export interface PageSummary {
  name: string;
  updatedBy: string | null;
  updatedAt: string;
}

/** What `/api/pages` answers: the pages, and those linked to and not written yet. */
export interface Listing {
  pages: PageSummary[];
  missing: Missing[];
}

type Entry = { kind: "page"; page: PageSummary } | { kind: "missing"; missing: Missing };

interface Folder {
  entries: Entry[];
  folders: Map<string, Folder>;
}

/** `docs/getting-started` lives in the folder `docs`: the tree is read off the names, written or not. */
function treeOf({ pages, missing }: Listing): Folder {
  const root: Folder = { entries: [], folders: new Map() };
  const entries: Entry[] = [...pages.map((page): Entry => ({ kind: "page", page })), ...missing.map((one): Entry => ({ kind: "missing", missing: one }))];
  entries.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const entry of entries) {
    const parts = nameOf(entry).split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (next === undefined) {
        next = { entries: [], folders: new Map() };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.entries.push(entry);
  }
  return root;
}

/** "linked from a, b and 3 more": the server sends the first five. */
export function linkedFrom({ linkedFrom: names, linkCount }: Missing): string {
  const more = linkCount - names.length;
  return `not written yet; linked from ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

const nameOf = (entry: Entry): string => (entry.kind === "page" ? entry.page.name : entry.missing.name);

function Branch({ folder, current }: { folder: Folder; current: string }): ReactNode {
  return (
    <ul>
      {[...folder.folders].map(([name, child]) => (
        <li key={`folder:${name}`} className="folder">
          <span>{name}/</span>
          <Branch folder={child} current={current} />
        </li>
      ))}
      {folder.entries.map((entry) => {
        const name = nameOf(entry);
        const title = entry.kind === "missing" ? linkedFrom(entry.missing) : entry.page.updatedBy === null ? undefined : `last changed by ${entry.page.updatedBy}`;
        return (
          <li key={name}>
            <a href={`#${encodeURIComponent(name)}`} className={entry.kind === "missing" ? "missing" : undefined} aria-current={name === current ? "page" : undefined} title={title}>
              {name.split("/").at(-1)}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar({ listing, current, me }: { listing: Listing; current: string; me: Me }): ReactNode {
  const [draft, setDraft] = useState("");
  // Not rebuilt as a name is typed below: only when the listing changes.
  const tree = useMemo(() => treeOf(listing), [listing]);
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
      <Search />
      <h2>Pages</h2>
      <Branch folder={tree} current={current} />
      <form onSubmit={create}>
        <input value={draft} onChange={(event) => setDraft(event.target.value.trim())} placeholder="new page, or folder/page" aria-label="New page name" aria-invalid={draft !== "" && !valid} />
        <button type="submit" disabled={!valid}>
          Open
        </button>
      </form>
      {draft !== "" && !valid ? <p className="small muted">Letters, digits, - _ . and / for folders.</p> : null}
      <Vault me={me} pages={listing.pages} />
    </nav>
  );
}
