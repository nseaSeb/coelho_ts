/**
 * Parser and matcher for ProseMirror-style content expressions:
 * `"block+"`, `"paragraph block*"`, `"(text | image)*"`, `"heading{1,3}"`.
 *
 * Matching simulates the expression over the child list with a set of
 * reachable positions, so alternation and repetition need no automaton and
 * `"paragraph* paragraph"` never backtracks wrongly.
 */
export type Ast =
  | { kind: "empty" }
  | { kind: "name"; name: string }
  | { kind: "seq"; items: Ast[] }
  | { kind: "choice"; items: Ast[] }
  | { kind: "repeat"; ast: Ast; min: number; max: number };

type Token =
  | { kind: "pipe" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "repeat"; min: number; max: number }
  | { kind: "name"; name: string };

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_-]/;

export function parse(source: string): Ast {
  const tokens = tokenize(source);
  const [ast, rest] = parseChoice(tokens);
  if (rest.length > 0) throw new Error(`unexpected ${describe(rest[0] as Token)} in ${JSON.stringify(source)}`);
  return ast;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (" \t\n\r".includes(char)) {
      i += 1;
    } else if (char === "|") {
      tokens.push({ kind: "pipe" });
      i += 1;
    } else if (char === "(") {
      tokens.push({ kind: "open" });
      i += 1;
    } else if (char === ")") {
      tokens.push({ kind: "close" });
      i += 1;
    } else if (char === "*") {
      tokens.push({ kind: "repeat", min: 0, max: Infinity });
      i += 1;
    } else if (char === "+") {
      tokens.push({ kind: "repeat", min: 1, max: Infinity });
      i += 1;
    } else if (char === "?") {
      tokens.push({ kind: "repeat", min: 0, max: 1 });
      i += 1;
    } else if (char === "{") {
      const end = source.indexOf("}", i);
      if (end === -1) throw new Error("unterminated range, missing `}`");
      tokens.push(parseRange(source.slice(i + 1, end)));
      i = end + 1;
    } else if (NAME_START.test(char)) {
      let name = "";
      while (i < source.length && NAME_CHAR.test(source[i] as string)) {
        name += source[i];
        i += 1;
      }
      tokens.push({ kind: "name", name });
    } else {
      throw new Error(`unexpected character ${JSON.stringify(char)}`);
    }
  }
  return tokens;
}

function parseRange(body: string): Token {
  const parts = body.trim().split(",");
  const bound = (text: string): number => {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) throw new Error(`malformed range bound ${JSON.stringify(text)}`);
    return Number(trimmed);
  };
  if (parts.length === 1) {
    const min = bound(parts[0] as string);
    return { kind: "repeat", min, max: min };
  }
  if (parts.length === 2) {
    const min = bound(parts[0] as string);
    if ((parts[1] as string).trim() === "") return { kind: "repeat", min, max: Infinity };
    const max = bound(parts[1] as string);
    if (max < min) throw new Error(`range maximum ${max} is below its minimum ${min}`);
    return { kind: "repeat", min, max };
  }
  throw new Error(`malformed range ${JSON.stringify(body)}`);
}

function parseChoice(tokens: Token[]): [Ast, Token[]] {
  const alternatives: Ast[] = [];
  let rest = tokens;
  for (;;) {
    const [seq, after] = parseSeq(rest);
    if (seq.kind === "empty" && (after[0]?.kind === "pipe" || alternatives.length > 0)) {
      throw new Error("empty alternative around `|`");
    }
    alternatives.push(seq);
    if (after[0]?.kind !== "pipe") {
      rest = after;
      break;
    }
    rest = after.slice(1);
  }
  return [alternatives.length === 1 ? (alternatives[0] as Ast) : { kind: "choice", items: alternatives }, rest];
}

function parseSeq(tokens: Token[]): [Ast, Token[]] {
  const items: Ast[] = [];
  let rest = tokens;
  while (rest.length > 0) {
    const token = rest[0] as Token;
    let atom: Ast;
    if (token.kind === "name") {
      atom = { kind: "name", name: token.name };
      rest = rest.slice(1);
    } else if (token.kind === "open") {
      const [inner, after] = parseChoice(rest.slice(1));
      if (after[0]?.kind !== "close") throw new Error("unbalanced `(`");
      atom = inner;
      rest = after.slice(1);
    } else if (token.kind === "repeat") {
      throw new Error(`unexpected ${describe(token)}`);
    } else {
      break;
    }
    const next = rest[0];
    if (next?.kind === "repeat") {
      atom = { kind: "repeat", ast: atom, min: next.min, max: next.max };
      rest = rest.slice(1);
    }
    items.push(atom);
  }
  if (items.length === 0) return [{ kind: "empty" }, rest];
  return [items.length === 1 ? (items[0] as Ast) : { kind: "seq", items }, rest];
}

function describe(token: Token): string {
  switch (token.kind) {
    case "pipe":
      return "`|`";
    case "open":
      return "`(`";
    case "close":
      return "`)`";
    case "repeat":
      return "repetition";
    case "name":
      return `name ${JSON.stringify(token.name)}`;
  }
}

/** Every name the expression refers to, node or group alike. */
export function names(ast: Ast): string[] {
  const out = new Set<string>();
  const walk = (node: Ast): void => {
    switch (node.kind) {
      case "empty":
        return;
      case "name":
        out.add(node.name);
        return;
      case "seq":
      case "choice":
        node.items.forEach(walk);
        return;
      case "repeat":
        walk(node.ast);
    }
  };
  walk(ast);
  return [...out];
}

/**
 * Whether `children` satisfies the expression. `instanceOf(name, child)`
 * answers whether a child is that name, directly or through a group.
 */
export function matches<T>(ast: Ast, children: T[], instanceOf: (name: string, child: T) => boolean): boolean {
  const reachable = step(ast, new Set([0]), children, instanceOf);
  return reachable.has(children.length);
}

function step<T>(ast: Ast, positions: Set<number>, children: T[], instanceOf: (name: string, child: T) => boolean): Set<number> {
  switch (ast.kind) {
    case "empty":
      return positions;
    case "name": {
      const next = new Set<number>();
      for (const position of positions) {
        if (position < children.length && instanceOf(ast.name, children[position] as T)) next.add(position + 1);
      }
      return next;
    }
    case "seq":
      return ast.items.reduce((acc, item) => step(item, acc, children, instanceOf), positions);
    case "choice": {
      const union = new Set<number>();
      for (const item of ast.items) for (const position of step(item, positions, children, instanceOf)) union.add(position);
      return union;
    }
    case "repeat": {
      let current = positions;
      for (let i = 0; i < ast.min; i += 1) current = step(ast.ast, current, children, instanceOf);
      let remaining = ast.max === Infinity ? Infinity : ast.max - ast.min;
      let frontier = current;
      const all = new Set(current);
      while (remaining > 0 && frontier.size > 0) {
        const fresh = new Set<number>();
        for (const position of step(ast.ast, frontier, children, instanceOf)) {
          if (!all.has(position)) {
            all.add(position);
            fresh.add(position);
          }
        }
        frontier = fresh;
        remaining -= 1;
      }
      return all;
    }
  }
}
