# Store listing package

| File | Purpose |
|---|---|
| listing-en.md / listing-th.md | name, summary, description, category, tags, screenshot captions |
| permissions-justification.md | single purpose + text for each permission field + follow-up to reduce review friction |
| privacy-practices.md | answers for the Privacy practices tab and a data-storage table |
| privacy-policy.html | the policy (Thai + English). Same page is published as `site/privacy.html` |
| test-instructions.md | text for reviewers |
| pre-submission-checklist.md | policy checklist, risks, upload steps, data-continuity note |

Packaging: `node tools/package.mjs` (from the repo root) creates `dist/tabroost-<version>.zip` and checks it.

## Hosting the privacy policy for free (needed: a public URL)

1. Fill `{{DEVELOPER_NAME}}`, `{{CONTACT_EMAIL}}`, `{{EFFECTIVE_DATE}}` in `site/privacy.html` (and copy the final text back here, or treat `site/` as the source of truth and delete the copy).
2. Push the repo to GitHub (public), then enable Pages with source **GitHub Actions** (workflow `.github/workflows/pages.yml` is included). See `GITHUB-SETUP.md`.
3. The URL is `https://<user>.github.io/<repo>/privacy.html`. Paste it in the dashboard (Privacy policy field). Alternatives: Cloudflare Pages, Netlify, or any static host.
4. The URL must stay online and match what the extension does. Update it whenever data handling changes.

## Open items for the developer

- Developer name, contact email, effective date (placeholders).
- Public hosting URL for the policy and the homepage/support URLs.
- Own trademark and Web Store name search for "Tabroost" (classes 9 and 42; USPTO, WIPO, Thai DIP, Web Store, domain, social handles).
- Take 5 screenshots 1280x800 with dummy tabs.
- Decide on the permission follow-up (optional `<all_urls>`, `bookmarks`, `sessions`).
- Check wording of menu names in test-instructions.md against the final build; remove the statistics section if the dashboard is hidden in 1.0.0.
- Verify store fees, dashboard labels, review times on the current Chrome Web Store documentation.
