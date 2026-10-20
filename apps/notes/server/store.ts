import type { Document, ValidationError } from "@nseaprotector/coelho-core";
import pg from "pg";

/** A page as it is stored: the Yjs state to resume from, and the validated document derived from it. */
export interface StoredPage {
  name: string;
  /** coelho's validated JSON: what a page renders and what an export reads. */
  body: Document;
  /** sha256 of the canonical bytes; `null` for a page with nothing in it. */
  hash: string | null;
  /** Plain text, for search. */
  text: string;
  /** What the shared document held that the schema refused, repaired before it was stored. */
  errors: ValidationError[];
  /** Who made the last stored change; `null` for a page as the server seeded it. */
  updatedBy: string | null;
  /** The pages this one links to, derived from the validated body when it is stored. */
  links: string[];
  updatedAt: string;
}

export interface DocumentStore {
  /** The Yjs state of a page, or `null` for a page never stored. */
  load(name: string): Promise<Uint8Array | null>;
  save(page: Omit<StoredPage, "updatedAt">, state: Uint8Array): Promise<void>;
  get(name: string): Promise<StoredPage | null>;
  list(): Promise<Array<Pick<StoredPage, "name" | "hash" | "updatedBy" | "updatedAt">>>;
  /** The pages that link to this one. */
  backlinks(name: string): Promise<Array<Pick<StoredPage, "name" | "updatedAt">>>;
  /** Every page with its body, for an export. */
  all(): Promise<StoredPage[]>;
  /**
   * Pages whose name or text holds every word of `query`, each word read as
   * the start of a word. A snippet marks matches between \u0001 and \u0002,
   * never as HTML: the text is the writers', and is rendered as text.
   */
  search(query: string): Promise<Array<{ name: string; snippet: string }>>;
  close(): Promise<void>;
}

/** For tests and for running without a database: nothing survives a restart. */
export function memoryStore(): DocumentStore {
  const rows = new Map<string, { page: StoredPage; state: Uint8Array }>();
  return {
    load: async (name) => rows.get(name)?.state ?? null,
    save: async (page, state) => void rows.set(page.name, { page: { ...page, updatedAt: new Date().toISOString() }, state }),
    get: async (name) => rows.get(name)?.page ?? null,
    list: async () =>
      [...rows.values()].map(({ page }) => ({ name: page.name, hash: page.hash, updatedBy: page.updatedBy, updatedAt: page.updatedAt })).sort((a, b) => a.name.localeCompare(b.name)),
    backlinks: async (name) =>
      [...rows.values()].filter(({ page }) => page.links.includes(name)).map(({ page }) => ({ name: page.name, updatedAt: page.updatedAt })).sort((a, b) => a.name.localeCompare(b.name)),
    all: async () => [...rows.values()].map(({ page }) => page),
    search: async (query) => {
      const words = wordsOf(query).map((word) => word.toLowerCase());
      if (words.length === 0) return [];
      const found: Array<{ name: string; snippet: string }> = [];
      for (const { page } of rows.values()) {
        const haystack = `${page.name} ${page.text}`.toLowerCase();
        const tokens = haystack.split(/[^\p{L}\p{N}]+/u);
        if (!words.every((word) => tokens.some((token) => token.startsWith(word)))) continue;
        found.push({ name: page.name, snippet: snippetOf(page.text, words) });
      }
      return found.sort((a, b) => a.name.localeCompare(b.name));
    },
    close: async () => {},
  };
}

const MIGRATION = `
create table if not exists pages (
  name       text primary key,
  state      bytea not null,
  body       jsonb not null,
  hash       text,
  text       text not null default '',
  errors     jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table pages add column if not exists updated_by text;
alter table pages add column if not exists links text[] not null default '{}';
create index if not exists pages_links on pages using gin (links);
-- Postgres reads "siege/semaine-42" as one path-like word, so "sema" would
-- not find it: separators become spaces before the words are indexed.
alter table pages drop column if exists search;
alter table pages add column if not exists search_words tsvector
  generated always as (to_tsvector('simple', regexp_replace(name || ' ' || text, '[/_.-]', ' ', 'g'))) stored;
create index if not exists pages_search_words on pages using gin (search_words);`;

