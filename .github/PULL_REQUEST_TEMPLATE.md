## What and why

<!-- A short description of the change and the reason. -->

## How I tested

<!-- Commands run, manual steps, Chrome version. UI tests: only with an isolated test profile. -->

## Checklist

- [ ] `node tools/check-imports.mjs` and the node tests pass
- [ ] `node tools/package.mjs` prints OK
- [ ] No new permission, network request, `eval` or remote code (or it is discussed in the PR)
- [ ] Thai and English strings both added (see `tools/glossary.md`)
- [ ] If stored data or data handling changed: `site/privacy.html` and CHANGELOG.md updated
- [ ] No personal data, local paths or logs in the diff
