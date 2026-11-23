// Transport over chrome.bookmarks (synced by Chrome Sync). Uses only chrome.bookmarks APIs.
//
//   const t = createBookmarksTransport(chrome.bookmarks, {cache})
//   installBookmarkListeners(chrome.bookmarks, (raw) => t.handleRaw(raw))   // call at SW top level, synchronously
//
// Event filter: events are only forwarded when the node's parent (or the node itself) is a
// tracked folder/marker (root, device folders, vault marker), so unrelated user-bookmark
// churn costs one Map lookup.
import { parseNodeUrl, NODE_TITLE } from './codec.js';

/** Register chrome.bookmarks listeners. `dispatch(rawEvent)` must be late-bound by the caller. */
export function installBookmarkListeners(api, dispatch) {
  api.onCreated.addListener((id, node) => dispatch({ type: 'create', id, parentId: node.parentId, url: node.url || null }));
  api.onChanged.addListener((id, info) => dispatch({ type: 'change', id, url: info.url || null }));
  api.onRemoved.addListener((id, info) => dispatch({ type: 'remove', id, parentId: info.parentId, url: (info.node && info.node.url) || null }));
  api.onMoved.addListener((id, info) => dispatch({ type: 'move', id, parentId: info.parentId, oldParentId: info.oldParentId }));
  if (api.onChildrenReordered) api.onChildrenReordered.addListener((id) => dispatch({ type: 'reorder', id, parentId: id }));
  if (api.onImportBegan) api.onImportBegan.addListener(() => dispatch({ type: 'importBegan' }));
  if (api.onImportEnded) api.onImportEnded.addListener(() => dispatch({ type: 'importEnded' }));
}

export function createBookmarksTransport(api, { cache = null } = {}) {
  let handler = null;
  const tracked = new Map(); // id -> {role:'root'|'device'|'marker', parentId}
  const parentOf = new Map(); // node id -> parent id (onChanged does not carry the parent)
  const PARENT_CACHE_MAX = 4000;
  let cachedOther = null;
  const remember = (id, parentId) => { if (parentOf.size > PARENT_CACHE_MAX) parentOf.clear(); parentOf.set(id, parentId); };

  async function persist() {
    if (cache) { try { await cache.set([...tracked.entries()]); } catch { /* ignore */ } }
  }
  async function loadCache() {
    if (!cache || tracked.size) return;
    try { const v = await cache.get(); if (Array.isArray(v)) for (const [k, val] of v) tracked.set(k, val); } catch { /* ignore */ }
  }

  const norm = (n) => ({ id: n.id, url: n.url || undefined, title: n.title, dateAdded: n.dateAdded, parentId: n.parentId });

  const t = {
    setEventHandler(cb) { handler = cb; },
    track(id, role, parentId) { tracked.set(id, { role, parentId }); persist(); },
    untrack(id) { tracked.delete(id); persist(); },
    trackedCount() { return tracked.size; },

    /** Called by the SW-level listener. Applies the O(1) filter and forwards to the engine. */
    async handleRaw(raw) {
      await loadCache();
      if (raw.type === 'importBegan' || raw.type === 'importEnded') { if (handler) handler(raw); return; }
      if (raw.parentId !== undefined && raw.id) remember(raw.id, raw.parentId);
      if (raw.type === 'change' && raw.parentId === undefined && !tracked.has(raw.id)) {
        // onChanged carries no parent: resolve it (cached) so in-place head updates in a tracked folder are not missed
        let p = parentOf.get(raw.id);
        if (p === undefined) {
          try { const n = (await api.get(raw.id))[0]; if (n) { p = n.parentId; remember(raw.id, p); } } catch { /* node gone */ }
        }
        if (p !== undefined) raw = { ...raw, parentId: p };
      }
      const relevant = tracked.has(raw.id) || (raw.parentId !== undefined && tracked.has(raw.parentId))
        || (raw.oldParentId !== undefined && tracked.has(raw.oldParentId));
      if (!relevant) return;
      if (raw.type === 'remove') tracked.delete(raw.id);
      if (handler) handler({ ...raw, origin: 'chrome' });
    },

    async getOtherRootId() {
      if (cachedOther) return cachedOther;
      const tree = await api.getTree();
      const kids = (tree[0] && tree[0].children) || [];
      let other = kids.find((k) => k.folderType === 'other');
      if (!other) other = kids.find((k) => /other/i.test(k.title || '')) || kids[1];
      if (!other) throw new Error('Other bookmarks folder not found');
      cachedOther = other.id;
      return cachedOther;
    },

    /** Find vault markers anywhere (search by host), returns [{rootId, markerId, marker, dateAdded}]. */
    async findRoots() {
      const hits = await api.search('cmr.invalid');
      const out = [];
      for (const h of hits) {
        if (!h.url) continue;
        const p = parseNodeUrl(h.url);
        if (!p || p.kind !== 'v') continue;
        let folder = null;
        try { folder = (await api.get(h.parentId))[0]; } catch { /* ignore */ }
        out.push({ rootId: h.parentId, markerId: h.id, marker: p.marker, dateAdded: folder ? folder.dateAdded : h.dateAdded });
      }
      return out;
    },

    async createRoot(markerUrl) {
      const other = await t.getOtherRootId();
      const folder = await api.create({ parentId: other, title: NODE_TITLE });
      const marker = await api.create({ parentId: folder.id, title: NODE_TITLE, url: markerUrl });
      t.track(folder.id, 'root');
      t.track(marker.id, 'marker', folder.id);
      return { rootId: folder.id, markerId: marker.id };
    },

    async listChildren(parentId) { const kids = (await api.getChildren(parentId)).map(norm); for (const k of kids) remember(k.id, parentId); return kids; },
    async getNode(id) { try { const r = await api.get(id); return r[0] ? norm(r[0]) : null; } catch { return null; } },
    async createFolder(parentId, title = NODE_TITLE) { const f = await api.create({ parentId, title }); return f.id; },
    async createNode(parentId, url, title = NODE_TITLE) { const n = await api.create({ parentId, title, url }); remember(n.id, parentId); return n.id; },
    async updateNode(id, url) { await api.update(id, { url }); },
    async moveNode(id, parentId) { await api.move(id, { parentId }); remember(id, parentId); },
    async removeNode(id) { await api.remove(id); },
    async removeTree(id) { await api.removeTree(id); tracked.delete(id); persist(); },
    async getSubTree(id) { const r = await api.getSubTree(id); return r[0]; },

    /** Rebuild the tracked set from the vault root (after a SW restart without cache). */
    async rebuildTracked(rootId) {
      tracked.clear();
      const sub = await t.getSubTree(rootId);
      if (!sub) return;
      tracked.set(rootId, { role: 'root' });
      for (const c of sub.children || []) {
        if (c.url) {
          const p = parseNodeUrl(c.url);
          if (p && p.kind === 'v') tracked.set(c.id, { role: 'marker', parentId: rootId });
        } else tracked.set(c.id, { role: 'device', parentId: rootId });
      }
      await persist();
    },
  };
  return t;
}