/**
 * Pages in Postgres. The Yjs state is what the room resumes from; the body
 * is coelho's validated JSON in a jsonb column, next to its hash and its
 * text, derived at write time so a search never has to extract it.
 */
export async function postgresStore(pool: pg.Pool): Promise<DocumentStore> {
  await pool.query(MIGRATION);
  const row = (r: Record<string, unknown>): StoredPage => ({
    name: r.name as string,
    body: r.body as Document,
    hash: (r.hash as string | null) ?? null,
    text: r.text as string,
    errors: r.errors as ValidationError[],
    updatedBy: (r.updated_by as string | null) ?? null,
    links: (r.links as string[] | null) ?? [],
    updatedAt: (r.updated_at as Date).toISOString(),
  });
  return {
    load: async (name) => {
      const result = await pool.query("select state from pages where name = $1", [name]);
      return result.rows[0] === undefined ? null : new Uint8Array(result.rows[0].state as Buffer);
    },
    save: async (page, state) => {
      await pool.query(
        `insert into pages (name, state, body, hash, text, errors, updated_by, links, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (name) do update set state = $2, body = $3, hash = $4, text = $5, errors = $6,
           updated_by = coalesce($7, pages.updated_by), links = $8, updated_at = now()`,
        [page.name, Buffer.from(state), JSON.stringify(page.body), page.hash, page.text, JSON.stringify(page.errors), page.updatedBy, page.links],
      );
    },
    get: async (name) => {
      const result = await pool.query("select name, body, hash, text, errors, updated_by, links, updated_at from pages where name = $1", [name]);
      return result.rows[0] === undefined ? null : row(result.rows[0]);
    },
    list: async () => {
      const result = await pool.query("select name, hash, updated_by, updated_at from pages order by name");
      return result.rows.map((r) => ({ name: r.name as string, hash: (r.hash as string | null) ?? null, updatedBy: (r.updated_by as string | null) ?? null, updatedAt: (r.updated_at as Date).toISOString() }));
    },
    backlinks: async (name) => {
      const result = await pool.query("select name, updated_at from pages where $1 = any(links) order by name", [name]);
      return result.rows.map((r) => ({ name: r.name as string, updatedAt: (r.updated_at as Date).toISOString() }));
    },
    all: async () => {
      const result = await pool.query("select name, body, hash, text, errors, updated_by, links, updated_at from pages order by name");
      return result.rows.map(row);
    },
    search: async (query) => {
      const words = wordsOf(query);
      if (words.length === 0) return [];
      // Words only, each a prefix: the query is built from letters and
      // digits, so nothing a writer types is read as tsquery syntax.
      const tsquery = words.map((word) => `${word}:*`).join(" & ");
      const result = await pool.query(
        `select name, ts_headline('simple', text, to_tsquery('simple', $1), 'StartSel=' || chr(1) || ', StopSel=' || chr(2) || ', MaxWords=18, MinWords=6') as snippet
         from pages where search_words @@ to_tsquery('simple', $1) order by ts_rank(search_words, to_tsquery('simple', $1)) desc, name limit 30`,
        [tsquery],
      );
      return result.rows.map((r) => ({ name: r.name as string, snippet: r.snippet as string }));
    },
    close: async () => {},
  };
}

/** Up to eight words of letters and digits: what a search is made of. */
function wordsOf(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
}

/**
 * Some words around the first match, matches marked as the Postgres store
 * marks them. A match is a word starting with one of the query's words, as
 * the search itself reads them; when the match is in the page's name only,
 * the snippet is the start of its text.
 */
export function snippetOf(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})[\\p{L}\\p{N}]*`, "giu");
  const at = pattern.exec(flat)?.index ?? 0;
  pattern.lastIndex = 0;
  return flat.slice(Math.max(0, at - 40), at + 80).replace(pattern, (match) => `\u0001${match}\u0002`);
}
