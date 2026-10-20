import type { Document } from "@nseaprotector/coelho-core";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, test } from "vitest";
import { memoryAccounts, postgresAccounts, type AccountStore } from "../server/accounts.js";
import { memoryStore, postgresStore, type DocumentStore, type StoredPage } from "../server/store.js";

/**
 * One contract, both stores: what the app is tested against in memory is
 * what Postgres does. Postgres runs when TEST_DATABASE_URL is set, each
 * test in a schema of its own, dropped after; CI sets it, and fails
 * without it rather than skip it.
 */
const url = process.env.TEST_DATABASE_URL || undefined;
if (process.env.CI && url === undefined) throw new Error("TEST_DATABASE_URL is required in CI");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A pool on a schema of its own, dropped after the test. */
async function isolated(): Promise<pg.Pool> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  cleanups.push(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  return pool;
}

const both = <T,>(memory: () => T | Promise<T>, postgres: (pool: pg.Pool) => Promise<T>): Array<[string, () => Promise<T>]> => [
  ["memory", async () => memory()],
  ...(url === undefined ? [] : [["postgres", async () => postgres(await isolated())] as [string, () => Promise<T>]]),
];
const stores = both<DocumentStore>(memoryStore, postgresStore);
const accountStores = both<AccountStore>(memoryAccounts, postgresAccounts);

const doc = (text: string): Document => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) as Document;
const page = (name: string, change: Partial<Omit<StoredPage, "updatedAt">> = {}): Omit<StoredPage, "updatedAt"> => ({
  name,
  body: doc(change.text ?? name),
  hash: `h-${name}`,
  text: name,
  errors: [],
  updatedBy: null,
  links: [],
  ...change,
});
const names = (rows: Array<{ name: string }>): string[] => rows.map((row) => row.name);

describe.each(stores)("the %s store", (_kind, make) => {
  test("keeps a page: its state, its body, whether it exists, and who changed it last", async () => {
    const store = await make();
    expect(await store.load("a")).toBeNull();
    expect(await store.exists("a")).toBe(false);
    await store.save(page("a", { updatedBy: "Ada", text: "first" }), new Uint8Array([1, 2]));
    expect(await store.load("a")).toEqual(new Uint8Array([1, 2]));
    expect(await store.exists("a")).toBe(true);
    // A store without an author, the server seeding, keeps the last one.
    await store.save(page("a", { updatedBy: null, text: "second" }), new Uint8Array([3]));
    expect(await store.get("a")).toMatchObject({ name: "a", text: "second", updatedBy: "Ada", hash: "h-a", links: [] });
    expect(await store.load("a")).toEqual(new Uint8Array([3]));
  });

  test("lists pages by name, all of them, and those that link to one", async () => {
    const store = await make();
    for (const name of ["c", "a", "b"]) await store.save(page(name, { links: name === "a" ? [] : ["a"] }), new Uint8Array());
    expect(names(await store.list())).toEqual(["a", "b", "c"]);
    expect(names(await store.all()).sort()).toEqual(["a", "b", "c"]);
    expect(names(await store.backlinks("a"))).toEqual(["b", "c"]);
    expect(await store.backlinks("nobody")).toEqual([]);
  });

  test("names the pages linked to and not written yet, five linking pages at most, in code point order", async () => {
    const store = await make();
    for (const name of ["g", "f", "e", "d", "c", "b", "B"]) await store.save(page(name, { links: ["later", "a"] }), new Uint8Array());
    await store.save(page("a", { links: ["Zed"] }), new Uint8Array());
    expect(await store.missing()).toEqual([
      { name: "Zed", linkedFrom: ["a"], linkCount: 1 },
      { name: "later", linkedFrom: ["B", "b", "c", "d", "e"], linkCount: 7 },
    ]);
  });

  test("sort names by code point, the same in both: capitals first, a letter beyond U+FFFF last", async () => {
    const store = await make();
    for (const name of ["𠀀", "a", "Ａ", "B"]) await store.save(page(name, { links: ["later"] }), new Uint8Array());
    await store.save(page("later-not", { links: ["𠀁", "b", "Ｃ"] }), new Uint8Array());
    expect(names(await store.list())).toEqual(["B", "a", "later-not", "Ａ", "𠀀"]);
    expect(names(await store.backlinks("later"))).toEqual(["B", "a", "Ａ", "𠀀"]);
    expect(await store.missing()).toEqual([
      { name: "b", linkedFrom: ["later-not"], linkCount: 1 },
      { name: "later", linkedFrom: ["B", "a", "Ａ", "𠀀"], linkCount: 4 },
      { name: "Ｃ", linkedFrom: ["later-not"], linkCount: 1 },
      { name: "𠀁", linkedFrom: ["later-not"], linkCount: 1 },
    ]);
  });

  test("leave the hidden pages' links out of what is not written yet", async () => {
    const store = await make();
    await store.save(page("../../evil", { links: ["home", "later"] }), new Uint8Array());
    await store.save(page("a", { links: ["later"] }), new Uint8Array());
    expect(await store.missing(["../../evil"])).toEqual([{ name: "later", linkedFrom: ["a"], linkCount: 1 }]);
  });

  test("finds pages by the start of their words, in names split at / _ . -", async () => {
    const store = await make();
    await store.save(page("projects/sprint-42", { text: "Planning the release" }), new Uint8Array());
    await store.save(page("notes", { text: "Nothing planned here, a release maybe" }), new Uint8Array());
    expect(names(await store.search("spri")).sort()).toEqual(["projects/sprint-42"]);
    expect(names(await store.search("plan rel")).sort()).toEqual(["notes", "projects/sprint-42"]);
    expect(await store.search("")).toEqual([]);
    expect(await store.search("absent")).toEqual([]);
    const [hit] = await store.search("planning");
    expect(hit?.snippet).toContain("\u0001Planning\u0002");
  });

  test("keeps a page's history, newest first, a page of it at a time", async () => {
    const store = await make();
    expect(await store.latestVersion("a")).toBeNull();
    const made = [];
    for (let at = 0; at < 3; at += 1) made.push(await store.addVersion({ name: "a", body: doc(`v${at}`), hash: `h${at}`, createdBy: "Ada", note: at === 0 ? "imported" : null }));
    await store.addVersion({ name: "b", body: doc("other"), hash: "hb", createdBy: null, note: null });
    expect((await store.latestVersion("a"))?.id).toBe(made[2]?.id);
    expect((await store.versions("a")).map((version) => version.hash)).toEqual(["h2", "h1", "h0"]);
    expect((await store.versions("a", { limit: 1, before: made[2]?.id })).map((version) => version.hash)).toEqual(["h1"]);
    expect(await store.version("a", made[1]!.id)).toMatchObject({ hash: "h1", body: doc("v1"), previousId: made[0]!.id, createdBy: "Ada", note: null });
    expect(await store.version("a", made[0]!.id)).toMatchObject({ previousId: null, note: "imported" });
    expect(await store.version("b", made[0]!.id)).toBeNull();
    expect(await store.version("a", "not-an-id")).toBeNull();
    expect(await store.version("a", "99999999999999999999")).toBeNull();
    expect(await store.versions("a", { before: "99999999999999999999" })).toHaveLength(3);
    expect((await store.versions("a", { before: "not-an-id" })).map((version) => version.hash)).toEqual(["h2", "h1", "h0"]);
    await store.updateVersion(made[2]!.id, { body: doc("folded"), hash: "h2b" });
    expect(await store.version("a", made[2]!.id)).toMatchObject({ hash: "h2b", body: doc("folded") });
  });

  test("keeps a page's threads: the room's state, and the threads as JSON", async () => {
    const store = await make();
    expect(await store.loadThreads("a")).toBeNull();
    expect(await store.threads("a")).toEqual([]);
    await store.saveThreads("a", new Uint8Array([7]), [{ id: "t_1" }]);
    await store.saveThreads("a", new Uint8Array([8]), [{ id: "t_1" }, { id: "t_2" }]);
    expect(await store.loadThreads("a")).toEqual(new Uint8Array([8]));
    expect(await store.threads("a")).toEqual([{ id: "t_1" }, { id: "t_2" }]);
  });
});

