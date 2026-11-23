// In-memory bookmark tree shared by simulated devices, with per-device replicas and
// controllable event delivery (reorder / duplicate / drop / delay) for fault injection.
// Implements the same transport interface as transport-bookmarks.js.
import { parseNodeUrl, NODE_TITLE } from './codec.js';

export class MemoryBookmarks {
  constructor({ now = () => Date.now(), rng = Math.random } = {}) {
    this.now = now;
    this.rng = rng;
    this.nodes = new Map(); // canonical: id -> {id,parentId,url|null,title,dateAdded}
    this.nextId = 1;
    this.views = new Set();
    this.otherId = this._add(null, null, 'Other bookmarks').id;
    this.writeCount = 0;
  }
  _add(parentId, url, title) {
    const node = { id: String(this.nextId++), parentId, url, title, dateAdded: this.now() };
    this.nodes.set(node.id, node);
    return node;
  }
  view(name = 'dev') {
    const v = new MemoryTransport(this, name);
    this.views.add(v);
    return v;
  }
  _broadcast(origin, ev) {
    for (const v of this.views) {
      v.queue.push({ ...ev, node: ev.node ? { ...ev.node } : null, origin: v === origin ? 'self' : 'remote' });
    }
  }
  /** Test helper: tamper with a node as if edited by a user on some device. */
  tamper(id, url) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.url = url;
    this._broadcast(null, { type: 'change', id, node: n });
  }
  /** Test helper: delete a subtree as if a user did it. */
  tamperRemove(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    const snap = { ...n };
    this._removeSubtree(id);
    this._broadcast(null, { type: 'remove', id, node: snap });
  }
  _removeSubtree(id) {
    for (const n of [...this.nodes.values()]) if (n.parentId === id) this._removeSubtree(n.id);
    this.nodes.delete(id);
  }
}

export class MemoryTransport {
  constructor(tree, name) {
    this.tree = tree;
    this.name = name;
    this.replica = new Map(); // what this device currently sees
    this.queue = []; // pending events from the "sync server"
    this.handler = null;
    this.stats = { creates: 0, updates: 0, removes: 0 };
    // start with a copy of the current tree
    for (const n of tree.nodes.values()) this.replica.set(n.id, { ...n });
  }
  setEventHandler(cb) { this.handler = cb; }

  // ---- delivery control (the "sync" part) ----
  /**
   * Deliver queued events to this device.
   * opts: {shuffle, dup (prob), dropEvent (prob: replica updates but no callback), limit, rng, filter(ev)->bool}
   * Per-node event order is always preserved; order across nodes may be shuffled.
   */
  deliver(opts = {}) {
    const rng = opts.rng || this.tree.rng;
    let evs = this.queue;
    this.queue = [];
    if (opts.filter) {
      const keep = [];
      for (const e of evs) (opts.filter(e) ? keep : this.queue).push(e);
      evs = keep;
    }
    if (opts.shuffle) {
      const byId = new Map();
      for (const e of evs) { if (!byId.has(e.id)) byId.set(e.id, []); byId.get(e.id).push(e); }
      const lists = [...byId.values()];
      for (let i = lists.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [lists[i], lists[j]] = [lists[j], lists[i]]; }
      evs = lists.flat();
    }
    if (opts.limit !== undefined && evs.length > opts.limit) {
      this.queue = evs.slice(opts.limit).concat(this.queue);
      evs = evs.slice(0, opts.limit);
    }
    let n = 0;
    for (const e of evs) {
      const dropped = opts.dropEvent && rng() < opts.dropEvent;
      const times = !dropped && opts.dup && rng() < opts.dup ? 2 : 1;
      this._applyToReplica(e);
      n++;
      if (dropped) continue;
      for (let i = 0; i < times; i++) this._fire(e);
    }
    return n;
  }
  pending() { return this.queue.length; }
  _applyToReplica(e) {
    if (e.type === 'remove') {
      const drop = (id) => {
        for (const n of [...this.replica.values()]) if (n.parentId === id) drop(n.id);
        this.replica.delete(id);
      };
      drop(e.id);
    } else if (e.node) {
      this.replica.set(e.id, { ...e.node });
    }
  }
  _fire(e) {
    if (!this.handler) return;
    const n = e.node || {};
    this.handler({ type: e.type, id: e.id, parentId: n.parentId, url: n.url || null, origin: e.origin });
  }

