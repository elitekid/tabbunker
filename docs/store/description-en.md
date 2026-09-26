# Chrome Web Store / Edge Add-ons / Firefox AMO listing (English)

## Name
TabBunker

## Short description (same as manifest extDescription, 132 chars max for Chrome; no competitor names in title/summary: store policy + OneTab trademark)
Pick the tabs to save from the toolbar, reopen them anytime, and keep an automatic backup file in Downloads. No account needed.

## Category
Productivity > Tools (Chrome) / Productivity (Edge) / Tabs (Firefox)

## Detailed description

Too many tabs? Click the TabBunker icon in the toolbar and a small menu opens. Save every tab in the window, uncheck the ones you want to keep, or save them without closing. Clicking the icon never closes a tab by itself.

Saved something by mistake? Undo it right there. From the same menu you can reopen a single tab or a whole group.

The in-browser history updates after each change. With file backup on by default, a separate JSON copy is also written after a short delay.

- In-browser history: the last 20 snapshots are kept inside the extension.
- On disk, when file backup is on: a JSON file is written to Downloads/TabBunker. It survives extension resets, browser profile wipes, and reinstalls, and opens in any text editor. In Chrome and Edge the download popup stays hidden while the file is saved. File backup can be turned off.

No account. No server. No network requests. Your tab list never leaves your computer. The code is open source.

The install prompt may show up to three warnings (browsing history, downloads, and site icons). Saved addresses never leave your device.

Features
- Toolbar menu: save this window's tabs (close them or keep them open), pick which tabs to save, undo, and search, open, rename, lock, or delete saved groups.
- Keyboard shortcut (Alt+Shift+S on Windows by default) and right-click menu: save this window, this tab, or a link instantly, without picking.
- Full vault page when you need it: search everything, drag tabs between groups, trash, and restore from a backup file.
- Opening a group with 30 or more tabs asks first.
- Backup: the in-browser snapshot ring updates after changes. With file backup on, tabbunker-latest.json is overwritten after each change and a dated copy is kept at most hourly (30 kept). The last file save time shows in the toolbar menu, the vault, and settings.
- Import: OneTab text export, Session Buddy JSON, and TabBunker backup files, with a merge preview and one-step undo.
- Export: TabBunker JSON, OneTab-compatible text, or an HTML bookmarks file you can import into any browser.
- Favicons next to every saved tab in Chrome and Edge (from the browser's local cache, never fetched from the web). Firefox shows domain initials. Dark mode follows your system.
- Trash with 30-day recovery for deleted groups.
- Works in Chrome, Edge, and Firefox. English and Korean UI.

Permissions, explained
- tabs: read the URL and title of open tabs so they can be saved, then close and reopen them.
- storage / unlimitedStorage: keep your groups and backup history locally without a size cap.
- downloads: write backup and export files to your Downloads folder. Nothing is ever uploaded.
- downloads.ui (Chrome and Edge): hide the download popup only while an automatic backup file is being saved, then turn it back on right away.
- alarms: schedule the backup and the daily trash cleanup.
- contextMenus: register right-click menu items only.
- favicon (Chrome and Edge): read favicons from the browser's local cache for the list. No network requests.

Switching from OneTab or Session Buddy
Export your data from the old extension, open the TabBunker vault, click Import, and choose the exported file (for OneTab, save its text export to a .txt file first). You will see a preview of what will be merged before anything changes.

Website: https://elitekid.github.io/tabbunker/
Source code and issues: https://github.com/elitekid/tabbunker
Privacy policy: https://github.com/elitekid/tabbunker/blob/main/PRIVACY.md

## Edge search terms

1. tab manager
2. save tabs
3. tab backup
4. session manager
5. restore tabs
6. close all tabs
7. import tabs
