# Pre-submission checklist (Chrome Web Store)

Policy names and dashboard labels change. For every point: verify on the current Chrome Web Store Developer Program Policies page and the dashboard help before you rely on it.

## 1. Policy compliance

| Policy area | What to check for Tabroost | Status |
|---|---|---|
| Single purpose | One purpose: manage tabs and reduce memory use. Search, trash, recovery, sync, stats all serve that. Statement is in permissions-justification.md. Do not add unrelated features (shopping, new-tab override, search change). | [ ] |
| Minimum permissions | Every permission has a user-visible feature. Required: tabs, tabGroups, storage, unlimitedStorage, alarms, contextMenus, scripting, favicon, system.memory, idle. Optional (run time): `<all_urls>` host access, bookmarks, sessions (done; see permissions-justification.md). Remove any unused permission (a leftover one is a common rejection reason). Confirm the dashboard shows separate justification fields for optional permissions and fill them. | [ ] |
| Accurate listing and metadata | Name, summary, description and screenshots describe real behaviour. Features that are not in the build (no "coming soon" items remain; the stats dashboard shipped) must not be listed. No unverifiable numbers ("saves X GB"). No keyword stuffing, no repeated terms, no other brands' names, no "official". | [ ] |
| Privacy policy and data disclosures | Privacy policy hosted at a public https URL, linked in the dashboard, mentions the data types handled (URLs and titles of tabs), and matches the Privacy practices answers. The in-product behaviour must match what you declare. | [ ] |
| Limited Use | Statement is in the policy; no data goes to anyone. | [ ] |
| No remote code / obfuscation | No eval, new Function, remote script or module; code readable (no minified-only or obfuscated code; if you minify, keep it non-obfuscated and say so). Run `node tools/package.mjs`; it scans for these. | [ ] |
| No deceptive behavior | The sync feature stores data in bookmarks pointing to fake `https://cmr.invalid/` URLs. This must be disclosed to the user: in the store description (done), in the policy (done), in the settings screen next to the sync toggle (verify), and in the test instructions (done). The folder is clearly named "Tabroost sync data - do not edit". It is opt-in. The URLs are in a reserved TLD and are never fetched. Nothing is hidden: the user can see and delete the folder. | [ ] |
| Spam, ratings, reviews | Do not ask friends to rate in bulk, do not offer rewards for ratings, do not publish multiple near-identical items. One listing for this extension only. | [ ] |
| Trademark / impersonation | Name "Tabroost": the developer must do their own search of the Chrome Web Store, USPTO, WIPO Global Brand Database and the Thai DIP register (classes 9 and 42) and check the domain/handles. store-assets/README.md only reports a quick web search and cannot prove the name is free. No Google or Chrome logos or colors in icons or screenshots; the description states no affiliation. No competitor names (say "other tab managers"). | [ ] |
| Content | No adult, hateful or illegal content in listing or screenshots; use dummy tabs in screenshots (no personal sites, emails or account names). | [ ] |
| User data security | Data stays local; sync is encrypted (AES-GCM, PBKDF2-SHA256); all pages and communication over https where any. The local data is not encrypted at rest (state it honestly: policy section 7). | [ ] |
| Minimum Chrome version | `minimum_chrome_version` is 121. Confirm every API used exists in 121 (tabGroups, scripting, optional permissions and `chrome.permissions.onAdded/onRemoved`, favicon permission, `chrome.sessions`, `system.memory`, ES modules in SW, `_locales`). Test on that version if you can. | [ ] |
| MV3 and CSP | `manifest_version` 3; no `content_security_policy` loosening (`unsafe-eval`, remote origins); no inline scripts in HTML pages (CSP default blocks them). `node tools/package.mjs` checks scripts and eval. | [ ] |
| Quality | No console errors on load; works after browser restart (service worker wakes); uninstall leaves nothing. Icons 16/32/48/128 present. | [ ] |
| Account | Developer account is registered (one-time fee, verify current amount), contact email verified, 2-step verification enabled, trader/non-trader status declared (EU rules; verify current dashboard). | [ ] |

## 2. Risk list: what could cause rejection or a slower review

