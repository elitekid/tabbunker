// 백그라운드: 명령 큐, mutate, 백업 엔진, 메시지 API

import {
  action,
  actionBadge,
  alarms,
  browserApi,
  commands,
  contextMenus,
  downloads,
  tabs,
  windows,
} from './shared/browser.js';
import {
  applyImport,
  collapseGroupTitle,
  createGroup,
  createSnapshot,
  createTab,
  normalizeUrl,
  sameLink,
  sanitizeSubfolder,
  DEFAULT_SETTINGS,
} from './shared/model.js';
import {
  applyGroupChanges,
  clearUndo,
  ensureMigrated,
  loadBackupRing,
  loadBackupState,
  loadGroups,
  loadMeta,
  loadSettings,
  loadUndo,
  purgeAndSave,
  pushBackupRing,
  saveAllGroups,
  saveBackupState,
  saveMeta,
  saveSettings,
  saveUndo,
} from './shared/storage.js';

const ALARM_BACKUP = 'tk-backup';
const ALARM_WATCHDOG = 'tk-backup-watchdog';
const ALARM_TRASH = 'tk-trash-purge';
const WATCHDOG_MS = 2 * 60 * 1000;
const BACKUP_NOW_TIMEOUT_MS = 20_000;
const DATED_INTERVAL_MS = 60 * 60 * 1000;
const MAX_DATED_FILES = 30;

const urlById = new Map();
let queueTail = Promise.resolve();
const pendingLater = [];
let menuChain = Promise.resolve();
let badgeGen = 0;
let badgeTimer = null;
const BADGE_COLOR = '#2457D6';
const manifestMeta = browserApi.runtime.getManifest();
const isFirefox = !!manifestMeta.browser_specific_settings?.gecko;

function i18n(key) {
  return browserApi.i18n.getMessage(key) || key;
}

function runMenuTask(fn) {
  const run = menuChain.then(() => fn());
  menuChain = run.catch(() => {});
  return run;
}

async function showBadge(text) {
  badgeGen++;
  const gen = badgeGen;
  clearTimeout(badgeTimer);
  await actionBadge.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await actionBadge.setBadgeText({ text });
  badgeTimer = setTimeout(() => {
    if (gen === badgeGen) {
      actionBadge.setBadgeText({ text: '' }).catch(() => {});
    }
  }, 2500);
}

async function showBadgeFail() {
  await showBadge('!');
}

function formatBadgeCount(n) {
  if (n > 99) return '99+';
  return '+' + n;
}

async function handleOpResult(res) {
  if (!res) return;
  if (res.ok) {
    if (res.added === false) return;
    let n = 0;
    if (res.added === true) n = 1;
    else if (typeof res.closed === 'number') n = res.closed;
    else if (typeof res.count === 'number') n = res.count;
    if (n > 0) await showBadge(formatBadgeCount(n));
  } else if (['system', 'incognito', 'empty', 'invalid'].includes(res.code)) {
    await showBadgeFail();
  }
}

function enqueue(_name, fn) {
  const run = queueTail.then(() => fn());
  queueTail = run.catch(() => {});
  return run;
}

function enqueueLater(fn) {
  pendingLater.push(fn);
  queueTail = queueTail.then(flushLater).catch(() => {});
}

function flushLater() {
  const fns = pendingLater.splice(0);
  return fns.reduce((p, fn) => p.then(() => fn()), Promise.resolve());
}

