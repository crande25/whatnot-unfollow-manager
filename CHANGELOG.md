# Changelog

All notable changes to Whatnot Unfollow Manager, newest first. The version is `version` in `manifest.json`; it shows on the install page and in Firefox's Add-ons Manager.

## Unreleased

Nothing yet.

## 1.0.0 — 2026-10-30

The first release.

### For users

- Published at https://github.com/crande25/whatnot-unfollow-manager under the MIT License, with an install page at https://crande25.github.io/whatnot-unfollow-manager/. Once Mozilla has signed a version, the page installs it in one click, and Firefox keeps it up to date from there.
- Docs: the README is written for people who find the project on GitHub and says plainly that the add-on is unofficial. The install page holds the user guide (installing, the keep list, how a run works, troubleshooting and limits), carries the same notice, and has a description and preview image for search results and link previews.
- A Firefox add-on, for Firefox 140 or later on a computer. An earlier, unreleased build was a Chrome extension; this one doesn't load in Chrome.
- Panel on whatnot.com that lists every account you follow and unfollows all of them except the ones on your keep list: open the panel, **Unfollow N accounts**, **Yes, unfollow**. It opens from a round launcher button (bottom-left), the toolbar button (from any tab; it opens Whatnot if needed) or Alt+Shift+U. The add-on's entry in Firefox's Add-ons Manager links to the install page.
- Keep list: ☆ Keep on each account, **Keep all N shown** for a filtered set, filter by name and by All / To unfollow / Kept, add by `@username` or profile link, remove, Export to JSON and Import (an Export file, a JSON array, or plain text with one username or link per line). Saved in the add-on's storage, so it survives restarts and is shared by all tabs.
- Bulk runs go one account at a time with randomized pauses at Careful, Normal (default) or Fast speed. They show progress and the time left, and can be paused, resumed and stopped. Failed accounts are marked with the reason and can be retried. Firefox asks before you leave the page mid-run.
- Rate limits and server errors back off 30 s, 60 s, then 120 s per account. A run halts when you're signed out, when Whatnot answers HTTP 403, or after 5 failures in a row.
- Undo (Options tab): follows the accounts from the last bulk unfollow again.
- Option to hide the launcher button.

### Internal

- `manifest.json` gains `update_url` (`https://crande25.github.io/whatnot-unfollow-manager/updates.json`) and `homepage_url` (the install page). The update URL has to ship in the first signed version, because an installed copy only ever checks the URL it was installed with.
- `build.ps1` replaces the earlier `package.ps1`. It still builds `dist/whatnot-unfollow-manager-<version>.zip` with Windows' tar.exe, which writes forward-slash paths (Windows PowerShell 5.1's `Compress-Archive` writes backslashes, which Firefox and addons.mozilla.org reject). It now also writes:
  - `install.html` from `install.template.html`, filling in `{{VERSION}}` and `{{XPI}}` and keeping either the `<!--IF SIGNED-->` or the `<!--IF UNSIGNED-->` block;
  - `updates.json` from the signed files in `xpi/`, with a SHA-256 `update_hash` for each.

  `-Signed <file>` checks a file from Mozilla before copying it to `xpi/`: it needs a Mozilla signature in `META-INF/`, the same add-on ID and version, and exactly the files of the zip just built. The build fails if `update_url` changes.
