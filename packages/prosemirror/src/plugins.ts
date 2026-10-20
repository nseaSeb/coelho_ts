import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Schema } from "prosemirror-model";
import { splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Command, Plugin } from "prosemirror-state";

/**
 * The editing behaviour the Phoenix hook ships: history, the base keymap,
 * the usual shortcuts, and the typing rules that turn `# `, `- `, `1. `,
 * `> ` and triple backticks into blocks. Every rule is guarded by the
 * schema: a schema without headings gets no heading rule.
 */
export function coelhoPlugins(schema: Schema): Plugin[] {
  const keys: Record<string, (typeof baseKeymap)[string]> = {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
  };
  const mark = (name: string, key: string): void => {
    const type = schema.marks[name];
    if (type !== undefined) keys[key] = toggleMark(type);
  };
  mark("bold", "Mod-b");
  mark("italic", "Mod-i");
  mark("underline", "Mod-u");
  mark("code", "Mod-`");
  if (schema.nodes.list_item !== undefined) keys.Enter = splitListItem(schema.nodes.list_item);
  keys["Shift-Enter"] = insertHardBreak(schema);

  const rules = [];
  if (schema.nodes.heading !== undefined) {
    rules.push(textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({ level: match[1]?.length ?? 1 })));
  }
  if (schema.nodes.bullet_list !== undefined) rules.push(wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list));
  if (schema.nodes.ordered_list !== undefined) {
    rules.push(
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list,
        (match) => ({ start: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs.start as number) === Number(match[1]),
      ),
    );
  }
  if (schema.nodes.blockquote !== undefined) rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));
  if (schema.nodes.code_block !== undefined) rules.push(textblockTypeInputRule(/^```$/, schema.nodes.code_block));

  return [inputRules({ rules }), keymap(keys), keymap(baseKeymap), history(), dropCursor(), gapCursor()];
}

/**
 * A line break that stays in its block: a newline inside code, a
 * `hard_break` where the parent allows one, and nothing at all elsewhere,
 * so the key falls through to the next binding.
 */
export function insertHardBreak(schema: Schema): Command {
  const br = schema.nodes.hard_break;
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    if ($from.parent.type.spec.code) {
      dispatch?.(state.tr.insertText("\n").scrollIntoView());
      return true;
    }
    if (br === undefined || !$from.sameParent($to) || !$from.parent.canReplaceWith($from.index(), $to.index(), br)) return false;
    dispatch?.(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
    return true;
  };
}

export { setBlockType, toggleMark, wrapIn, wrapInList };
