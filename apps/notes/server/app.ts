import { FIELD, replace, seed, sharedThreads, snapshot, THREADS, type RelativeRange } from "@nseaprotector/coelho-collab";
import { hash, isBlank, sanitize, toMarkdown, toText, validate, type Comment, type Node } from "@nseaprotector/coelho-core";
import { Database } from "@hocuspocus/extension-database";
import { Server, type Extension } from "@hocuspocus/server";
import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as Y from "yjs";
import { commentSchema, firstPage, isPageName, linksOf, roomOf, schema, threadsRoomOf } from "./schema.js";
import { zip } from "./zip.js";
import type { AccountStore, Role, User } from "./accounts.js";
import { authRoutes, colorOf, userFrom } from "./auth.js";
import type { DocumentStore, VersionSummary } from "./store.js";

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
  /** How long a writer's session lasts as one version, in ms. Default: 5 minutes. */
  versionWindow?: number;
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
  // A writer's session is one version: saves by the same person within
  // this long of the version's start are folded into it.
  const session = options.versionWindow ?? 5 * 60 * 1000;
  // Who changed each page since it was last stored. The store hook knows
  // only the last of them; a version written by two people is theirs both.
  const writers = new Map<string, Set<string>>();

  /**
   * What a store carries besides the document: who, why, and room for the
   * version it made, read back by whoever asked for it (a restore).
   * Hocuspocus hands the connection's context to the store hook as it is.
   */
  interface StoreContext {
    user?: User;
    note?: string;
    importing?: boolean;
    stored?: VersionSummary;
  }

  /**
   * Stores a page, and its history: a new version when the document
   * changed and someone else wrote it, or more than one person did, or the
   * session is over, or `note` says why it must stand on its own (an
   * import, a restore). Runs under Hocuspocus's save lock for the page, so
   * stores of one page never overlap.
   */
  const persist = async (name: string, document: Y.Doc, state: Uint8Array, context: StoreContext): Promise<void> => {
    const { document: body, errors } = snapshot(document, schema);
    const digest = await hash(body);
    const note = context.note ?? null;
    let latest = await store.latestVersion(name);
    if (latest === null) {
      // A page stored before it had a history: what it held is its first
      // version, so the first change after it can still be undone.
      const before = await store.get(name);
      if (before !== null && before.hash !== digest) {
        latest = await store.addVersion({ name, body: before.body, hash: before.hash, createdBy: before.updatedBy, note: "before history" });
      }
    }
    const names = [...(writers.get(name) ?? [])];
    writers.delete(name);
    if (names.length === 0 && context.user !== undefined) names.push(context.user.name);
    const author = names.length === 0 ? null : names.join(", ");
    await store.save({ name, body, hash: digest, text: toText(body, schema), errors, updatedBy: context.user?.name ?? null, links: linksOf(body) }, state);
    if (latest !== null && latest.hash === digest) {
      context.stored = latest;
      return;
    }
    const sameSession =
      latest !== null && note === null && latest.note === null && names.length === 1 && latest.createdBy === author && Date.now() - Date.parse(latest.createdAt) < session;
    if (sameSession && latest !== null) {
      await store.updateVersion(latest.id, { body, hash: digest });
      context.stored = latest;
    } else {
      const { body: _written, ...made } = await store.addVersion({ name, body, hash: digest, createdBy: author, note });
      void _written;
      context.stored = made;
    }
  };

  /** Writes a document into a page's room through the server's own connection, and stores it as one version. */
  const writeInto = async (name: string, document: unknown, context: StoreContext): Promise<VersionSummary | undefined> => {
    const connection = await server.hocuspocus.openDirectConnection(name, context);
    try {
      await connection.transact((shared) => replace(shared, schema, document));
    } finally {
      // Stores now, through the same path and lock as every other store.
      await connection.disconnect();
    }
    return context.stored;
  };

  // Every connection is someone signed in. A reader's connection is read
  // only on the server, where a modified client cannot lift it.
  const authentication: Extension = {
    priority: 200,
    async onAuthenticate({ requestHeaders, connectionConfig, documentName }) {
      const user = await userFrom(accounts, requestHeaders.get("cookie"));
      if (user === null) throw new Error("sign in first");
      // A room is a page, and a page has a name a link can hold; or it is
      // a page's threads, which every client reads and the server alone writes.
      const room = roomOf(documentName);
      if (room === null) throw new Error("not a page name");
      if (user.role === "reader" || room.kind === "threads") connectionConfig.readOnly = true;
      return { user };
    },
    async onChange({ documentName, context }) {
      const user = (context as StoreContext | undefined)?.user;
      if (user === undefined || roomOf(documentName)?.kind !== "page") return;
      const names = writers.get(documentName) ?? new Set<string>();
      names.add(user.name);
      writers.set(documentName, names);
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
      if (roomOf(documentName)?.kind !== "page") return;
      // An import writes the page itself: seeding it first would only be overwritten.
      if (document.getXmlFragment(FIELD).length > 0 || (context as { importing?: boolean } | undefined)?.importing) return;
      seed(document, schema, firstPage(documentName));
      await persist(documentName, document, Y.encodeStateAsUpdate(document), {});
    },
  };

  const persistence = new Database({
    fetch: async ({ documentName }) => {
      const room = roomOf(documentName);
      if (room === null) throw new Error("not a room");
      return room.kind === "page" ? store.load(room.page) : store.loadThreads(room.page);
    },
    store: async ({ documentName, document, state, lastContext }) => {
      const room = roomOf(documentName);
      if (room === null) return;
      if (room.kind === "page") return persist(room.page, document, state, (lastContext as StoreContext | undefined) ?? {});
      // The threads as JSON beside the state, for the API, repaired once
      // more on the way out: the server wrote every body repaired, but this
      // is the last check before they leave, whatever the state came from.
      await store.saveThreads(room.page, state, sharedThreads(document, "", { bodies: commentSchema }).list());
    },
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
  app.use(["/api/pages", "/api/export", "/api/search", "/api/import"], async (request, response, next) => {
    const user = await userFrom(accounts, request.headers.cookie);
    if (user === null) return void response.status(401).json({ error: "sign in first" });
    response.locals.user = user;
    next();
  });
  // Every route under a page takes a page's name, and nothing else: no
  // room is opened, and nothing stored, under any other.
  app.param("name", (_request, response, next, name: unknown) => {
    if (isPageName(name)) next();
    else response.status(400).json({ error: "not a page name" });
  });
  // A name that is not a page's may be stored from before names were
  // checked everywhere: no route serves it, so it is listed nowhere.
  const named = <T extends { name: string }>(rows: T[]): T[] => rows.filter((row) => isPageName(row.name));
  app.get("/api/pages", async (_request, response) => {
    response.json(named(await store.list()));
  });
  // The vault: one Markdown file per page, in folders, links as Obsidian writes them.
  app.get("/api/export", async (_request, response) => {
    // A name that is not a page's would be a path out of the folder it is unzipped in.
    const stored = await store.all();
    const pages = named(stored);
    if (pages.length < stored.length) {
      console.warn(`export: left out ${stored.length - pages.length} stored name(s) that are not a page's: ${JSON.stringify(stored.filter((page) => !isPageName(page.name)).map((page) => page.name))}`);
    }
    const files = pages.map((page) => ({
      path: `${page.name}.md`,
      data: Buffer.from(`${toMarkdown(page.body, schema, { nodes: { page_link: (node) => `[[${String(node.attrs?.name)}]]` } })}\n`, "utf8"),
    }));
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", 'attachment; filename="coelho-notes.zip"');
    response.end(await zip(files));
  });

  app.get("/api/search", async (request, response) => {
    response.json(named(await store.search(String(request.query.q ?? "").slice(0, 200))));
  });

  // Pages read from Markdown in the browser, which has the DOM the reading
  // needs. Each is a claim, revalidated here, and written into its room
  // through the server's own connection: whoever has it open sees it
  // change, and it is stored as anyone's change is, under who imported it.
  // The session is checked, above, before the body, the only large one, is read.
  const editorOnly: express.RequestHandler = (_request, response, next) => {
    const user = response.locals.user as User;
    if (user.role === "reader") return void response.status(403).json({ error: "readers cannot change pages" });
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
        await writeInto(name, entry.document, { user, importing: true, note: "imported" });
        imported.push(name);
        if (!checked.ok) repaired.push(name);
      } catch {
        failed.push(name);
      }
    }
    response.json({ imported, repaired, refused, failed });
  });

  // -- Comment threads ------------------------------------------------------
  //
  // Every change goes through here: the server checks the session, stamps
  // the author with the account, repairs the body under the comment schema,
  // and writes into the page's threads room, which every client reads live.
  // Anyone signed in may comment, a reader too; the thread's author, an
  // editor or an admin may resolve or delete it.

  /** A comment body, repaired; `null` when nothing is left to say. */
  const commentBody = (raw: unknown): Node | null => {
    const body = sanitize(raw, commentSchema);
    return isBlank(body, commentSchema) ? null : body;
  };

  const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);

  /** A range as relativeAnchors records it: three relative positions, small. */
  const rangeOf = (raw: unknown): RelativeRange | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const { from, to, last } = raw as Record<string, unknown>;
    const position = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);
    if (!position(from) || !position(to) || !position(last) || JSON.stringify(raw).length > 2000) return null;
    return { from, to, last };
  };

  /** Writes into a page's threads room through the server's own connection, as `user`. */
  const inThreads = async <T>(name: string, user: User, change: (doc: Y.Doc) => T): Promise<T> => {
    const connection = await server.hocuspocus.openDirectConnection(threadsRoomOf(name), { user });
    let result: T | undefined;
    try {
      await connection.transact((doc) => {
        result = change(doc);
      });
    } finally {
      await connection.disconnect();
    }
    return result as T;
  };

  const threadOf = (doc: Y.Doc, id: string): Y.Map<unknown> | null => {
    const entry = doc.getMap<unknown>(THREADS).get(id);
    return entry instanceof Y.Map ? entry : null;
  };

  const mayManage = (user: User, thread: Y.Map<unknown>): boolean => user.role !== "reader" || thread.get("authorId") === user.id;

  const commentBy = (user: User, body: Node): Comment => ({ id: `c_${randomUUID()}`, author: user.name, createdAt: new Date().toISOString(), body });

  type Refusal = 403 | 404 | 409;
  type Outcome = 200 | 201 | 204 | Refusal;
  const refusals: Record<Refusal, string> = { 403: "only its author, an editor or an admin", 404: "no such thread", 409: "this thread is full" };
  const answer = (response: express.Response, outcome: Outcome): void => {
    if (outcome === 204) response.status(204).end();
    else if (outcome === 200 || outcome === 201) response.status(outcome).json({});
    else response.status(outcome).json({ error: refusals[outcome] });
  };

  app.get("/api/pages/:name/threads", async (request, response) => {
    response.json(await store.threads(String(request.params.name)));
  });

  app.post("/api/pages/:name/threads", async (request, response) => {
    const name = String(request.params.name);
    const user = response.locals.user as User;
    const { anchor, range, body } = (request.body ?? {}) as Record<string, unknown>;
    const quote = text((anchor as Record<string, unknown> | undefined)?.quote, 1000);
    const prefix = text((anchor as Record<string, unknown> | undefined)?.prefix ?? "", 200);
    const suffix = text((anchor as Record<string, unknown> | undefined)?.suffix ?? "", 200);
    const where = rangeOf(range);
    const first = commentBody(body);
    if (quote === null || quote === "" || prefix === null || suffix === null || where === null || first === null) {
      return void response.status(400).json({ error: "a quote, a range and something to say" });
    }
    const id = `t_${randomUUID()}`;
    const made = await inThreads(name, user, (doc) => {
      const threads = doc.getMap<unknown>(THREADS);
      if (threads.size >= 500) return false;
      const shared = sharedThreads(doc, user.name);
      shared.open(id, { from: 0, to: 0, quote, prefix, suffix });
      const thread = threadOf(doc, id) as Y.Map<unknown>;
      thread.set("range", where);
      thread.set("authorId", user.id);
      shared.reply(id, commentBy(user, first));
      return true;
    });
    if (!made) return void response.status(409).json({ error: "this page has as many threads as it can hold" });
    response.status(201).json({ id });
  });

  app.post("/api/pages/:name/threads/:id/comments", async (request, response) => {
    const user = response.locals.user as User;
    const body = commentBody((request.body as Record<string, unknown> | undefined)?.body);
    if (body === null) return void response.status(400).json({ error: "something to say" });
    const outcome = await inThreads<Outcome>(String(request.params.name), user, (doc) => {
      const thread = threadOf(doc, String(request.params.id));
      if (thread === null) return 404;
      const comments = thread.get("comments");
      if (comments instanceof Y.Array && comments.length >= 500) return 409;
      sharedThreads(doc, user.name).reply(String(request.params.id), commentBy(user, body));
      return 201;
    });
    answer(response, outcome);
  });

  app.patch("/api/pages/:name/threads/:id", async (request, response) => {
    const user = response.locals.user as User;
    const resolved = (request.body as Record<string, unknown> | undefined)?.resolved;
    if (typeof resolved !== "boolean") return void response.status(400).json({ error: "resolved: true or false" });
    const outcome = await inThreads<Outcome>(String(request.params.name), user, (doc) => {
      const thread = threadOf(doc, String(request.params.id));
      if (thread === null) return 404;
      if (!mayManage(user, thread)) return 403;
      thread.set("resolved", resolved);
      return 200;
    });
    answer(response, outcome);
  });

  app.delete("/api/pages/:name/threads/:id", async (request, response) => {
    const user = response.locals.user as User;
    const outcome = await inThreads<Outcome>(String(request.params.name), user, (doc) => {
      const thread = threadOf(doc, String(request.params.id));
      if (thread === null) return 404;
      if (!mayManage(user, thread)) return 403;
      doc.getMap<unknown>(THREADS).delete(String(request.params.id));
      return 204;
    });
    answer(response, outcome);
  });

  app.get("/api/pages/:name/versions", async (request, response) => {
    const before = typeof request.query.before === "string" ? request.query.before : undefined;
    response.json(await store.versions(request.params.name, before === undefined ? {} : { before }));
  });
  app.get("/api/pages/:name/versions/:id", async (request, response) => {
    const version = await store.version(request.params.name, request.params.id);
    if (version === null) response.status(404).json({ error: "no such version" });
    else response.json(version);
  });
  // A restore writes the version's body into the room, as any writer would:
  // everyone with the page open sees it come back, and it becomes the
  // newest version, the one it replaced kept in the history.
  app.post("/api/pages/:name/versions/:id/restore", editorOnly, async (request, response) => {
    const name = String(request.params.name);
    const version = await store.version(name, String(request.params.id));
    if (version === null) return void response.status(404).json({ error: "no such version" });
    const latest = await store.latestVersion(name);
    // The page already is this version: nothing to write, no version to add.
    if (latest !== null && latest.hash === version.hash) return void response.json({ ...latest, unchanged: true });
    const user = response.locals.user as User;
    response.json(await writeInto(name, version.body, { user, note: `restored from #${version.id}` }));
  });

  app.get("/api/pages/:name/backlinks", async (request, response) => {
    response.json(named(await store.backlinks(request.params.name)));
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
