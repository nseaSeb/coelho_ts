import { buildAttr } from "./attr.js";
import { matches, names, parse, type Ast } from "./contentExpression.js";
import type {
  Attr,
  AttrInput,
  Limits,
  MarkSpec,
  MarkSpecInput,
  Node,
  NodeSpec,
  NodeSpecInput,
} from "./types.js";

export interface SchemaInput {
  topNode?: string;
  version?: number;
  limits?: Partial<Limits>;
  nodes?: Record<string, NodeSpecInput>;
  marks?: Record<string, MarkSpecInput>;
}

export interface Schema {
  readonly topNode: string;
  readonly version: number | null;
  readonly limits: Limits;
  readonly nodes: ReadonlyMap<string, NodeSpec>;
  readonly marks: ReadonlyMap<string, MarkSpec>;
  readonly nodeOrder: readonly string[];
  readonly markOrder: readonly string[];
  readonly groups: ReadonlyMap<string, ReadonlySet<string>>;
  /** @internal parsed content expressions, by node name */
  readonly content: ReadonlyMap<string, Ast>;
}

/**
 * The bounds every schema carries, generous by default: they exist so a
 * hostile document cannot exhaust the process, and an application tightens
 * them per field. `Infinity` lifts a bound.
 */
export const DEFAULT_LIMITS: Limits = {
  maxNodes: 10_000,
  maxDepth: 100,
  maxTextLength: 1_000_000,
  maxAttrLength: 10_000,
};

export function defineSchema(input: SchemaInput): Schema {
  const nodeInputs = ensureTextNode(input.nodes ?? {});
  const markInputs = input.marks ?? {};
  const nodes = new Map(Object.entries(nodeInputs).map(([name, decl]) => [name, buildNode(name, decl)]));
  const marks = new Map(Object.entries(markInputs).map(([name, decl]) => [name, buildMark(name, decl)]));
  return finish({
    topNode: input.topNode ?? "doc",
    version: buildVersion(input.version),
    limits: buildLimits(DEFAULT_LIMITS, input.limits),
    nodes,
    marks,
    nodeOrder: Object.keys(nodeInputs),
    markOrder: Object.keys(markInputs),
  });
}

/**
 * A schema with nodes and marks added or redeclared. A redeclared name
 * keeps its place in the order, and only the fields the declaration
 * mentions change; a new name is appended.
 */
export function extendSchema(schema: Schema, input: SchemaInput): Schema {
  const nodeInputs = input.nodes ?? {};
  const markInputs = input.marks ?? {};
  const nodes = new Map(schema.nodes);
  for (const [name, decl] of Object.entries(nodeInputs)) {
    nodes.set(name, adjust(nodes.get(name), buildNode(name, decl), decl));
  }
  const marks = new Map(schema.marks);
  for (const [name, decl] of Object.entries(markInputs)) {
    marks.set(name, adjust(marks.get(name), buildMark(name, decl), decl));
  }
  return finish({
    topNode: schema.topNode,
    version: input.version === undefined ? schema.version : buildVersion(input.version),
    limits: buildLimits(schema.limits, input.limits),
    nodes,
    marks,
    nodeOrder: appendNew(schema.nodeOrder, Object.keys(nodeInputs)),
    markOrder: appendNew(schema.markOrder, Object.keys(markInputs)),
  });
}

const NODE_FIELDS: Record<string, (keyof NodeSpec)[]> = {
  content: ["contentSource"],
  group: ["group"],
  marks: ["marks"],
  attrs: ["attrs"],
  inline: ["inline"],
  text: ["text"],
  void: ["void"],
  code: ["code"],
  class: ["class"],
  editorAttrs: ["editorAttrs"],
  render: ["render"],
  renderInline: ["renderInline"],
  renderUntrusted: ["renderUntrusted"],
  renderUntrustedInline: ["renderUntrustedInline"],
  toText: ["toText"],
  editorText: ["editorText"],
  parse: ["parse"],
};

function adjust<S extends NodeSpec | MarkSpec>(existing: S | undefined, built: S, decl: object): S {
  if (existing === undefined) return built;
  const out = { ...existing } as unknown as Record<string, unknown>;
  const source = built as unknown as Record<string, unknown>;
  for (const key of Object.keys(decl)) {
    for (const field of NODE_FIELDS[key] ?? [key]) {
      if (field in source) out[field] = source[field];
    }
  }
  return out as unknown as S;
}

function appendNew(existing: readonly string[], added: string[]): string[] {
  return [...existing, ...added.filter((name) => !existing.includes(name))];
}

function finish(partial: Omit<Schema, "groups" | "content">): Schema {
  const groups = new Map<string, Set<string>>();
  const content = new Map<string, Ast>();
  for (const [name, spec] of partial.nodes) {
    for (const group of spec.group) {
      const members = groups.get(group) ?? new Set<string>();
      members.add(name);
      groups.set(group, members);
    }
    if (spec.contentSource !== null) {
      try {
        content.set(name, parse(spec.contentSource));
      } catch (error) {
        throw new Error(`node ${JSON.stringify(name)}: ${(error as Error).message}`);
      }
    }
  }
  const schema: Schema = { ...partial, groups, content };
  validateSchema(schema);
  return schema;
}

