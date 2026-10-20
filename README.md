# coelho_ts

[![CI](https://github.com/nseaSeb/coelho_ts/actions/workflows/ci.yml/badge.svg)](https://github.com/nseaSeb/coelho_ts/actions/workflows/ci.yml)

Structured rich text for TypeScript and React. The document is the storage,
never HTML.

This is a port of [Coelho](https://github.com/nseaSeb/coelho) (Elixir /
Phoenix) to the JavaScript side: the same JSON document, the same schema
language, the same validation, the same canonical bytes and hash, the same
safe HTML and plain text. The two implementations are checked against one
shared fixture, so a document written by one is read by the other without a
migration.

![The demo: the editor with an @ mention list open under the caret, a mention drawn as a React chip, a commented passage with its thread beside the editor, and under it the HTML, the HTML a stranger's comment would get, and its source, all recomputed from the stored document.](apps/demo/demo.png)

Run it: `pnpm install && pnpm --filter coelho-demo dev`, then http://localhost:5180.

## Why

A rich text editor is the one dependency every back-office ends up with,
and the one that turns into a subscription: collaboration, comments,
versions and import/export sit behind a paid tier, and the stored format
sits behind the editor. This project separates the two:

- `@coelho/core` owns the format. Zero dependencies, runs in the browser,
  in Node, in a worker. Your schema, your validation, your rendering.
- the editor (ProseMirror, MIT) is an adapter behind that boundary. Swap
  it, upgrade it, or replace it: the stored documents do not change.

## Packages

| Package | What | Status |
| --- | --- | --- |
| `@coelho/core` | schema, `validate`, `sanitize`, `canonical`, `hash`, `toHtml`, `toInlineHtml`, `toText`, `toMarkdown`, `isBlank`, trusted/untrusted rendering policy, anchors | `validate`, `canonical`, `hash`, `toHtml` and `toText` byte for byte with coelho's corpus; `sanitize` ported with coelho's own test suite |
| `@coelho/prosemirror` | coelho schema → ProseMirror `Schema`, editing plugins, anchored comments, suggestion triggers, `fromHtml`, `fromMarkdown`, Markdown paste | working |
| `@coelho/react` | `<CoelhoEditor>`, `useCoelhoEditor`, default toolbar, React node views, `useSuggestion` and `<SuggestionMenu>` | working |

`apps/demo` (`pnpm --filter coelho-demo dev`, http://localhost:5180) shows
the editor with anchored comments, and under it everything derived from
the stored tree.

## Five minutes

```ts
import { defaultSchema, validate, hash, toHtml, toText } from "@coelho/core";

const schema = defaultSchema();
const result = validate(editor.state.doc.toJSON(), schema);

if (!result.ok) {
  // result.errors: [{ path: ["content", 0, "marks", 0, "attrs", "href"], message: 'scheme "javascript" is not allowed' }]
}

const stored = result.document;          // canonical: store this JSON
await hash(stored);                      // sha256 of the canonical bytes, or null when empty
toHtml(stored, schema);                  // the page
toHtml(stored, schema, { policy: "untrusted" }); // a stranger's comment, links and images reduced to text
toText(stored, schema);                  // what a search index holds
```

### Two boundaries

`validate` is the boundary at the keyboard: strict, it refuses and says
where. `sanitize` is the boundary at the screen: a stored row is not
revalidated when it is read, so one written under an older or looser
schema, or by a direct SQL write, goes through it before a page shows it.

```ts
const row = await db.posts.find(id);
toHtml(sanitize(row.body, schema), schema);
sanitize(row.body, schema, { limits: { maxTextLength: Infinity } }); // clean the structure, keep the length
```

It never fails and never raises. An unknown key or a failing attribute is
dropped, a forbidden mark goes and its text stays, an unknown node goes
with its text, a document over its bounds is cut to fit, and what cannot
be repaired becomes the empty document. Sanitising twice is sanitising
once. The editor can load a row through it too: `useCoelhoEditor({ repair: true })`.

### Your own schema

```ts
import { defaultSchema, extendSchema } from "@coelho/core";

const schema = extendSchema(defaultSchema(), {
  nodes: {
    mention: {
      group: "inline", inline: true, void: true,
      attrs: { user_id: { required: true, validate: "integer" } },
      render: ["span", (node) => [["data-user", String(node.attrs?.user_id)]]],
    },
  },
  marks: { highlight: { class: "hl", render: ["mark", []] } },
});
```

## Markdown

`toMarkdown` (in `@coelho/core`, no dependency) writes CommonMark with
GitHub's tables and strikethrough. Every character a writer typed comes
back as that character: what Markdown would read as syntax is escaped, a
mark is written with `**`, `*` or `~~` only where CommonMark is certain to
read them as delimiters and as `<strong>`, `<em>`, `<del>` otherwise, and
what Markdown cannot say (a cell holding a list, a heading holding a line
break) is written as HTML. Your own nodes and marks take overrides.

`fromMarkdown` and `fromHtml` (in `@coelho/prosemirror`, they need a DOM)
go the other way through the schema's own parse rules, on an inert
document: nothing in the HTML runs or loads. `markdownPaste(schema)` makes
pasted plain text arrive formatted. Text that says nothing in Markdown is
left to ProseMirror, so it takes the marks at the cursor (a word pasted
into bold stays bold); nothing is parsed inside code; Shift-paste keeps
everything plain.

The tests are coelho's, with its oracle: a document's Markdown, read back,
has to equal its HTML read back through the same import, so the only
differences left are the Markdown's. Every string coelho pins comes out
identical here. Of coelho's three properties, two are ported; the third
draws from coelho's shared document generator, and stands in here as
Unicode added to the syntax-heavy one: no-break and narrow spaces, `«` `»`,
`’`, a decomposed `é`, emoji. The property holds on 5,000 generated
documents (`MARKDOWN_SEEDS=5000 pnpm test`; the timeout grows with it).

What the search found, none of it in the writer's escaping:

- markdown-it drops escaped characters from an image's alt text;
- ProseMirror's parser moves a block out of a list item that does not
  open with its paragraph, and its paste opens a slice so deep that a
  pasted list lost its first bullet;
- CommonMark strips only spaces and tabs at a block's edge, while
  JavaScript's `trim` (markdown-it uses it) strips a no-break space too.
  `toMarkdown` writes such a space at an edge as its entity, the one place
  it differs from coelho's writer; every reader decodes it to the same
  character.

`scripts/sanitize-parity` also exports 800 of these documents with this
writer's Markdown, for `compare.exs` to replay through coelho's
`to_markdown` from a coelho checkout; it reports the edge entities apart.

## React inside the editor

ProseMirror owns the editable DOM; React owns everything around it. Two
places cross that line, both without React ever rendering into
ProseMirror's tree directly.

**Node views.** A leaf node can be drawn in the editor by a React
component, rendered through a portal into the element ProseMirror creates,
moves and destroys. The page still renders the node from the schema.

```tsx
function MentionChip({ node, selected }: NodeViewProps) {
  return <span className={selected ? "chip selected" : "chip"}>{node.attrs.label}</span>;
}
const nodeViews = { mention: MentionChip }; // stable: read once
<CoelhoEditor schema={schema} nodeViews={nodeViews} value={value} onChange={setValue} />
```

**Suggestions.** `@` for a mention, `/` for a block: the plugin says what
is being typed (a trigger must start a word, so `a@b` is an address; the
query ends at the first space; nothing opens in code), and the list is
the application's. Arrows, Enter and Tab reach the list through the
editor, so focus never leaves the text; Escape dismisses until the writer
starts again elsewhere. The editor is a multi-line text box, which
points at the list and its highlighted option (`aria-controls`,
`aria-activedescendant`) only while the list is open, and a choice
replaces the range the editor holds when it is made.

```tsx
const [{ plugin, keys }] = useState(() => createSuggestion(["@"]));
const suggestion = useSuggestion(editor, {
  keys,
  items: (match) => people.matching(match.query),
  onSelect: (person) => run(replaceSuggestion(mention.create({ id: person.id, label: person.name }))),
});
<SuggestionMenu suggestion={suggestion} label="People">{(person) => person.name}</SuggestionMenu>
```

## Anchored comments

A thread points at a range of the document and is stored beside it, never
inside it: commenting does not change the document, its canonical bytes
or its hash.

```ts
interface Thread { id: string; anchor: { from: number; to: number; quote: string; prefix?: string; suffix?: string }; resolved: boolean; comments: Comment[] }
```

- In the editor, `commentsPlugin` draws threads as decorations and maps
  their ranges through every change. Typing at the end of a commented
  range does not extend it. Deleting the text loses the anchor; undo
  finds it again.
- `@coelho/core` computes positions and quotes on the stored JSON exactly
  as ProseMirror does (checked on every range of a test document), so a
  server can place a thread without an editor.
- An anchor keeps the text just before and after its quote, the shape of
  the W3C Web Annotation `TextQuoteSelector`. When the document changed
  elsewhere, `reanchor` ranks every occurrence of the quote by how well
  its surroundings agree, and uses distance only to break ties: a comment
  on one word does not jump to the same word in a paragraph added above.
- A thread whose text is gone is kept, marked as such, with what it said.
  Undo brings it back; retyping the same words, or reloading a document
  that has them somewhere else, does not.
- A comment's body is a coelho document under a schema of its own,
  rendered with `policy: "untrusted"`.

## Parity

`fixtures/corpus.json` is copied verbatim from coelho's test suite. Each
entry is a source document with the canonical bytes, hash, HTML, inline
HTML and text the Elixir implementation produced.
`packages/core/test/parity.test.ts` replays every entry here and expects
the same bytes. A change to the fixture is a change to what both sides
promise, and is reviewed as such.

To check `sanitize` against the Elixir implementation on 800 generated
documents, from a coelho checkout:

```
SANITIZE_PARITY_OUT=/tmp/cases.json pnpm vitest run scripts/sanitize-parity
cd ../coelho && MIX_ENV=test mix run ../coelho_ts/scripts/sanitize-parity/compare.exs /tmp/cases.json
```

## Development

```
pnpm install
pnpm check     # typecheck, lint, test
```

Node 20+, pnpm 10.

## Roadmap

Done: the storage layer with parity, `sanitize`, Markdown both ways, the ProseMirror adapter,
the controlled React editor (StrictMode-safe: every jsdom test mounts
under StrictMode), React node views, suggestions, anchored comments.

1. `@coelho/core`: `toJSON` of the schema in the shape coelho's browser
   hook expects.
2. Node views with editable content (only leaf nodes today).
3. Comments: render threads on the page (`toHtml` with highlights),
   mentions in comment bodies.
4. Collaborative editing over Yjs.

## License

MIT.
