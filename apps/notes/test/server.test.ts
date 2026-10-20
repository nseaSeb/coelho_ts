import { FIELD, snapshot } from "@nseaprotector/coelho-collab";
import { hash, toHtml } from "@nseaprotector/coelho-core";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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

async function start(store: DocumentStore = memoryStore(), accounts = memoryAccounts(), versionWindow?: number, debounce = 20): Promise<Running & { accounts: typeof accounts }> {
  const server = createNotesServer({ store, accounts, port: 0, debounce, ...(versionWindow === undefined ? {} : { versionWindow }) });
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

/** A link to another page, written into the shared document as the editor writes it. */
function link(provider: HocuspocusProvider, name: string): void {
  const paragraph = provider.document.getXmlFragment(FIELD).get(1) as Y.XmlElement;
  const element = new Y.XmlElement("page_link");
  element.setAttribute("name", name);
  paragraph.insert(paragraph.length, [element]);
}

describe("links between pages", () => {
  test("are stored with the page, and a page knows who links to it", async () => {
    const { url, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const a = await open(url, "projects/roadmap", cookie);
    link(a, "docs/install");
    link(a, "docs/install");
    await until(async () => ((await store.get("projects/roadmap"))?.links.length ?? 0) > 0);
    expect((await store.get("projects/roadmap"))?.links).toEqual(["docs/install"]);
    const response = await call(http, `/api/pages/${encodeURIComponent("docs/install")}/backlinks`, { cookie });
    expect(((await response.json()) as Array<{ name: string }>).map((page) => page.name)).toEqual(["projects/roadmap"]);
    expect(toHtml((await store.get("projects/roadmap"))!.body, schema)).toContain('<a class="page-link" href="#docs%2Finstall">docs/install</a>');
  });

  test("to something that is not a page name are not links: repaired before they are stored", async () => {
    const { url, http, store } = await start();
    const mallory = await open(url, "page", await signUp(http, "Mallory"));
    link(mallory, "javascript:alert(1)");
    await until(async () => ((await store.get("page"))?.errors.length ?? 0) > 0);
    const stored = await store.get("page");
    expect(stored?.errors.map((error) => error.message)).toEqual(["must be a page name"]);
    expect(stored?.links).toEqual([]);
    expect(JSON.stringify(stored?.body)).not.toContain("javascript");
  });

  test("a room whose name is not a page name is refused", async () => {
    const { url, http } = await start();
    await expect(open(url, "../etc/passwd", await signUp(http, "Camille"))).rejects.toThrow(/refused/);
  });
});

describe("the vault", () => {
  test("exports every page as Markdown, in folders, with links as Obsidian writes them", async () => {
    const { url, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const page = await open(url, "projects/sprint-42", cookie);
    firstText(page).insert(0, "Plan **bold** ");
    link(page, "docs/install");
    await until(async () => ((await store.get("projects/sprint-42"))?.links.length ?? 0) > 0);
    const response = await call(http, "/api/export", { cookie });
    expect(response.headers.get("content-type")).toBe("application/zip");
    // Read back with the system's unzip: the archive is a real ZIP.
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(dir, "vault.zip"), Buffer.from(await response.arrayBuffer()));
    expect(execFileSync("unzip", ["-Z1", join(dir, "vault.zip")], { encoding: "utf8" }).trim().split("\n")).toEqual(["projects/sprint-42.md"]);
    const markdown = execFileSync("unzip", ["-p", join(dir, "vault.zip"), "projects/sprint-42.md"], { encoding: "utf8" });
    expect(markdown).toBe("# projects/sprint-42\n\nPlan \\*\\*bold\\*\\* Everyone with this page open edits it together. Type `[[` to link another page.[[docs/install]]\n");
  });

  test("imports pages an editor read from Markdown, revalidated, live for whoever has them open", async () => {
    const { url, http, store } = await start();
    const admin = await signUp(http, "Camille");
    const reader = await signUp(http, "Sacha");
    const watching = await open(url, "imported", admin);
    const pages = [
      { name: "imported", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "From the vault." }, { type: "page_link", attrs: { name: "other" } }] }] } },
      { name: "hostile", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "kept", marks: [{ type: "link", attrs: { href: "javascript:x" } }] }] }] } },
      { name: "../nope", document: { type: "doc", content: [{ type: "paragraph" }] } },
    ];
    expect((await call(http, "/api/import", { body: { pages }, cookie: reader })).status).toBe(403);
    const result = (await (await call(http, "/api/import", { body: { pages }, cookie: admin })).json()) as Record<string, string[]>;
    expect(result).toEqual({ imported: ["imported", "hostile"], repaired: ["hostile"], refused: ["../nope"], failed: [] });
    // The page open in an editor changed under it, and was stored under who imported it.
    await until(() => textOf(watching).includes("From the vault."));
    expect(watching.document.getXmlFragment(FIELD).length).toBe(1);
    await until(async () => (await store.get("imported"))?.links.includes("other") ?? false);
    expect((await store.get("imported"))?.updatedBy).toBe("Camille");
    await until(async () => (await store.get("hostile"))?.text === "kept");
    expect(JSON.stringify((await store.get("hostile"))?.body)).not.toContain("javascript");
  });

  test("reports a page that fails to import, and goes on with the others", async () => {
    const { server, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const open = server.hocuspocus.openDirectConnection.bind(server.hocuspocus);
    vi.spyOn(server.hocuspocus, "openDirectConnection").mockImplementation((name, context) => (name === "boom" ? Promise.reject(new Error("boom")) : open(name, context)));
    const page = (name: string) => ({ name, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: name }] }] } });
    const result = (await (await call(http, "/api/import", { body: { pages: [page("one"), page("boom"), page("two")] }, cookie })).json()) as Record<string, string[]>;
    expect(result).toEqual({ imported: ["one", "two"], repaired: [], refused: [], failed: ["boom"] });
    await until(async () => (await store.get("two"))?.text === "two");
  });

  test("an import is not even read without a session", async () => {
    const { http } = await start();
    const big = JSON.stringify({ pages: [{ name: "x", document: { type: "doc", padding: "x".repeat(9_000_000) } }] });
    const response = await fetch(`${http}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(response.status).toBe(401);
  });

  test("an imported page is written as given, never seeded first", async () => {
    const saved: string[] = [];
    const memory = memoryStore();
    const { http, store } = await start({ ...memory, save: async (page, state) => (saved.push(page.text), memory.save(page, state)) });
    const cookie = await signUp(http, "Camille");
    const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Only this." }] }] };
    await call(http, "/api/import", { body: { pages: [{ name: "fresh", document }] }, cookie });
    await until(async () => (await store.get("fresh"))?.text === "Only this.");
    expect((await store.get("fresh"))?.updatedBy).toBe("Camille");
    expect(saved.some((text) => text.includes("Everyone with this page open"))).toBe(false);
  });

  test("is searched by words, each the start of a word, and snippets are text, not HTML", async () => {
    const { url, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const page = await open(url, "guide", cookie);
    firstText(page).insert(0, "Writing <script>alert(1)</script> the Markdown guide. ");
    await until(async () => (await store.get("guide"))?.text.includes("Writing") ?? false);
    const search = async (q: string): Promise<Array<{ name: string; snippet: string }>> => (await call(http, `/api/search?q=${encodeURIComponent(q)}`, { cookie })).json() as never;
    expect((await search("writ mark")).map((hit) => hit.name)).toEqual(["guide"]);
    expect(await search("absent")).toEqual([]);
    expect(await search("&|!:*()")).toEqual([]);
    const [hit] = await search("markdown");
    expect(hit?.snippet).toContain("\u0001Markdown\u0002");
    expect(hit?.snippet).toContain("<script>");
  });
});

describe("a page's history", () => {
  type Summary = { id: string; createdBy: string | null; note: string | null; hash: string | null };
  const history = async (http: string, name: string, cookie: string): Promise<Summary[]> => (await call(http, `/api/pages/${name}/versions`, { cookie })).json() as never;

  test("starts with the seeded page, and folds one writer's session into one version", async () => {
    const { url, http, store } = await start();
    const cookie = await signUp(http, "Camille");
    const page = await open(url, "log", cookie);
    for (const word of ["one ", "two ", "three "]) {
      firstText(page).insert(0, word);
      await until(async () => (await store.get("log"))?.text.includes(word) ?? false);
    }
    const versions = await history(http, "log", cookie);
    expect(versions.map((v) => v.createdBy)).toEqual(["Camille", null]);
    expect(versions[0]?.hash).toBe((await store.get("log"))?.hash);
  });

  test("starts a new version when someone else writes, or the session is over", async () => {
    const { url, http, store } = await start(memoryStore(), memoryAccounts(), 0);
    const admin = await signUp(http, "Camille");
    const page = await open(url, "log", admin);
    firstText(page).insert(0, "a ");
    await until(async () => (await store.get("log"))?.text.includes("a ") ?? false);
    firstText(page).insert(0, "b ");
    await until(async () => (await store.get("log"))?.text.includes("b ") ?? false);
    expect((await history(http, "log", admin)).map((v) => v.createdBy)).toEqual(["Camille", "Camille", null]);
  });

  test("restores a version for everyone with the page open, and keeps what it replaced", async () => {
    const { url, http, store } = await start();
    const admin = await signUp(http, "Camille");
    const reader = await signUp(http, "Sacha");
    const page = await open(url, "log", admin);
    const watching = await open(url, "log", reader);
    const seeded = (await history(http, "log", admin)).at(-1)!;
    firstText(page).insert(0, "Gone soon. ");
    await until(async () => (await store.get("log"))?.text.includes("Gone soon.") ?? false);

    expect((await call(http, `/api/pages/log/versions/${seeded.id}/restore`, { body: {}, cookie: reader })).status).toBe(403);
    const restored = (await (await call(http, `/api/pages/log/versions/${seeded.id}/restore`, { body: {}, cookie: admin })).json()) as Summary;
    expect(restored.note).toBe(`restored from #${seeded.id}`);
    expect(restored.hash).toBe(seeded.hash);

    await until(() => !textOf(watching).includes("Gone soon."));
    expect((await store.get("log"))?.hash).toBe(seeded.hash);
    const versions = await history(http, "log", admin);
    expect(versions.map((v) => v.note ?? v.createdBy)).toEqual([`restored from #${seeded.id}`, "Camille", null]);
    const replaced = (await (await call(http, `/api/pages/log/versions/${versions[1]!.id}`, { cookie: admin })).json()) as { body: unknown };
    expect(JSON.stringify(replaced.body)).toContain("Gone soon.");
  });

  test("an import is a version of its own", async () => {
    const { http } = await start();
    const cookie = await signUp(http, "Camille");
    const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "From a vault." }] }] };
    await call(http, "/api/import", { body: { pages: [{ name: "fresh", document }] }, cookie });
    expect((await history(http, "fresh", cookie)).map((v) => [v.createdBy, v.note])).toEqual([["Camille", "imported"]]);
  });

  test("a page stored before it had a history keeps what it held as its first version", async () => {
    const store = memoryStore();
    // A page as an older release stored it: a row, no version.
    const old = new Y.Doc();
    const { seed } = await import("@nseaprotector/coelho-collab");
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Written long ago." }] }] } as never;
    seed(old, schema, body);
    await store.save({ name: "old", body, hash: await hash(body), text: "Written long ago.", errors: [], updatedBy: "Someone", links: [] }, Y.encodeStateAsUpdate(old));
    const { url, http } = await start(store);
    const cookie = await signUp(http, "Camille");
    const page = await open(url, "old", cookie);
    firstText(page, 0).delete(0, 8);
    await until(async () => (await store.get("old"))?.text === "long ago.");
    const versions = await history(http, "old", cookie);
    expect(versions.map((v) => [v.createdBy, v.note])).toEqual([["Camille", null], ["Someone", "before history"]]);
    const first = (await (await call(http, `/api/pages/old/versions/${versions[1]!.id}`, { cookie })).json()) as { body: unknown };
    expect(JSON.stringify(first.body)).toContain("Written long ago.");
  });

  test("a version two people wrote is theirs both, and is not folded into either one's session", async () => {
    const { url, http, store } = await start(memoryStore(), memoryAccounts(), undefined, 400);
    const ada = await signUp(http, "Ada");
    const lin = await signUp(http, "Lin");
    await call(http, "/api/users/2", { method: "PATCH", body: { role: "editor" }, cookie: ada });
    const a = await open(url, "both", ada);
    const b = await open(url, "both", lin);
    firstText(a).insert(0, "Ada. ");
    firstText(b).insert(0, "Lin. ");
    await until(async () => ((await store.get("both"))?.text.includes("Ada.") && (await store.get("both"))?.text.includes("Lin.")) ?? false);
    const [newest] = await history(http, "both", ada);
    expect(newest?.createdBy?.split(", ").sort()).toEqual(["Ada", "Lin"]);
  });

  test("a restore is stored once, returns the version it made, and restoring the page as it is adds nothing", async () => {
    let saves = 0;
    const memory = memoryStore();
    const { url, http, store } = await start({ ...memory, save: async (page, state) => ((saves += 1), memory.save(page, state)) });
    const cookie = await signUp(http, "Camille");
    const page = await open(url, "once", cookie);
    const seeded = (await history(http, "once", cookie)).at(-1)!;
    firstText(page).insert(0, "Gone soon. ");
    await until(async () => (await store.get("once"))?.text.includes("Gone soon.") ?? false);
    saves = 0;
    const restored = (await (await call(http, `/api/pages/once/versions/${seeded.id}/restore`, { body: {}, cookie })).json()) as Summary;
    expect(saves).toBe(1);
    expect(restored).toMatchObject({ note: `restored from #${seeded.id}`, hash: seeded.hash });
    expect((await history(http, "once", cookie))[0]?.id).toBe(restored.id);
    const again = (await (await call(http, `/api/pages/once/versions/${seeded.id}/restore`, { body: {}, cookie })).json()) as Summary & { unchanged?: boolean };
    expect(again.unchanged).toBe(true);
    expect(await history(http, "once", cookie)).toHaveLength(3);
  });

  test("is read fifty versions at a time, and each version knows the one before it", async () => {
    const store = memoryStore();
    for (let i = 0; i < 60; i += 1) await store.addVersion({ name: "long", body: { type: "doc" } as never, hash: String(i), createdBy: "Ada", note: null });
    const { http } = await start(store);
    const cookie = await signUp(http, "Camille");
    const newest = await history(http, "long", cookie);
    expect(newest).toHaveLength(50);
    const older = (await (await call(http, `/api/pages/long/versions?before=${newest.at(-1)!.id}`, { cookie })).json()) as Summary[];
    expect(older).toHaveLength(10);
    const last = (await (await call(http, `/api/pages/long/versions/${newest.at(-1)!.id}`, { cookie })).json()) as { previousId: string | null };
    expect(last.previousId).toBe(older[0]!.id);
    const first = (await (await call(http, `/api/pages/long/versions/${older.at(-1)!.id}`, { cookie })).json()) as { previousId: string | null };
    expect(first.previousId).toBeNull();
  });
});

