import { fileURLToPath } from "node:url";
import { createNotesServer } from "./app.js";
import { memoryStore, postgresStore } from "./store.js";

const url = process.env.DATABASE_URL;
const store = url === undefined ? memoryStore() : await postgresStore(url);
const port = Number(process.env.PORT ?? 1234);
const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../web", import.meta.url));

const server = createNotesServer({ store, port, staticDir });
await server.listen();
console.log(`coelho notes on http://localhost:${port} (${url === undefined ? "in memory: nothing survives a restart" : "Postgres"})`);
