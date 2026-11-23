# Chrome Split View and Tabroost: findings

Tested on Chrome 158.0.8127.36 stable (Windows), isolated profile, throwaway MV3 extension with only `tabs`/`tabGroups` permissions. Profile deleted, 0 test Chrome processes left.

## 1. Research (sources)

- Blog, "Enhance multitasking extensions with the new Tabs Split View API": https://developer.chrome.com/blog/split-view-api-extensions (API ships in Chrome 155; no manifest permission needed; native split view itself shipped in Chrome 145 per localized copies).
- Tabs API reference: https://developer.chrome.com/docs/extensions/reference/api/tabs
  - `Tab.splitViewId` (number): Chrome 140+. `chrome.tabs.SPLIT_VIEW_ID_NONE === -1`.
  - `tabs.query({splitViewId})` filter: Chrome 140+ (`-1` = not split).
  - `onUpdated` `changeInfo.splitViewId`: Chrome 140+.
  - `tabs.createSplit([idA, idB])` -> Promise<splitViewId>: Chrome 155+. Tabs must be adjacent, not already split, same `windowId`, `pinned`, `groupId`.
  - `tabs.unsplit(splitViewId)`: Chrome 155+.
  - `tabs.create({splitWithTabId, index?})`: Chrome 155+.
  - Docs note that on `onCreated` the split membership may not be set yet; use `onUpdated`.
  - Docs say nothing about move/group/ungroup/discard/remove with splits (we measured, below).
- Firefox bug 1993037 (same property in Firefox 149): https://bugzilla.mozilla.org/show_bug.cgi?id=1993037
- Unverified/not found: any feature flag (not needed: feature is on by default in 158). Chrome UI action to split manually: right-click tab -> "Add tab to new split view" (wording from memory, unverified here).

Note: `splitViewId` is a per-session random id (e.g. 1261241068); it is only a pairing key, never persist it as meaningful across sessions.

## 2. Empirical results (Chrome 158)

Split views CAN be created programmatically with `tabs.createSplit`, so the test was fully scripted (no UI clicks).

| Behaviour | Result |
|---|---|
| `tabs.query({})` fields | includes `splitViewId`; both panes share the same value, others `-1`; both panes are normal tabs with own `id`, `index` (adjacent), `url`, `title`. Only ONE pane is `active:true` (the focused one); its partner is visible on screen but reports `active:false`. |
| `onUpdated` | fires `{splitViewId: N}` per pane on create and `{splitViewId: -1}` on dissolve |
| `createSplit` non-adjacent | rejects: "Cannot create split view with non-adjacent tabs." |
| `create({splitWithTabId})` | works, new tab joins split immediately (`tab.splitViewId` set) |
| `tabs.discard(paneBackground)` | works; **returns a NEW tab object with a NEW id**; split pairing kept (same splitViewId, discarded:true). Old id then throws "No tab with id". |
| `tabs.discard(activePane)` | works (active pane discarded and stays active, ids replaced), pairing kept |
| `tabs.group({tabIds:[onePane]})` | partner pane is pulled into the same group (both got the new `groupId`) |
| `tabs.move(onePane, index elsewhere)` | split DISSOLVES for both panes (`splitViewId` -1 on both) |
| moving another tab between the panes | breaks the split too (observed, partner pane became -1) |
| `tabs.remove(onePane)` | other pane survives as a normal tab, `splitViewId` -> -1 |
| `tabs.remove([both])` | both closed fine |
| `tabs.unsplit(id)` | works, both stay as plain tabs (note: our first try used a stale id after discard, so always re-read the id) |
| `tabs.query({splitViewId:-1})` | excludes both panes |

Not tested: pinned splits, splits in tab groups surviving a `tabs.group` re-assign, audible panes, multi-window moves (`windows.create({tabId})`), the sweep's `active:false` query discarding the *visible partner* of an active pane (we discarded a background split only; the partner of the focused pane was not tried), session restore of splits after Chrome restart, native Chrome "Reopen closed tab" for a split.

## 3. Impact on Tabroost

Panes are ordinary tabs everywhere in the code, so nothing crashes. Concrete risks:

1. **stash (`lib/stash.js` gatherWindow, ~L92-140)**: both panes saved as two separate items, adjacent in order (good, tabs are walked in strip order). Pairing is lost, restore shows two ordinary tabs. With `dedupeOnStash`, two panes with the same URL collapse into one item (the partner closes, nothing lost but the split).
2. **drain (`lib/drain.js` tabs.remove ~L222, L344, L365; discard L312)**: closing one pane dissolves the other, harmless because both are being closed. Danger only for tabs that are NOT closed (excluded sites, pinned, `keep`): if pane A is saved/closed and pane B stays (excluded site), B silently loses its split and is left as a normal tab; acceptable. Partial-failure retry logic checks tab ids with `tabs.get`; ids are already tolerant of "replaced" (drain.js L94-96), which matters since discard changes the id.
3. **suspend sweep (`lib/suspend.js` ~L252-266)**: queries `active:false`, so the visible partner of the focused pane is eligible to be discarded after idle time: the user sees one half of the split go blank/reload. Fix: skip any tab whose `splitViewId !== -1` when its partner is active or recently accessed (simplest: skip a pane if any tab with the same splitViewId is active or audible). Also `markFrozen`/override maps keyed by tab id must follow the new id after discard (same as for ordinary tabs; check `firstseen.js` handles replacement).
4. **probe (`probeProtect`)**: audible/media probe is per tab; an audible pane protects only itself, its partner could still be discarded. Treat the pair as one unit.
5. **restore (`lib/restore.js` L177 `tabs.create`, L49/L404 discard, L74-84 group)**: layout lost. Each item is created sequentially with `index: off+i` so panes end up adjacent only if saved adjacent. Discard of freshly created restored tabs replaces their id (already handled for plain tabs) and keeps pairing.
6. **snapshot (`lib/snapshot.js` L33-40 rows)**: rows have `{w,i,url,title,g,p,f}`; no split field, so snapshot recovery returns plain tabs. No loss of tabs.
7. **opener/firstseen**: only per-tab, no special effect.
8. **Tab groups**: restore groups tab-by-tab; grouping one pane pulls the partner in (harmless, but the second `tabs.group` call must tolerate "already in group").

