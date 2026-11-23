# Privacy practices tab: answers

Dashboard wording changes over time. Match the idea, and verify each item on the current dashboard. Fill the privacy policy URL (hosted copy of privacy-policy.html / site/privacy.html) in the Privacy section too.

## Data types: what to tick

Dashboard question: "What user data do you plan to collect from users now or in the future?" Tick a category if the extension handles that data, even if it never leaves the device. Google's definition of "collect" in this form includes "handling" (verify the current definition on the dashboard help). Being conservative is safer for review.

| Category | Tick? | Why |
|---|---|---|
| Personally identifiable information | No | No name, email, address, ID is requested or stored. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No* | No passwords of third-party services are collected. *The sync passphrase and the optional password lock are chosen by the user, are never stored in plain form and never leave the device. If you think the reviewer might see this as "authentication information", ticking it is acceptable; add the note in the justification. |
| Personal communications | No | |
| Location | No | |
| **Web history** | **Yes** | The URLs and titles of tabs the user saves (and recovery notes of open tabs) are stored locally. |
| **User activity** | **Yes** | Local usage statistics (time/activity counters, last-used time, opened-time). Tick it if `activityTracking` stays on by default in the shipped version; it is local-only and can be switched off. If statistics are removed or off by default and not collected, untick. |
| **Website content** | **Probably No** | The sleep check only reads a yes/no (unsaved input, media playing) and does not store content. Page titles and URLs are covered by Web history. If you want maximum caution you may tick it with the same justification; decide with the final code. |

Note: the local statistics dashboard is included in this build. Answer for what the uploaded build really does.

## Data usage justification (text for the dashboard fields)

For Web history:
```
Tabroost saves the URL and title of tabs the user chooses to save, so it can show them in the user's list and reopen them later. It also keeps short recovery notes of the open tabs so tabs can be recovered after a crash. This data is stored only on the user's device (IndexedDB and chrome.storage), is not transmitted to the developer or any third party, and can be exported or deleted by the user at any time.
```

For User activity (if ticked):
```
Optional local statistics (for example when a saved tab was last used and daily counters) are used to show the user a dashboard and to sort the list. They are stored only on the device, are never sent anywhere, and can be switched off in settings.
```

## Certifications (all three: tick)

1. "I do not sell or transfer user data to third parties, outside of the approved use cases." - true.
2. "I do not use or transfer user data for purposes that are unrelated to my item's single purpose." - true.
3. "I do not use or transfer user data to determine creditworthiness or for lending purposes." - true.

## Remote code

Are you using remote code? **No.** (Justification field, if shown: "All JavaScript is in the package. No remote scripts, no eval, no remotely loaded modules.")

## Limited Use statement

The policy states that data use follows the Chrome Web Store User Data Policy including Limited Use. Already included in privacy-policy.html.

## What is stored where

| Data | Location | Leaves the device? | Retention / deletion |
|---|---|---|---|
| Saved tab sets, tabs (URL, title, notes, category, flags) | IndexedDB (extension origin) | No | Until the user deletes. Deleted items go to the trash, then are purged after a set number of days (defaults: deleted 30 days, opened-and-removed 7 days). "Delete for good" is immediate. Removing the extension deletes the data. |
| Second backup copy of the list | chrome.storage.local | No | Same as above; follows the list. |
| Settings, whitelist, small state | chrome.storage.local / sync-free | No | Until the user resets or removes the extension. |
| Crash-recovery notes (open tabs every few minutes) | IndexedDB / chrome.storage.local | No | Only the latest few are kept (verify the exact count in the app) and they can be cleared in the app. |
| Local statistics (counters, last used) | IndexedDB / chrome.storage.local | No | Default `retentionDays` is 400 days of daily stats; user can turn stats off or clear them. |
| Favicons | In the list page cache from the browser's favicon service | No requests to sites by the extension | User can turn icons off. |
| Optional sync data | Bookmarks folder "Tabroost sync data - do not edit" under Other bookmarks, AES-GCM-256 encrypted, key from the user's passphrase (PBKDF2-SHA256). Entries use fake `https://cmr.invalid/` URLs. | Only through the user's own Chrome/Google bookmark sync, if the user has it on, and only as ciphertext. The developer never receives it. | Turn sync off in settings, which removes the folder (verify in the final build), or delete the folder by hand. |
| Sync passphrase | Not stored | No | n/a |
| Exports | Files the user saves | User decides | User controls. |

## Permissions asked at run time (optional)

Page access (`<all_urls>`), `bookmarks` and `sessions` are optional permissions. They are not granted at install and are requested only after the user presses a button ("Allow checking forms and video before sleeping a tab", "Turn on sync", "Turn on" in recovery). The answers above do not change: the page check only reads two yes/no facts on the spot (unsaved form input, media playing) and stores or sends nothing. Taking a permission back never deletes saved data. See permissions-justification.md.

## Never leaves the device

URLs, titles, notes, categories, statistics, settings, recovery notes, the passphrase, and plain (decrypted) sync data. The extension makes no network requests of its own (favicons come from the browser's local favicon service; verify with the audit that `fetch(` only targets `chrome-extension://.../_favicon/`).

## Controls given to the user

- Export all data to a file; import from file or other tab managers' text format.
- Delete items, empty the trash, delete all data (confirm in the final build).
- Turn off statistics; turn off favicons; turn off sync; turn off auto-sleep and the crash-recovery notes.
- Uninstalling removes all local data.
