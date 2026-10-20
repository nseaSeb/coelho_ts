import { dismissSuggestion, suggestionState, type SuggestionKeys, type SuggestionMatch } from "@coelho/prosemirror";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CoelhoEditor } from "./useCoelhoEditor.js";

export interface UseSuggestionOptions<T> {
  /** The handle `createSuggestion` returned with the plugin. */
  keys: SuggestionKeys;
  /** The choices for what is being typed. The application's own: the editor does not know what a name matches. */
  items: (match: SuggestionMatch) => T[];
  /** What choosing an item does: usually `replaceSuggestion` with a node, or `clearSuggestion` and a command. */
  onSelect: (item: T, match: SuggestionMatch) => void;
}

export interface Suggestion<T> {
  match: SuggestionMatch | null;
  items: T[];
  /** The highlighted item. */
  index: number;
  setIndex: (index: number) => void;
  select: (item: T) => void;
  /** Where the trigger is in the viewport, for a `position: fixed` list; `null` when it cannot be measured. */
  coords: { left: number; top: number; bottom: number } | null;
  /** The list's id, for `aria-controls`; each option is `${listId}-${index}`. */
  listId: string;
}

/**
 * The list half of a suggestion: what to show, which item is highlighted,
 * and the keys that move through it. Arrow keys, Enter and Tab come from
 * the editor through `keys`, so focus never leaves the text; Escape is the
 * plugin's own. The editor's element is a multi-line text box, and carries
 * `aria-autocomplete`, `aria-controls` and `aria-activedescendant` while the
 * list is open.
 */
export function useSuggestion<T>(editor: CoelhoEditor, options: UseSuggestionOptions<T>): Suggestion<T> {
  const match = editor.state === null ? null : suggestionState(editor.state);
  const items = match === null ? [] : options.items(match);
  const [index, setIndex] = useState(0);
  const listId = useId();

  // A new query starts at the top of the list.
  const query = match === null ? null : `${match.from}:${match.trigger}${match.query}`;
  useEffect(() => setIndex(0), [query]);

  const latest = useRef({ match, items, index, onSelect: options.onSelect });
  latest.current = { match, items, index: Math.min(index, Math.max(items.length - 1, 0)), onSelect: options.onSelect };

  const { keys } = options;
  useEffect(() => {
    keys.current = (event) => {
      const { match: open, items: list, index: at, onSelect } = latest.current;
      if (open === null || list.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((at + step + list.length) % list.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        onSelect(list[at] as T, open);
        return true;
      }
      return false;
    };
    return () => {
      keys.current = null;
    };
  }, [keys]);

  // Clicking away closes the list. A click on the list itself keeps the
  // editor focused (its items prevent the mousedown), so this does not fire.
  const view = editor.view;
  useEffect(() => {
    if (view === null) return;
    const onBlur = (): void => {
      if (suggestionState(view.state) !== null) dismissSuggestion()(view.state, view.dispatch);
    };
    view.dom.addEventListener("blur", onBlur);
    return () => view.dom.removeEventListener("blur", onBlur);
  }, [view]);

  const open = match !== null && items.length > 0;
  const active = latest.current.index;
  // The editor is a multi-line text box, which a combobox is not. While the
  // list is open it says that it completes from a list, which list, and
  // which option is highlighted; once it closes, it says nothing of it.
  useEffect(() => {
    if (view === null) return;
    const dom = view.dom;
    dom.setAttribute("role", "textbox");
    dom.setAttribute("aria-multiline", "true");
    if (open) {
      dom.setAttribute("aria-autocomplete", "list");
      dom.setAttribute("aria-controls", listId);
      dom.setAttribute("aria-activedescendant", `${listId}-${active}`);
    } else {
      dom.removeAttribute("aria-autocomplete");
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
  }, [view, open, listId, active]);

  let coords: Suggestion<T>["coords"] = null;
  if (match !== null && view !== null) {
    try {
      const at = view.coordsAtPos(match.from);
      coords = { left: at.left, top: at.top, bottom: at.bottom };
    } catch {
      coords = null;
    }
  }

  return {
    match,
    items,
    index: active,
    setIndex,
    select: (item) => {
      if (match !== null) options.onSelect(item, match);
    },
    coords,
    listId,
  };
}

export interface SuggestionMenuProps<T> {
  suggestion: Suggestion<T>;
  /** Draws one item; `active` is the highlighted one. */
  children: (item: T, active: boolean) => ReactNode;
  /** A label for the list, read by screen readers. */
  label: string;
  className?: string;
}

/** A `position: fixed` listbox under the trigger. Nothing is rendered while there is nothing to choose. */
export function SuggestionMenu<T>({ suggestion, children, label, className }: SuggestionMenuProps<T>): ReactNode {
  const { match, items, index, setIndex, select, coords, listId } = suggestion;
  if (match === null || items.length === 0) return null;
  const style = coords === null ? undefined : { position: "fixed" as const, left: coords.left, top: coords.bottom + 4 };
  return (
    <ul id={listId} role="listbox" aria-label={label} className={className ?? "coelho-suggestions"} style={style}>
      {items.map((item, at) => (
        <li
          key={at}
          id={`${listId}-${at}`}
          role="option"
          aria-selected={at === index}
          onMouseEnter={() => setIndex(at)}
          // Keep the editor focused and its selection, so the choice replaces the query.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => select(item)}
        >
          {children(item, at === index)}
        </li>
      ))}
    </ul>
  );
}
