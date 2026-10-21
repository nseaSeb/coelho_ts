# Changelog

The four packages are versioned together.

## 0.3.0 — 2026-10-21

Additions only; nothing that worked in 0.2.0 changes.

- **@nseaprotector/coelho-core**: `diffDocuments(before, after, schema)`
  compares two versions of a document block by block, by canonical bytes,
  and word by word inside a block of the same kind that was edited;
  `diffWords` compares two texts. Additions only.
- **@nseaprotector/coelho-react**: a React node view can draw a node that
  has content. The component renders its chrome (an icon, a select) in an
  element of its own, beside the content, which stays ProseMirror's and is
  edited like any other text; ProseMirror never reads what React draws, and
  events in the chrome are the component's. Components receive
  `updateAttributes`, which changes the node as one step of the history
  and throws on a name or a value the schema refuses. A node view's element
  now wears the classes the page renders for that node, and its plain
  attributes as `data-*` (leaf node views too). A component renders again
  only when its node's attributes or selection change, not while its
  content is typed in; events go to the component only on its controls.
- **@nseaprotector/coelho-prosemirror**: `fromMarkdown` and `markdownPaste`
  read Obsidian callouts (`> [!warning]`) into a node of your schema with
  `callouts`. A parse rule's function may return `null` to refuse an
  element.
- **@nseaprotector/coelho-core**: `quoteMarkdown` writes Markdown as a
  quote, for a node override such as a callout.
- **@nseaprotector/coelho-collab**: `sharedThreads(...).places()` lists the
  threads as `list` does, without their comments; `source.threads` uses it,
  so placing threads after a remote change no longer repairs every comment
  body.

## 0.2.0 — 2026-10-20

Additions only; nothing that worked in 0.1.0 changes.

- **@nseaprotector/coelho-collab**: `replace(doc, schema, document)` writes
  a stored document over a shared one, repaired by `sanitize` first, in one
  transaction, so every connected writer sees it arrive. What an import or
  a restore does; the counterpart of `seed`, which only fills an empty
  room.
- **@nseaprotector/coelho-prosemirror**: `fromMarkdown(markdown, schema, {
  wikiLinks })` reads Obsidian's `[[page]]` and `[[page|alias]]` into a
  node of your schema, held to its attributes' validators. `#heading` and
  `^block` suffixes point at the page; a `resolve` option maps targets as
  written to the names you store; nothing is read inside code or escaped
  brackets; a link the schema refuses keeps its words as text.
- **@nseaprotector/coelho-core**, **@nseaprotector/coelho-react**: no
  change, versioned with the others.

## 0.1.0 — 2026-10-20

First release: the storage layer with parity with coelho, `sanitize`,
Markdown both ways, the ProseMirror editor without a framework, the React
editor and node views, suggestions, anchored comments, and collaboration
over Yjs.
