# Chrome Web Store / Edge Add-ons / Firefox AMO listing (English)

## Name
TabBunker

## Short description (manifest, 132 chars max for Chrome; no competitor names in title/summary: store policy + OneTab trademark)
Close your tabs. Keep a backup. One-click tab saver with automatic local backup and restore preview.

## Category
Productivity > Tools (Chrome) / Productivity (Edge) / Tabs (Firefox)

## Detailed description

Too many tabs? One click closes every tab in the window and saves them as a group in your vault. Restore one tab, a whole group, or preview first.

The install prompt may show up to three warnings (browsing history, downloads, and site icons). TabBunker reads open tab titles and URLs to save them, writes backup files to Downloads, and shows favicons from the browser cache. Saved addresses never leave your device.

What makes TabBunker different is what happens after you click: every change is backed up automatically, twice.

- In-browser history: the last 20 snapshots are kept inside the extension.
- On disk: a JSON file is written to Downloads/TabBunker. It survives extension resets, browser profile wipes, and reinstalls. You can open it with any text editor.

No account. No server. No network requests. Your tab list never leaves your computer. The code is open source.

Features
- One-click collapse: toolbar icon or Alt+Shift+S closes all tabs in the current window into a group.
- Vault page: search across all groups and tabs, restore a single tab or the whole group, lock groups so they cannot be deleted, rename, drag tabs between groups.
- Restore preview: the vault lists every link before you restore, and asks first when a group has 30 or more tabs.
- Automatic backup: in-browser snapshot ring plus tabbunker-latest.json in your Downloads folder, overwritten after every change, and an hourly dated copy (30 kept). The vault shows when the last file was written.
- Import: OneTab text export, Session Buddy JSON, and TabBunker backup files, with a merge preview and one-step undo.
- Export: TabBunker JSON, OneTab-compatible text, or an HTML bookmarks file you can import into any browser.
- Right-click menu: send this tab, send a link, or send all tabs in the window without opening anything. Undo works for sent tabs.
- Favicons next to every saved tab in Chrome (from the browser's local cache, never fetched from the web). Firefox shows domain initials. Dark mode follows your system.
- Trash with 30-day recovery for deleted groups.
- Works in Chrome, Edge, and Firefox. English and Korean UI.

Permissions, explained
- tabs: read the URL and title of open tabs so they can be saved, then close and reopen them.
- storage / unlimitedStorage: keep your groups and backup history locally without a size cap.
- downloads: write backup and export files to your Downloads folder. Nothing is ever uploaded.
- alarms: schedule the backup and the daily trash cleanup.
- contextMenus: register right-click menu items only.
- favicon (Chrome only): read favicons from the browser local cache for the vault. No network requests.

Switching from OneTab or Session Buddy
Export your data from the old extension, open the TabBunker vault, click Import, and choose the exported file (for OneTab, save its text export to a .txt file first). You will see a preview of what will be merged before anything changes.

Website: https://elitekid.github.io/tabbunker/
Source code and issues: https://github.com/elitekid/tabbunker
Privacy policy: https://github.com/elitekid/tabbunker/blob/main/PRIVACY.md

## Edge search terms

1. tab manager
2. save tabs
3. close all tabs
4. backup
5. session
6. restore tabs
7. import tabs
