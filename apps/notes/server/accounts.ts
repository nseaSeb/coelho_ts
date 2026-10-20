import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { isId } from "./store.js";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export type Role = "admin" | "editor" | "reader";
export const ROLES: Role[] = ["admin", "editor", "reader"];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AccountStore {
  /**
   * Creates an account. The first one in an empty store is the admin,
   * whatever `role` says; deciding that and inserting are one step, so two
   * people signing up at once cannot both be first.
   */
  create(account: { email: string; name: string; passwordHash: string; role: Role }): Promise<User | "taken">;
  byEmail(email: string): Promise<(User & { passwordHash: string }) | null>;
  list(): Promise<User[]>;
  setRole(id: string, role: Role): Promise<User | null>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** The user a session belongs to, if it exists and has not expired. */
  sessionUser(tokenHash: string): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

// -- Passwords and sessions --------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

/** `scrypt$N$r$p$salt$key`: the parameters travel with the hash, so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || key === undefined) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A new session token, and the hash that is stored in its place: a leaked table opens no session. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// -- Stores ------------------------------------------------------------------

export function memoryAccounts(): AccountStore {
  const users = new Map<string, User & { passwordHash: string }>();
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const plain = (account: User & { passwordHash: string }): User => ({ id: account.id, email: account.email, name: account.name, role: account.role });
  let next = 1;
  return {
    create: async ({ email, name, passwordHash, role }) => {
      if ([...users.values()].some((user) => user.email === email)) return "taken";
      const user = { id: String(next++), email, name, passwordHash, role: users.size === 0 ? "admin" : role };
      users.set(user.id, user);
      return plain(user);
    },
    byEmail: async (email) => [...users.values()].find((user) => user.email === email) ?? null,
    list: async () => [...users.values()].map(plain),
    setRole: async (id, role) => {
      const user = users.get(id);
      if (user === undefined) return null;
      user.role = role;
      return plain(user);
    },
    createSession: async (userId, tokenHash, expiresAt) => void sessions.set(tokenHash, { userId, expiresAt }),
    sessionUser: async (tokenHash) => {
      const session = sessions.get(tokenHash);
      if (session === undefined || session.expiresAt.getTime() < Date.now()) return null;
      const user = users.get(session.userId);
      return user === undefined ? null : plain(user);
    },
    deleteSession: async (tokenHash) => void sessions.delete(tokenHash),
  };
}

const MIGRATION = `
create table if not exists users (
  id            bigserial primary key,
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  role          text not null check (role in ('admin', 'editor', 'reader')),
  created_at    timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id    bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists sessions_expires_at on sessions (expires_at);`;

export async function postgresAccounts(pool: pg.Pool): Promise<AccountStore> {
  await pool.query(MIGRATION);
  const user = (row: Record<string, unknown>): User => ({ id: String(row.id), email: row.email as string, name: row.name as string, role: row.role as Role });
  return {
    create: async ({ email, name, passwordHash, role }) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        // Who is first is decided under a lock: two sign-ups at the same
        // moment on an empty table would otherwise both see it empty.
        await client.query("lock table users in share row exclusive mode");
        const existing = await client.query("select 1 from users where email = $1", [email]);
        if (existing.rowCount !== 0) {
          await client.query("rollback");
          return "taken";
        }
        const count = await client.query("select count(*)::int as n from users");
        const result = await client.query(
          "insert into users (email, name, password_hash, role) values ($1, $2, $3, $4) returning id, email, name, role",
          [email, name, passwordHash, count.rows[0].n === 0 ? "admin" : role],
        );
        await client.query("commit");
        return user(result.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    byEmail: async (email) => {
      const result = await pool.query("select id, email, name, role, password_hash from users where email = $1", [email]);
      const row = result.rows[0];
      return row === undefined ? null : { ...user(row), passwordHash: row.password_hash as string };
    },
    list: async () => (await pool.query("select id, email, name, role from users order by id")).rows.map(user),
    setRole: async (id, role) => {
      if (!isId(id)) return null;
      const result = await pool.query("update users set role = $2 where id = $1 returning id, email, name, role", [id, role]);
      return result.rows[0] === undefined ? null : user(result.rows[0]);
    },
    createSession: async (userId, tokenHash, expiresAt) => {
      await pool.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)", [tokenHash, userId, expiresAt]);
    },
    sessionUser: async (tokenHash) => {
      const result = await pool.query(
        "select u.id, u.email, u.name, u.role from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()",
        [tokenHash],
      );
      return result.rows[0] === undefined ? null : user(result.rows[0]);
    },
    deleteSession: async (tokenHash) => {
      await pool.query("delete from sessions where token_hash = $1", [tokenHash]);
    },
  };
}
