# @nseaprotector/coelho-core

Structured rich text you own. The storage layer of [coelho_ts](https://github.com/nseaSeb/coelho_ts): a schema, strict validation, a canonical JSON form and its hash, `sanitize`, safe HTML, Markdown and plain text. No editor, no DOM, no dependency: it runs in the browser, in Node, in a worker, under any framework.

**[Live demo](https://nseaseb.github.io/coelho_ts/)** · [Repository](https://github.com/nseaSeb/coelho_ts)

```
npm install @nseaprotector/coelho-core
```

```ts
import { defaultSchema, validate, sanitize, hash, toHtml, toMarkdown, toText } from "@nseaprotector/coelho-core";

const schema = defaultSchema();

// At the keyboard: strict, refuses and says where.
const result = validate(editorJson, schema);
if (!result.ok) console.log(result.errors); // [{ path: ["content", 0, "marks", 0, "attrs", "href"], message: 'scheme "javascript" is not allowed' }]

// What you store: canonical JSON, never HTML.
const stored = result.ok ? result.document : null;
await hash(stored); // sha256 of the canonical bytes

// At the screen: a stored row is not revalidated when read, so repair it.
toHtml(sanitize(row.body, schema), schema);
toHtml(stored, schema, { policy: "untrusted" }); // a stranger's comment: links and images reduced to text
toMarkdown(stored, schema);                       // CommonMark with GitHub tables and strikethrough
toText(stored, schema);                           // for a search index
```

Your own schema: `defineSchema` and `extendSchema`, with nodes, marks, attributes and their validators, content expressions, and how each renders.

A port of [coelho](https://github.com/nseaSeb/coelho) (Elixir): the same JSON, the same canonical bytes and hash, checked against coelho's own corpus. ESM only. MIT.
