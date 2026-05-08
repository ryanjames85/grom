# Release Checklist

Steps to cut a Grom release. Do them in order — skipping the version bump is what causes `grom-0.3.7.vsix` to appear under the v0.3.8 tag.

1. **Bump version in `package.json`** — `"version": "0.3.x"`
2. **Update `CHANGELOG.md`** — add a new `## [0.3.x] — YYYY-MM-DD` section
3. **Update `docs/index.html`** — bump the `<span class="badge">v0.3.x</span>` near the top
4. **Commit** — `git commit -m 'feat: v0.3.x — short summary'`
5. **Push** — `git push`
6. **Tag and push tag** — `git tag v0.3.x && git push origin v0.3.x`

The GitHub Actions workflow picks up the tag, builds the `.vsix`, and attaches it to the release automatically. The `.vsix` filename is derived from `package.json` — if you skip step 1, the asset will be named after the previous version.
