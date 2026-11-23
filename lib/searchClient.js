// Page-side connection to search-worker.js: a SharedWorker (one shared index for every open list page), falling back to
// a dedicated Worker when SharedWorker is unavailable or fails to start.

export function connectSearch(onMessage) {
  const url = new URL('../search-worker.js', import.meta.url);
  let port = null;
  let kind = 'none';
  let dedicated = null;

  const useDedicated = () => {
    if (dedicated) return;
    dedicated = new Worker(url, { type: 'module', name: 'cmr-search' });
    dedicated.onmessage = (e) => onMessage(e.data);
    dedicated.onerror = (e) => onMessage({ type: 'status', state: 'error', error: String((e && e.message) || 'worker error'), progress: 0, docs: 0 });
    port = dedicated;
    kind = 'dedicated';
    onMessage({ type: 'client', kind });
  };

  try {
    if (typeof SharedWorker === 'undefined') throw new Error('no SharedWorker');
    const w = new SharedWorker(url, { type: 'module', name: 'cmr-search' });
    w.port.onmessage = (e) => onMessage(e.data);
    w.onerror = () => { try { w.port.close(); } catch { /* ignore */ } useDedicated(); };
    w.port.start();
    port = w.port;
    kind = 'shared';
    onMessage({ type: 'client', kind });
  } catch {
    useDedicated();
  }

  return {
    get kind() { return kind; },
    post(msg) { try { port.postMessage(msg); } catch { /* worker gone */ } },
  };
}
