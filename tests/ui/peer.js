// TEST ONLY: a second "device" inside the same profile: own IndexedDB (cmr-peerB), own sync controller, the REAL chrome.bookmarks transport.
// Opened by the e2e driver as chrome-extension://<id>/tests/ui/peer.html. Never linked from the product.
import * as db from '../../lib/db.js';
import { installBookmarkListeners } from '../../lib/sync/transport-bookmarks.js';
import { createSyncController } from '../../lib/synccontrol.js';

db.setDbName('cmr-peerB');
db.setWriter(true);
const ctl = createSyncController({ bookmarks: chrome.bookmarks, deviceLabel: 'peer-B' });
installBookmarkListeners(chrome.bookmarks, (raw) => ctl.raw(raw));
db.setOnWrite(() => { if (ctl.status() && ctl.status().enabled) setTimeout(() => ctl.flushLocal().catch(() => {}), 800); });
window.peer = { db, ctl };
