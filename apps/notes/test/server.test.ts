import { FIELD, snapshot } from "@nseaprotector/coelho-collab";
import { hash, toHtml } from "@nseaprotector/coelho-core";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Server } from "@hocuspocus/server";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createNotesServer } from "../server/app.js";
import { schema } from "../server/schema.js";
import { memoryStore, type DocumentStore } from "../server/store.js";

const running: Server[] = [];
const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const server of running.splice(0)) await server.destroy();
});

async function start(store: DocumentStore): Promise<{ server: Server; url: string; http: string }> {
  const server = createNotesServer({ store, port: 0, debounce: 20 });
  await server.listen();
  running.push(server);
  const { port } = server.address;
  return { server, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

/** A writer opening a page, resolved once it holds what the server has. */
function open(url: string, name: string): Promise<HocuspocusProvider> {
  return new Promise((resolve) => {
    const provider = new HocuspocusProvider({ url, name, document: new Y.Doc(), onSynced: () => resolve(provider) });
    providers.push(provider);
  });
}

const textOf = (provider: HocuspocusProvider): string => snapshot(provider.document, schema).document.content?.map((block) => JSON.stringify(block)).join("") ?? "";

async function until(check: () => Promise<boolean> | boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function firstText(provider: HocuspocusProvider, index = 1): Y.XmlText {
  const block = provider.document.getXmlFragment(FIELD).get(index) as Y.XmlElement;
  return block.get(0) as Y.XmlText;
}

describe("the notes server", () => {
  test("seeds a page once, however many writers open it at the same time", async () => {
    const { url } = await start(memoryStore());
    const [a, b] = await Promise.all([open(url, "welcome"), open(url, "welcome")]);
    await until(() => textOf(a) === textOf(b) && textOf(a) !== "");
    expect(a.document.getXmlFragment(FIELD).length).toBe(2);
    expect(toHtml(snapshot(a.document, schema).document, schema)).toMatch(/^<h1>welcome<\/h1><p>Everyone with this page open/);
  });

  test("stores a page as soon as it is seeded, before anyone types", async () => {
    const store = memoryStore();
    const { url } = await start(store);
    await open(url, "fresh");
    const stored = await store.get("fresh");
    expect(stored?.text.startsWith("fresh\n")).toBe(true);
    expect(stored?.hash).not.toBeNull();
  });

  test("stores what writers type, validated, with its hash and text, and serves it", async () => {
    const store = memoryStore();
    const { url, http } = await start(store);
    const a = await open(url, "notes");
    const b = await open(url, "notes");
    firstText(a).insert(0, "Camille: ");
    await until(() => textOf(b) === textOf(a));
    await until(async () => (await store.get("notes"))?.text.includes("Camille: ") ?? false);
    const stored = await store.get("notes");
    expect(stored?.errors).toEqual([]);
    expect(stored?.hash).toBe(await hash(snapshot(a.document, schema).document));
    const served = (await (await fetch(`${http}/api/pages/notes`)).json()) as { body: unknown; hash: string };
    expect(served.hash).toBe(stored?.hash);
    expect(served.body).toEqual(stored?.body);
    expect(((await (await fetch(`${http}/api/pages`)).json()) as Array<{ name: string }>).map((page) => page.name)).toEqual(["notes"]);
  });

  test("never stores what a client writes past the editor, and records what it repaired", async () => {
    const store = memoryStore();
    const { url } = await start(store);
    const mallory = await open(url, "page");
    firstText(mallory).format(0, 8, { link: { href: "javascript:alert(document.cookie)" } });
    await until(async () => ((await store.get("page"))?.errors.length ?? 0) > 0);
    const stored = await store.get("page");
    expect(stored?.errors.map((error) => error.message)).toEqual(['scheme "javascript" is not allowed']);
    expect(JSON.stringify(stored?.body)).not.toContain("javascript:");
  });

  test("resumes a stored page after a restart instead of seeding it again", async () => {
    const store = memoryStore();
    const first = await start(store);
    const a = await open(first.url, "kept");
    firstText(a).insert(0, "Kept: ");
    await until(async () => (await store.get("kept"))?.text.includes("Kept: ") ?? false);
    a.destroy();
    await first.server.destroy();
    running.splice(running.indexOf(first.server), 1);

    const second = await start(store);
    const b = await open(second.url, "kept");
    await until(() => textOf(b).includes("Kept: "));
    expect(b.document.getXmlFragment(FIELD).length).toBe(2);
  });
});
