import { clearSuggestion, replaceSuggestion, setBlockType, wrapIn, wrapInList, type SuggestionKeys, type SuggestionMatch } from "@nseaprotector/coelho-prosemirror";
import { SuggestionMenu, useSuggestion, type CoelhoEditorHandle, type NodeViewProps } from "@nseaprotector/coelho-react";
import type { Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import type { ReactNode } from "react";

export interface Person {
  id: string;
  name: string;
  role: string;
}

/** Who can be mentioned. An application would ask its server; the editor never knows. */
export const people: Person[] = [
  { id: "u_camille", name: "Camille Durand", role: "Programmation" },
  { id: "u_sacha", name: "Sacha Martin", role: "Communication" },
  { id: "u_dominique", name: "Dominique Leroy", role: "Direction de salle" },
  { id: "u_alex", name: "Alex Bernard", role: "Projection" },
  { id: "u_noa", name: "Noa Petit", role: "Billetterie" },
  { id: "u_eloise", name: "Éloïse Moreau", role: "Siège" },
];

const fold = (text: string): string => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Matches any word of the name from its start, ignoring case and accents: `@elo` finds Éloïse. */
export function matching(query: string): Person[] {
  const wanted = fold(query);
  return people.filter((person) => fold(person.name).split(/\s+/).some((word) => word.startsWith(wanted))).slice(0, 6);
}

/** How the editor draws a mention: a React component, while the page draws the schema's `<span>`. */
export function MentionChip({ node, selected }: NodeViewProps): ReactNode {
  const person = people.find((p) => p.id === node.attrs.id);
  const label = String(node.attrs.label ?? person?.name ?? node.attrs.id);
  return (
    <span className={selected ? "mention-chip selected" : "mention-chip"} title={person === undefined ? "Unknown person" : `${person.name} · ${person.role}`}>
      <span className="avatar" aria-hidden="true">
        {initials(label)}
      </span>
      {label}
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

interface Block {
  label: string;
  hint: string;
  command: (schema: Schema) => Command | null;
}

const blocks: Block[] = [
  { label: "Heading 1", hint: "#", command: (s) => (s.nodes.heading ? setBlockType(s.nodes.heading, { level: 1 }) : null) },
  { label: "Heading 2", hint: "##", command: (s) => (s.nodes.heading ? setBlockType(s.nodes.heading, { level: 2 }) : null) },
  { label: "Heading 3", hint: "###", command: (s) => (s.nodes.heading ? setBlockType(s.nodes.heading, { level: 3 }) : null) },
  { label: "Bullet list", hint: "-", command: (s) => (s.nodes.bullet_list ? wrapInList(s.nodes.bullet_list) : null) },
  { label: "Numbered list", hint: "1.", command: (s) => (s.nodes.ordered_list ? wrapInList(s.nodes.ordered_list) : null) },
  { label: "Quote", hint: ">", command: (s) => (s.nodes.blockquote ? wrapIn(s.nodes.blockquote) : null) },
  { label: "Code block", hint: "```", command: (s) => (s.nodes.code_block ? setBlockType(s.nodes.code_block) : null) },
  {
    label: "Divider",
    hint: "---",
    command: (s) => {
      const rule = s.nodes.horizontal_rule;
      return rule === undefined ? null : (state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(rule.create()).scrollIntoView());
        return true;
      };
    },
  },
];

type Item = { kind: "person"; person: Person } | { kind: "block"; block: Block };

/** The `@` and `/` lists of the demo, in one menu since only one trigger is ever open. */
export function Suggestions({ editor, keys }: { editor: CoelhoEditorHandle; keys: SuggestionKeys }): ReactNode {
  const run = (command: Command): void => {
    const view = editor.view;
    if (view !== null) command(view.state, view.dispatch, view);
  };
  const suggestion = useSuggestion<Item>(editor, {
    keys,
    items: (match: SuggestionMatch) =>
      match.trigger === "@"
        ? matching(match.query).map((person) => ({ kind: "person", person }))
        : blocks.filter((block) => fold(block.label).includes(fold(match.query)) && block.command(editor.pmSchema) !== null).map((block) => ({ kind: "block", block })),
    onSelect: (item) => {
      if (item.kind === "person") {
        run(replaceSuggestion(editor.pmSchema.nodes.mention!.create({ id: item.person.id, label: item.person.name })));
      } else {
        run(clearSuggestion());
        const command = item.block.command(editor.pmSchema);
        if (command !== null) run(command);
      }
      editor.view?.focus();
    },
  });
  const label = suggestion.match?.trigger === "@" ? "People" : "Insert a block";
  return (
    <SuggestionMenu suggestion={suggestion} label={label}>
      {(item, active) =>
        item.kind === "person" ? (
          <span className={active ? "suggestion active" : "suggestion"}>
            <span className="avatar" aria-hidden="true">
              {initials(item.person.name)}
            </span>
            <span>
              {item.person.name} <small>{item.person.role}</small>
            </span>
          </span>
        ) : (
          <span className={active ? "suggestion active" : "suggestion"}>
            <span>{item.block.label}</span>
            <kbd>{item.block.hint}</kbd>
          </span>
        )
      }
    </SuggestionMenu>
  );
}
