# Store assets: rename + logo study

Everything here is new and lives outside the extension. Exclude `store-assets/` from the shipped zip. No existing extension file was touched.

## 1. Name shortlist

Why rename: "Clean My RAM" is close to MacPaw's CleanMyMac / CleanMyPC, and "RAM cleaner" wording is a spam-flag in the Chrome Web Store. Names must also avoid OneTab, Chrome and Google.

**Honesty note.** These findings come from general web searches (Chrome Web Store listings, Firefox add-ons, Justia trademark pages, aggregator sites). A web search cannot prove a name is free. Before committing, search the Chrome Web Store yourself, and check USPTO TESS/Search, WIPO Global Brand Database and the Thai DIP (Department of Intellectual Property) trademark database, classes 9 and 42 (software). Also check the domain and the social handles. Nothing was registered.

| Candidate | Conflicts found | Risk | Verdict |
|---|---|---|---|
| **Tabroost** | No extension, company or trademark hit in 2 searches. Only unrelated "TAB Software" style companies came up. | Low (unverified) | **Top 1**. Roost = a place to rest, fits "stash / sleep". |
| **Tabpillow** | No software hit; only physical tablet pillows. | Low (unverified) | **Top 2**. Cute, "tuck tabs in". Slightly long. |
| **Hushtab** | No exact match. Close: "Hushify - Tab Suspender" (https://chromewebstore.google.com/detail/hushify-—-tab-suspender-a/jdeaohffinodjabdibegjcceafgmdjgm). Many HUSH-prefixed US marks (HUSH, HUSHED, HUSHSPACE; https://trademark.justia.com/756/01/hush-75601920.html). | Medium | **Top 3**, but a Hush-prefix trademark clash is possible. |
| Sabai Tabs | No extension. But live/pending SABAI marks in software classes (Sabai Group LLC, serial 99347833; https://trademarkdir.com/trademark/sabai-99347833) and a Bangkok booking app "SABAI". | Medium-high | Best for Thai audience, but "Sabai" is crowded. Skip unless a lawyer clears it. |
| Tabdrift | Nothing exact. Neighbour: "Tabrift - Tab Session Manager" (https://chromewebstore.google.com/detail/decfagklmcljcgpmalmlclepokoapfap), a tab saver. | Medium | Too close to Tabrift. |
| Tabquill | Nothing found. | Low (unverified) | Hard to say in Thai. Backup. |
| Tabwick | Nothing found. | Low (unverified) | Meaning unclear. Backup. |
| Tabnest | At least 6 Chrome extensions named TabNest, several save/restore tabs (https://chromewebstore.google.com/detail/tabnest/gplhcnbpmokcnjhhcbhfjgdnpdjgoadk). | High | Reject. |
| TabNap / NapTab | "Tabnap" snooze tool, "Tabs to Nap" (https://chromewebstore.google.com/detail/tabs-to-nap/ghddlgjinefkhkldkcbcibacfaclodih), Firefox TabNap (https://addons.mozilla.org/en-US/firefox/addon/tabnap/). | High | Reject. |
| Lumo / Lumitabs | LumiTabs is a tab saver (https://chromewebstore.google.com/detail/ogekdcaggomkoaoegaohefkmgalkmkoi), Lumitabs dimmer (https://chromewebstore.google.com/detail/aopkjclaaceglhpdbfmcchofdjfoimpf). | High | Reject. |
| Tabloom | Existing "Tabloom" extension (https://chromewebstore.google.com/detail/tabloom/cbmnnefephhnnpilpdcpfflleephjknp) plus a GitHub project. | High | Reject. |
| Stashly | At least 4 Chrome extensions named Stashly, one saves all tabs with OneTab import (https://addons.mozilla.org/addon/stashly/). | High | Reject. |
| Keptab | Existing OneTab-style tab list extension, same name (https://chromewebstore.google.com/detail/keptab/feodekcipceogpeomnijgmdlmocbggbi). | Very high | Reject. |
| Moontab | "Moontab Extreme" (https://chromewebstore.google.com/detail/moontab-extreme/mpgnjbpflgkmnppgjjinfgjcffjknpam), Firefox "Moontabs" (tab sleeper). | High | Reject. |
| Dozetab | "Doze Tabs", "Tabdoze" (https://github.com/mrdear/tabdoze), "Tab Snoozer". | High | Reject. |
| Tabnook | Existing "TabNook" extension by TabNook LLC (https://chromewebstore.google.com/detail/tabnook/dhbbmlpccicljdlpbmobeegamhcpjnpn). | High | Reject. |
| Tabhaven | Two Chrome extensions "tabhaven"/"TabHaven", both save tabs. | High | Reject. |
| Restab / TabRest | "TabRest - Rest your tabs, free your RAM" (https://chromewebstore.google.com/detail/agajndkecodedlklmpnjgikglkpeopib) is nearly the same idea. | Very high | Reject. |
| Sleepytab / Tab Lullaby | "SleepyTabs" and "Tab Lullaby" are existing tab suspenders. | High | Reject. |

The Chrome Web Store is crowded with "Tab + noun" names. Even the low-risk ones above should be re-checked on the store itself, because new listings appear weekly.

### Top 3 with taglines

| # | Name | English tagline | Thai tagline | Thai reading |
|---|---|---|---|---|
| 1 | **Tabroost** | Give your tabs a place to rest. | ให้แท็บได้พัก ให้เครื่องได้หายใจ | แท็บรูสต์ |
| 2 | **Tabpillow** | Tuck your tabs in. Free your RAM. | ห่มผ้าให้แท็บ คืนแรมให้เครื่อง | แท็บพิลโลว์ |
| 3 | **Hushtab** | Quiet tabs, light memory. | แท็บเงียบ แรมเบา | ฮัชแท็บ |

Tip: keep the Thai store listing and in-app Thai text as the primary description, and put a plain-English keyword phrase ("tab manager, save tabs, tab suspender") in the description instead of in the name.

## 2. Logo directions

All three share one palette family (not Google or OneTab colours: violet / teal / berry tile, cream glyph, amber accent). SVG is hand-written (no raster). Contrast was measured with the WCAG formula.

| Dir | Idea | Tile | 16 px | Notes |
|---|---|---|---|---|
| **A sleepy** (recommended) | A saved-tab "folder tab" with closed eyes and a small z | violet `#7F52E8` | Clear: tab shape, eyes and z stay readable | Tells the whole story (save + sleep). Mono badge is a strong silhouette. Reads as friendly for a Thai audience. |
| B stack (folder `b-nest`, file name kept from an earlier nest idea) | Three stacked tab cards, top one amber | teal `#14867F` | Clear but generic | Looks like a "layers" icon. Least distinctive. |
| C chip | Memory chip with a crescent moon | berry `#C2417A` | Fine after simplifying (pins reduced to 2 per side) | Good at 32+ but the chip reads as "hardware / RAM", the same cliche as RAM cleaners. |

**Recommendation: A (sleepy tab).** It is the only one that shows both "tab saved" and "resting", it is distinctive next to OneTab's funnel and Chrome's colours, and it survives 16 px and mono use.

Contrast of A: tile `#7F52E8` vs white 4.9:1, vs `#202124` 3.3:1 (both above the 3:1 non-text minimum); cream glyph vs tile 4.5:1; amber z vs tile 3.1:1; ink eyes vs cream 11.2:1. Because the tile is a mid-tone fill, the icon works on light and dark toolbars with no outline.

Design rules used:
- 16 px is a separate simplified SVG (`*-icon-16.svg`): fewer details, coordinates snapped to the pixel grid, thicker strokes.
- 32/48 use the full-bleed detailed art. 128 uses the same art with 16 px transparent padding (art is 96 px inside 128).
- Mono versions: black or white silhouette, eyes cut out with an SVG mask (for the action badge, favicons or monochrome UI).

## 3. File index

```
store-assets/
  README.md
  png/compare-directions.png all 3 directions at 16/32/48/128, light + dark, mono
  svg/<dir>-icon-fullbleed.svg   detailed art, no padding (source for 32/48/512)
  svg/<dir>-icon-128.svg         same art, 16 px padding for the Web Store
  svg/<dir>-icon-16.svg          simplified 16 px variant
  svg/<dir>-mono*.svg            monochrome (black / white, detailed + 16 px)
  png/<dir>/icon16|32|48|128.png, icon512-preview.png, mono16*.png, mono32*.png
  promo/small-tile-440x280-en.png / -th.png
  promo/marquee-1400x560-en.png / -th.png
  promo/github-social-1280x640.png
  promo/preview-sheet.png    icon on #fff and #202124, 16/32/48/128, mono, mock toolbars
  tools/gen-svg.mjs          writes the SVGs
  tools/make-icons.mjs       rasterizes icons (one throwaway headless Chrome via CDP)
  tools/make-compare.mjs     comparison sheet
  tools/make-store.mjs       icon preview sheet (the promo tiles moved to shots-compose.mjs)
  tools/render.mjs           shared renderer (launches one Chrome with a temp profile, kills it, deletes the profile)
  screenshots/README.md      the five 1280x800 store screenshots (en/ and th/), promo art list, captions, upload order
  tools/shots-capture.mjs    raw UI captures with demo data (one Chrome with a scratch copy of the extension)
  tools/shots-compose.mjs    final screenshots, promo tiles and the GitHub social preview (replaces the promo part of make-store.mjs)
  tools/demo-data.mjs, lib-chrome.mjs, png-rgb.mjs   demo data, Chrome launcher, PNG to 24-bit RGB
```
`<dir>` is `a-sleepy`, `b-nest` or `c-chip`. Promo art uses the Leelawadee UI font (installed with Windows), with Segoe UI as fallback. Regenerate with `node tools/gen-svg.mjs && node tools/make-icons.mjs && node tools/make-store.mjs` (needs Node 22 and Chrome at `C:/Program Files/Google/Chrome`).

## 4. How to swap in later (not done yet)

1. Copy the chosen direction's PNGs over the extension icons:
   - `store-assets/png/a-sleepy/icon16.png` to `icons/icon16.png`
   - `.../icon32.png` to `icons/icon32.png`
   - `.../icon48.png` to `icons/icon48.png`
   - `.../icon128.png` to `icons/icon128.png`
2. In `manifest.json` set `"name"` to the final name (for example `"Tabroost"`). It is also worth changing the strings that say "Clean My RAM" in the command descriptions, `popup.html` / `stash.html` titles, and any Thai/English UI text. Search the repo for `Clean My RAM`.
3. If you want a monochrome toolbar badge or favicon, use `svg/a-sleepy-mono*.svg` or `png/a-sleepy/mono*.png`.
4. Upload `promo/small-tile-440x280-*.png` and `promo/marquee-1400x560-*.png` in the Web Store dashboard. The 1280x800 screenshots are in `screenshots/en/` (default) and `screenshots/th/` (Thai locale); see `screenshots/README.md`.
5. Make sure `store-assets/` is excluded from the release zip.
6. If you pick a different name than Tabroost, update `NAME` and `TAG` in `tools/make-store.mjs` and rerun it.
