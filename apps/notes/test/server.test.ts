import { FIELD, snapshot } from "@nseaprotector/coelho-collab";
import { hash, toHtml } from "@nseaprotector/coelho-core";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { memoryAccounts } from "../server/accounts.js";
import { createNotesServer } from "../server/app.js";
import { schema } from "../server/schema.js";
import { memoryStore, type DocumentStore } from "../server/store.js";

const running: Server[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of running.splice(0)) await server.destroy();
});

interface Running {
  server: Server;
  store: DocumentStore;
  url: string;
  http: string;
}

async function start(store: DocumentStore = memoryStore(), accounts = memoryAccounts()): Promise<Running & { accounts: typeof accounts }> {
  const server = createNotesServer({ store, accounts, port: 0, debounce: 20 });
  await server.listen();
  running.push(server);
  const { port } = server.address;
  return { server, store, accounts, url: `ws://127.0.0.1:${port}/collab`, http: `http://127.0.0.1:${port}` };
}

async function call(http: string, path: string, init: { method?: string; body?: unknown; cookie?: string; json?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = init.json === false ? "text/plain" : "application/json";
  return fetch(`${http}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

/** Signs up and returns the session cookie. */
async function signUp(http: string, name: string, password = "correct horse"): Promise<string> {
  const response = await call(http, "/api/signup", { body: { email: `${name.toLowerCase()}@example.test`, name, password } });
  expect(response.status).toBe(201);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

/** A writer opening a page with a session cookie, as a browser does on the same origin. */
function open(url: string, name: string, cookie: string | null): Promise<HocuspocusProvider> {
  class WithCookie extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, { protocols, headers: cookie === null ? {} : { cookie } } as unknown as string[]);
    }
  }
  return new Promise((resolve, reject) => {
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WithCookie, minDelay: 50, delay: 50 });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: new Y.Doc(),
      onSynced: () => resolve(provider),
      onAuthenticationFailed: ({ reason }) => reject(new Error(`refused: ${reason}`)),
    });
    provider.attach();
    closers.push(() => {
      provider.destroy();
      socket.destroy();
    });
  });
}

async function until(check: () => Promise<boolean> | boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const textOf = (provider: HocuspocusProvider): string => JSON.stringify(snapshot(provider.document, schema).document);

function firstText(provider: HocuspocusProvider, index = 1): Y.XmlText {
  return (provider.document.getXmlFragment(FIELD).get(index) as Y.XmlElement).get(0) as Y.XmlText;
}

describe("pages", () => {
  test("are seeded once, however many writers open one at the same time, and stored at once", async () => {
    const { url, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const [a, b] = await Promise.all([open(url, "welcome", cookie), open(url, "welcome", cookie)]);
    await until(() => textOf(a) === textOf(b));
    expect(a.document.getXmlFragment(FIELD).length).toBe(2);
    expect(toHtml(snapshot(a.document, schema).document, schema)).toMatch(/^<h1>welcome<\/h1><p>Everyone with this page open/);
    expect((await store.get("welcome"))?.text.startsWith("welcome\n")).toBe(true);
  });

  test("store what writers type, validated, with its hash, its text and who wrote it", async () => {
    const { url, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const a = await open(url, "notes", cookie);
    firstText(a).insert(0, "Camille: ");
    await until(async () => (await store.get("notes"))?.text.includes("Camille: ") ?? false);
    const stored = await store.get("notes");
    expect(stored?.errors).toEqual([]);
    expect(stored?.updatedBy).toBe("Camille");
    expect(stored?.hash).toBe(await hash(snapshot(a.document, schema).document));
    const served = (await (await call(http, "/api/pages/notes", { cookie })).json()) as { hash: string };
    expect(served.hash).toBe(stored?.hash);
  });

  test("never store what a client writes past the editor, and record what was repaired", async () => {
    const { url, http, store } = await start();
    const mallory = await open(url, "page", await signUp(http, "Mallory"));
    firstText(mallory).format(0, 8, { link: { href: "javascript:alert(document.cookie)" } });
    await until(async () => ((await store.get("page"))?.errors.length ?? 0) > 0);
    const stored = await store.get("page");
    expect(stored?.errors.map((error) => error.message)).toEqual(['scheme "javascript" is not allowed']);
    expect(JSON.stringify(stored?.body)).not.toContain("javascript:");
  });

  test("resume after a restart instead of being seeded again", async () => {
    const store = memoryStore();
    const accounts = memoryAccounts();
    const first = await start(store, accounts);
    const cookie = await signUp(first.http, "Camille");
    const a = await open(first.url, "kept", cookie);
    firstText(a).insert(0, "Kept: ");
    await until(async () => (await store.get("kept"))?.text.includes("Kept: ") ?? false);
    for (const close of closers.splice(0)) close();
    await first.server.destroy();
    running.splice(running.indexOf(first.server), 1);

    const second = await start(store, accounts);
    const b = await open(second.url, "kept", cookie);
    await until(() => textOf(b).includes("Kept: "));
    expect(b.document.getXmlFragment(FIELD).length).toBe(2);
  });
});

describe("accounts", () => {
  test("the first to sign up is the admin, everyone after is a reader", async () => {
    const { http } = await start();
    const admin = await signUp(http, "Camille");
    await signUp(http, "Sacha");
    expect(((await (await call(http, "/api/me", { cookie: admin })).json()) as { role: string }).role).toBe("admin");
    const people = (await (await call(http, "/api/users", { cookie: admin })).json()) as Array<{ name: string; role: string }>;
    expect(people.map(({ name, role }) => [name, role])).toEqual([["Camille", "admin"], ["Sacha", "reader"]]);
  });

  test("sign in, sign out, and the address cannot be taken twice", async () => {
    const { http } = await start();
    await signUp(http, "Camille");
    expect((await call(http, "/api/signup", { body: { email: "camille@example.test", name: "Again", password: "correct horse" } })).status).toBe(409);
    expect((await call(http, "/api/login", { body: { email: "camille@example.test", password: "wrong one!" } })).status).toBe(401);
    const login = await call(http, "/api/login", { body: { email: "CAMILLE@example.test", password: "correct horse" } });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await call(http, "/api/me", { cookie })).status).toBe(200);
    expect((await call(http, "/api/logout", { body: {}, cookie })).status).toBe(204);
    expect((await call(http, "/api/me", { cookie })).status).toBe(401);
  });

  test("refuse what a form from another site could send, and repeated wrong passwords", async () => {
    const { http } = await start();
    await signUp(http, "Camille");
    expect((await call(http, "/api/login", { body: { email: "camille@example.test", password: "correct horse" }, json: false })).status).toBe(415);
    for (let i = 0; i < 10; i += 1) await call(http, "/api/login", { body: { email: "camille@example.test", password: `wrong ${i}` } });
    expect((await call(http, "/api/login", { body: { email: "camille@example.test", password: "correct horse" } })).status).toBe(429);
  });

  test("only an admin changes roles, and the last admin stays one", async () => {
    const { http } = await start();
    const admin = await signUp(http, "Camille");
    const reader = await signUp(http, "Sacha");
    expect((await call(http, "/api/users/1", { method: "PATCH", body: { role: "reader" }, cookie: reader })).status).toBe(403);
    expect((await call(http, "/api/users/1", { method: "PATCH", body: { role: "reader" }, cookie: admin })).status).toBe(409);
    expect((await call(http, "/api/users/2", { method: "PATCH", body: { role: "owner" }, cookie: admin })).status).toBe(400);
    expect((await call(http, "/api/users/2", { method: "PATCH", body: { role: "editor" }, cookie: admin })).status).toBe(200);
  });
});

describe("who is connected", () => {
  test("nobody without a session, not even to read", async () => {
    const { url, http } = await start();
    await expect(open(url, "welcome", null)).rejects.toThrow(/refused/);
    expect((await call(http, "/api/pages")).status).toBe(401);
  });

  test("a reader reads, and what a reader's client writes reaches nobody", async () => {
    const { url, http, store } = await start();
    const editor = await open(url, "page", await signUp(http, "Camille"));
    const reader = await open(url, "page", await signUp(http, "Sacha"));
    const before = (await store.get("page"))?.hash;
    firstText(reader).insert(0, "Sacha was here. ");
    firstText(editor).insert(0, "Camille was here. ");
    await until(() => textOf(reader).includes("Camille was here."));
    await until(async () => (await store.get("page"))?.text.includes("Camille was here.") ?? false);
    expect(textOf(editor)).not.toContain("Sacha was here.");
    expect((await store.get("page"))?.text).not.toContain("Sacha was here.");
    expect((await store.get("page"))?.hash).not.toBe(before);
  });

  test("a role given by the admin applies at once: the reader becomes an editor", async () => {
    const { url, http, store } = await start();
    const admin = await signUp(http, "Camille");
    const sacha = await signUp(http, "Sacha");
    const reader = await open(url, "page", sacha);
    await call(http, "/api/users/2", { method: "PATCH", body: { role: "editor" }, cookie: admin });
    // The connection is closed and comes back under the new role.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await until(() => reader.isSynced);
    firstText(reader).insert(0, "Now an editor. ");
    await until(async () => (await store.get("page"))?.text.includes("Now an editor.") ?? false);
    expect((await store.get("page"))?.updatedBy).toBe("Sacha");
  });

  test("presence carries the account's name, whatever a client claims", async () => {
    const { url, http } = await start();
    const camille = await open(url, "page", await signUp(http, "Camille"));
    const sacha = await open(url, "page", await signUp(http, "Sacha"));
    sacha.setAwarenessField("user", { name: "Camille", color: "#000" });
    await until(() => [...(camille.awareness?.getStates().values() ?? [])].some((state) => (state.user as { name?: string } | undefined)?.name === "Sacha"));
    // Sacha's client claimed to be Camille; what Camille receives says Sacha.
    const names = [...(camille.awareness?.getStates().values() ?? [])].map((state) => (state.user as { name?: string } | undefined)?.name);
    expect(names).toContain("Sacha");
    expect(names).not.toContain("Camille");
  });
});
