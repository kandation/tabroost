// Drain journal URL keys. The drain store keeps one record per tab until the tabs are closed; it compares the live tab URL with the
// saved one ("drift: never close an unsaved URL"). With the password lock ON the record holds a SALTED HASH of the URL instead of the
// URL: no readable URL sits in the database while tabs are being closed. (A 53-bit hash: enough to detect drift, not reversible;
// a known URL can still be confirmed by hashing it, and the records are deleted when the drain finishes.) Lock off: identity, no cost.
let salt = null;
export function setSalt(s) { salt = s || null; }
export const hasSalt = () => !!salt;

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed; let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const dk = (u) => (salt ? '#' + cyrb53(salt + String(u)).toString(36) : u);
