// Minimal test registry/assert (no dependencies).
export const registry = [];
export const test = (name, fn, opts = {}) => registry.push({ name, fn, ...opts });
export function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
export function eq(a, b, msg = '') {
  const x = typeof a === 'string' ? a : JSON.stringify(a);
  const y = typeof b === 'string' ? b : JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y.slice(0, 300)} got ${x.slice(0, 300)}`);
}
export async function throws(fn, pattern, msg = 'expected throw') {
  try { await fn(); } catch (e) {
    if (pattern && !(pattern instanceof RegExp ? pattern.test(String(e && (e.name + ' ' + e.message))) : String(e).includes(pattern))) throw new Error(`${msg}: wrong error ${e}`);
    return e;
  }
  throw new Error(msg);
}
