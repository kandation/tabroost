// The single-writer queue: in-memory promise chain. Every logical mutation runs through runExclusive().

let q = Promise.resolve();

export function runExclusive(fn) {
  const run = q.then(() => fn(), () => fn());
  q = run.catch(() => {});
  return run;
}