function validateSchema(schema: Schema): void {
  if (!schema.nodes.has(schema.topNode)) throw new Error(`top node ${JSON.stringify(schema.topNode)} is not declared`);
  for (const [name, ast] of schema.content) {
    for (const referenced of names(ast)) {
      if (!schema.nodes.has(referenced) && !schema.groups.has(referenced)) {
        throw new Error(`node ${JSON.stringify(name)} refers to unknown node or group ${JSON.stringify(referenced)}`);
      }
    }
  }
  for (const [name, spec] of schema.nodes) {
    if (spec.marks !== "all") {
      for (const mark of spec.marks) {
        if (!schema.marks.has(mark)) throw new Error(`node ${JSON.stringify(name)} allows unknown mark ${JSON.stringify(mark)}`);
      }
    }
  }
}

function ensureTextNode(nodes: Record<string, NodeSpecInput>): Record<string, NodeSpecInput> {
  if ("text" in nodes) return nodes;
  return { ...nodes, text: { group: "inline", inline: true, text: true } };
}

function buildNode(name: string, decl: NodeSpecInput): NodeSpec {
  return {
    name,
    contentSource: decl.content ?? null,
    group: normalizeList(decl.group),
    marks: decl.marks === undefined || decl.marks === "all" ? "all" : decl.marks === "none" ? [] : normalizeList(decl.marks),
    attrs: buildAttrs(decl.attrs),
    inline: decl.inline ?? false,
    text: decl.text ?? false,
    void: decl.void ?? false,
    code: decl.code ?? false,
    class: decl.class ?? null,
    editorAttrs: decl.editorAttrs ?? {},
    render: decl.render ?? null,
    renderInline: decl.renderInline ?? null,
    renderUntrusted: decl.renderUntrusted ?? null,
    renderUntrustedInline: decl.renderUntrustedInline ?? null,
    toText: decl.toText ?? null,
    editorText: decl.editorText ?? null,
    parse: decl.parse ?? [],
  };
}

function buildMark(name: string, decl: MarkSpecInput): MarkSpec {
  return {
    name,
    attrs: buildAttrs(decl.attrs),
    class: decl.class ?? null,
    editorAttrs: decl.editorAttrs ?? {},
    code: decl.code ?? false,
    render: decl.render ?? null,
    renderUntrusted: decl.renderUntrusted ?? null,
    parse: decl.parse ?? [],
  };
}

function buildAttrs(attrs: Record<string, AttrInput> | undefined): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  for (const [name, input] of Object.entries(attrs ?? {})) out[name] = buildAttr(input);
  return out;
}

function normalizeList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : value;
}

function buildVersion(version: number | undefined): number | null {
  if (version === undefined) return null;
  if (!Number.isInteger(version) || version <= 0) throw new Error(`schema version must be a positive integer, got ${version}`);
  return version;
}

export function buildLimits(base: Limits, given: Partial<Limits> | undefined): Limits {
  const out = { ...base };
  for (const key of Object.keys(given ?? {}) as (keyof Limits)[]) {
    const value = given?.[key];
    if (value === undefined) continue;
    if (value !== Infinity && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`limit ${key} must be a positive integer or Infinity, got ${value}`);
    }
    out[key] = value;
  }
  return out;
}

export function nodeSpec(schema: Schema, name: string): NodeSpec | undefined {
  return schema.nodes.get(name);
}

export function markSpec(schema: Schema, name: string): MarkSpec | undefined {
  return schema.marks.get(name);
}

export function specOf(schema: Schema, node: unknown): NodeSpec | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const type = (node as Node).type;
  return typeof type === "string" ? schema.nodes.get(type) : undefined;
}

/** Where a mark sits in the schema's declaration order; unknown marks sort last. */
export function markIndex(schema: Schema, name: string): number {
  const index = schema.markOrder.indexOf(name);
  return index === -1 ? schema.markOrder.length : index;
}

export function markAllowed(allowed: "all" | readonly string[], name: string): boolean {
  return allowed === "all" || allowed.includes(name);
}

/** Whether `nodeType` is `name`, directly or through a group `name` denotes. */
export function instanceOf(schema: Schema, name: string, nodeType: string): boolean {
  return name === nodeType || (schema.groups.get(name)?.has(nodeType) ?? false);
}

/** Whether a list of child types satisfies the node's content expression. */
export function contentMatches(schema: Schema, spec: NodeSpec, types: string[]): boolean {
  const ast = schema.content.get(spec.name);
  if (ast === undefined) return types.length === 0;
  return matches(ast, types, (name, child) => instanceOf(schema, name, child));
}
