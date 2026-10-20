/**
 * A document is plain JSON, exactly what ProseMirror's `toJSON()` produces
 * and what a `jsonb` column stores. No class wraps it: what is validated is
 * what is stored, and a JSON round trip is the identity.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Attrs = Record<string, JsonValue>;

export interface Mark {
  type: string;
  attrs?: Attrs;
}

export interface Node {
  type: string;
  attrs?: Attrs;
  content?: Node[];
  marks?: Mark[];
  text?: string;
}

/** A validated document. Structurally a `Node`; the brand records that it came out of `validate`. */
export type Document = Node & { readonly __coelhoValidated?: true };

export interface ValidationError {
  /** Segments from the root: string keys for object fields, integers for positions inside `content`. */
  path: Array<string | number>;
  message: string;
}

export type Limits = {
  maxNodes: number;
  maxDepth: number;
  maxTextLength: number;
  maxAttrLength: number;
};

/** A custom validator answers `null` when the value is fine, or the message explaining why not. */
export type ValidateFn = (value: unknown) => null | string;

export type Validator =
  | "string"
  | "integer"
  | "boolean"
  | "safe_url"
  | { oneOf: JsonValue[] }
  | { nullable: Validator }
  | ValidateFn;

export type RenderAs = { style: string } | { class: Record<string, string> };

export interface AttrInput {
  default?: JsonValue;
  required?: boolean;
  validate?: Validator;
  renderAs?: RenderAs;
}

export interface Attr {
  default: JsonValue;
  required: boolean;
  validate: Validator | null;
  renderAs: RenderAs | null;
}

/** What an attribute list may carry: `null`, `undefined` and `false` are dropped, `true` is a bare attribute. */
export type DomAttrValue = string | number | boolean | null | undefined;
export type DomAttrs = Array<[string, DomAttrValue]>;

export interface RenderContext {
  /** How an attachment key becomes a URL. Absent: attachments render as missing. */
  resolve?: Record<string, string> | ((key: string) => string | null | undefined);
  [key: string]: unknown;
}

export type RenderFn = (node: Node | Mark, inner: string, context: RenderContext) => string;
export type DomRender = [
  tag: string | ((node: Node | Mark) => string),
  attrs: DomAttrs | ((node: Node | Mark, context: RenderContext) => DomAttrs),
];
export type Render = DomRender | RenderFn;

/** An HTML import rule: a tag name, or a tag name with a function turning DOM attributes into node attributes. */
export type ParseRule = string | [tag: string, attrs: (attrs: Record<string, string>) => Attrs];

export interface NodeSpecInput {
  content?: string;
  group?: string | string[];
  marks?: "all" | "none" | string | string[];
  attrs?: Record<string, AttrInput>;
  inline?: boolean;
  text?: boolean;
  void?: boolean;
  code?: boolean;
  class?: string;
  editorAttrs?: Record<string, string>;
  render?: Render;
  renderInline?: Render;
  renderUntrusted?: Render;
  renderUntrustedInline?: Render;
  toText?: string | ((node: Node) => string);
  editorText?: string;
  parse?: ParseRule[];
}

export interface NodeSpec {
  name: string;
  contentSource: string | null;
  group: string[];
  marks: "all" | string[];
  attrs: Record<string, Attr>;
  inline: boolean;
  text: boolean;
  void: boolean;
  code: boolean;
  class: string | null;
  editorAttrs: Record<string, string>;
  render: Render | null;
  renderInline: Render | null;
  renderUntrusted: Render | null;
  renderUntrustedInline: Render | null;
  toText: string | ((node: Node) => string) | null;
  editorText: string | null;
  parse: ParseRule[];
}

export interface MarkSpecInput {
  attrs?: Record<string, AttrInput>;
  class?: string;
  editorAttrs?: Record<string, string>;
  code?: boolean;
  render?: Render;
  renderUntrusted?: Render;
  parse?: ParseRule[];
}

export interface MarkSpec {
  name: string;
  attrs: Record<string, Attr>;
  class: string | null;
  editorAttrs: Record<string, string>;
  code: boolean;
  render: Render | null;
  renderUntrusted: Render | null;
  parse: ParseRule[];
}
