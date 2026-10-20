import { fileURLToPath } from "node:url";
import pg from "pg";
import { memoryAccounts, postgresAccounts, ROLES, type Role } from "./accounts.js";
import { createNotesServer } from "./app.js";
import { memoryStore, postgresStore } from "./store.js";

const url = process.env.DATABASE_URL;
const pool = url === undefined ? null : new pg.Pool({ connectionString: url });
const store = pool === null ? memoryStore() : await postgresStore(pool);
const accounts = pool === null ? memoryAccounts() : await postgresAccounts(pool);
const port = Number(process.env.PORT ?? 1234);
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../web", import.meta.url));
const defaultRole = (ROLES as string[]).includes(process.env.DEFAULT_ROLE ?? "") ? (process.env.DEFAULT_ROLE as Role) : "reader";

const server = createNotesServer({
  store,
  accounts,
  port,
  staticDir,
  defaultRole,
  signup: process.env.SIGNUP !== "closed",
  secureCookies: process.env.COOKIE_SECURE === "true",
});
await server.listen();
console.log(`coelho notes on http://localhost:${port} (${url === undefined ? "in memory: nothing survives a restart" : "Postgres"}; sign-up ${process.env.SIGNUP === "closed" ? "closed" : "open"}, new accounts are ${defaultRole}s)`);
