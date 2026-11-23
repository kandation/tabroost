# GitHub setup (public repository, MIT)

Placeholders: `<user>` your GitHub name, `<repo>` the repository name (for example `tabroost`). Menu names change; verify in the current GitHub docs. Nothing here was run for you: no git init, commit or push has been done.

## 0. Clean the tree first

1. Fill the placeholders: `{{DEVELOPER_NAME}}` in `LICENSE`, the policy pages and `site/*.html`; `{{EFFECTIVE_DATE}}`; `{{REPO_URL}}`; `{{STORE_URL}}` (use the store link after publishing; until then point the button at the repo).
2. Run `node tools/audit-repo.mjs` and resolve every HIGH item (for example `store-assets/tools/render.mjs` has a hard-coded machine path; the internal `docs/spec-*.md` mention local paths). Either fix the text, move internal specs to a folder you ignore in `.gitignore`, or edit them. Run it again until HIGH is 0.
3. Run the tests listed in the README.
4. The contact for everything is the repository Issues page (`{{REPO_URL}}/issues`); no email address is published. The audit flags personal addresses so you notice them. The Chrome Web Store dashboard asks for a contact email separately; enter it there only.

## 1. Create the repository

On GitHub: **New repository**, name `<repo>`, **Public**, no README/license/.gitignore (they exist locally). Description: "Save all open tabs to a searchable list and sleep idle tabs. Local, private Chrome extension." Topics: `chrome-extension`, `tab-manager`, `manifest-v3`, `privacy`, `thai`, `session-manager`.

## 2. First push (commands to run yourself, in the project folder)

```
git init -b main
git config user.name "<your name>"          # repo-local identity; use the GitHub noreply email to avoid exposing your address
git config user.email "<id>+<user>@users.noreply.github.com"
git add .
git status                                  # read the list; nothing personal, no profile folders, no zip
git commit -m "Initial public release 1.0.0"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

(Check also that the commit author email is not your private address: `git log -1 --format=%ae`. Past commit history, if you import any, may contain personal data; start fresh if unsure.)

## 3. GitHub Pages (privacy policy URL)

1. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
2. The workflow `.github/workflows/pages.yml` publishes the `site/` folder on every push to `main` that changes it (or run it by hand from the Actions tab).
3. Public URLs afterwards: `https://<user>.github.io/<repo>/` (home), `https://<user>.github.io/<repo>/privacy.html` (use this one in the Chrome Web Store Privacy policy field), `/terms.html`, `/support.html`. Open each in a private window and check no `{{...}}` placeholder remains.

## 4. Repository settings

- Settings > General: enable Issues, **Discussions** (the issue template links to it), disable Wikis if unused.
- Settings > Branches (or Rules): protect `main`: require a pull request, require the CI check to pass, block force pushes.
- Settings > Code security: enable **Dependabot alerts** (no dependencies, but harmless), **Private vulnerability reporting** (used by SECURITY.md), and secret scanning/push protection if offered.
- Social preview and the About box: description, website (Pages URL), topics.
- Edit `.github/ISSUE_TEMPLATE/config.yml` to replace `<user>/<repo>`.

## 5. Release with the store zip

```
node tools/package.mjs                       # dist/tabroost-<version>.zip
git tag v<version> && git push origin v<version>
```
GitHub > Releases > Draft a new release > choose the tag > attach `dist/tabroost-<version>.zip` > paste the CHANGELOG entry. `dist/` is git-ignored on purpose; the zip is attached to the release, not committed.

## 6. Link the repo from the Web Store listing

In the Developer Dashboard > Store listing, set the **Homepage URL** to the Pages home (or the repo) and **Support URL** to `https://<user>.github.io/<repo>/support.html` or the issues page. Mention "open source, MIT" in the description if you like. Verify the field names on the current dashboard.

## 7. Keep in sync later

Every release: bump `manifest.json` version, update CHANGELOG, run the checks, package, tag, attach zip, upload the same zip to the dashboard.
