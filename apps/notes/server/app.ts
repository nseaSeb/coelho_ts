import { FIELD, seed, snapshot } from "@nseaprotector/coelho-collab";
import { hash, toText } from "@nseaprotector/coelho-core";
import { Database } from "@hocuspocus/extension-database";
import { Server, type Extension } from "@hocuspocus/server";
import express from "express";
import { existsSync } from "node:fs";
import * as Y from "yjs";
import { firstPage, schema } from "./schema.js";
import type { DocumentStore } from "./store.js";

export interface NotesServerOptions {
  store: DocumentStore;
  port?: number;
  /** The built web app to serve, if any. */
  staticDir?: string;
  /** How long after the last change a page is stored, in ms. */
  debounce?: number;
}

/**
 * The collaboration server. Every writer of a page is connected to it; it
 * seeds a page the first time it is opened, and stores it — validated —
 * after changes settle. The shared document is not a trust boundary: any
 * client can write anything into it, so this is where what is stored is
 * decided, by coelho's schema.
 */
export function createNotesServer(options: NotesServerOptions): Server {
  const { store } = options;

  const persist = async (name: string, document: Y.Doc, state: Uint8Array): Promise<void> => {
    const { document: body, errors } = snapshot(document, schema);
    await store.save({ name, body, hash: await hash(body), text: toText(body, schema), errors }, state);
  };

  // A page that has never been stored is seeded here, once per room, rather
  // than by whichever client opens it first: two clients seeding the same
  // empty room would show its content twice. It is stored at once, since
  // Hocuspocus only stores after a change from a client.
  const seeding: Extension = {
    priority: 50,
    async onLoadDocument({ document, documentName }) {
      if (document.getXmlFragment(FIELD).length > 0) return;
      seed(document, schema, firstPage(documentName));
      await persist(documentName, document, Y.encodeStateAsUpdate(document));
    },
  };

  const persistence = new Database({
    fetch: async ({ documentName }) => store.load(documentName),
    store: async ({ documentName, document, state }) => persist(documentName, document, state),
  });

  const app = express();
  app.get("/api/pages", async (_request, response) => {
    response.json(await store.list());
  });
  app.get("/api/pages/:name", async (request, response) => {
    const page = await store.get(request.params.name);
    if (page === null) response.status(404).json({ error: "no such page" });
    else response.json(page);
  });
  if (options.staticDir !== undefined && existsSync(options.staticDir)) app.use(express.static(options.staticDir));

  // Express answers HTTP on the same port as the WebSockets. A request it
  // handles stops Hocuspocus's own reply; one it does not falls through.
  const http: Extension = {
    onRequest: ({ request, response }) =>
      new Promise<void>((resolve, reject) => {
        response.once("finish", () => reject(null));
        app(request as express.Request, response as express.Response, (error?: unknown) => (error ? reject(error) : resolve()));
      }),
  };

  return new Server({
    port: options.port ?? 1234,
    quiet: true,
    debounce: options.debounce ?? 1000,
    maxDebounce: 5000,
    extensions: [persistence, seeding, http],
  });
}
