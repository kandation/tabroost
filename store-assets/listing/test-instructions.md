# Test instructions for the Chrome Web Store reviewer

Paste the block below into Dashboard > Test instructions. No login, account, API key or server is needed. Tabroost has no backend.

```
No account or login is needed. The extension works fully offline and has no server.

SETUP
1. Install Tabroost. Pin it from the puzzle-piece menu.
2. Open 6-10 ordinary tabs (for example wikipedia.org, example.com, news pages). Put two of them in a Chrome tab group (right-click a tab > Add tab to new group).

A. SAVE AND RESTORE (core feature)
1. Click the Tabroost toolbar icon (or press Alt+Shift+S). The tabs from all windows are saved and closed, and the saved list opens in a tab.
2. In the list you will see one "tab set" with your tabs. Try the search box at the top (type part of a title), the sort/filter buttons, pin and star icons.
3. Click one saved tab: it opens again. Click "Open all" on the tab set: tabs reopen gradually and are asleep (greyed) until you click them. Tab groups are recreated with their names and colors.
4. Delete a tab set: it moves to Trash (left menu). Restore it from Trash.

B. AUTO-SLEEP AND PROTECTION (needs the optional permission; it is not granted at install)
0. Tabroost asks for page access only when needed. Open Settings (left menu) > "Permissions asked later" (or the Sleep card) and press "Allow checking forms and video before sleeping a tab", then accept Chrome's prompt. Until you do, auto-sleep is paused on purpose (no tab is ever slept without the check) and the page says so. You can take the permission back with the "Take back" button in the same card.
1. Open Settings (left menu). Auto-sleep is on by default with a 20 minute idle time. For a quick test set the idle time to the smallest option, or right-click on any web page and choose the Tabroost item "put this tab to sleep now".
2. Open a page with a text box (for example any site with a search box). Type some text without submitting, switch to another tab, then use the same right-click action on the first tab: it is NOT put to sleep because of unsaved input. This is the only reason the extension has access to all websites: a short built-in function checks for unsaved form input or playing media before a tab is slept.
3. Open any video/audio page, start playback, switch tab: the playing tab is not slept.

C. CRASH RECOVERY
Settings has a "Recover lost tabs" list (left menu: clock icon). It shows recovery notes of open tabs that Tabroost writes every few minutes. Chrome's own recently closed tabs appear there after pressing "Turn on" (optional sessions permission).

D. EXPORT AND DELETE
Settings > Export/Import: export to a file. Trash > empty to delete for good.

E. OPTIONAL ENCRYPTED SYNC (off by default; needs two browser profiles to see devices syncing)
Sync stores encrypted data in a bookmark folder that Chrome's own bookmark sync can carry to other devices. A reviewer can verify it with a single profile:
1. Settings > Sync between devices > Turn on. Chrome first asks to allow the optional bookmarks permission (needed only for this feature; "No" keeps sync off and changes nothing). Choose any passphrase (write it down; it cannot be recovered).
2. Open the bookmark manager (chrome://bookmarks). Under "Other bookmarks" there is a folder "Tabroost sync data - do not edit". Its entries are bookmarks to https://cmr.invalid/... which is a reserved, non-resolving address and only holds encrypted text. Nothing is contacted.
3. Optional two-device check: open a second Chrome profile signed in to the same Google account with bookmark sync on (or copy the folder through bookmark export/import), install Tabroost there, turn on Sync with the same passphrase. Tab sets saved on the first profile appear in the second. Without the passphrase the data stays unreadable.
4. Turn sync off in Settings to remove the folder.

F. STATISTICS DASHBOARD (local)
Left menu > the dashboard entry opens a local page. All numbers come from data in this browser. It can be turned off in Settings, which stops collecting.

NOTES
- The language follows the browser language (Thai or English) and can be switched in Settings > Language.
- Tabroost makes no network requests of its own. Site icons come from the browser's favicon cache.
- Tab pages on chrome:// cannot be inspected by extensions; Tabroost saves their URLs only if "internal pages" is set to save.
```

## Notes for the developer (do not paste)

- Verify every menu name against the final build before pasting; the wording above follows the current glossary (tools/glossary.md) and may drift as other agents edit strings.
- Make sure item E step 4 (turning off removes the folder) is true in the final build, or reword it.
