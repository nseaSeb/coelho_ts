import { THREADS } from "@nseaprotector/coelho-collab";
import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { Discussion } from "../web/src/Threads.js";

const made: Array<{ discussion: Discussion; socket: HocuspocusProviderWebsocket }> = [];
afterEach(() => {
  for (const { discussion, socket } of made.splice(0)) {
    discussion.destroy();
    socket.destroy();
  }
});

/** A discussion that never connects: the room is filled by hand, as the server would. */
function discussion(): Discussion {
  const socket = new HocuspocusProviderWebsocket({ url: "ws://127.0.0.1:9/collab", autoConnect: false });
  const created = new Discussion("page", { id: "u1", email: "ada@example.test", name: "Ada", role: "editor", color: "#000" }, socket);
  made.push({ discussion: created, socket });
  return created;
}

describe("a page's discussion", () => {
  test("a draft that lost its place is refused out loud, and kept", async () => {
    const threads = discussion();
    threads.drafts.set("draft_1", { anchor: { from: 1, to: 3, quote: "Ev" } });
    await expect(threads.submitDraft("draft_1", "Who?")).rejects.toThrow(/lost its place/);
    expect(threads.drafts.has("draft_1")).toBe(true);
  });

  test("places threads from where they are, without reading their comments", () => {
    const threads = discussion();
    const doc = threads.provider.document;
    const entry = new Y.Map<unknown>();
    doc.getMap(THREADS).set("t_1", entry);
    entry.set("quote", "Everyone");
    entry.set("prefix", "");
    entry.set("suffix", " edits");
    entry.set("resolved", true);
    entry.set("comments", Y.Array.from([{ id: "c_1", author: "Ada", createdAt: "", body: { type: "doc", content: [{ type: "paragraph" }] } }]));
    const list = vi.spyOn(threads.shared, "list");
    expect(threads.source.threads()).toEqual([{ id: "t_1", anchor: { from: 0, to: 0, quote: "Everyone", prefix: "", suffix: " edits" }, resolved: true }]);
    expect(list).not.toHaveBeenCalled();
  });
});
