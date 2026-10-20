import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Schema } from "prosemirror-model";
import { splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Plugin } from "prosemirror-state";

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
  if (schema.nodes.hard_break !== undefined) {
    const br = schema.nodes.hard_break;
    keys["Shift-Enter"] = (state, dispatch) => {
      dispatch?.(state.tr.replaceSelectionWith(br.create()).scrollIntoView());
      return true;
    };
  }

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

export { setBlockType, toggleMark, wrapIn, wrapInList };
