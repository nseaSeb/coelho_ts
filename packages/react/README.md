# @nseaprotector/coelho-react

A React rich text editor on ProseMirror and a schema you own. Part of [coelho_ts](https://github.com/nseaSeb/coelho_ts).

**[Live demo](https://nseaseb.github.io/coelho_ts/)** · [Repository](https://github.com/nseaSeb/coelho_ts)

```
npm install @nseaprotector/coelho-core @nseaprotector/coelho-react
```

```tsx
import { defaultSchema } from "@nseaprotector/coelho-core";
import { CoelhoEditor } from "@nseaprotector/coelho-react";
import "prosemirror-view/style/prosemirror.css";

const schema = defaultSchema(); // outside the component: a new schema rebuilds the editor

export function Body({ value, onChange }) {
  return <CoelhoEditor schema={schema} value={value} onChange={onChange} />;
}
```

- `<CoelhoEditor>` and `useCoelhoEditor`: controlled, StrictMode-safe. React owns the container and the toolbar; ProseMirror owns what is inside.
- **Node views as React components**, rendered through portals: `nodeViews={{ mention: MentionChip }}`.
- **Suggestion menus**: `useSuggestion` and `<SuggestionMenu>` for `@` mentions and `/` commands, driven from the keyboard without leaving the text, with the ARIA attributes a screen reader needs.
- `repair` to load a stored row that no longer validates, and `setup` for collaboration with `@nseaprotector/coelho-collab`.

ESM only. MIT.