describe("comment threads", () => {
  const range = { from: { type: null, tname: "coelho", item: null, assoc: 0 }, to: { type: null, tname: "coelho", item: null, assoc: 0 }, last: { type: null, tname: "coelho", item: null, assoc: 0 } };
  const body = (text: string): unknown => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  type Listed = { id: string; resolved: boolean; anchor: { quote: string }; comments: Array<{ author: string; body: unknown }> };

  /** The threads room as a client reads it. */
  function threadsOf(provider: HocuspocusProvider): Listed[] {
    const map = provider.document.getMap<Y.Map<unknown>>("coelho-threads");
    return [...map.entries()].map(([id, entry]) => ({
      id,
      resolved: entry.get("resolved") === true,
      anchor: { quote: String(entry.get("quote")) },
      comments: ((entry.get("comments") as Y.Array<{ author: string; body: unknown }> | undefined)?.toArray() ?? []),
    }));
  }

  test("are opened through the server, under the account's name, and reach every reader of the page live", async () => {
    const { url, http, store } = await start();
    const ada = await signUp(http, "Ada");
    const lin = await signUp(http, "Lin");
    const watching = await open(url, "page::threads", lin);
    const created = await call(http, "/api/pages/page/threads", { body: { anchor: { quote: "Everyone" }, range, body: { ...(body("Who is everyone?") as object), author: "Mallory" } }, cookie: ada });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await until(() => threadsOf(watching).length === 1);
    expect(threadsOf(watching)[0]).toMatchObject({ id, resolved: false, anchor: { quote: "Everyone" }, comments: [{ author: "Ada", body: body("Who is everyone?") }] });
    // A reader may comment: commenting is not editing.
    expect((await call(http, `/api/pages/page/threads/${id}/comments`, { body: { body: body("Us.") }, cookie: lin })).status).toBe(201);
    await until(() => threadsOf(watching)[0]?.comments.length === 2);
    expect(threadsOf(watching)[0]?.comments.map((c) => c.author)).toEqual(["Ada", "Lin"]);
    await until(async () => (await store.threads("page")).length === 1);
    expect(((await (await call(http, "/api/pages/page/threads", { cookie: ada })).json()) as Listed[])[0]?.comments).toHaveLength(2);
  });

  test("are read only to every client: what one writes into the room reaches nobody", async () => {
    const { url, http } = await start();
    const ada = await signUp(http, "Ada");
    const mallory = await open(url, "page::threads", ada);
    const watching = await open(url, "page::threads", await signUp(http, "Lin"));
    const forged = new Y.Map<unknown>();
    mallory.document.getMap("coelho-threads").set("forged", forged);
    forged.set("quote", "x");
    await call(http, "/api/pages/page/threads", { body: { anchor: { quote: "real" }, range, body: body("Real.") }, cookie: ada });
    await until(() => threadsOf(watching).length === 1);
    expect(threadsOf(watching).map((t) => t.anchor.quote)).toEqual(["real"]);
  });

  test("bodies are repaired under the comment schema, and an empty one is refused", async () => {
    const { url, http } = await start();
    const ada = await signUp(http, "Ada");
    const watching = await open(url, "page::threads", ada);
    const hostile = { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Big" }] }, { type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] };
    expect((await call(http, "/api/pages/page/threads", { body: { anchor: { quote: "q" }, range, body: hostile }, cookie: ada })).status).toBe(201);
    await until(() => threadsOf(watching).length === 1);
    expect(threadsOf(watching)[0]?.comments[0]?.body).toEqual(body("click"));
    expect((await call(http, "/api/pages/page/threads", { body: { anchor: { quote: "q" }, range, body: { type: "doc", content: [{ type: "paragraph" }] } }, cookie: ada })).status).toBe(400);
    expect((await call(http, "/api/pages/page/threads", { body: { anchor: { quote: "q" }, range: { from: "nowhere" }, body: body("x") }, cookie: ada })).status).toBe(400);
  });

  test("are resolved or deleted by their author, an editor or an admin, and nobody else", async () => {
    const { url, http } = await start();
    const ada = await signUp(http, "Ada");
    const lin = await signUp(http, "Lin");
    const sam = await signUp(http, "Sam");
    const watching = await open(url, "page::threads", ada);
    const { id } = (await (await call(http, "/api/pages/page/threads", { body: { anchor: { quote: "q" }, range, body: body("Lin's.") }, cookie: lin })).json()) as { id: string };
    expect((await call(http, `/api/pages/page/threads/${id}`, { method: "PATCH", body: { resolved: true }, cookie: sam })).status).toBe(403);
    expect((await call(http, `/api/pages/page/threads/${id}`, { method: "PATCH", body: { resolved: true }, cookie: lin })).status).toBe(200);
    await until(() => threadsOf(watching)[0]?.resolved === true);
    expect((await call(http, `/api/pages/page/threads/${id}`, { method: "DELETE", body: {}, cookie: sam })).status).toBe(403);
    expect((await call(http, `/api/pages/page/threads/${id}`, { method: "DELETE", body: {}, cookie: ada })).status).toBe(204);
    await until(() => threadsOf(watching).length === 0);
  });

  test("a threads room is only a page's: one for something else is refused", async () => {
    const { url, http } = await start();
    await expect(open(url, "../x::threads", await signUp(http, "Ada"))).rejects.toThrow(/refused/);
  });
});

