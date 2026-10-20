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
  updatedAt: string;
}

export interface DocumentStore {
  /** The Yjs state of a page, or `null` for a page never stored. */
  load(name: string): Promise<Uint8Array | null>;
  save(page: Omit<StoredPage, "updatedAt">, state: Uint8Array): Promise<void>;
  get(name: string): Promise<StoredPage | null>;
  list(): Promise<Array<Pick<StoredPage, "name" | "hash" | "updatedBy" | "updatedAt">>>;
  close(): Promise<void>;
}

/** For tests and for running without a database: nothing survives a restart. */
export function memoryStore(): DocumentStore {
  const rows = new Map<string, { page: StoredPage; state: Uint8Array }>();
  return {
    load: async (name) => rows.get(name)?.state ?? null,
    save: async (page, state) => void rows.set(page.name, { page: { ...page, updatedAt: new Date().toISOString() }, state }),
    get: async (name) => rows.get(name)?.page ?? null,
    list: async () => [...rows.values()].map(({ page }) => ({ name: page.name, hash: page.hash, updatedBy: page.updatedBy, updatedAt: page.updatedAt })),
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
alter table pages add column if not exists updated_by text;`;

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
    updatedAt: (r.updated_at as Date).toISOString(),
  });
  return {
    load: async (name) => {
      const result = await pool.query("select state from pages where name = $1", [name]);
      return result.rows[0] === undefined ? null : new Uint8Array(result.rows[0].state as Buffer);
    },
    save: async (page, state) => {
      await pool.query(
        `insert into pages (name, state, body, hash, text, errors, updated_by, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (name) do update set state = $2, body = $3, hash = $4, text = $5, errors = $6,
           updated_by = coalesce($7, pages.updated_by), updated_at = now()`,
        [page.name, Buffer.from(state), JSON.stringify(page.body), page.hash, page.text, JSON.stringify(page.errors), page.updatedBy],
      );
    },
    get: async (name) => {
      const result = await pool.query("select name, body, hash, text, errors, updated_by, updated_at from pages where name = $1", [name]);
      return result.rows[0] === undefined ? null : row(result.rows[0]);
    },
    list: async () => {
      const result = await pool.query("select name, hash, updated_by, updated_at from pages order by name");
      return result.rows.map((r) => ({ name: r.name as string, hash: (r.hash as string | null) ?? null, updatedBy: (r.updated_by as string | null) ?? null, updatedAt: (r.updated_at as Date).toISOString() }));
    },
    close: async () => {},
  };
}
