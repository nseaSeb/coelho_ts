import { FIELD, replace, seed, snapshot } from "@nseaprotector/coelho-collab";
import { hash, toMarkdown, toText, validate } from "@nseaprotector/coelho-core";
import { Database } from "@hocuspocus/extension-database";
import { Server, type Extension } from "@hocuspocus/server";
import express from "express";
import { existsSync } from "node:fs";
import * as Y from "yjs";
import { firstPage, isPageName, linksOf, schema } from "./schema.js";
import { zip } from "./zip.js";
import type { AccountStore, Role, User } from "./accounts.js";
import { authRoutes, colorOf, userFrom } from "./auth.js";
import type { DocumentStore } from "./store.js";

export interface NotesServerOptions {
  store: DocumentStore;
  accounts: AccountStore;
  /** The role of everyone who signs up after the first, who is the admin. Default: reader. */
  defaultRole?: Role;
  /** `false` closes sign-up, except for the very first account. Default: open. */
  signup?: boolean;
  secureCookies?: boolean;
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

  const { accounts } = options;
  const persist = async (name: string, document: Y.Doc, state: Uint8Array, by: User | null): Promise<void> => {
    const { document: body, errors } = snapshot(document, schema);
    await store.save({ name, body, hash: await hash(body), text: toText(body, schema), errors, updatedBy: by?.name ?? null, links: linksOf(body) }, state);
  };

  // Every connection is someone signed in. A reader's connection is read
  // only on the server, where a modified client cannot lift it.
  const authentication: Extension = {
    priority: 200,
    async onAuthenticate({ requestHeaders, connectionConfig, documentName }) {
      const user = await userFrom(accounts, requestHeaders.get("cookie"));
      if (user === null) throw new Error("sign in first");
      // A room is a page, and a page has a name a link can hold.
      if (!isPageName(documentName)) throw new Error("not a page name");
      if (user.role === "reader") connectionConfig.readOnly = true;
      return { user };
    },
    // Presence says who is where; the server says who. Whatever name a
    // client puts in its presence, the one shown to others is its account's.
    async beforeHandleAwareness({ context, states }) {
      const user = (context as { user?: User } | undefined)?.user;
      if (user === undefined) return;
      for (const [clientId, state] of states) states.set(clientId, { ...state, user: { id: user.id, name: user.name, color: colorOf(user) } });
    },
  };

  // A page that has never been stored is seeded here, once per room, rather
  // than by whichever client opens it first: two clients seeding the same
  // empty room would show its content twice. It is stored at once, since
  // Hocuspocus only stores after a change from a client.
  const seeding: Extension = {
    priority: 50,
    async onLoadDocument({ document, documentName, context }) {
      // An import writes the page itself: seeding it first would only be overwritten.
      if (document.getXmlFragment(FIELD).length > 0 || (context as { importing?: boolean } | undefined)?.importing) return;
      seed(document, schema, firstPage(documentName));
      await persist(documentName, document, Y.encodeStateAsUpdate(document), null);
    },
  };

  const persistence = new Database({
    fetch: async ({ documentName }) => store.load(documentName),
    store: async ({ documentName, document, state, lastContext }) => persist(documentName, document, state, (lastContext as { user?: User } | undefined)?.user ?? null),
  });

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(
    authRoutes({
      accounts,
      defaultRole: options.defaultRole ?? "reader",
      signup: options.signup ?? true,
      secureCookies: options.secureCookies ?? false,
      // A new role applies now: their sockets close, and their browsers
      // reconnect and authenticate again under it. Closing the document
      // connection alone would leave the socket open and the client idle.
      onRoleChanged: (userId) => {
        for (const document of server.hocuspocus.documents.values()) {
          for (const connection of document.getConnections()) {
            if ((connection.context as { user?: User } | undefined)?.user?.id === userId) connection.webSocket.close(4000, "role changed");
          }
        }
      },
    }),
  );
  app.use(["/api/pages", "/api/export", "/api/search"], async (request, response, next) => {
    if ((await userFrom(accounts, request.headers.cookie)) === null) response.status(401).json({ error: "sign in first" });
    else next();
  });
  app.get("/api/pages", async (_request, response) => {
    response.json(await store.list());
  });
  // The vault: one Markdown file per page, in folders, links as Obsidian writes them.
  app.get("/api/export", async (_request, response) => {
    const pages = await store.all();
    const files = pages.map((page) => ({
      path: `${page.name}.md`,
      data: Buffer.from(`${toMarkdown(page.body, schema, { nodes: { page_link: (node) => `[[${String(node.attrs?.name)}]]` } })}\n`, "utf8"),
    }));
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", 'attachment; filename="coelho-notes.zip"');
    response.end(await zip(files));
  });

  app.get("/api/search", async (request, response) => {
    response.json(await store.search(String(request.query.q ?? "").slice(0, 200)));
  });

  // Pages read from Markdown in the browser, which has the DOM the reading
  // needs. Each is a claim, revalidated here, and written into its room
  // through the server's own connection: whoever has it open sees it
  // change, and it is stored as anyone's change is, under who imported it.
  // The session is checked before the body, the only large one, is read.
  const editorOnly: express.RequestHandler = async (request, response, next) => {
    const user = await userFrom(accounts, request.headers.cookie);
    if (user === null) return void response.status(401).json({ error: "sign in first" });
    if (user.role === "reader") return void response.status(403).json({ error: "readers cannot import" });
    response.locals.user = user;
    next();
  };
  app.post("/api/import", editorOnly, express.json({ limit: "8mb" }), async (request, response) => {
    const user = response.locals.user as User;
    const pages = (request.body as { pages?: unknown })?.pages;
    if (!Array.isArray(pages) || pages.length > 500) return void response.status(400).json({ error: "pages: a list of at most 500 { name, document }" });
    const imported: string[] = [];
    const repaired: string[] = [];
    const refused: string[] = [];
    const failed: string[] = [];
    for (const entry of pages as Array<{ name?: unknown; document?: unknown }>) {
      if (!isPageName(entry?.name)) {
        refused.push(String(entry?.name ?? ""));
        continue;
      }
      const name = entry.name;
      // One page failing is reported, and does not stop the others.
      try {
        const checked = validate(entry.document, schema);
        const connection = await server.hocuspocus.openDirectConnection(name, { user, importing: true });
        try {
          await connection.transact((shared) => replace(shared, schema, entry.document));
        } finally {
          await connection.disconnect();
        }
        imported.push(name);
        if (!checked.ok) repaired.push(name);
      } catch {
        failed.push(name);
      }
    }
    response.json({ imported, repaired, refused, failed });
  });

  app.get("/api/pages/:name/backlinks", async (request, response) => {
    response.json(await store.backlinks(request.params.name));
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

  const server = new Server({
    port: options.port ?? 1234,
    quiet: true,
    debounce: options.debounce ?? 1000,
    maxDebounce: 5000,
    extensions: [authentication, persistence, seeding, http],
  });
  return server;
}
