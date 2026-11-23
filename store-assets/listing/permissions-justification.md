# Permission justifications (Developer Dashboard > Privacy practices)

Paste each block into the matching "Permission justification" field. The manifest now separates **required** permissions (asked at install) from **optional** ones (asked at run time, after the user clicks something). If the permission list changes again, re-check this file against manifest.json. The dashboard only shows fields for permissions that are in the uploaded manifest; optional permissions and optional host permissions get their own fields (verify the labels on the current dashboard).

## Single purpose

Paste into "Single purpose description":

```
Tabroost manages browser tabs and reduces memory use. It saves open tabs into a searchable local list and closes them, reopens them later without loading everything at once, and puts idle tabs to sleep.
```

All features (search, categories, trash, crash recovery, tab-group preservation, optional encrypted sync of the list, local statistics) serve that one purpose: managing the tabs you have open or have saved.

## Summary: required vs optional

| Permission | When Chrome asks | Install-time warning it adds | If the user says no |
|---|---|---|---|
| tabs | at install | "Read your browsing history" | (required) |
| tabGroups | at install | (none of its own) | (required) |
| storage, unlimitedStorage, alarms, contextMenus, scripting, favicon, system.memory, idle | at install | none | (required) |
| **optional host `<all_urls>`** | when the user presses "Allow checking forms and video before sleeping a tab" (Sleep settings card, popup, or the dismissible banner) | none at install; Chrome shows its own prompt "Read and change all your data on all websites" at that moment | Auto-sleep stays **paused**: no tab is put to sleep, because a tab that cannot be checked is never slept. Manual sleep ("put this tab to sleep now") is refused the same way. Everything else works. |
| **optional `bookmarks`** | when the user presses "Turn on sync" | none at install; prompt "Read and change your bookmarks" at that moment | Sync stays off with a friendly message. Nothing else is affected. If it is taken back later, sync pauses ("needs permission"); local data is never deleted. |
| **optional `sessions`** | when the user presses "Turn on" in the "Tabs Chrome just closed" part of the recovery screen | none at install; Chrome's own prompt, if it shows one for `sessions`, appears at that moment (verify wording) | That list is hidden behind a "Turn on" button. Tabroost's own recovery notes still work. |

