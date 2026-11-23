# Contributing to Tabroost

Thanks for helping. Small, focused pull requests are easiest to review.

## Ground rules

- Be kind (see CODE_OF_CONDUCT.md).
- No new network requests, analytics, remote code, `eval` or `new Function`. The store policy and our privacy promise depend on this.
- Do not add permissions without a discussion first; every permission needs a user-visible reason.
- Use one word per idea in UI strings (see `tools/glossary.md`). Thai is the primary language; add English at the same time.
- Keep the code readable (no obfuscation, no minified sources).

## Setup

No build step. Load the folder as an unpacked extension (chrome://extensions > Developer mode > Load unpacked) in a **separate, empty Chrome profile**, never in your everyday profile.

## Checks before a pull request

```
for f in *.js lib/*.js lib/sync/*.js; do node --check "$f"; done
node tools/check-imports.mjs
node tools/test-formats.mjs
node tests/query-test.mjs
node tests/search-test.mjs
node tests/snapshot-test.mjs
node tests/sync/run.mjs
node tools/package.mjs
node tools/audit-repo.mjs
```

The browser UI tests under `tests/ui/` drive a real Chrome through DevTools and must only be run with an isolated, throwaway profile.

## Pull requests

Describe what changed and why, how you tested, and whether permissions, stored data or strings changed. Update CHANGELOG.md for user-visible changes. If you change what data is stored or how, update the privacy policy in `site/privacy.html` in the same pull request.

## Reporting bugs and ideas

Use the issue templates. Security issues: see SECURITY.md.

## License

By contributing you agree that your contribution is licensed under the MIT License (see LICENSE).
