export { toProseMirrorSchema, toProseMirrorDoc, type LoadResult } from "./schema.js";
export { coelhoPlugins, insertHardBreak, setBlockType, toggleMark, wrapIn, wrapInList } from "./plugins.js";
export {
  addComment,
  commentsPlugin,
  commentsState,
  removeComment,
  selectComment,
  setActiveComment,
  setCommentResolved,
  type CommentsPluginOptions,
  type CommentsState,
  type StoredAnchor,
} from "./comments.js";