1. **Host access with `scripting`.** Broad host access triggers in-depth review. Mitigated: `<all_urls>` is now an optional host permission requested at run time, and the justification says "on-demand check before sleep, no content read". Re-test the denied and granted paths before each release (`node tests/perms-test.mjs`).
2. **`bookmarks` used to store non-bookmark data.** A reviewer may see fake bookmarks as unexpected behaviour. Mitigation: disclosure everywhere, opt-in, clear folder name, `.invalid` reserved domain, test steps to see it. The permission is now optional (asked only when the user turns on sync).
3. **`tabs` and saved URLs = web history.** Declare "Web history" and make the policy explicit. Be consistent: do not claim "we collect nothing" in the listing while ticking Web history; say "stored only on your device".
4. **`unlimitedStorage`, `system.memory`, `sessions`, `favicon`.** Rarely rejected, but each needs a one-line reason that matches real use.
5. **Unlabelled "coming soon" features or password lock.** Mentioning features that do not exist can be treated as misleading metadata.
6. **Listing wording that sounds like a "RAM cleaner/booster".** Avoided; keep it that way. No "saves X GB".
7. **Name conflict or trademark complaint.** Do the name search first.
8. **Policy URL placeholder not filled** ({{DEVELOPER_NAME}} etc.) or URL that returns 404.
9. **Screenshots that show real personal tabs.**
10. **Debug code left in the package**, for example message handlers that are not gated (the sw.js debug handler is gated by installType; verify with `node tools/audit-repo.mjs`).
11. **Reviewer cannot see auto-sleep protection:** the optional page-access permission is not granted at install, so auto-sleep is paused until the reviewer presses the button. test-instructions.md section B step 0 explains this; keep it.
12. **Stale data on update:** a permission added in an update disables the extension for existing users until they accept. Plan permissions before the first release. Optional permissions can be added later without disabling the extension, which is another reason to keep risky ones optional.

## 3. Upload steps in the Developer Dashboard

(Labels may differ; verify on the current dashboard.)

1. Run tests (`node tools/test-formats.mjs`, the other node tests) and `node tools/package.mjs`. Check that it prints OK and a zip at `dist/tabroost-<version>.zip`.
2. Go to https://chrome.google.com/webstore/devconsole and sign in with the developer account.
3. **Add new item** > upload the zip. The manifest is validated; fix errors if any.
4. **Store listing** tab: paste name/summary/description from listing-en.md (and add Thai from listing-th.md as a second language); category; upload icon 128x128 (from the package or store-assets), 1-5 screenshots 1280x800 (or 640x400), optional promo tiles; homepage and support URLs.
5. **Privacy practices** tab: single purpose, each permission justification, remote code = No, data types, three certifications, privacy policy URL. Use permissions-justification.md and privacy-practices.md.
6. **Test instructions** (under "Distribution" or "Test instructions" in the dashboard): paste from test-instructions.md.
7. **Distribution** tab: Visibility **Public**; regions (all regions, or select); pricing free.
8. **Submit for review.** Choose publishing mode: "Publish automatically after approval" or "Defer publishing" (you press Publish after approval; staged rollout percentage may be offered for updates). Verify the exact options on the dashboard.
9. Expected review time: usually a few days; many items are reviewed within about 1-3 days, new items or items with broad permissions can take a week or more. These are rough ranges from experience; the dashboard shows status and Google does not guarantee a time.
10. After approval: if deferred, click **Publish**. The listing URL appears on the dashboard; the item can take a few hours to appear in search.

## 4. Updates and versions

- Every upload needs a **higher `version`** in manifest.json than the last published one (dot-separated integers, for example 1.0.0 -> 1.0.1). Bump it before running `node tools/package.mjs`.
- Changing permissions or host permissions in an update disables the extension for users until they approve, and invites a slower review. Avoid adding permissions in patch releases.
- Update the changelog and the privacy answers if data handling changes.
- If you change the manifest `description`, change the store summary to match.

## 5. IMPORTANT: data continuity (different extension ID)

The extension ID of the Web Store version is different from the ID of your unpacked (developer) copy, and the browser stores IndexedDB and storage per extension ID. **Saved data does not carry over.**

Before switching from the unpacked copy:
1. In the unpacked version open the list page > Export all (file).
2. Install the Store version, open the list page > Import, choose the file.
3. Check counts, then remove the unpacked version.
Turn off sync on the old copy first, or make sure both copies are not syncing the same folder at once. (If the Store version is the one the user keeps, enable sync again with the same passphrase and verify data merges; test this before telling users.)

The ID can be kept stable between your own builds by adding a `key` to manifest.json for development; the Web Store assigns its own ID. Do not add the `key` field to the version you upload (the dashboard warns/rejects; verify).

## 6. Last look (human)

- [ ] Placeholders replaced: developer name, contact email, effective date, hosting URL.
- [ ] Screenshots taken with dummy data, 1280x800.
- [ ] Description and policy re-read in Thai and English.
- [ ] `node tools/audit-repo.mjs` shows no personal data in the public repo.
- [ ] Name search done.
