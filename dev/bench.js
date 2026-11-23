// DEV ONLY (not part of the extension runtime): injected into stash.html by the CDP test driver.
// window.__bench.run({kind:'slow'|'fast'|'fling', seconds}) drives the list scroller with rAF and reports frame stats.
(() => {
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const longTasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {}
  // count every <img src> assignment (extension-scheme image loads do not appear in Resource Timing)
  let imgSets = 0;
  let favSets = 0;
  const origSet = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) { if (n === 'src' && this.tagName === 'IMG') { imgSets++; if (String(v).includes('_favicon')) favSets++; } return origSet.call(this, n, v); };
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return d.get.call(this); }, set(v) { imgSets++; if (String(v).includes('_favicon')) favSets++; d.set.call(this, v); } });
  window.__bench = {
    nodes: () => document.getElementsByTagName('*').length,
    favReqs: () => performance.getEntriesByType('resource').filter((e) => e.name.includes('_favicon')).length,
    async run({ kind = 'slow', seconds = 10 } = {}) {
      const sc = document.getElementById('scroller');
      const max = () => sc.scrollHeight - sc.clientHeight;
      longTasks.length = 0;
      const deltas = [];
      const nodes = [];
      const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      let heapPeak = heap0;
      const fav0 = this.favReqs();
      const is0 = imgSets; const fs0 = favSets;
      sc.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 300));
      const t0 = performance.now();
      let last = t0;
      let y = 0;
      let nextJump = 0;
      await new Promise((resolve) => {
        const step = (now) => {
          deltas.push(now - last);
          last = now;
          const el = (now - t0) / 1000;
          if (kind === 'slow') y += sc.clientHeight * (1 / 60); // 1 viewport per second
          else if (kind === 'fast') y += sc.clientHeight * (10 / 60); // 10 viewports per second
          else if (kind === 'stopgo') { if (Math.floor(el / 0.5) % 2 === 0) y += sc.clientHeight * (5 / 60); } // 0.5 s moving, 0.5 s still
          else if (now >= nextJump) { y = Math.floor(Math.random() * max()); nextJump = now + 250; }
          if (kind !== 'fling' && y >= max()) y = 0;
          sc.scrollTop = y;
          if (deltas.length % 15 === 0) { nodes.push(document.getElementsByTagName('*').length); if (performance.memory) heapPeak = Math.max(heapPeak, performance.memory.usedJSHeapSize); }
          if (el < seconds) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      await new Promise((r) => setTimeout(r, 500));
      const d = deltas.slice(2);
      const fav = globalThis.__cmr && globalThis.__cmr.fav ? globalThis.__cmr.fav.stats() : null;
      return {
        kind, frames: d.length, p50: +pct(d, 0.5).toFixed(1), p95: +pct(d, 0.95).toFixed(1), p99: +pct(d, 0.99).toFixed(1), max: +Math.max(...d).toFixed(1),
        over32: d.filter((x) => x > 32).length, over50: d.filter((x) => x > 50).length,
        longTasks: longTasks.length, longTaskMax: +(Math.max(0, ...longTasks)).toFixed(1),
        nodesMax: Math.max(...nodes), heapStartMB: +(heap0 / 1048576).toFixed(1), heapPeakMB: +(heapPeak / 1048576).toFixed(1),
        imgSrcSets: imgSets - is0, faviconUrlRequests: favSets - fs0, loader: fav,
      };
    },
  };
})();
