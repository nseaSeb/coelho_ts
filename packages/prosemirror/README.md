# @nseaprotector/coelho-prosemirror

A [ProseMirror](https://prosemirror.net) rich text editor on a schema you own, with no framework: it works in React, Vue, Angular, Svelte or plain JavaScript. Part of [coelho_ts](https://github.com/nseaSeb/coelho_ts).

**[Live demo](https://nseaseb.github.io/coelho_ts/)** · [Repository](https://github.com/nseaSeb/coelho_ts)

```
npm install @nseaprotector/coelho-core @nseaprotector/coelho-prosemirror
```

```ts
import { defaultSchema } from "@nseaprotector/coelho-core";
import { createEditor } from "@nseaprotector/coelho-prosemirror";
import "prosemirror-view/style/prosemirror.css";

const editor = createEditor(document.querySelector("#editor")!, {
  schema: defaultSchema(),
  value: storedDocument,
  onChange: (document) => save(document), // JSON that coelho-core validates
});

editor.setDocument(other); // replace it; refused if it does not validate
editor.destroy();
```

What it adds to ProseMirror:

- the ProseMirror schema built from a coelho schema, so the editor draws what the page will render;
- typing rules and keys (`# `, `- `, `1. `, `> `, triple backticks, Shift-Enter);
- **anchored comments**: threads drawn as decorations and stored beside the document, never inside it, re-anchored by their quote and its context when the document changed elsewhere;
- **suggestions**: `@` mentions, `/` commands, the list being yours;
- **Markdown**: `fromMarkdown`, `fromHtml` on an inert document (nothing in it runs or loads), and `markdownPaste` for pasted plain text.

ESM only. MIT.
