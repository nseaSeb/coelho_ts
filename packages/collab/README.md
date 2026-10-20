# @nseaprotector/coelho-collab

Real-time collaborative rich text over [Yjs](https://yjs.dev) for ProseMirror. Yjs carries and merges every writer's changes; what you store stays a validated document. Part of [coelho_ts](https://github.com/nseaSeb/coelho_ts).

**[Live demo](https://nseaseb.github.io/coelho_ts/)** (two writers in one page) · [Repository](https://github.com/nseaSeb/coelho_ts)

```
npm install @nseaprotector/coelho-core @nseaprotector/coelho-prosemirror @nseaprotector/coelho-collab yjs
```

```ts
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { collab, seed, snapshot, relativeAnchors, sharedThreads } from "@nseaprotector/coelho-collab";

const doc = new Y.Doc();             // connect it with y-websocket or Hocuspocus
const awareness = new Awareness(doc);
if (roomIsEmpty) seed(doc, schema, storedDocument); // once per room

// React: useCoelhoEditor({ schema, setup: collab({ doc, awareness }), history: false })
// Anything else: createEditor(element, { schema, setup: collab({ doc, awareness }), history: false })

const { document, errors } = snapshot(doc, schema); // validated, ready to store
```

- Remote cursors, offline merge, and **undo that is each writer's own**.
- **Comment threads that survive other writers**, on Yjs relative positions: someone typing inside a commented word does not lose the thread.
- **Shared threads** beside the document in the same Y.Doc: the stored document and its hash do not change.
- **The shared document is not a trust boundary**: anything a peer writes past the editor is repaired by `snapshot` before it is stored, and hostile threads are read defensively.

ESM only. MIT.
