# Parity fixtures

`corpus.json` is copied verbatim from
[nseaSeb/coelho](https://github.com/nseaSeb/coelho/blob/master/test/fixtures/corpus.json)
(`test/fixtures/corpus.json`). It is never edited here.

Each entry holds a source document and what the Elixir implementation
produced from it: the canonical bytes, the SHA-256 hash, the rendered HTML,
the inline HTML and the plain text. `packages/core/test/parity.test.ts`
replays every entry through the TypeScript implementation and expects the
same bytes.

To refresh it, copy the file from coelho again. A diff in this file is a
change in what both implementations promise, and is reviewed as such.
