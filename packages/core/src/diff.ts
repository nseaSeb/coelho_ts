import { canonical, toText } from "./document.js";
import type { Schema } from "./schema.js";
import type { Node } from "./types.js";

/** A run of words, kept, added or removed. */
export interface WordChange {
  kind: "same" | "added" | "removed";
  text: string;
}

/** What happened to one top-level block between two versions of a document. */
export type BlockChange =
  | { kind: "same"; block: Node }
  | { kind: "added"; block: Node }
  | { kind: "removed"; block: Node }
  /** The same kind of block, edited: its text, word by word. */
  | { kind: "changed"; before: Node; after: Node; words: WordChange[] };

/**
 * Past this many cells, once the common ends are set aside, a comparison
 * is not worth its time or its memory: what differs is shown removed and
 * added instead.
 */
const MAX_CELLS = 1_000_000;

/**
 * The difference between two versions of a document, block by block, and
 * word by word inside a block that was edited rather than replaced. Blocks
 * are compared by their canonical bytes, so a version that only moved
 * attributes around is not a change. Give it validated documents.
 */
export function diffDocuments(before: Node | null | undefined, after: Node | null | undefined, schema: Schema): BlockChange[] {
  const a = before?.content ?? [];
  const b = after?.content ?? [];
  const steps = lcs(a.map(canonical), b.map(canonical), MAX_CELLS);
  // Two large, mostly different versions: everything went, everything came.
  if (steps === null) return [...a.map((block): BlockChange => ({ kind: "removed", block })), ...b.map((block): BlockChange => ({ kind: "added", block }))];
  const out: BlockChange[] = [];
  let removed: Node[] = [];
  let added: Node[] = [];
  const flush = (): void => {
    // A run of removed blocks followed by added ones: a block of the same
    // kind at the same place in both is an edit, not a replacement.
    const paired = Math.min(removed.length, added.length);
    for (let i = 0; i < paired; i += 1) {
      const was = removed[i] as Node;
      const now = added[i] as Node;
      if (was.type === now.type) {
        const words = diffWords(toText(was, schema), toText(now, schema));
        if (words !== null) {
          out.push({ kind: "changed", before: was, after: now, words });
          continue;
        }
      }
      out.push({ kind: "removed", block: was }, { kind: "added", block: now });
    }
    for (const block of removed.slice(paired)) out.push({ kind: "removed", block });
    for (const block of added.slice(paired)) out.push({ kind: "added", block });
    removed = [];
    added = [];
  };
  for (const step of steps) {
    if (step.kind === "same") {
      flush();
      out.push({ kind: "same", block: b[step.right] as Node });
    } else if (step.kind === "removed") removed.push(a[step.left] as Node);
    else added.push(b[step.right] as Node);
  }
  flush();
  return out;
}

/** Words and the spaces between them, each a token, so the text comes back exactly. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** The word diff of two texts, or `null` when it would be too large to compute. */
export function diffWords(before: string, after: string): WordChange[] | null {
  const a = tokens(before);
  const b = tokens(after);
  const steps = lcs(a, b, MAX_CELLS);
  if (steps === null) return null;
  const out: WordChange[] = [];
  for (const step of steps) {
    const text = step.kind === "added" ? (b[step.right] as string) : (a[step.left] as string);
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === step.kind) last.text += text;
    else out.push({ kind: step.kind, text });
  }
  return out;
}

type Step = { kind: "same"; left: number; right: number } | { kind: "removed"; left: number; right: number } | { kind: "added"; left: number; right: number };

/**
 * A longest common subsequence, as the steps that walk from one list to
 * the other; `null` when what is left once the common ends are set aside
 * is larger than `limit` cells.
 */
function lcs(a: string[], b: string[], limit: number): Step[] | null {
  // Common ends first: an edit in the middle of a long page costs only the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > limit) return null;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[start + i] === b[start + j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const steps: Step[] = [];
  for (let i = 0; i < start; i += 1) steps.push({ kind: "same", left: i, right: i });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      steps.push({ kind: "same", left: start + i, right: start + j });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || table[i]![j + 1]! > table[i + 1]![j]!)) {
      // On a tie, what goes comes before what comes: it reads that way.
      steps.push({ kind: "added", left: start + i, right: start + j });
      j += 1;
    } else {
      steps.push({ kind: "removed", left: start + i, right: start + j });
      i += 1;
    }
  }
  for (let k = 0; endA + k < a.length; k += 1) steps.push({ kind: "same", left: endA + k, right: endB + k });
  return steps;
}
