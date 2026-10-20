import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from "prosemirror-state";

/**
 * What the writer is typing after a trigger: `@ca` is the trigger `@`
 * and the query `ca`, over the range `from`–`to` that a choice replaces.
 */
export interface SuggestionMatch {
  trigger: string;
  query: string;
  from: number;
  to: number;
}

/**
 * Where the editor hands keys to whoever draws the list. The list is the
 * application's — what it holds, how it filters, what a choice does — so
 * the plugin only says what is being typed, and asks the list about the
 * keys that move through it.
 */
export interface SuggestionKeys {
  current: ((event: KeyboardEvent) => boolean) | null;
}

interface SuggestionPluginState {
  match: SuggestionMatch | null;
  /** The `from` of a match the writer dismissed with Escape; it stays closed until they type elsewhere. */
  dismissed: number | null;
}

const key = new PluginKey<SuggestionPluginState>("coelho-suggestion");
const DISMISS = "dismiss";

/** The plugin and the key handle it shares with the list, created together. */
export function createSuggestion(triggers: string[]): { plugin: Plugin<SuggestionPluginState>; keys: SuggestionKeys } {
  const keys: SuggestionKeys = { current: null };
  return { plugin: suggestionPlugin(triggers, keys), keys };
}

/**
 * Opens on a trigger that starts a word — `a@b` is an address, not a
 * mention — and closes at the first space, outside the textblock, inside
 * code, on a selection, or on Escape.
 */
export function suggestionPlugin(triggers: string[], keys: SuggestionKeys): Plugin<SuggestionPluginState> {
  const pattern = new RegExp(`(?:^|[\\s\\ufffc])(${triggers.map(escapeRegExp).join("|")})([^\\s\\ufffc]*)$`);
  return new Plugin<SuggestionPluginState>({
    key,
    state: {
      init: () => ({ match: null, dismissed: null }),
      apply: (tr, previous, _old, state) => {
        const found = find(state, pattern);
        if (tr.getMeta(key) === DISMISS) return { match: null, dismissed: found?.from ?? null };
        if (found !== null && found.from === previous.dismissed) return { match: null, dismissed: previous.dismissed };
        return { match: found, dismissed: null };
      },
    },
    props: {
      handleKeyDown: (view, event) => {
        if (key.getState(view.state)?.match == null) return false;
        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(key, DISMISS));
          return true;
        }
        return keys.current?.(event) ?? false;
      },
    },
  });
}

export function suggestionState(state: EditorState): SuggestionMatch | null {
  return key.getState(state)?.match ?? null;
}

export function dismissSuggestion(): Command {
  return (state, dispatch) => {
    if (suggestionState(state) === null) return false;
    dispatch?.(state.tr.setMeta(key, DISMISS));
    return true;
  };
}

/**
 * Replaces the trigger and its query with a node, or with text, followed
 * by a space. The range is the one the editor holds now, not the one the
 * list was opened with: a writer who kept typing still loses exactly their
 * query.
 */
export function replaceSuggestion(content: Node | string): Command {
  return (state, dispatch) => {
    const match = suggestionState(state);
    if (match === null) return false;
    if (dispatch !== undefined) {
      const tr = state.tr;
      if (typeof content === "string") tr.insertText(`${content} `, match.from, match.to);
      else tr.replaceWith(match.from, match.to, [content, state.schema.text(" ")]);
      const end = tr.mapping.map(match.to);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView());
    }
    return true;
  };
}

/** Removes the trigger and its query, for a choice that is a command rather than content. */
export function clearSuggestion(): Command {
  return (state, dispatch) => {
    const match = suggestionState(state);
    if (match === null) return false;
    dispatch?.(state.tr.delete(match.from, match.to).setMeta(key, DISMISS));
    return true;
  };
}

function find(state: EditorState, pattern: RegExp): SuggestionMatch | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if ($pos.marks().some((mark) => mark.type.spec.code)) return null;
  const before = parent.textBetween(0, $pos.parentOffset, undefined, "￼");
  const match = pattern.exec(before);
  if (match === null) return null;
  const trigger = match[1] as string;
  const query = match[2] as string;
  const to = $pos.pos;
  return { trigger, query, from: to - query.length - trigger.length, to };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
