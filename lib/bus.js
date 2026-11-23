// SW -> page notifications (BroadcastChannel). Messages never reach the posting context itself.

let ch = null;
function chan() {
  if (!ch) ch = new BroadcastChannel('cmr');
  return ch;
}

export function post(msg) {
  try { chan().postMessage(msg); } catch { /* ignore */ }
}

export function on(fn) {
  chan().addEventListener('message', (e) => fn(e.data));
}