  // ---- transport interface ----
  async getOtherRootId() { return this.tree.otherId; }
  async findRoots() {
    const out = [];
    for (const n of this.replica.values()) {
      if (!n.url) continue;
      const p = parseNodeUrl(n.url);
      if (p && p.kind === 'v') {
        const folder = this.replica.get(n.parentId);
        out.push({ rootId: n.parentId, markerId: n.id, marker: p.marker, dateAdded: folder ? folder.dateAdded : n.dateAdded });
      }
    }
    return out;
  }
  async createRoot(markerUrl) {
    const folder = this._write(this.tree.otherId, null, NODE_TITLE);
    const marker = this._write(folder.id, markerUrl, NODE_TITLE);
    return { rootId: folder.id, markerId: marker.id };
  }
  async listChildren(parentId) {
    const out = [];
    for (const n of this.replica.values()) if (n.parentId === parentId) out.push({ id: n.id, url: n.url || undefined, title: n.title, dateAdded: n.dateAdded, parentId });
    out.sort((a, b) => Number(a.id) - Number(b.id));
    return out;
  }
  async getNode(id) {
    const n = this.replica.get(id);
    return n ? { id: n.id, url: n.url || undefined, title: n.title, parentId: n.parentId, dateAdded: n.dateAdded } : null;
  }
  async createFolder(parentId, title = NODE_TITLE) { this.stats.creates++; return this._write(parentId, null, title).id; }
  async createNode(parentId, url, title = NODE_TITLE) { this.stats.creates++; return this._write(parentId, url, title).id; }
  async updateNode(id, url) {
    const n = this.tree.nodes.get(id);
    if (!n) throw new Error('no such node ' + id);
    this.stats.updates++;
    n.url = url;
    this.tree.writeCount++;
    this.replica.set(id, { ...n });
    this.tree._broadcast(this, { type: 'change', id, node: n });
  }
  async moveNode(id, parentId) {
    const n = this.tree.nodes.get(id);
    if (!n) throw new Error('no such node ' + id);
    n.parentId = parentId;
    this.tree.writeCount++;
    this.replica.set(id, { ...n });
    this.tree._broadcast(this, { type: 'change', id, node: n });
  }
  async removeNode(id) { return this.removeTree(id); }
  async removeTree(id) {
    const n = this.tree.nodes.get(id);
    if (!n) return;
    this.stats.removes++;
    const snap = { ...n };
    this.tree._removeSubtree(id);
    this.tree.writeCount++;
    this._applyToReplica({ type: 'remove', id });
    this.tree._broadcast(this, { type: 'remove', id, node: snap });
  }
  async getSubTree(id) {
    const build = (nid) => {
      const n = this.replica.get(nid);
      if (!n) return null;
      const kids = [...this.replica.values()].filter((x) => x.parentId === nid).sort((a, b) => Number(a.id) - Number(b.id));
      return { id: n.id, url: n.url || undefined, title: n.title, children: n.url ? undefined : kids.map((k) => build(k.id)) };
    };
    return build(id);
  }
  _write(parentId, url, title) {
    const parent = this.tree.nodes.get(parentId);
    if (!parent) throw new Error('no such parent ' + parentId);
    const node = this.tree._add(parentId, url, title);
    this.tree.writeCount++;
    this.replica.set(node.id, { ...node });
    this.tree._broadcast(this, { type: 'create', id: node.id, node });
    return node;
  }
}
