// Orders the items of a big session off the main thread: receives sort keys, returns the permutation.
const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });
self.onmessage = (e) => {
  const { id, keys, dir, numeric } = e.data;
  const n = keys.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const sign = dir === 'desc' ? -1 : 1;
  const arr = Array.from(idx);
  if (numeric) arr.sort((a, b) => sign * (keys[a] - keys[b]) || a - b);
  else arr.sort((a, b) => sign * collator.compare(keys[a], keys[b]) || a - b);
  const out = new Uint32Array(arr);
  self.postMessage({ id, order: out }, [out.buffer]);
};