Overall: no tab loss risk found; the user-visible bugs are (a) split layout not restored, (b) the idle sweep can blank the visible partner pane.

## 4. Recommended implementation

Minimal safe (about 0.5 day):
- Sweep: in `suspend.js`, build `Map(splitViewId -> [tabs])` from the `tabs.query` (query WITHOUT the `active:false` pre-filter for the split check, or do a second query) and skip a tab if `splitViewId !== -1` and any partner is active/audible/recently accessed. Add a "split view partner" protected reason for the popup.
- Dedupe: do not dedupe-collapse a pane whose partner has the same URL (or keep dedupe, accept).

Full (about 1.5-2 days incl. tests):
- stash: for tabs with `splitViewId >= 0` assign window-local pair id `sv` (like `tg`), store `item.sv = k` (small int, only when paired and BOTH panes are saved items). Add field to the item schema, sync payload, export/import, validation, and migration (absent = no split).
- restore: after creating both items (adjacent, same pinned, group them first or let grouping complete), call `chrome.tabs.createSplit([idA,idB])` guarded by `typeof chrome.tabs.createSplit === 'function'` and try/catch (Chrome < 155 or constraint failure falls back to two plain tabs). Order: create both -> group both (same groupId) -> createSplit -> then discard (pairing survives discard).
- List UI: small split icon on items sharing `sv`, and i18n string. Bulk delete of one pane should not delete the partner.
- snapshot: add `sv` to rows (optional) so snapshot recovery recreates the pair.
- Be defensive: never trust `splitViewId` values across sessions, only equality inside one query result.

## 5. Test plan (CDP, same setup as this investigation)

Isolated Chrome with fresh `--user-data-dir`, port 9567, `--enable-unsafe-extension-debugging`, `Extensions.loadUnpacked` the real extension (needs a copy under the scratchpad), plus the probe extension's SW to call `tabs.createSplit`. Scripts:
1. Stash a window containing a split pair, a plain tab and a grouped split pair; assert saved items carry the same `sv` and `tg`; all tabs closed.
2. Restore in background; assert two adjacent tabs per pair with equal `splitViewId !== -1`, groups preserved, no tab lost; run again with same URL in both panes and with dedupe on.
3. Sweep: make partner of the active pane idle (set `lastAccessed` old / lower threshold), run sweep; assert the pane was not discarded; assert a fully idle background split is discarded together and pairing remains; assert ids replaced are tracked.
4. Drain with an excluded-site pane: partner stays, no exception.
5. Snapshot: take, stash, restore from snapshot, assert pairs.
6. Chrome < 155 fallback: stub `chrome.tabs.createSplit = undefined` in the SW and assert two plain tabs are restored.

Probe extension and runner (throwaway, deleted with the scratchpad): `<scratch>/splitext\{manifest.json,sw.js}`, `<scratch>/t.mjs`, `e.mjs`. Manual alternative for the developer: load an unpacked extension whose SW calls `chrome.tabs.createSplit` in the console, or in Chrome right-click a tab -> add to split view, then open the popup listing `splitViewId` of `chrome.tabs.query({})`.

## 6. Unverified

Everything under "Not tested" in section 2, plus whether the sweep's `active:false` pre-filter really includes the visible partner pane in a live Chrome with focus on a split (strongly implied by one-active-per-split observation).

## 7. Implementation status

Implemented (see lib/splitview.js, tests/split-view-unit.mjs, tests/split-view-test.mjs):
- Saved items get `sv` (window-local pair index) only when both panes are saved together; the raw `splitViewId` is never stored. Two same-url panes are never collapsed by dedupe.
- Restore creates both panes back to back, groups them, calls `tabs.createSplit` (guarded), then applies the normal discard-after-load policy to both. A pair is never cut by a chunk boundary or the restore pool. Any failure leaves two plain tabs.
- Sweep, auto-stash, clean-all and refresh treat the two panes as one unit (never a sleeping pane next to an active, audible, protected or recently used partner); the popup lists the reason 'split-partner'.
- Snapshots carry `sv`; the list shows a small split icon (click = open the pair side by side).
- Measured on Chrome 158: discarding a pane replaces its tab id but keeps the pairing; pinned panes can be split; a pair inside a Chrome tab group can be split after grouping.
