# Changelog

## 1.1.0 (2026-09-17)

### Added

- One-time review request on the vault page after first-run onboarding is done, at least one successful file backup, three or more collapses, and 48 hours since install. Shown as a small non-modal banner with Write a review, Don't ask again, and Report a problem links. No star-rating filter, no rewards, and no repeat after either button is used.
- TabBunker info section at the bottom of Settings with permanent Write a review, Report a problem, and Source code links.

## 1.0.0 (2026-09-15)

### Added

- Right-click context menu: send this tab, send link, send all tabs in this window, open vault. Sending a single tab includes pinned tabs; the badge shows how many were saved.
- Favicons in the vault: Chrome reads its local favicon cache (`favicon` permission), Firefox shows a domain-letter avatar. No network requests; extension pages only allow `self` and `data:` images.
- Dark mode (follows the system) and a refreshed vault and settings layout with one shared theme.
- Undo after collapse now restores pinned state, keeps links whose tab failed to reopen, and falls back to the requesting window when the original window is gone.
- One-click collapse, vault with search/restore/lock/trash, automatic dual backup, import/export with preview, one-step undo, settings page, first-run onboarding, and Chrome/Edge/Firefox MV3 builds.

### Changed

- File backup no longer stops after 24 files a day. `tabbunker-latest.json` is overwritten after each change (30 s / 5 min / 30 min delay setting), plus at most one dated copy per hour with the 30 newest kept and older ones removed.
- Backup success is recorded only when the browser reports the download complete. The vault header shows in-browser snapshot time, file backup state, and offers Back up now / Restore from backup file.
- A canceled download (for example the "Ask where to save" browser setting) pauses file backup with an explanation instead of retrying every 30 seconds.
- Every change made in the vault or settings now goes through the background page, so renames, locks, drags, trash actions, imports and undo all schedule a backup.
- Collapsing tabs opens or focuses the vault in the same window first, so the window never closes, and shows "Saved N tabs" with Undo.
- Restore asks for confirmation from 30 tabs, passes pinned state, and keeps links that failed to open.
- Import preview shows excluded line counts and the exact effect of Merge / Replace all. Replace all moves existing groups to Trash instead of discarding them; locked groups stay.
- Delete all data never touches backup files on disk.

### Fixed

- Backup scheduling no longer re-triggers itself from its own storage writes.
- Trash cleanup alarm was re-created on every service worker start and effectively never fired.
- Backup folder names are sanitized (no path separators or `..`).
- Firefox automatic file backup no longer fails on data URLs (blob URL path). Firefox smoke test added (`tools/scenario-firefox.mjs`).
