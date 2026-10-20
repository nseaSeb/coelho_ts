import type { Node } from "../src/index.js";

// Generators of documents a stored row might hold, shared by the fuzz tests
// and by the export that replays them through coelho's Elixir sanitize.

/** A seeded generator, so a case is reproducible from its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const types = ["doc", "paragraph", "heading", "text", "image", "link", "bullet_list", "list_item", "code_block", "hard_break", "attachment", "script", "", 7, null];
const markTypes = ["bold", "italic", "link", "code", "blink", null, 3];
const values = [null, true, 0, 1, 3, 99, -1, "", "x", "javascript:alert(1)", "https://ok.test", "left", "center", [], {}, { nested: { deep: [1, 2] } }];

function hostileNode(next: () => number, depth: number): unknown {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  if (next() < 0.05) return pick(values);
  const node: Record<string, unknown> = { type: pick(types) };
  if (next() < 0.5) node.text = next() < 0.8 ? "word ".repeat(Math.floor(next() * 4)) : pick(values);
  if (next() < 0.3) node.attrs = next() < 0.8 ? { level: pick(values), src: pick(values), href: pick(values), key: pick(values), align: pick(values), start: pick(values) } : pick(values);
  if (next() < 0.3) node.marks = next() < 0.8 ? Array.from({ length: Math.floor(next() * 3) }, () => ({ type: pick(markTypes), attrs: { href: pick(values) } })) : pick(values);
  if (next() < 0.2) node[pick(["onclick", "style", "schema_version", "__proto__x"])] = pick(values);
  if (depth < 6 && next() < 0.7) node.content = next() < 0.9 ? Array.from({ length: Math.floor(next() * 4) }, () => hostileNode(next, depth + 1)) : pick(values);
  return node;
}

/** Trees of anything: unknown types, wrong shapes, values where objects belong. */
export function hostile(seed: number): unknown {
  const next = random(seed);
  return next() < 0.8 ? { type: "doc", content: Array.from({ length: 1 + Math.floor(next() * 4) }, () => hostileNode(next, 1)) } : hostileNode(next, 0);
}

const text = (value: string, marks?: unknown[]): Node => (marks === undefined ? { type: "text", text: value } : ({ type: "text", text: value, marks } as Node));
const paragraph = (content: unknown[]): Node => ({ type: "paragraph", content }) as Node;

/** A valid document with every kind of block, before anything happens to it. */
export function base(): Node {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
      paragraph([text("alpha "), text("bold", [{ type: "bold" }]), text(" link", [{ type: "link", attrs: { href: "https://ok.test" } }])]),
      { type: "bullet_list", content: [{ type: "list_item", content: [paragraph([text("one")])] }, { type: "list_item", content: [paragraph([text("two")])] }] },
      paragraph([text("omega"), { type: "hard_break" }, { type: "image", attrs: { src: "/a.png", alt: "a" } }]),
      { type: "code_block", content: [text("x = 1")] },
    ],
  };
}

type Mutation = (node: Record<string, unknown>) => void;
const mutations: Mutation[] = [
  (node) => (node.onclick = "alert(1)"),
  (node) => (node.attrs = { ...(node.attrs as object), level: 99, align: "sideways" }),
  (node) => (node.type = "script"),
  (node) => (node.marks = [{ type: "blink" }, { type: "link", attrs: { href: "javascript:alert(1)" } }]),
  (node) => (node.content = "not a list"),
  (node) => (node.attrs = "not a map"),
  (node) => (node.text = 42),
  (node) => {
    if (Array.isArray(node.content)) node.content.push({ type: "image", attrs: { alt: "no src" } });
  },
];

function nodes(node: Record<string, unknown>, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  out.push(node);
  if (Array.isArray(node.content)) for (const child of node.content) nodes(child as Record<string, unknown>, out);
  return out;
}

/** The valid document with one to three of the things a stored row picks up over the years. */
export function mutated(seed: number): unknown {
  const next = random(seed);
  const input = JSON.parse(JSON.stringify(base())) as Record<string, unknown>;
  const all = nodes(input).slice(1);
  for (let i = 0; i < 1 + Math.floor(next() * 3); i += 1) {
    const target = all[Math.floor(next() * all.length)] as Record<string, unknown>;
    (mutations[Math.floor(next() * mutations.length)] as Mutation)(target);
  }
  return input;
}
