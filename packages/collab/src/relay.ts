import { applyAwarenessUpdate, encodeAwarenessUpdate, type Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

interface Peer {
  doc: Y.Doc;
  awareness: Awareness;
}

/**
 * A network inside one page: every joined document receives every other's
 * updates and presence, while the relay is online. Offline, each goes on
 * alone; back online, each sends the others exactly what they miss, and
 * the CRDT merges. What y-websocket or Hocuspocus do over a socket, with no
 * server, for a demo and for tests.
 *
 * Updates are applied with the relay as their origin, which is not the
 * editor's, so a writer's undo never reverts what arrived from others.
 */
export class LocalRelay {
  private peers: Peer[] = [];
  private listeners = new Set<() => void>();
  online = true;

  join(doc: Y.Doc, awareness: Awareness): () => void {
    const peer = { doc, awareness };
    if (this.online) for (const other of this.peers) this.exchange(other, peer);
    this.peers.push(peer);
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === this || !this.online) return;
      for (const other of this.peers) if (other !== peer) Y.applyUpdate(other.doc, update, this);
    };
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
      if (origin === this || !this.online) return;
      const update = encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]);
      for (const other of this.peers) if (other !== peer) applyAwarenessUpdate(other.awareness, update, this);
    };
    doc.on("update", onUpdate);
    awareness.on("update", onAwareness);
    return () => {
      doc.off("update", onUpdate);
      awareness.off("update", onAwareness);
      this.peers = this.peers.filter((p) => p !== peer);
    };
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (online) {
      for (let i = 0; i < this.peers.length; i += 1) {
        for (let j = i + 1; j < this.peers.length; j += 1) this.exchange(this.peers[i] as Peer, this.peers[j] as Peer);
      }
    }
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Each side sends the other what it does not have yet, and its presence. */
  private exchange(a: Peer, b: Peer): void {
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), this);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), this);
    applyAwarenessUpdate(b.awareness, encodeAwarenessUpdate(a.awareness, [...a.awareness.getStates().keys()]), this);
    applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(b.awareness, [...b.awareness.getStates().keys()]), this);
  }
}
