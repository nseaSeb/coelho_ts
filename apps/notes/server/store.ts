import type { Document, ValidationError } from "@nseaprotector/coelho-core";
import pg from "pg";
import { isId } from "./ids.js";

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

/** A page as it was at one moment of its history. */
export interface PageVersion {
  id: string;
  name: string;
  body: Document;
  hash: string | null;
  /** Who wrote it; `null` for the page as the server seeded it. */
  createdBy: string | null;
  /** Why this version exists, when it is not someone writing: "imported", "restored from #12". */
  note: string | null;
  createdAt: string;
  /** The last change folded into it: a writer's session is one version, not one per save. */
  updatedAt: string;
}

export type VersionSummary = Omit<PageVersion, "body">;

/** A page linked to and not written yet. */
export interface Missing {
  name: string;
  /** The first five pages that link to it. */
  linkedFrom: string[];
  linkCount: number;
}

/**
 * Code point order: the order of UTF-8 bytes, which is Postgres's
 * `collate "C"`. Not `<`, which compares UTF-16 units and puts a letter
 * beyond U+FFFF before "Ａ". Both stores sort names this way.
 */
export function byCodePoint(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

export interface DocumentStore {
  /** The Yjs state of a page, or `null` for a page never stored. */
  load(name: string): Promise<Uint8Array | null>;
  /** Whether a page was ever stored, without reading it. */
  exists(name: string): Promise<boolean>;
  save(page: Omit<StoredPage, "updatedAt">, state: Uint8Array): Promise<void>;
  get(name: string): Promise<StoredPage | null>;
  list(): Promise<Array<Pick<StoredPage, "name" | "hash" | "updatedBy" | "updatedAt">>>;
  /**
   * The pages linked to and not written yet, by name, each with how many
   * pages link to it and the first five of them, by name in code point order.
   */
  missing(): Promise<Missing[]>;
  /**
   * Moves the pages named out of the way: kept, in a table of their own,
   * and served by nothing. For names stored before every name was checked.
   */
  quarantine(names: string[]): Promise<void>;
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
  /** A page's history, newest first, without the bodies: `limit` of them, older than `before` if given. */
  versions(name: string, page?: { before?: string; limit?: number }): Promise<VersionSummary[]>;
  /** A version, and the id of the one before it: what it changed is the difference with that one. */
  version(name: string, id: string): Promise<(PageVersion & { previousId: string | null }) | null>;
  /** The newest version, or `null` for a page with no history yet. */
  latestVersion(name: string): Promise<VersionSummary | null>;
  addVersion(version: Omit<PageVersion, "id" | "createdAt" | "updatedAt">): Promise<PageVersion>;
  /** Folds a new state into an existing version. */
  updateVersion(id: string, change: Pick<PageVersion, "body" | "hash">): Promise<void>;
  /** A page's threads room: its Yjs state, or `null` before anyone commented. */
  loadThreads(name: string): Promise<Uint8Array | null>;
  /** Stores the threads room's state, and its threads as JSON for the API. */
  saveThreads(name: string, state: Uint8Array, threads: unknown[]): Promise<void>;
  /** A page's threads as last stored. */
  threads(name: string): Promise<unknown[]>;
  close(): Promise<void>;
}

/** For tests and for running without a database: nothing survives a restart. */
export function memoryStore(): DocumentStore {
  const rows = new Map<string, { page: StoredPage; state: Uint8Array }>();
  const quarantined = new Map<string, { page: StoredPage; state: Uint8Array }>();
  const history: PageVersion[] = [];
  const discussions = new Map<string, { state: Uint8Array; threads: unknown[] }>();
  let nextVersion = 1;
  const summary = (version: PageVersion): VersionSummary => {
    const { body, ...rest } = version;
    void body;
    return rest;
  };
  return {
    loadThreads: async (name) => discussions.get(name)?.state ?? null,
    saveThreads: async (name, state, threads) => void discussions.set(name, { state, threads }),
    threads: async (name) => discussions.get(name)?.threads ?? [],
    versions: async (name, page = {}) => {
      // An id that is not one is ignored, as Postgres's store does.
      const before = page.before !== undefined && isId(page.before) ? Number(page.before) : null;
      return history
        .filter((version) => version.name === name && (before === null || Number(version.id) < before))
        .reverse()
        .slice(0, Math.min(page.limit ?? 50, 200))
        .map(summary);
    },
    version: async (name, id) => {
      const mine = history.filter((version) => version.name === name);
      const at = mine.findIndex((version) => version.id === id);
      return at === -1 ? null : { ...(mine[at] as PageVersion), previousId: mine[at - 1]?.id ?? null };
    },
    latestVersion: async (name) => {
      for (let i = history.length - 1; i >= 0; i -= 1) if (history[i]!.name === name) return summary(history[i]!);
      return null;
    },
    addVersion: async (version) => {
      const now = new Date().toISOString();
      const stored = { ...version, id: String(nextVersion++), createdAt: now, updatedAt: now };
      history.push(stored);
      return stored;
    },
    updateVersion: async (id, change) => {
      const version = history.find((one) => one.id === id);
      if (version !== undefined) Object.assign(version, change, { updatedAt: new Date().toISOString() });
    },
    load: async (name) => rows.get(name)?.state ?? null,
    exists: async (name) => rows.has(name),
    // A store without an author (the server seeding) keeps the last one, as Postgres does.
    save: async (page, state) =>
      void rows.set(page.name, { page: { ...page, updatedBy: page.updatedBy ?? rows.get(page.name)?.page.updatedBy ?? null, updatedAt: new Date().toISOString() }, state }),
    get: async (name) => rows.get(name)?.page ?? null,
    list: async () =>
      [...rows.values()].map(({ page }) => ({ name: page.name, hash: page.hash, updatedBy: page.updatedBy, updatedAt: page.updatedAt })).sort((a, b) => byCodePoint(a.name, b.name)),
    quarantine: async (names) => {
      for (const name of names) {
        const row = rows.get(name);
        if (row === undefined) continue;
        quarantined.set(name, row);
        rows.delete(name);
      }
    },
    missing: async () => {
      const linking = new Map<string, string[]>();
      for (const { page } of rows.values()) {
        for (const link of page.links) {
          if (rows.has(link)) continue;
          let from = linking.get(link);
          if (from === undefined) linking.set(link, (from = []));
          from.push(page.name);
        }
      }
      return [...linking]
        .sort(([a], [b]) => byCodePoint(a, b))
        .map(([name, from]) => ({ name, linkedFrom: from.sort(byCodePoint).slice(0, 5), linkCount: from.length }));
    },
    backlinks: async (name) =>
      [...rows.values()].filter(({ page }) => page.links.includes(name)).map(({ page }) => ({ name: page.name, updatedAt: page.updatedAt })).sort((a, b) => byCodePoint(a.name, b.name)),
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
      return found.sort((a, b) => byCodePoint(a.name, b.name));
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
-- Postgres reads "projects/sprint-42" as one path-like word, so "spri" would
-- not find it: separators become spaces before the words are indexed.
alter table pages drop column if exists search;
alter table pages add column if not exists search_words tsvector
  generated always as (to_tsvector('simple', regexp_replace(name || ' ' || text, '[/_.-]', ' ', 'g'))) stored;
create index if not exists pages_search_words on pages using gin (search_words);
create table if not exists page_versions (
  id         bigserial primary key,
  name       text not null,
  body       jsonb not null,
  hash       text,
  created_by text,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists page_versions_name on page_versions (name, id desc);
-- Pages stored under a name that is not a page's, before every name was
-- checked: kept here, served by nothing.
create table if not exists pages_quarantine (
  name           text not null,
  state          bytea not null,
  body           jsonb not null,
  hash           text,
  text           text not null,
  errors         jsonb not null,
  updated_by     text,
  links          text[] not null,
  updated_at     timestamptz not null,
  quarantined_at timestamptz not null default now()
);
create table if not exists page_threads (
  name       text primary key,
  state      bytea not null,
  threads    jsonb not null default '[]',
  updated_at timestamptz not null default now()
);`;

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
    exists: async (name) => (await pool.query("select 1 from pages where name = $1", [name])).rowCount === 1,
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
      const result = await pool.query('select name, hash, updated_by, updated_at from pages order by name collate "C"');
      return result.rows.map((r) => ({ name: r.name as string, hash: (r.hash as string | null) ?? null, updatedBy: (r.updated_by as string | null) ?? null, updatedAt: (r.updated_at as Date).toISOString() }));
    },
    quarantine: async (names) => {
      if (names.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into pages_quarantine (name, state, body, hash, text, errors, updated_by, links, updated_at)
           select name, state, body, hash, text, errors, updated_by, links, updated_at from pages where name = any($1::text[])`,
          [names],
        );
        await client.query("delete from pages where name = any($1::text[])", [names]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    missing: async () => {
      const result = await pool.query(
        `select link as name, (array_agg(p.name order by p.name collate "C"))[1:5] as linked_from, count(*)::int as link_count
         from pages p cross join lateral unnest(p.links) as link
         where not exists (select 1 from pages q where q.name = link)
         group by link order by link collate "C"`,
      );
      return result.rows.map((r) => ({ name: r.name as string, linkedFrom: r.linked_from as string[], linkCount: r.link_count as number }));
    },
    backlinks: async (name) => {
      const result = await pool.query('select name, updated_at from pages where $1 = any(links) order by name collate "C"', [name]);
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
         from pages where search_words @@ to_tsquery('simple', $1) order by ts_rank(search_words, to_tsquery('simple', $1)) desc, name collate "C" limit 30`,
        [tsquery],
      );
      return result.rows.map((r) => ({ name: r.name as string, snippet: r.snippet as string }));
    },
    versions: async (name, page = {}) => {
      const before = page.before !== undefined && isId(page.before) ? page.before : null;
      const result = await pool.query(
        "select id, name, hash, created_by, note, created_at, updated_at from page_versions where name = $1 and ($2::bigint is null or id < $2) order by id desc limit $3",
        [name, before, Math.min(page.limit ?? 50, 200)],
      );
      return result.rows.map((r) => versionOf(r) as VersionSummary);
    },
    version: async (name, id) => {
      if (!isId(id)) return null;
      const result = await pool.query(
        "select *, (select max(id) from page_versions p where p.name = v.name and p.id < v.id) as previous_id from page_versions v where name = $1 and id = $2",
        [name, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : { ...(versionOf(row) as PageVersion), previousId: row.previous_id === null ? null : String(row.previous_id) };
    },
    latestVersion: async (name) => {
      const result = await pool.query("select id, name, hash, created_by, note, created_at, updated_at from page_versions where name = $1 order by id desc limit 1", [name]);
      return result.rows[0] === undefined ? null : (versionOf(result.rows[0]) as VersionSummary);
    },
    addVersion: async (version) => {
      const result = await pool.query(
        "insert into page_versions (name, body, hash, created_by, note) values ($1, $2, $3, $4, $5) returning *",
        [version.name, JSON.stringify(version.body), version.hash, version.createdBy, version.note],
      );
      return versionOf(result.rows[0]) as PageVersion;
    },
    updateVersion: async (id, change) => {
      await pool.query("update page_versions set body = $2, hash = $3, updated_at = now() where id = $1", [id, JSON.stringify(change.body), change.hash]);
    },
    loadThreads: async (name) => {
      const result = await pool.query("select state from page_threads where name = $1", [name]);
      return result.rows[0] === undefined ? null : new Uint8Array(result.rows[0].state as Buffer);
    },
    saveThreads: async (name, state, threads) => {
      await pool.query(
        `insert into page_threads (name, state, threads, updated_at) values ($1, $2, $3, now())
         on conflict (name) do update set state = $2, threads = $3, updated_at = now()`,
        [name, Buffer.from(state), JSON.stringify(threads)],
      );
    },
    threads: async (name) => {
      const result = await pool.query("select threads from page_threads where name = $1", [name]);
      return (result.rows[0]?.threads as unknown[] | undefined) ?? [];
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

function versionOf(r: Record<string, unknown>): PageVersion | VersionSummary {
  const version: VersionSummary = {
    id: String(r.id),
    name: r.name as string,
    hash: (r.hash as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
  return r.body === undefined ? version : { ...version, body: r.body as Document };
}
