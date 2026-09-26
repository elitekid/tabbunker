# Changelog

## 1.1.1 (2026-09-26)

### Fixed

- If the computer clock is moved back, dated backup files (tabbunker-YYYYMMDD-HHMM.json) resume on the normal hourly schedule. Before, no new dated file was made until the clock reached one hour past the time of the last dated file (about a day and an hour after moving the clock back a day). The latest backup file was not affected.

### Changed

- The Chrome Web Store and Edge Add-ons name is now "TabBunker - Save Tabs & Auto Backup" (Korean: "TabBunker - 탭 저장·자동 백업"). The toolbar menu still says TabBunker, backups still go to Downloads/TabBunker, and the Firefox name is unchanged.

## 1.1.0 (2026-09-17)

### Added

- One-time review request on the vault page after at least one successful file backup, three or more collapses, and 48 hours since install. Shown as a small non-modal banner with Write a review, Don't ask again, and Report a problem links. No star-rating filter, no rewards, and no repeat after either button is used.
- TabBunker info section at the bottom of Settings with permanent Write a review, Report a problem, and Source code links.
- One-time notice at the top of the dropdown that backup files are saved to Downloads/TabBunker, with Got it and Turn off in Settings. On Firefox it also says the downloads list may open briefly, since Firefox cannot hide it.
- Toolbar dropdown popup to preview tabs, pick which to save, browse recent groups, undo the last save, and open the full vault or settings without closing tabs accidentally.

### Changed

- Clicking the toolbar icon opens a dropdown instead of immediately saving and closing every tab in the window.
- Saving tabs no longer opens or focuses the vault tab; a toast with Undo appears in the dropdown (or on the next open if the dropdown was closed).
- Keyboard shortcut and context-menu save still work instantly and show a badge count instead of opening the vault.
- Fresh install no longer opens the vault page automatically.
- Automatic file backup downloads on Chrome and Edge hide the browser download bubble while a backup is in progress.
- Settings page redesigned to match the dropdown: changes save instantly (no Save button), switches and segmented choices, file backup status with last saved time and Back up now, the folder shown as Downloads / name, the real keyboard shortcut read from the browser (so Windows shows Alt+Shift+S and Mac shows its symbols) with a Change button on Chrome and Edge, and Delete all moved into its own section with an in-page confirmation that focuses Cancel.
- The vault now matches the dropdown and settings: sticky header, backup status with a colored dot and relative time, click a tab row to open it, text-style group actions (Open all, Rename, Lock, Delete), and "Open"/"Open all" instead of "Restore". Renaming happens in place (Enter saves, Esc cancels). Browser alert, confirm and prompt dialogs are replaced by in-page dialogs and a short notice under the header.
- The dismissible welcome card in the vault is gone. When nothing is saved, the vault shows a short how-to with Import from another tab manager, and it disappears once you save tabs. The review request no longer depends on that card.
- Korean text uses one consistent polite tone across the dropdown, vault and settings.

### Fixed

- Vault "Saved N tabs" banner now disappears after Undo restores the tabs.
- The vault first-run card no longer has a "Save and close tabs" button that closed every tab in the window from the vault page. It now points to the toolbar dropdown, pinning, the instant-save shortcut, and what the full vault is for.
- Group titles show readable dates ("Today 6:37 PM", "Yesterday", "Sep 3", with the year for older groups) in the dropdown and the vault. Stored titles and backup files are unchanged, and renamed groups are shown as is.
- The dropdown shows a short message when nothing is saved yet or a search has no matches, and never lists trashed groups.
- Korean text no longer breaks in the middle of a word.
- The dropdown tab count refreshes when tabs open, close, or finish loading while it is open (Firefox briefly reported reopened tabs as browser pages after Undo).

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
