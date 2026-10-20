# Changelog

The four packages are versioned together.

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
