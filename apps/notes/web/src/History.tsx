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
}

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

  const reload = useCallback(async (): Promise<void> => {
    setVersions(await api<Summary[]>(`${path(name)}/versions`));
  }, [name]);
  useEffect(() => {
    void reload().catch(() => setVersions([]));
    const timer = setInterval(() => void reload().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [reload]);

  const index = versions?.findIndex((version) => version.id === selected) ?? -1;
  const current = index >= 0 ? versions?.[index] : undefined;
  const previous = index >= 0 ? versions?.[index + 1] : undefined;

  // What to compare: the version with the one before it, or with the page now.
  useEffect(() => {
    if (current === undefined) return void setBodies(null);
    let live = true;
    const load = async (): Promise<void> => {
      const target = (await api<Version>(`${path(name)}/versions/${current.id}`)).body;
      if (compare === "now") {
        const now = (await api<{ body: Document }>(path(name))).body;
        if (live) setBodies({ base: target, target: now });
      } else {
        const base = previous === undefined ? null : (await api<Version>(`${path(name)}/versions/${previous.id}`)).body;
        if (live) setBodies({ base, target });
      }
    };
    void load().catch((caught: Error) => live && setError(caught.message));
    return () => {
      live = false;
    };
  }, [name, current?.id, current?.updatedAt, previous?.id, compare]);

  const changes = useMemo(() => (bodies === null ? null : diffDocuments(bodies.base, bodies.target, schema)), [bodies]);

  const restore = async (): Promise<void> => {
    if (current === undefined || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      const restored = await api<Summary>(`${path(name)}/versions/${current.id}/restore`, { body: {} });
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
          {me.role !== "reader" && index > 0 ? (
            <button type="button" className="primary" disabled={restoring} onClick={() => void restore()}>
              {restoring ? "Restoring…" : `Restore version #${current.id}`}
            </button>
          ) : null}
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

/** The changes as the page would show them: kept blocks faded, added and removed marked, edits word by word. */
export function Diff({ changes }: { changes: BlockChange[] }): ReactNode {
  if (changes.every((change) => change.kind === "same")) return <p className="muted small">No change.</p>;
  return (
    <div className="diff prose">
      {changes.map((change, at) => {
        if (change.kind === "changed") {
          return (
            <p key={at} className="diff-changed">
              {change.words.map((word, i) =>
                word.kind === "same" ? <span key={i}>{word.text}</span> : word.kind === "added" ? <ins key={i}>{word.text}</ins> : <del key={i}>{word.text}</del>,
              )}
            </p>
          );
        }
        return <div key={at} className={`diff-${change.kind}`} dangerouslySetInnerHTML={{ __html: blockHtml(change.block) }} />;
      })}
    </div>
  );
}
