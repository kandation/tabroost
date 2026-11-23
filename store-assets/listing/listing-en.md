# Chrome Web Store listing (English)

Paste these into the Developer Dashboard > Store listing > English. Counts were checked against the limits (name 75, summary 132). Re-check them if you edit.

## Name (max 75)

```
Tabroost
```

(If the store rejects the bare name as too generic or taken, use `Tabroost - Tab Manager` after your own name search.)

## Short summary (max 132) - also the manifest `description` candidate

```
Save all your open tabs to a searchable list, and put idle tabs to sleep to use less memory. Everything stays on your device.
```

## Category

Primary suggestion: **Productivity** (Workflow & Planning / "Tools" sub-area if the dashboard asks). Verify the category names on the current dashboard.

## Language

Default language: English or Thai (choose the one you will keep up to date). Add the other as a second language and paste the matching file.

## Tags / keywords (not a dashboard field; use as wording ideas, never stuff them in the description)

tab manager, save tabs, tab list, tab sleep, tab suspender, reduce memory, session saver, tab groups, bookmark sync, import from other tab managers

## Detailed description

```
Tabroost helps you manage tabs and use less memory. Save everything you have open into a searchable list with one click, close the tabs, and bring them back whenever you want.

WHAT IT DOES

Save all open tabs
Click the toolbar icon (or press Alt+Shift+S). Tabroost saves the tabs from all your windows as one "tab set", then closes them. If you have a lot of tabs, it closes them gradually and watches your free memory so the browser does not freeze.

Open them again without a memory spike
Open one tab or a whole tab set from the list. Tabs are opened in small steps and stay asleep until you click them, so restoring 100 tabs does not load 100 pages at once.

Put idle tabs to sleep
Optional auto-sleep puts tabs you have not used for a while to sleep. A sleeping tab stays in the tab bar and reloads when you click it. It is off for tabs that are playing audio or video, tabs with form input you have not saved, and sites on your allow list (video-call sites are on it by default).

Find things fast
Fuzzy search, sort, group and filter. Keyboard shortcuts on the list page can be switched on or off one by one in Settings. Pin, star, add categories, and keep Chrome tab groups: tab groups are saved and restored with their names and colors.

Do not lose work
Deleted items wait in a trash for a set number of days. Tabroost also keeps recovery notes of your open tabs every few minutes, so you can recover lost tabs after a crash. You can export everything to a file, and import lists from other tab managers.

HOW IT PROTECTS YOUR TABS AND DATA

- Your saved tabs are stored in this browser (IndexedDB and extension storage), not on a server.
- Tabroost has no servers, no account, no analytics, no ads and makes no network requests of its own. It does not download or run remote code.
- Before sleeping a tab, a short script checks the page for unsaved form input or playing media. It only reads that yes/no answer on your device. It does not read or store page content.

OPTIONAL: SYNC BETWEEN YOUR DEVICES

If you turn it on, Tabroost encrypts your tab sets with a passphrase you choose and stores the encrypted data in your browser's own bookmarks, in a folder named "Tabroost sync data - do not edit" under Other bookmarks. Chrome's own sync (if you use it) carries the bookmarks to your other devices. The entries look like bookmarks to https://cmr.invalid/..., which is a reserved address that cannot open anything; they only hold encrypted data. Do not edit or move this folder. Your passphrase is never stored or sent. If you forget it, the synced data cannot be recovered, but your local list is not affected. Sync is off by default.

PRIVACY

Tabroost keeps the URLs and titles of tabs you choose to save, your settings, and (optionally) local usage statistics, on your device only. Nothing is sold, shared or sent to the developer. The statistics can be switched off. You can export or delete your data at any time. Full policy: see the privacy policy link on this page.

OPTIONAL: PASSWORD LOCK

Off by default. If you turn it on, Tabroost encrypts your saved list on this computer (titles, links, notes, the trash and the backup copy) with your password, and locks itself after idle time or when your screen locks. It protects against someone at your computer and against someone copying the browser profile folder. It does not hide when sets were saved or how many tabs they hold. If you forget the password, you can open the list with the recovery key, or with a backup password or a passkey you set up in Settings. If you have none of these, the list cannot be opened again; saving tabs still works. The lock and sync work together: synced data stays encrypted in the sync folder with your sync passphrase, the lock key protects the data on this computer, and sync pauses while the list is locked and carries on after you unlock. Before you erase everything after losing a password, you can save an encrypted backup file (.tabroost) that opens only with the old password, recovery key, backup password or passkey and can be imported again later.

DASHBOARD

- A local dashboard of how you use tabs over time (off by default, can be turned off any time)

WHY THESE PERMISSIONS

tabs and tabGroups: read and close your open tabs, and save/restore tab groups.
storage and unlimitedStorage: keep your saved list and settings on your device.
alarms: run auto-sleep and crash-recovery notes on a timer.
contextMenus: right-click menu items to save a tab.
scripting and (optional) access to sites: run the short check for unsaved input or playing media before sleeping a tab. Asked only when you press "Allow checking forms and video"; without it, auto-sleep stays paused. Nothing else.
favicon: show site icons in your list from the browser's own cache.
system.memory: read free memory to pace closing and restoring tabs.
bookmarks (optional, asked when you turn on sync): only for the optional encrypted sync folder.
sessions (optional, asked when you press "Turn on" in recovery): show Chrome's recently closed tabs in the recovery list.

HOW TO START

1. Install Tabroost and pin it to the toolbar.
2. Open a few tabs and click the Tabroost icon. They are saved and closed.
3. Open the list from the icon, then click a tab or tab set to open it again.
4. Open Settings in the list page to set auto-sleep, trash time, language (Thai or English) and optional sync.

Tabroost is an independent project. It is not affiliated with or endorsed by Google or any other tab manager.
```

## Screenshot captions (1280x800, up to 5)

1. Save every open tab with one click. They go into a list and the browser gets lighter.
2. Search, sort and group your saved tabs. Chrome tab groups are kept.
3. Open a whole tab set gradually. Tabs stay asleep until you click them, so memory does not spike.
4. Auto-sleep skips tabs with playing media, unsaved form input, and sites you protect.
5. Optional encrypted sync, deleted items in a trash, and recovery notes of your open tabs.

## Promo images (optional)

Small tile 440x280, marquee 1400x560: see `store-assets/promo/`. Not required for approval.

## Fill-in items

- Support URL / homepage: your GitHub repo or the site/support.html URL.
- Privacy policy URL: https://<user>.github.io/<repo>/privacy.html (after hosting).
