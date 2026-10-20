import type { Anchor } from "./anchors.js";
import type { Node } from "./types.js";

/**
 * A comment is rich text too: its body is a document, validated against a
 * schema of its own and rendered with `policy: "untrusted"`, since it is
 * written by whoever can comment rather than by whoever owns the page.
 */
export interface Comment {
  id: string;
  author: string;
  body: Node;
  createdAt: string;
}

/** A discussion attached to a range of a document, stored beside it. */
export interface Thread {
  id: string;
  anchor: Anchor;
  resolved: boolean;
  comments: Comment[];
}