Install-time warnings the Web Store listing will show for the shipped manifest (inferred from Chrome's permission-warning table; verify in the dashboard preview): **"Read your browsing history"** (from `tabs`). `tabGroups`, `storage`, `unlimitedStorage`, `alarms`, `contextMenus`, `scripting`, `favicon` and `system.memory` do not add a warning of their own. The earlier build also showed "Read and change all your data on all websites" and "Read and change your bookmarks"; those two are gone from the install prompt.

## Required permissions

### tabs
```
Tabroost reads the URL, title, window, group and pinned/audible state of open tabs so it can save them into the user's list, close them, restore them, find duplicates, and decide which idle tabs may be put to sleep. This is the core feature. The data stays on the user's device and is never sent anywhere.
```

### tabGroups
```
Used to read the name, color and membership of Chrome tab groups when saving tabs, and to recreate those groups when the user reopens a saved tab set. If the user turns off "keep tab groups", it is not used.
```

### storage
```
Stores the user's settings and small state (for example the list of protected sites, the sleep timer and a second backup copy of the saved list) in chrome.storage on the user's device.
```

### unlimitedStorage
```
A saved list can contain thousands of tabs (URLs, titles, notes, recovery snapshots) in IndexedDB. Without this permission the browser's default quota could silently fail on large lists and the user would lose saved tabs. Nothing is uploaded.
```

### alarms
```
Schedules the periodic jobs in the Manifest V3 service worker: checking for idle tabs to sleep, writing the crash-recovery note of open tabs every few minutes, purging expired trash items, and the optional sync timer. No alarms run for tracking.
```

### contextMenus
```
Adds right-click menu items on the toolbar icon (open the list, save this tab, save other tabs, save tabs to the right, save all windows, protect this site) and on a page (keep this tab awake, put this tab to sleep now), so the user can act without opening the popup.
```

### scripting
```
Used only for the short check before a tab is put to sleep (chrome.scripting.executeScript with a function bundled in the extension, never remote code): is there a form field with input that was not saved, and is media currently playing. If either is true, or if the check cannot run, the tab is not put to sleep. The permission by itself gives no access to any site: it only works on sites the user has allowed through the optional "check forms and video before sleeping a tab" permission, and it fails harmlessly everywhere else. The result is used on the spot; page content is not read out, stored or sent.
```

### favicon
```
Shows each saved page's site icon in the list using the browser's own favicon cache (chrome-extension://.../_favicon/). It does not contact the sites. The user can turn icons off in settings.
```

### idle

Used by the optional password lock only: when the operating system locks the screen, Tabroost can lock the saved list too (a setting, on by default once the lock is turned on). It reads no activity and no page content; it only receives the "locked" state change. The permission produces no install-time warning.

### system.memory
```
Reads the amount of free memory so Tabroost can pace closing and restoring: it closes or opens tabs in smaller steps when memory is low, which keeps the browser from freezing. The value is used locally and not stored or sent.
```

## Optional permissions (requested at run time)

The manifest declares `optional_permissions: ["bookmarks", "sessions"]` and `optional_host_permissions: ["<all_urls>"]`. Each is requested with `chrome.permissions.request` straight from a button click. The user can take each back in Settings > "Permissions asked later" (or in chrome://extensions), and the app copes with that at any moment (guards on every use; listeners on `chrome.permissions.onAdded` / `onRemoved`).

### Optional host permission: <all_urls>
```
Requested only when the user presses "Allow checking forms and video before sleeping a tab". Needed only so the scripting check can run on whichever site is open when a tab is about to be put to sleep, to avoid losing text the user typed and to avoid stopping playing video. Tabroost has no content scripts, does not run on pages at load, does not read or modify page content, and makes no network requests to those sites. The script runs only on demand, only on tabs being considered for sleep, and only if auto-sleep is enabled. If the permission is not granted, or a page cannot be checked (for example a restricted page), the tab is left awake: auto-sleep simply stays paused and the settings page, the popup and a dismissible banner say so and offer the button.
```

### bookmarks (optional)
```
Requested only when the user presses "Turn on sync" for the optional encrypted sync feature, which is off by default. Tabroost then creates one folder named "Tabroost sync data - do not edit" under Other bookmarks and stores AES-GCM-encrypted data in bookmark entries with the reserved address https://cmr.invalid/... (a non-resolving address). Chrome's own bookmark sync can then carry it to the user's other devices. Tabroost only touches that folder and never reads, changes or deletes the user's real bookmarks. If the user declines or later removes the permission, sync stays off or pauses, and all saved tabs on the device stay untouched.
```

### sessions (optional)
```
Requested only when the user presses "Turn on" next to "Tabs Chrome just closed" in the crash-recovery screen. It reads Chrome's "recently closed" list so lost tabs can be shown next to Tabroost's own recovery notes and restored. It is read on demand when the user opens that screen. Without it, that one list is hidden and Tabroost's own recovery notes still work.
```

## Remote code

```
No. All code is bundled in the extension package. There are no remote scripts, no eval or new Function, and no remotely hosted libraries. The scripting function that checks tabs is part of the package.
```

## What happens when a permission is not granted (behaviour contract)

- **No host access:** the sweep returns `noHostAccess`, discards nothing, and records a status for the UI. "Put this tab to sleep now" and "close duplicate tabs" skip tabs they cannot check. Saving, restoring, search, dashboard, snapshots and crash recovery do not use host access (`chrome.tabs.query`, the extension's own pages and the browser favicon cache only).
- **No bookmarks:** `chrome.bookmarks` is never touched (the SW listeners are installed only when the API exists, and re-installed on `permissions.onAdded`). Enabling sync asks first; "no" gives a friendly message and sync stays off. Removing it while sync is on shows "sync paused, needs permission" and keeps all local and remote data.
- **No sessions:** `chrome.sessions` is never touched; the recently-closed section shows a "Turn on" button.
- Nothing is deleted when a permission is granted or taken back.

## Verification notes (for the developer)

- `scripting` without host permission is valid in the manifest. In a test Chrome, `chrome.scripting.executeScript` on an http page without host access rejects with "Cannot access contents of the page. Extension manifest must request permission to access the respective host." (this is what the sweep treats as "cannot check, leave awake").
- Other features that might need host access were checked by grep: no `fetch`/`XMLHttpRequest`, no content scripts, no `webRequest`; icons use `_favicon` (needs only `favicon`).
- `idle` is a required permission (it shows no install warning). It is used only by the optional password lock: `chrome.idle.onStateChanged` with the state `locked` (the operating system locked the screen) locks the list when the setting "lock when the computer locks its screen" is on. Nothing else calls it. When the lock is off it does nothing.
- After changing permissions, re-run `node tools/package.mjs`, update the Privacy practices answers, and re-test with the permissions denied and granted (`node tests/perms-test.mjs`).
- `tabGroups` could also be optional later; it stays required because "keep tab groups" is on by default.
- Manifest `description` is a short English sentence from `_locales/en/messages.json` (Thai in `_locales/th`). Keep it at or under 132 characters and keep the store summary identical.