function broadcast(type, payload) {
  browserApi.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

function isDirty(meta, state) {
  return (meta?.revision ?? 0) > (state?.lastFileOkRevision ?? 0);
}

function urlOf(tab) {
  return tab.url || tab.pendingUrl || '';
}

function isSystemUrl(url) {
  return (
    !url ||
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('moz-extension://') ||
    url.startsWith('chrome-extension://')
  );
}

async function getCollapseTargets(windowId) {
  const settings = await loadSettings();
  const winTabs = await tabs.query({ windowId });
  const eligible = [];
  let pinnedExcluded = 0;
  let systemExcluded = 0;

  for (const t of winTabs) {
    const url = urlOf(t);
    if (isSystemUrl(url)) {
      systemExcluded++;
      continue;
    }
    if (!settings.includePinned && t.pinned) {
      pinnedExcluded++;
      continue;
    }
    eligible.push(t);
  }

  return { eligible, pinnedExcluded, systemExcluded, settings };
}

async function resolveWindowId(hints = {}) {
  if (hints.windowId != null) return hints.windowId;
  if (hints.senderTab?.windowId != null) return hints.senderTab.windowId;
  const win = await windows.getLastFocused({ windowTypes: ['normal'] });
  return win.id;
}

async function ensureVaultTab(windowId, opts = {}) {
  const { collapsedBanner = false } = opts;
  const extUrl = browserApi.runtime.getURL('vault/vault.html');
  const query = collapsedBanner ? '?collapsed=1' : '';
  const existing = await tabs.query({ windowId, url: extUrl + '*' });
  if (existing.length > 0) {
    await tabs.update(existing[0].id, { active: true });
    return existing[0];
  }
  return tabs.create({
    windowId,
    url: extUrl + query,
    active: true,
  });
}

async function registerContextMenus() {
  if (!contextMenus) return;
  const doRegister = async () => {
    await contextMenus.removeAll();
    const items = [
      { id: 'tb-send-tab', contexts: ['page', 'action'], title: i18n('ctxSendTab') },
      { id: 'tb-send-link', contexts: ['link'], title: i18n('ctxSendLink') },
      { id: 'tb-send-window', contexts: ['action'], title: i18n('ctxSendWindow') },
      { id: 'tb-open-vault', contexts: ['action'], title: i18n('ctxOpenVault') },
    ];
    for (const item of items) {
      await contextMenus.create({
        id: item.id,
        contexts: item.contexts,
        title: item.title,
      });
    }
  };
  try {
    await runMenuTask(() => doRegister());
  } catch (err) {
    console.error('contextMenus register failed:', err);
    try {
      await runMenuTask(() => doRegister());
    } catch (err2) {
      console.error('contextMenus register retry failed:', err2);
    }
  }
}

/** mutate: 큐 안에서만 호출 */
async function mutate(reason, fn) {
  const meta = await loadMeta();
  const revisionBefore = meta.revision;
  let begun = false;

  const ctx = {
    revisionBefore,
    async begin() {
      if (begun) return;
      begun = true;
      const newMeta = { ...meta, revision: revisionBefore + 1 };
      await saveMeta(newMeta);
      // 검증 단계 동안 바뀐 상태를 덮지 않도록 다시 읽는다
      const freshState = await loadBackupState();
      if (!isDirty(meta, freshState)) {
        await saveBackupState({ ...freshState, firstDirtyAt: Date.now() });
      }
      ctx.revisionAfter = revisionBefore + 1;
    },
  };

  const result = await fn(ctx);
  if (result && result.ok === false) return result;

  await ensureBackupAlarm();
  broadcast('vaultChanged', { reason });
  return result;
}

function makeUrl(body) {
  const canBlob = typeof URL.createObjectURL === 'function';
  if (canBlob) {
    return URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  }
  return 'data:application/json;charset=utf-8,' + encodeURIComponent(body);
}

function datedFilename(subfolder) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${subfolder}/tabbunker-${stamp}.json`;
}

function classifyInterrupt(error) {
  const e = (error || '').toUpperCase();
  if (e.includes('USER_CANCELED')) return 'canceled';
  if (e.includes('FILE_ACCESS_DENIED') || e.includes('FILE_BLOCKED') || e.includes('FILE_SECURITY_CHECK_FAILED')) {
    return 'access';
  }
  if (e.includes('FILE_NO_SPACE')) return 'disk';
  if (e.includes('FILE_NAME_TOO_LONG')) return 'name';
  if (e.includes('USER_SHUTDOWN') || e.includes('CRASH')) return 'shutdown';
  return 'unknown';
}

function classifyException(err) {
  const msg = String(err?.message || err || '');
  if (msg.toLowerCase().includes('filename')) return 'name';
  return 'unknown';
}

async function scheduleRetry(state) {
  const retryCount = (state.retryCount || 0) + 1;
  const delay = retryCount === 1 ? 5 * 60 * 1000 : 30 * 60 * 1000;
  const retryNotBefore = Date.now() + delay;
  await saveBackupState({
    ...state,
    retryCount,
    retryNotBefore,
    inflight: null,
  });
  await alarms.create(ALARM_BACKUP, { when: retryNotBefore });
}

async function handleBackupFailure(state, code) {
  if (code === 'canceled') {
    await saveBackupState({
      ...state,
      paused: 'canceled',
      inflight: null,
      lastError: { code: 'canceled', detail: '', at: Date.now() },
    });
    return;
  }
  if (code === 'shutdown') {
    await saveBackupState({ ...state, inflight: null });
    return;
  }
  await saveBackupState({
    ...state,
    inflight: null,
    lastError: { code, detail: '', at: Date.now() },
  });
  await scheduleRetry(state);
}

async function ensureBackupAlarm() {
  const state = await loadBackupState();
  const settings = await loadSettings();
  const now = Date.now();

  const when = Math.max(
    (state.firstDirtyAt || now) + (settings.backupIntervalSec || 30) * 1000,
    state.retryNotBefore ?? 0
  );

  const existing = await alarms.get(ALARM_BACKUP);
  if (existing) {
    if (when <= now) {
      enqueueLater(() => runBackup('due'));
    }
    return;
  }

  await alarms.create(ALARM_BACKUP, { when });
  if (when <= now) {
    enqueueLater(() => runBackup('due'));
  }
}

async function reconcileInflight() {
  const state = await loadBackupState();
  if (!state.inflight) return state;

  const items = await downloads.search({ id: state.inflight.downloadId });
  const item = items[0];

  if (!item) {
    const newState = {
      ...state,
      inflight: null,
      lastError: { code: 'unknown', detail: '', at: Date.now() },
    };
    await saveBackupState(newState);
    return newState;
  }

  if (item.state === 'complete' || item.state === 'interrupted') {
    await settleDownload(item);
    return loadBackupState();
  }

  const elapsed = Date.now() - (state.inflight.startedAt || 0);
  if (elapsed > WATCHDOG_MS) {
    const abandoned = [...(state.abandonedLatestIds || [])];
    if (state.inflight.kind === 'latest') {
      abandoned.push({
        id: state.inflight.downloadId,
        revision: state.inflight.revision,
      });
    }
    await saveBackupState({
      ...state,
      inflight: null,
      lastError: { code: 'stalled', detail: '', at: Date.now() },
      abandonedLatestIds: abandoned,
    });
    await scheduleRetry(state);
    return loadBackupState();
  }

  await alarms.create(ALARM_WATCHDOG, {
    when: Date.now() + WATCHDOG_MS - elapsed,
  });
  return state;
}

async function getSnapshotBody(revision) {
  const ring = await loadBackupRing();
  const entry = ring.find((e) => e.revision === revision);
  if (entry?.data) {
    return JSON.stringify(entry.data, null, 2);
  }
  const meta = await loadMeta();
  if (meta.revision === revision) {
    const groups = await loadGroups();
    const settings = await loadSettings();
    return JSON.stringify(createSnapshot(groups, settings), null, 2);
  }
  return null;
}

async function startDatedDownload(state, revision, subfolder) {
  const body = await getSnapshotBody(revision);
  if (!body) return state;

  const url = makeUrl(body);
  const filename = datedFilename(subfolder);
  try {
    const id = await downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    if (typeof URL.createObjectURL === 'function') {
      urlById.set(id, url);
    }
    const newState = {
      ...state,
      inflight: {
        downloadId: id,
        kind: 'dated',
        revision,
        filename,
        startedAt: Date.now(),
      },
    };
    await saveBackupState(newState);
    const items = await downloads.search({ id });
    if (items[0] && (items[0].state === 'complete' || items[0].state === 'interrupted')) {
      await settleDownload(items[0]);
    } else {
      await alarms.create(ALARM_WATCHDOG, { when: Date.now() + WATCHDOG_MS });
    }
    return loadBackupState();
  } catch (err) {
    await handleBackupFailure(state, classifyException(err));
    return loadBackupState();
  }
}

async function cleanupDatedFiles(state) {
  let datedFiles = [...(state.datedFiles || [])];
  datedFiles.sort((a, b) => (a.seq || 0) - (b.seq || 0));

  while (datedFiles.length > MAX_DATED_FILES) {
    const oldest = datedFiles[0];
    const items = await downloads.search({ id: oldest.downloadId });
    const item = items[0];
    let removed = false;

    if (!item || item.exists === false) {
      try {
        await downloads.erase({ id: oldest.downloadId });
      } catch {
        /* ignore */
      }
      removed = true;
    } else {
      try {
        await downloads.removeFile(oldest.downloadId);
        await downloads.erase({ id: oldest.downloadId });
        removed = true;
      } catch {
        oldest.cleanupFails = (oldest.cleanupFails || 0) + 1;
        datedFiles[0] = oldest;
        break;
      }
    }

    if (removed) {
      datedFiles = datedFiles.slice(1);
    }
  }

  const cleanupBlocked = datedFiles.some((f) => (f.cleanupFails || 0) >= 3);
  return { ...state, datedFiles, cleanupBlocked };
}

async function settleDownload(item) {
  let state = await loadBackupState();
  const meta = await loadMeta();
  const settings = await loadSettings();

  if ((state.ignoredDownloadIds || []).includes(item.id)) return;

  const isInflight = state.inflight && state.inflight.downloadId === item.id;
  const abandoned = (state.abandonedLatestIds || []).find((a) => a.id === item.id);

  if (!isInflight && !abandoned) {
    if (item.id === state.latestDownloadId) return;
    return;
  }

  if (item.state === 'complete') {
    if (isInflight && state.inflight.kind === 'latest') {
      const R = state.inflight.revision;
      const id = item.id;
      const prevLatest = state.latestDownloadId;

      state = {
        ...state,
        inflight: null,
        lastFileOkRevision: Math.max(state.lastFileOkRevision || 0, R),
        lastFileOkAt: Date.now(),
        latestDownloadId: id,
        lastError: null,
        retryCount: 0,
        retryNotBefore: null,
        paused: false,
      };

      if (meta.revision > R) {
        /* firstDirtyAt 유지 */
      } else {
        state.firstDirtyAt = null;
      }

      await saveBackupState(state);

      if (prevLatest && prevLatest !== id) {
        try {
          await downloads.erase({ id: prevLatest });
        } catch {
          /* ignore */
        }
      }

      revokeUrl(id);

      const now = Date.now();
      const shouldDate =
        !state.datedError &&
        !state.cleanupBlocked &&
        (state.lastDatedAt === null ||
          (now - state.lastDatedAt >= DATED_INTERVAL_MS &&
            state.lastDatedRevision !== R));

      if (shouldDate) {
        if (state.lastDatedAt !== null && now < state.lastDatedAt) {
          await saveBackupState({ ...state, lastDatedAt: now });
        } else {
          const sub = sanitizeSubfolder(settings.backupSubfolder);
          state = await startDatedDownload(state, R, sub);
        }
      }

      await ensureBackupAlarm();
      return;
    }

    if (isInflight && state.inflight.kind === 'dated') {
      const R = state.inflight.revision;
      state = {
        ...state,
        inflight: null,
        lastDatedAt: Date.now(),
        lastDatedRevision: R,
        datedSeq: (state.datedSeq || 0) + 1,
        datedFiles: [
          ...(state.datedFiles || []),
          {
            downloadId: item.id,
            seq: (state.datedSeq || 0) + 1,
            at: Date.now(),
            revision: R,
            cleanupFails: 0,
          },
        ],
        datedError: null,
      };
      state = await cleanupDatedFiles(state);
      await saveBackupState(state);
      revokeUrl(item.id);
      return;
    }

    if (abandoned) {
      state = {
        ...state,
        firstDirtyAt: state.firstDirtyAt ?? Date.now(),
        lastFileOkRevision: Math.min(
          state.lastFileOkRevision || 0,
          abandoned.revision
        ),
        abandonedLatestIds: state.abandonedLatestIds.filter((a) => a.id !== item.id),
      };
      await saveBackupState(state);
      await ensureBackupAlarm();
      return;
    }
  }

  if (item.state === 'interrupted') {
    const code = classifyInterrupt(item.error);

    if (isInflight && state.inflight.kind === 'latest') {
      await handleBackupFailure(state, code);
      revokeUrl(item.id);
      return;
    }

    if (isInflight && state.inflight.kind === 'dated') {
      state = {
        ...state,
        inflight: null,
        datedError: { code, at: Date.now() },
      };
      await saveBackupState(state);
      revokeUrl(item.id);
      return;
    }
  }
}

function revokeUrl(id) {
  const url = urlById.get(id);
  if (url && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
    urlById.delete(id);
  }
}

async function runBackup(trigger) {
  let state = await loadBackupState();
  const meta = await loadMeta();
  const settings = await loadSettings();
  const now = Date.now();

  if (state.wipeInProgress) return state;

  state = await reconcileInflight();
  if (state.inflight) {
    const elapsed = Date.now() - (state.inflight.startedAt || 0);
    if (elapsed <= WATCHDOG_MS) return state;
  }

  const revision = meta.revision;

  if (revision !== state.lastRingRevision) {
    const groups = await loadGroups();
    await pushBackupRing(groups, settings, revision);
    state = {
      ...state,
      lastRingRevision: revision,
      lastRingAt: now,
    };
    await saveBackupState(state);
  }

  const dirty = isDirty(meta, state);
  const isManual = trigger === 'manual';

  if (
    !isManual &&
    (!settings.autoFileBackup ||
      state.paused === 'canceled' ||
      now < (state.retryNotBefore ?? 0) ||
      !dirty)
  ) {
    return state;
  }

  if (state.inflight) return state;

  const groups = await loadGroups();
  const body = JSON.stringify(createSnapshot(groups, settings), null, 2);
  const sub = sanitizeSubfolder(settings.backupSubfolder);
  const filename = `${sub}/tabbunker-latest.json`;
  const url = makeUrl(body);

  try {
    const id = await downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'overwrite',
    });

    if (typeof URL.createObjectURL === 'function') {
      urlById.set(id, url);
    }

    state = {
      ...state,
      inflight: {
        downloadId: id,
        kind: 'latest',
        revision,
        filename,
        startedAt: Date.now(),
      },
      paused: isManual ? false : state.paused,
    };
    await saveBackupState(state);
    await alarms.create(ALARM_WATCHDOG, { when: Date.now() + WATCHDOG_MS });

    const items = await downloads.search({ id });
    if (items[0] && (items[0].state === 'complete' || items[0].state === 'interrupted')) {
      await settleDownload(items[0]);
      state = await loadBackupState();
    }

    if (isManual) {
      return waitForBackupSettle();
    }

    return state;
  } catch (err) {
    await handleBackupFailure(state, classifyException(err));
    if (isManual) return waitForBackupSettle();
    return loadBackupState();
  }
}

async function waitForBackupSettle() {
  const deadline = Date.now() + BACKUP_NOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await loadBackupState();
    if (!state.inflight) return state;
    const items = await downloads.search({ id: state.inflight.downloadId });
    const item = items[0];
    if (item && (item.state === 'complete' || item.state === 'interrupted')) {
      await settleDownload(item);
      continue;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return loadBackupState();
}

async function reconcileStartup() {
  let state = await reconcileInflight();
  const meta = await loadMeta();
  const settings = await loadSettings();
  const now = Date.now();

  if (state.wipeInProgress) {
    const groups = await loadGroups();
    if (groups.length === 0) {
      state = {
        ...state,
        wipeInProgress: false,
        lastFileOkRevision: meta.revision,
        lastRingRevision: meta.revision,
        firstDirtyAt: null,
        lastError: null,
        abandonedLatestIds: [],
      };
      await saveBackupState(state);
    }
    return;
  }

  if (meta.revision !== state.lastRingRevision) {
    const groups = await loadGroups();
    await pushBackupRing(groups, settings, meta.revision);
    state = {
      ...state,
      lastRingRevision: meta.revision,
      lastRingAt: now,
    };
    await saveBackupState(state);
  }

  if (
    isDirty(meta, state) &&
    settings.autoFileBackup &&
    state.paused !== 'canceled' &&
    now >= (state.retryNotBefore ?? 0)
  ) {
    return runBackup('startup');
  }

  if (state.retryNotBefore && now < state.retryNotBefore) {
    await alarms.create(ALARM_BACKUP, { when: state.retryNotBefore });
  }

  return state;
}

async function ensureTrashAlarm() {
  const existing = await alarms.get(ALARM_TRASH);
  if (!existing) {
    await alarms.create(ALARM_TRASH, { periodInMinutes: 1440 });
  }
}

const ready = ensureMigrated()
  .then(() => ensureTrashAlarm())
  .then(() => reconcileStartup());

// --- 접기 ---

async function commitAndClose(windowId, browserTabs) {
  const tabData = browserTabs.map((t) =>
    createTab({
      url: urlOf(t),
      title: t.title || '',
      favIconUrl: t.favIconUrl || '',
      pinned: !!t.pinned,
    })
  );

  const group = createGroup({
    title: collapseGroupTitle(tabData),
    tabs: tabData,
  });

  await mutate('collapse', async (ctx) => {
    await ctx.begin();
    await applyGroupChanges({ put: [group] });
  });

  const closingIds = new Set(browserTabs.map((t) => t.id));
  const remainingInWindow = await tabs.query({ windowId });
  const allWillClose =
    remainingInWindow.length > 0 &&
    remainingInWindow.every((t) => closingIds.has(t.id));
  if (allWillClose) {
    await ensureVaultTab(windowId, { collapsedBanner: true });
  }

  const removeResults = await Promise.allSettled(
    browserTabs.map((t) => tabs.remove(t.id))
  );

  const closedIndexes = [];
  let closed = 0;
  let remaining = 0;
  for (let i = 0; i < removeResults.length; i++) {
    if (removeResults[i].status === 'fulfilled') {
      closedIndexes.push(i);
      closed++;
    } else {
      remaining++;
    }
  }

  const meta = await loadMeta();
  await saveUndo({
    kind: 'collapse',
    at: Date.now(),
    revisionAfter: meta.revision,
    payload: {
      groupId: group.id,
      windowId,
      title: group.title,
      urls: tabData.map((t) => t.url),
      closedIndexes,
      pinned: tabData.map((t) => t.pinned),
    },
  });

  broadcast('collapsed', {
    groupId: group.id,
    count: tabData.length,
    closed,
    remaining,
    windowId,
  });

  return {
    ok: true,
    groupId: group.id,
    count: tabData.length,
    closed,
    remaining,
  };
}

async function doCollapse(hints) {
  const windowId = await resolveWindowId(hints);
  const win = await windows.get(windowId);
  if (win.incognito) {
    return { ok: false, code: 'incognito' };
  }

  const { eligible } = await getCollapseTargets(windowId);

  if (eligible.length === 0) {
    await ensureVaultTab(windowId, { collapsedBanner: true });
    return { ok: false, code: 'empty' };
  }

  await ensureVaultTab(windowId, { collapsedBanner: true });
  return commitAndClose(windowId, eligible);
}

async function doCollapseTabs(msg) {
  const rawIds = Array.isArray(msg.tabIds) ? msg.tabIds : [];
  const tabIds = [...new Set(rawIds.filter((id) => Number.isInteger(id)))];
  if (tabIds.length === 0) {
    return { ok: false, code: 'empty' };
  }

  const fetched = [];
  for (const id of tabIds) {
    try {
      fetched.push(await tabs.get(id));
    } catch {
      /* skip missing */
    }
  }
  if (fetched.length === 0) {
    return { ok: false, code: 'empty' };
  }

  const windowId = fetched[0].windowId;
  if (msg.windowId != null && msg.windowId !== windowId) {
    return { ok: false, code: 'window-mismatch' };
  }

  const win = await windows.get(windowId);
  if (win.incognito) {
    return { ok: false, code: 'incognito' };
  }

  const sameWindow = fetched.filter((t) => t.windowId === windowId);
  const eligible = [];
  for (const t of sameWindow) {
    const url = urlOf(t);
    if (isSystemUrl(url)) continue;
    eligible.push(t);
  }

  if (eligible.length === 0) {
    return { ok: false, code: 'system' };
  }

  return commitAndClose(windowId, eligible);
}

const SAVED_LINKS_TITLES = new Set(['Saved links', '저장한 링크']);

async function doSaveLink(msg) {
  const url = typeof msg.url === 'string' ? msg.url.trim() : '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, code: 'invalid' };
    }
  } catch {
    return { ok: false, code: 'invalid' };
  }

  if (msg.incognito) {
    return { ok: false, code: 'incognito' };
  }

  let title = typeof msg.title === 'string' ? msg.title : '';
  if (title.length > 200) title = title.slice(0, 200);

  let settings = await loadSettings();
  const groups = await loadGroups();
  const active = groups.filter((g) => !g.trashedAt);

  let group = settings.savedLinksGroupId
    ? active.find((g) => g.id === settings.savedLinksGroupId && !g.locked)
    : null;

  if (!group && settings.savedLinksGroupId === null) {
    const candidates = active.filter((g) => !g.locked && SAVED_LINKS_TITLES.has(g.title));
    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      group = candidates[0];
      settings = { ...settings, savedLinksGroupId: group.id };
      await saveSettings(settings);
    }
  }

  if (group) {
    const dup = (group.tabs || []).some((t) => sameLink(t.url, url));
    if (dup) {
      return { ok: true, groupId: group.id, added: false };
    }
  }

  const tab = createTab({ url, title: title || url });
  let resultGroupId;

  await mutate('saveLink', async (ctx) => {
    if (!group) {
      const fresh = await loadGroups();
      const freshActive = fresh.filter((g) => !g.trashedAt);
      const trashed = fresh.filter((g) => g.trashedAt);
      group = createGroup({ title: i18n('savedLinksGroup'), tabs: [tab] });
      settings = { ...settings, savedLinksGroupId: group.id };
      await saveSettings(settings);
      await ctx.begin();
      await applyGroupChanges({ put: [group, ...freshActive, ...trashed] });
      resultGroupId = group.id;
      return;
    }
    group = { ...group, tabs: [tab, ...(group.tabs || [])] };
    if (settings.savedLinksGroupId !== group.id) {
      await saveSettings(settings);
    }
    await ctx.begin();
    await applyGroupChanges({ put: [group] });
    resultGroupId = group.id;
  });

  return { ok: true, groupId: resultGroupId, added: true };
}

// --- 메시지 핸들러 ---

async function handleMessage(msg, sender) {
  try {
    await ready;

    switch (msg.type) {
      case 'getGroups': {
        const meta = await loadMeta();
        const groups = await loadGroups();
        return { ok: true, groups, revision: meta.revision };
      }

      case 'getBackupStatus': {
        const meta = await loadMeta();
        const state = await loadBackupState();
        const settings = await loadSettings();
        const undo = await loadUndo();
        let undoInfo = null;
        if (undo?.kind === 'collapse') {
          const g = (await loadGroups()).find((x) => x.id === undo.payload?.groupId);
          undoInfo = {
            kind: 'collapse',
            count: undo.payload?.closedIndexes?.length ?? 0,
            groupId: undo.payload?.groupId,
          };
        } else if (undo?.kind === 'import') {
          undoInfo = { kind: 'import' };
        }
        return { ok: true, revision: meta.revision, state, settings, undo: undoInfo };
      }

      case 'getCollapsePreview': {
        const windowId = await resolveWindowId({
          windowId: msg.windowId,
          senderTab: sender.tab,
        });
        const win = await windows.get(windowId);
        const { eligible, pinnedExcluded, systemExcluded } =
          await getCollapseTargets(windowId);
        return {
          ok: true,
          eligible: eligible.length,
          pinnedExcluded,
          systemExcluded,
          incognito: !!win.incognito,
        };
      }

      case 'collapse':
        return enqueue('collapse', () =>
          doCollapse({ windowId: msg.windowId, senderTab: sender.tab })
        );

      case 'collapseTabs':
        return enqueue('collapseTabs', () => doCollapseTabs(msg));

      case 'saveLink':
        return enqueue('saveLink', () => doSaveLink({ ...msg, incognito: sender.tab?.incognito }));

      case 'renameGroup':
        return enqueue('renameGroup', () =>
          mutate('renameGroup', async (ctx) => {
            const title = (msg.title || '').trim();
            if (!title) return { ok: true };
            const groups = await loadGroups();
            const g = groups.find((x) => x.id === msg.id);
            if (!g) return { ok: true };
            await ctx.begin();
            g.title = title;
            await applyGroupChanges({ put: [g] });
            return { ok: true };
          })
        );

      case 'setLocked':
        return enqueue('setLocked', () =>
          mutate('setLocked', async (ctx) => {
            const groups = await loadGroups();
            const g = groups.find((x) => x.id === msg.id);
            if (!g) return { ok: true };
            await ctx.begin();
            g.locked = !!msg.locked;
            await applyGroupChanges({ put: [g] });
            return { ok: true };
          })
        );

      case 'moveTab':
        return enqueue('moveTab', () =>
          mutate('moveTab', async (ctx) => {
            const groups = await loadGroups();
            const from = groups.find((x) => x.id === msg.fromId);
            const to = groups.find((x) => x.id === msg.toId);
            if (!from || !to) return { ok: false, code: 'stale' };
            const tab = from.tabs[msg.fromIndex];
            if (!tab || normalizeUrlCheck(tab.url) !== normalizeUrlCheck(msg.expectUrl)) {
              return { ok: false, code: 'stale' };
            }
            await ctx.begin();
            const [moved] = from.tabs.splice(msg.fromIndex, 1);
            to.tabs.push(moved);
            const put = [from, to];
            const remove = [];
            if (from.tabs.length === 0) remove.push(from.id);
            await applyGroupChanges({ put, remove });
            return { ok: true };
          })
        );

      case 'trashGroup':
      case 'untrashGroup':
        return enqueue(msg.type, () =>
          mutate(msg.type, async (ctx) => {
            const groups = await loadGroups();
            const g = groups.find((x) => x.id === msg.id);
            if (!g) return { ok: true };
            if (msg.type === 'trashGroup' && g.locked) {
              return { ok: false, code: 'locked' };
            }
            await ctx.begin();
            if (msg.type === 'trashGroup') {
              g.trashedAt = Date.now();
            } else {
              g.trashedAt = null;
            }
            await applyGroupChanges({ put: [g] });
            return { ok: true };
          })
        );

      case 'deleteGroupForever':
        return enqueue('deleteGroupForever', () =>
          mutate('deleteGroupForever', async (ctx) => {
            const groups = await loadGroups();
            const g = groups.find((x) => x.id === msg.id);
            if (!g) return { ok: true };
            if (g.locked) return { ok: false, code: 'locked' };
            await ctx.begin();
            await applyGroupChanges({ remove: [msg.id] });
            return { ok: true };
          })
        );

      case 'restoreTabs':
        return enqueue('restoreTabs', () =>
          mutate('restoreTabs', async (ctx) => {
            const groups = await loadGroups();
            const g = groups.find((x) => x.id === msg.groupId);
            if (!g) return { ok: false, code: 'stale' };
            const tab = g.tabs[msg.index];
            if (!tab || normalizeUrlCheck(tab.url) !== normalizeUrlCheck(msg.expectUrl)) {
              return { ok: false, code: 'stale' };
            }
            const windowId = msg.windowId ?? sender.tab?.windowId;
            const results = await Promise.allSettled([
              tabs.create({
                windowId,
                url: tab.url,
                pinned: !!tab.pinned,
                active: false,
              }),
            ]);
            if (results[0].status !== 'fulfilled') {
              return { ok: false, code: 'stale' };
            }
            await ctx.begin();
            g.tabs.splice(msg.index, 1);
            const settings = await loadSettings();
            const put = g.tabs.length > 0 ? [g] : [];
            const remove =
              g.tabs.length === 0 &&
              settings.removeAfterRestore !== false &&
              !g.locked
                ? [g.id]
                : [];
            if (g.tabs.length > 0) await applyGroupChanges({ put, remove });
            else if (remove.length) await applyGroupChanges({ remove });
            return { ok: true, opened: 1 };
          })
        );

      case 'restoreGroup':
        return enqueue('restoreGroup', () =>
          mutate('restoreGroup', async (ctx) => {
            const groups = await loadGroups();
            const g = groups.find((x) => x.id === msg.groupId);
            if (!g) return { ok: true, opened: 0, failed: 0 };
            const tabCount = (g.tabs || []).length;
            if (tabCount >= 30 && !msg.confirmLarge) {
              return { ok: false, code: 'confirm-required', count: tabCount };
            }
            const windowId = msg.windowId ?? sender.tab?.windowId;
            const settings = await loadSettings();
            let opened = 0;
            let failed = 0;
            const remainingTabs = [];

            for (const tab of g.tabs || []) {
              try {
                await tabs.create({
                  windowId,
                  url: tab.url,
                  pinned: !!tab.pinned,
                  active: false,
                });
                opened++;
              } catch {
                failed++;
                remainingTabs.push(tab);
              }
            }

            await ctx.begin();
            if (
              settings.removeAfterRestore !== false &&
              !g.locked &&
              failed === 0
            ) {
              await applyGroupChanges({ remove: [g.id] });
            } else if (failed > 0 || settings.removeAfterRestore === false) {
              g.tabs = remainingTabs.length > 0 ? remainingTabs : g.tabs;
              if (remainingTabs.length === 0 && opened > 0) {
                await applyGroupChanges({ remove: [g.id] });
              } else {
                await applyGroupChanges({ put: [g] });
              }
            }
            return { ok: true, opened, failed };
          })
        );

      case 'importApply':
        return enqueue('importApply', () =>
          mutate('importApply', async (ctx) => {
            const settings = await loadSettings();
            const existing = await loadGroups();
            const snapshot = createSnapshot(existing, settings);
            await ctx.begin();
            await saveUndo({
              kind: 'import',
              at: Date.now(),
              revisionAfter: ctx.revisionAfter,
              payload: { snapshot },
            });
            const result = applyImport(
              existing,
              msg.groups,
              msg.mode,
              settings.dedupeUrls
            );
            await saveAllGroups(result);
            return { ok: true, revision: ctx.revisionAfter };
          })
        );

      case 'undo':
        return enqueue('undo', () => doUndo(msg, sender));

      case 'updateSettings':
        return enqueue('updateSettings', () => doUpdateSettings(msg.patch));

      case 'deleteAllData':
        return enqueue('deleteAllData', () => doDeleteAllData());

      case 'backupNow':
        return enqueue('backupNow', async () => {
          let state = await loadBackupState();
          if (state.paused === 'canceled') {
            state = { ...state, paused: false };
            await saveBackupState(state);
          }
          const finalState = await runBackup('manual');
          if (finalState.inflight) {
            return { ok: false, code: 'timeout', state: finalState };
          }
          return { ok: true, state: finalState };
        });

      default:
        return { ok: false, code: 'error', message: 'unknown message' };
    }
  } catch (err) {
    return { ok: false, code: 'error', message: err.message };
  }
}

function normalizeUrlCheck(url) {
  try {
    const u = new URL(url);
    let href = u.href;
    if (href.endsWith('/')) href = href.slice(0, -1);
    return href.toLowerCase();
  } catch {
    return (url || '').trim().toLowerCase();
  }
}

async function doUndo(msg, sender) {
  const undo = await loadUndo();
  if (!undo) return { ok: false, code: 'none' };

  if (undo.kind === 'collapse') {
    return mutate('undoCollapse', async (ctx) => {
      const groups = await loadGroups();
      const g = groups.find((x) => x.id === undo.payload.groupId);
      if (!g || g.trashedAt) return { ok: false, code: 'stale' };
      if (g.title !== undo.payload.title) return { ok: false, code: 'stale' };
      const currentUrls = (g.tabs || []).map((t) => t.url);
      const payloadUrls = undo.payload.urls || [];
      if (
        currentUrls.length !== payloadUrls.length ||
        !currentUrls.every((u, i) => u === payloadUrls[i])
      ) {
        return { ok: false, code: 'stale' };
      }

      // 창 우선순위(DESIGN-p2 A4): 원래 창이 있으면 원래 창 → 요청 창 → 마지막 활성 창
      let targetWindowId = null;
      const windowExists = async (id) => {
        if (id == null) return false;
        try {
          await windows.get(id);
          return true;
        } catch {
          return false;
        }
      };
      if (await windowExists(undo.payload.windowId)) {
        targetWindowId = undo.payload.windowId;
      } else if (await windowExists(msg.windowId ?? sender.tab?.windowId)) {
        targetWindowId = msg.windowId ?? sender.tab?.windowId;
      } else {
        const win = await windows.getLastFocused({ windowTypes: ['normal'] });
        targetWindowId = win.id;
      }

      const closedIndexes = undo.payload.closedIndexes || [];
      const pinnedArr = undo.payload.pinned || [];
      let reopened = 0;
      let failed = 0;
      const reopenedIndexes = [];

      for (const idx of closedIndexes) {
        const tab = g.tabs[idx];
        if (!tab) continue;
        try {
          await tabs.create({
            windowId: targetWindowId,
            url: tab.url,
            pinned: !!pinnedArr[idx],
            active: false,
          });
          reopened++;
          reopenedIndexes.push(idx);
        } catch {
          failed++;
        }
      }

      if (reopened === 0 && failed > 0) {
        return { ok: false, code: 'reopen-failed' };
      }

      await ctx.begin();

      if (failed === 0) {
        await applyGroupChanges({ remove: [g.id] });
        await clearUndo();
        return { ok: true, kind: 'collapse', reopened, remaining: 0, failed: 0 };
      }

      const remainingTabs = g.tabs.filter((_, i) => !reopenedIndexes.includes(i));
      if (remainingTabs.length === 0) {
        await applyGroupChanges({ remove: [g.id] });
      } else {
        await applyGroupChanges({ put: [{ ...g, tabs: remainingTabs }] });
      }
      await clearUndo();
      return {
        ok: true,
        kind: 'collapse',
        reopened,
        remaining: remainingTabs.length,
        failed,
      };
    });
  }

  if (undo.kind === 'import') {
    return mutate('undoImport', async (ctx) => {
      if (ctx.revisionBefore !== undo.revisionAfter) {
        return { ok: false, code: 'stale' };
      }
      await ctx.begin();
      const snapshot = undo.payload.snapshot;
      const groups = (snapshot.groups || []).map((g) => createGroup(g));
      await saveAllGroups(groups);
      await clearUndo();
      return { ok: true, kind: 'import', reopened: 0, remaining: 0 };
    });
  }

  return { ok: false, code: 'none' };
}

async function doUpdateSettings(patch) {
  const current = await loadSettings();
  const merged = { ...current, ...patch };
  if (patch.backupSubfolder !== undefined) {
    merged.backupSubfolder = sanitizeSubfolder(patch.backupSubfolder);
  }

  await saveSettings(merged);

  let state = await loadBackupState();
  if (patch.autoFileBackup === true && state.paused === 'canceled') {
    state = { ...state, paused: false, lastError: null };
    await saveBackupState(state);
  }

  await ensureBackupAlarm();
  return { ok: true, settings: merged };
}

async function doDeleteAllData() {
  let state = await loadBackupState();

  if (state.inflight) {
    const ignored = [...(state.ignoredDownloadIds || []), state.inflight.downloadId];
    state = { ...state, inflight: null, ignoredDownloadIds: ignored };
  }

  state = { ...state, wipeInProgress: true };
  await saveBackupState(state);

  await mutate('deleteAllData', async (ctx) => {
    await ctx.begin();
    await saveAllGroups([]);
    await browserApi.storage.local.remove('tk_undo');
    await browserApi.storage.local.remove('tk_backup_ring');

    const defaults = {
      ...DEFAULT_SETTINGS,
      firstRunComplete: true,
    };
    await saveSettings(defaults);

    const meta = await loadMeta();
    state = await loadBackupState();
    state = {
      ...state,
      wipeInProgress: false,
      lastFileOkRevision: meta.revision,
      lastRingRevision: meta.revision,
      firstDirtyAt: null,
      lastError: null,
      abandonedLatestIds: [],
      inflight: null,
    };
    await saveBackupState(state);
    await alarms.clear(ALARM_BACKUP);
    await alarms.clear(ALARM_WATCHDOG);
    return { ok: true };
  });

  return { ok: true };
}

async function runTrashPurge() {
  const groups = await loadGroups();
  const cleaned = purgeExpiredTrash(groups);
  if (cleaned.length === groups.length) return;

  await mutate('trashPurge', async (ctx) => {
    const current = await loadGroups();
    const result = purgeExpiredTrash(current);
    if (result.length === current.length) return { ok: true };
    await ctx.begin();
    await saveAllGroups(result);
    return { ok: true };
  });
}

// --- 동기 리스너 등록 ---

browserApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, code: 'error', message: err.message }));
  return true;
});

browserApi.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  // 큐 안에서 처리해 mutate·runBackup 과 상태 쓰기가 겹치지 않게 한다
  enqueue('downloadChanged', async () => {
    await ready;
    const items = await downloads.search({ id: delta.id });
    if (items[0]) await settleDownload(items[0]);
  }).catch(console.error);
});

browserApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_BACKUP) {
    enqueue('backupAlarm', () => runBackup('alarm')).catch(console.error);
  } else if (alarm.name === ALARM_WATCHDOG) {
    enqueue('watchdog', async () => {
      await ready;
      await reconcileInflight();
      const state = await loadBackupState();
      if (state.inflight) {
        await runBackup('retry');
      }
    }).catch(console.error);
  } else if (alarm.name === ALARM_TRASH) {
    enqueue('trashPurge', () => runTrashPurge()).catch(console.error);
  }
});

action.onClicked.addListener((tab) => {
  enqueue('actionCollapse', () =>
    doCollapse({ senderTab: tab })
  ).catch(console.error);
});

browserApi.commands.onCommand.addListener((command, tab) => {
  if (command === 'collapse-tabs') {
    enqueue('commandCollapse', () =>
      doCollapse({ senderTab: tab })
    ).catch(console.error);
  }
});

if (contextMenus?.onClicked) {
  contextMenus.onClicked.addListener((info, tab) => {
    enqueue('contextMenu', async () => {
      switch (info.menuItemId) {
        case 'tb-send-tab':
          return handleOpResult(
            await doCollapseTabs({ tabIds: [tab?.id], windowId: tab?.windowId })
          );
        case 'tb-send-link':
          return handleOpResult(
            await doSaveLink({
              url: info.linkUrl,
              title: info.linkText || info.selectionText || '',
              incognito: tab?.incognito,
            })
          );
        case 'tb-send-window':
          return handleOpResult(
            await doCollapse({ senderTab: tab })
          );
        case 'tb-open-vault': {
          const wid = tab?.windowId ?? (await windows.getLastFocused({ windowTypes: ['normal'] })).id;
          await ensureVaultTab(wid, { collapsedBanner: false });
          return;
        }
        default:
          return;
      }
    }).catch(console.error);
  });
}

browserApi.runtime.onStartup.addListener(() => {
  enqueue('onStartup', async () => {
    await ready;
    await actionBadge.setBadgeText({ text: '' }).catch(() => {});
    if (isFirefox) await registerContextMenus();
    await reconcileStartup();
  }).catch(console.error);
});

browserApi.runtime.onInstalled.addListener((details) => {
  enqueue('onInstalled', async () => {
    await ready;
    await registerContextMenus();
    await reconcileStartup();
    if (details.reason === 'install') {
      const url = browserApi.runtime.getURL('vault/vault.html');
      await tabs.create({ url });
    }
  }).catch(console.error);
});
