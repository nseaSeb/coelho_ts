/**
 * The callout's kinds, in one place: the schema's validator and classes,
 * the editor's chrome, and the Markdown read and written all come from
 * this table.
 */
export const CALLOUT_KINDS = {
  note: { icon: "ℹ", label: "Note" },
  tip: { icon: "✓", label: "Tip" },
  warning: { icon: "!", label: "Warning" },
} as const;

export type CalloutKind = keyof typeof CALLOUT_KINDS;

export const calloutKinds = Object.keys(CALLOUT_KINDS) as CalloutKind[];

/** `callout-warning`, the class a kind renders as, on the page and in the editor alike. */
export const calloutClasses = Object.fromEntries(calloutKinds.map((kind) => [kind, `callout-${kind}`]));