- Signed files are served from `xpi/` on GitHub Pages, not from GitHub Releases. Firefox installs a linked add-on only when it's served as `application/x-xpinstall`, which Pages does for `.xpi` files. Pages serves the repository root from `main`.
- Added `LICENSE` (MIT), `index.html` (sends the Pages root to `install.html`), `.nojekyll` (Pages serves files as they are; Jekyll would read the `{{…}}` placeholders in the Markdown files as template tags), `.gitattributes`, `.gitignore` (`dist/`) and `images/preview.png` (made with demo accounts). `.gitattributes` keeps LF line endings in every checkout, so a clone builds files byte-identical to the signed ones, and marks PNG, XPI and zip files as binary.
- Commits use the account's GitHub noreply address, which keeps the owner's email out of the public history.
- `dev/firefox-test.ps1`: smoke test that drives a throwaway headless Firefox profile over Marionette (11 checks). It installs the add-on temporarily, checks the signed-out panel with one real `GetUser` lookup, then replaces `fetch` for `/services/graphql/` inside the test page with a fake endpoint (12 follows, one failing) for a full unfollow, retry and reload. It detects Cloudflare's bot check and says so instead of failing oddly.
- Converted from the unreleased Chrome build: the interface says "add-on" instead of "extension", and extension APIs go through `WUM.ext` (`browser`, falling back to `chrome`) in store.js and main.js; background.js uses the same lookup.
- The launcher icon is built with `createElementNS` instead of `innerHTML`, which addons.mozilla.org's validator flags. `WUM.h` accepts `svg:` tag names and sets `class` with `setAttribute`, which works for SVG elements.
- The bridge returns the GraphQL response body as text and api.js parses it, so the content script only ever holds its own objects (no Firefox Xray wrappers around page objects).
- Toolbar flow: background.js sends `wum:toggle` to the current tab. If no content script answers, it opens `https://www.whatnot.com/` and sends `wum:open` every 500 ms for up to 20 s until the new tab's content script answers. main.js handles both messages. The Chrome build's `#wum-open` hash and its `history.replaceState` call are gone, since writing page-owned history state from a Firefox content script is fragile.
- Manifest for Firefox: `background.scripts` (an event page) instead of `background.service_worker`; `browser_specific_settings.gecko` with the fixed add-on ID `{853460fc-11ee-444b-893a-cb8bcbfa229c}` (required for signing, and keeps the add-on's storage across reinstalls), `strict_min_version` 140.0, and `data_collection_permissions` set to `{ "required": ["none"] }`, which addons.mozilla.org requires for new add-ons since November 2025. `"world": "MAIN"` content scripts need Firefox 128 or later.
- Manifest V3 add-on with one permission (`storage`); content scripts match `https://www.whatnot.com/*` and `https://whatnot.com/*` only, which Firefox grants as host access at install.
- Two worlds: the isolated-world content scripts (UI, storage, runner) and a page-world bridge (`src/page/bridge.js`, `"world": "MAIN"`). The bridge makes the GraphQL calls with the page's own `fetch`, so they carry the session cookie and pass through the site's anti-bot hooks, and it patches nothing. The two talk over `window.postMessage` on channels `wum:content` and `wum:bridge`.
- Whatnot API: `POST /services/graphql/?operationName=<name>&ssr=0` with trimmed copies of whatnot-web's operations: `CurrentUser` (`me`), `GetUser(username)`, `Following` (`userFollowing`, 50 per page, falling back to 24 if the first page is refused or missing), and `FollowUser(id, active, followSource: USER_PROFILE_PAGE)`. Headers mirror whatnot-web's: `authorization: Cookie`, `x-whatnot-app`, plus the app version and session IDs read from `window.__whatnot__`, cookies and `sessionStorage`.
- Storage format (`storage.local`):
  - `keep`: `{ [key]: { key, id, username, displayName, imageUrl, addedAt } }`. The key is the account number (the numeric part of the Relay global ID, base64 of `PublicUserNode:<n>`, the same for every node type of one account), or `@username` for name-only imports until they are matched.
  - `settings`: `{ speed: 'careful' | 'normal' | 'fast', showLauncher }`.
  - `lastRun`: `{ startedAt, accounts: [{ id, username, displayName, imageUrl }] }`, saved every 10 unfollows during a run.
- Export file format:
  `{ format: "whatnot-unfollow-manager/keep-list", version: 1, exportedAt, accounts: [...] }`.
- The UI lives in an open shadow root on `<html>` (outside `<body>`). It is attached after the `load` event so React hydration is finished, and put back by a MutationObserver if a re-render removes it.