describe.each(accountStores)("the %s accounts", (_kind, make) => {
  const account = (email: string, role: "editor" | "reader" = "reader") => ({ email, name: email.split("@")[0] as string, passwordHash: `hash-${email}`, role });

  test("make the first account the admin, the others what they ask, and an email one account", async () => {
    const accounts = await make();
    const [first, second] = await Promise.all([accounts.create(account("ada@example.test")), accounts.create(account("lin@example.test", "editor"))]);
    // Signed up at the same moment: one of them, and only one, is the admin.
    expect([first, second].filter((one) => one !== "taken" && one.role === "admin")).toHaveLength(1);
    expect(await accounts.create(account("ada@example.test"))).toBe("taken");
    expect((await accounts.list()).map((user) => user.email).sort()).toEqual(["ada@example.test", "lin@example.test"]);
    expect(await accounts.byEmail("ada@example.test")).toMatchObject({ email: "ada@example.test", passwordHash: "hash-ada@example.test" });
    expect(await accounts.byEmail("nobody@example.test")).toBeNull();
  });

  test("change a role, and say so when there is no such account", async () => {
    const accounts = await make();
    await accounts.create(account("ada@example.test"));
    const lin = await accounts.create(account("lin@example.test"));
    expect(await accounts.setRole((lin as { id: string }).id, "editor")).toMatchObject({ email: "lin@example.test", role: "editor" });
    expect(await accounts.setRole("999999", "editor")).toBeNull();
    expect(await accounts.setRole("not-an-id", "editor")).toBeNull();
    expect(await accounts.setRole("99999999999999999999", "editor")).toBeNull();
  });

  test("open a session until it expires or is closed", async () => {
    const accounts = await make();
    const ada = (await accounts.create(account("ada@example.test"))) as { id: string };
    await accounts.createSession(ada.id, "live", new Date(Date.now() + 60_000));
    await accounts.createSession(ada.id, "expired", new Date(Date.now() - 1000));
    expect(await accounts.sessionUser("live")).toMatchObject({ id: ada.id, role: "admin" });
    expect(await accounts.sessionUser("expired")).toBeNull();
    expect(await accounts.sessionUser("unknown")).toBeNull();
    await accounts.deleteSession("live");
    expect(await accounts.sessionUser("live")).toBeNull();
  });
});
