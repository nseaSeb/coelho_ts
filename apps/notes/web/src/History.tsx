import { diffDocuments, toHtml, type BlockChange, type Document, type Node } from "@nseaprotector/coelho-core";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { schema } from "../../server/schema.js";
import { api, ApiError, type Me } from "./api.js";

interface Summary {
  id: string;
  hash: string | null;
  createdBy: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Version extends Summary {
  body: Document;
  previousId: string | null;
}

/** The server sends this many at a time. */
const PAGE = 50;

type Compare = "changes" | "now";

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const path = (name: string): string => `/api/pages/${encodeURIComponent(name)}`;

/**
 * A page's versions, newest first. Choosing one shows what it changed —
 * or how it differs from the page now — block by block and word by word;
 * an editor can bring it back for everyone.
 */
export function History({ name, me }: { name: string; me: Me }): ReactNode {
  const [versions, setVersions] = useState<Summary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<Compare>("changes");
  const [bodies, setBodies] = useState<{ base: Node | null; target: Node } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const [more, setMore] = useState(false);

  // The newest page of versions, refreshed; older pages, once loaded, are kept.
  const reload = useCallback(async (): Promise<void> => {
    const newest = await api<Summary[]>(`${path(name)}/versions`);
    const oldest = newest.at(-1)?.id;
    setVersions((loaded) => [...newest, ...(loaded ?? []).filter((version) => oldest !== undefined && Number(version.id) < Number(oldest))]);
    setMore((already) => already || newest.length === PAGE);
  }, [name]);

  const loadOlder = async (): Promise<void> => {
    const oldest = versions?.at(-1)?.id;
    if (oldest === undefined) return;
    const older = await api<Summary[]>(`${path(name)}/versions?before=${oldest}`);
    setVersions((loaded) => [...(loaded ?? []), ...older]);
    setMore(older.length === PAGE);
  };
  useEffect(() => {
    void reload().catch(() => setVersions([]));
    const timer = setInterval(() => void reload().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [reload]);

  const index = versions?.findIndex((version) => version.id === selected) ?? -1;
  const current = index >= 0 ? versions?.[index] : undefined;
  const newest = versions?.[0];

  // What to compare: the version with the one before it, as the server says
  // which one that is, or with the page now. A new choice clears the last
  // comparison and the last error at once.
  useEffect(() => {
    setBodies(null);
    setError(null);
    if (current === undefined) return;
    let live = true;
    const load = async (): Promise<void> => {
      const version = await api<Version>(`${path(name)}/versions/${current.id}`);
      if (compare === "now") {
        const now = (await api<{ body: Document }>(path(name))).body;
        if (live) setBodies({ base: version.body, target: now });
      } else {
        const base = version.previousId === null ? null : (await api<Version>(`${path(name)}/versions/${version.previousId}`)).body;
        if (live) setBodies({ base, target: version.body });
      }
    };
    void load().catch((caught: Error) => live && setError(caught.message));
    return () => {
      live = false;
    };
  }, [name, current?.id, current?.updatedAt, compare]);

  const changes = useMemo(() => (bodies === null ? null : diffDocuments(bodies.base, bodies.target, schema)), [bodies]);

  const restore = async (): Promise<void> => {
    if (current === undefined || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      const restored = await api<Summary>(`${path(name)}/versions/${current.id}/restore`, { body: {} });
      // The version the restore made, as the server returned it, not whatever is newest by now.
      await reload();
      setSelected(restored.id);
      setCompare("changes");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "the server did not answer");
    } finally {
      setRestoring(false);
    }
  };

  if (versions === null) return <p className="muted small">Loading the history…</p>;
  if (versions.length === 0) return <p className="muted small">No version yet: one is kept a moment after the page changes.</p>;

  return (
    <div className="history">
      <ol className="versions" aria-label="Versions">
        {versions.map((version, at) => (
          <li key={version.id}>
            <button type="button" aria-pressed={version.id === selected} onClick={() => setSelected(version.id === selected ? null : version.id)}>
              <span className="who">{version.note ?? version.createdBy ?? "created"}</span>
              <span className="when">
                {when(version.updatedAt)}
                {at === 0 ? " · now" : ""}
              </span>
              {version.note !== null && version.createdBy !== null ? <span className="by">by {version.createdBy}</span> : null}
            </button>
          </li>
        ))}
      </ol>
      {more ? (
        <button type="button" className="older" onClick={() => void loadOlder()}>
          Older versions
        </button>
      ) : null}
      {current === undefined ? (
        <p className="muted small">Choose a version to see what it changed.</p>
      ) : (
        <section className="compare" aria-label={`Version #${current.id}`}>
          <div className="compare-head" role="radiogroup" aria-label="Compare">
            <label>
              <input type="radio" name="compare" checked={compare === "changes"} onChange={() => setCompare("changes")} /> what it changed
            </label>
            <label>
              <input type="radio" name="compare" checked={compare === "now"} onChange={() => setCompare("now")} disabled={index === 0} /> since then
            </label>
          </div>
          {changes === null ? <p className="muted small">…</p> : <Diff changes={changes} />}
          {me.role === "reader" || index === 0 ? null : current.hash === newest?.hash ? (
            <p className="muted small">The page is this version already.</p>
          ) : (
            <button type="button" className="primary" disabled={restoring} onClick={() => void restore()}>
              {restoring ? "Restoring…" : `Restore version #${current.id}`}
            </button>
          )}
          {error === null ? null : (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

const blockHtml = (block: Node): string => toHtml({ type: "doc", content: [block] }, schema);

/** The element an edited block's words are shown in, so a heading still reads as one, and code as code. */
function Frame({ block, children }: { block: Node; children: ReactNode }): ReactNode {
  if (block.type === "heading") {
    const level = Number(block.attrs?.level ?? 1);
    const Tag = `h${level >= 1 && level <= 6 ? level : 1}` as "h1";
    return <Tag className="diff-changed">{children}</Tag>;
  }
  if (block.type === "code_block") {
    return (
      <pre className="diff-changed">
        <code>{children}</code>
      </pre>
    );
  }
  if (block.type === "paragraph") return <p className="diff-changed">{children}</p>;
  // A list, a quote: its text with its line breaks, as the words come.
  return <div className="diff-changed diff-lines">{children}</div>;
}

/** The changes as the page would show them: kept blocks faded, added and removed marked, edits word by word. */
export function Diff({ changes }: { changes: BlockChange[] }): ReactNode {
  if (changes.every((change) => change.kind === "same")) return <p className="muted small">No change.</p>;
  return (
    <div className="diff prose">
      {changes.map((change, at) => {
        if (change.kind === "changed") {
          // The same words, other marks or attributes: the change is in how
          // it looks, which only the two blocks side by side can show.
          if (change.words.every((word) => word.kind === "same")) {
            return (
              <div key={at} className="diff-restyled" title="The same words, formatted differently">
                <div className="diff-removed" dangerouslySetInnerHTML={{ __html: blockHtml(change.before) }} />
                <div className="diff-added" dangerouslySetInnerHTML={{ __html: blockHtml(change.after) }} />
              </div>
            );
          }
          return (
            <Frame key={at} block={change.after}>
              {change.words.map((word, i) =>
                word.kind === "same" ? <span key={i}>{word.text}</span> : word.kind === "added" ? <ins key={i}>{word.text}</ins> : <del key={i}>{word.text}</del>,
              )}
            </Frame>
          );
        }
        return <div key={at} className={`diff-${change.kind}`} dangerouslySetInnerHTML={{ __html: blockHtml(change.block) }} />;
      })}
    </div>
  );
}
