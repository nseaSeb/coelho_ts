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

Run it locally: `pnpm install && pnpm --filter coelho-demo dev`, then http://localhost:5180.

## Why

A rich text editor is the one dependency every back-office ends up with,
and the one that is hardest to leave: the stored format sits behind the
editor, and so do the features around it — collaboration, comments,
import and export. This project keeps all of them in code you own, and
separates the format from the editor:

- `@nseaprotector/coelho-core` owns the format. Zero dependencies, runs in the browser,
  in Node, in a worker. Your schema, your validation, your rendering.
- the editor (ProseMirror, MIT) is an adapter behind that boundary. Swap
  it, upgrade it, or replace it: the stored documents do not change.

**[Live demo](https://nseaseb.github.io/coelho_ts/)**

```
npm install @nseaprotector/coelho-core @nseaprotector/coelho-react
```

Not only React: `coelho-core` runs anywhere, and `createEditor` from
`coelho-prosemirror` mounts the editor with no framework (see
[Vue and Angular](#vue-and-angular)).

## Packages

| Package | What | Status |
| --- | --- | --- |
| `@nseaprotector/coelho-core` | schema, `validate`, `sanitize`, `canonical`, `hash`, `toHtml`, `toInlineHtml`, `toText`, `toMarkdown`, `isBlank`, trusted/untrusted rendering policy, anchors | `validate`, `canonical`, `hash`, `toHtml` and `toText` byte for byte with coelho's corpus; `sanitize` ported with coelho's own test suite |
| `@nseaprotector/coelho-prosemirror` | coelho schema → ProseMirror `Schema`, editing plugins, anchored comments, suggestion triggers, `fromHtml`, `fromMarkdown`, Markdown paste | working |
| `@nseaprotector/coelho-react` | `<CoelhoEditor>`, `useCoelhoEditor`, default toolbar, React node views, `useSuggestion` and `<SuggestionMenu>` | working |
| `@nseaprotector/coelho-collab` | collaborative editing over Yjs: `seed`, `snapshot`, `collab()`, comment threads on relative positions, shared threads, `LocalRelay` | working |

`apps/demo` (`pnpm --filter coelho-demo dev`, http://localhost:5180) shows
the editor with anchored comments, and under it everything derived from
the stored tree.

## Five minutes

```ts
import { defaultSchema, validate, hash, toHtml, toText } from "@nseaprotector/coelho-core";

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
import { defaultSchema, extendSchema } from "@nseaprotector/coelho-core";

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

## coelho notes: collaborative pages, with a server

`apps/notes` is the same editor behind a real server: a
[Hocuspocus](https://tiptap.dev/docs/hocuspocus) server (MIT) every writer
connects to, and Postgres. One command:

```
docker compose up --build
```

then http://localhost:8080, in two browsers. `#a-page-name` in the URL
opens another page.

- **The server decides what is stored.** After changes settle, it reads
  the shared document with `snapshot`, validates it, repairs what a client
  wrote past the editor, and stores the result. A `javascript:` link
  written into the shared document by a client is in no stored row, and
  what was repaired is recorded beside it.
- **One row per page**: the Yjs state the room resumes from (`bytea`), the
  validated document (`jsonb`), its hash, and its plain text, derived at
  write time for search.
- **A page is seeded on the server, once**, the first time it is opened,
  and stored at once, so two writers opening an empty page at the same
  moment do not see its content twice.
- **Who writes is decided by the server.** Accounts with an email and a
  password (scrypt), sessions in an `HttpOnly`, `SameSite=Lax` cookie whose
  token is stored hashed. The first account is the admin; everyone after
  is a reader until an admin makes them an editor, and a new role applies
  at once (their socket closes and reconnects under it). A reader's
  connection is read only on the server, so a modified client cannot
  write; the name and colour others see in the presence are the
  account's, whatever a client claims; each stored page records who last
  changed it. `SIGNUP=closed` closes sign-up, `DEFAULT_ROLE` sets the
  role of new accounts.
- **Pages link to pages.** `[[` in the editor lists the pages, or offers to
  create one; the link is a node of the schema (`page_link`), its name held
  to what a page name can be, so a hostile one is repaired like any other
  attribute. The server derives each page's links from the validated body
  when it stores it (a `text[]` column with a GIN index), and
  `GET /api/pages/:name/backlinks` answers who links to a page. A `/` in a
  name is a folder: `projects/sprint-42` sits in `projects`.
- **The vault goes out and comes back.** `GET /api/export` is a ZIP of
  Markdown files, one per page, in their folders, links written as
  Obsidian writes them (built with what Node ships: deflate, on zlib's
  thread pool so a large export does not hold up the WebSockets, and crc32).
  Import takes `.md` files or a vault folder: the browser reads them with
  `fromMarkdown`, Obsidian's `[[links]]` included (`#heading` and `^block`
  suffixes point at the page; a link without a folder finds its note by
  name, as Obsidian does), properties at the top of a note left out, and
  a file name kept as the page name when the app accepts it. Before
  anything is sent, it says which pages will be replaced, which files
  would land on the same page, and which have no usable name. The server
  checks the session before reading the body, revalidates each page and
  writes it into its room through its own connection, so whoever has it
  open sees it change; a page that fails is reported and the others go
  on. A page exported and imported again stores the same hash, accented
  names included. File names in the archive are UTF-8, which the Finder
  and every current unzip read; the `unzip` macOS ships does not.
- **Search** as you type, every word a prefix, over a generated `tsvector`
  with a GIN index; matches come back marked with control characters, not
  HTML, since the text is the writers'.
- HTTP and WebSockets share one port: `GET /api/pages` and
  `GET /api/pages/:name` return what is stored; the side panel of the app
  shows it, read back from the server.

Without Docker: `DATABASE_URL=postgres://… pnpm --filter coelho-notes dev:server`
and `pnpm --filter coelho-notes dev:web` (http://localhost:5181); without
`DATABASE_URL` the server keeps pages in memory.

## Collaboration

Yjs carries every writer's changes and merges them. It is not the
storage: what is stored is read out of the shared document with
`snapshot`, validated, and repaired by `sanitize` when a concurrent merge,
or a peer writing past the editor, left something the schema refuses.

```ts
const doc = new Y.Doc();
const awareness = new Awareness(doc);
if (roomIsEmpty) seed(doc, schema, storedDocument); // once per room, on the server

const setup = collab({ doc, awareness });           // fresh plugins for every view
useCoelhoEditor({ schema, setup, history: false }); // undo is each writer's own

const { document, errors } = snapshot(doc, schema); // validated, ready to store
```

The shared document is not a trust boundary. y-prosemirror builds nodes
without coelho's attribute validators, so a `javascript:` href written
into it directly reaches every editor (which draws it without its href)
and never the stored document. In production the snapshot belongs where
the document is stored, Hocuspocus's `onStoreDocument` for instance.

**Comment threads survive other writers.** y-prosemirror applies a remote
change by replacing the whole document, which collapses every mapped
range. With `relativeAnchors()`, a thread is located after such a change
by Yjs relative positions, which point at items of the shared document:
text typed before it or inside it, by anyone, keeps it on its words
(another writer turning *cat* into *chat* leaves it on *chat*, where a
quote alone would lose it), and its quote is the fallback.

**Threads are shared** with `sharedThreads(doc, author)`: a map beside the
document in the same Yjs document, a map per thread and an array of
comments, so replies posted at the same time are both kept. The stored
document and its hash are the same with or without them.

The demo's second section has two writers, each with their own Y.Doc,
joined by `LocalRelay` inside the page, with presence, an offline switch,
shared threads, and what each would store with its hash. Over a network,
y-websocket or Hocuspocus, both MIT, do the same; you run the server.

## Markdown

`toMarkdown` (in `@nseaprotector/coelho-core`, no dependency) writes CommonMark with
GitHub's tables and strikethrough. Every character a writer typed comes
back as that character: what Markdown would read as syntax is escaped, a
mark is written with `**`, `*` or `~~` only where CommonMark is certain to
read them as delimiters and as `<strong>`, `<em>`, `<del>` otherwise, and
what Markdown cannot say (a cell holding a list, a heading holding a line
break) is written as HTML. Your own nodes and marks take overrides.

`fromMarkdown` and `fromHtml` (in `@nseaprotector/coelho-prosemirror`, they need a DOM; `fromMarkdown` reads Obsidian's `[[links]]` into a node of your schema with `wikiLinks`)
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

## Vue and Angular

`createEditor` mounts the editor on an element and reports changes; a
component wraps it in a few lines.

```vue
<!-- Vue 3: <CoelhoField v-model="body" /> -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { defaultSchema, type Node } from "@nseaprotector/coelho-core";
import { createEditor, type CoelhoEditor } from "@nseaprotector/coelho-prosemirror";

const model = defineModel<Node | null>();
const host = ref<HTMLElement>();
const schema = defaultSchema();
let editor: CoelhoEditor | undefined;

onMounted(() => {
  editor = createEditor(host.value!, { schema, value: model.value, onChange: (doc) => (model.value = doc) });
});
watch(model, (doc) => editor?.setDocument(doc ?? null));
onBeforeUnmount(() => editor?.destroy());
</script>

<template><div ref="host" class="coelho-editor" /></template>
```

```ts
// Angular 17+: <coelho-field [value]="body" (changed)="body = $event" />
import { Component, ElementRef, effect, input, output, viewChild, type AfterViewInit, type OnDestroy } from "@angular/core";
import { defaultSchema, type Node } from "@nseaprotector/coelho-core";
import { createEditor, type CoelhoEditor } from "@nseaprotector/coelho-prosemirror";

@Component({ selector: "coelho-field", standalone: true, template: `<div #host class="coelho-editor"></div>` })
export class CoelhoFieldComponent implements AfterViewInit, OnDestroy {
  value = input<Node | null>(null);
  changed = output<Node>();
  private host = viewChild.required<ElementRef<HTMLElement>>("host");
  private editor?: CoelhoEditor;
  private schema = defaultSchema();

  constructor() {
    effect(() => this.editor?.setDocument(this.value()));
  }

  ngAfterViewInit(): void {
    this.editor = createEditor(this.host().nativeElement, { schema: this.schema, value: this.value(), onChange: (doc) => this.changed.emit(doc) });
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
  }
}
```

`setDocument` leaves the editor alone when it is handed the document it
already holds, so feeding `onChange` back into the input does not reset
the selection or the history.

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
- `@nseaprotector/coelho-core` computes positions and quotes on the stored JSON exactly
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
pnpm check     # typecheck, lint, unit and jsdom tests
pnpm e2e       # Playwright, in Chromium: the demo and coelho notes in a real browser
```

The end-to-end tests check what jsdom cannot: the `@` list placed under
the caret, copy and paste through the real clipboard, two writers in one
page, and two browsers signed in to the notes server (roles applied live,
`[[links]]` followed, backlinks). They run on every push.

Node 20+, pnpm 10.

## Roadmap

Done: the storage layer with parity, `sanitize`, Markdown both ways, collaboration over Yjs, the ProseMirror adapter,
the controlled React editor (StrictMode-safe: every jsdom test mounts
under StrictMode), React node views, suggestions, anchored comments.

1. `@nseaprotector/coelho-core`: `toJSON` of the schema in the shape coelho's browser
   hook expects.
2. Node views with editable content (only leaf nodes today).
3. Comments: render threads on the page (`toHtml` with highlights),
   mentions in comment bodies.
4. coelho notes: unresolved links (pages linked to and never opened),
   and comment threads on pages.

## License

MIT.
