// storage.local + IndexedDB 접근, 스냅샷 링

import { browserApi } from './browser.js';
import { alarms } from './browser.js';
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  createSnapshot,
  purgeExpiredTrash,
} from './model.js';

const DB_NAME = 'tabbunker';
const DB_VERSION = 1;
const STORE_GROUPS = 'groups';

const KEYS = {
  meta: 'tk_meta',
  settings: 'tk_settings',
  backupState: 'tk_backup_state',
  undo: 'tk_undo',
  backupRing: 'tk_backup_ring',
};

const BACKUP_RING_MAX = 20;
const BACKUP_RING_MAX_BYTES = 50 * 1024 * 1024;
const OLD_ALARM_BACKUP = 'tk-backup-debounce';

export const DEFAULT_BACKUP_STATE = {
  lastRingRevision: 0,
  lastRingAt: null,
  lastFileOkRevision: 0,
  lastFileOkAt: null,
  latestDownloadId: null,
  firstDirtyAt: null,
  inflight: null,
  lastError: null,
  paused: false,
  retryCount: 0,
  retryNotBefore: null,
  lastDatedAt: null,
  lastDatedRevision: 0,
  datedSeq: 0,
  datedFiles: [],
  datedError: null,
  cleanupBlocked: false,
  abandonedLatestIds: [],
  ignoredDownloadIds: [],
  wipeInProgress: false,
};

/** IndexedDB 열기 */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS, { keyPath: 'id' });
      }
    };
  });
}

async function withDb(fn) {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** 설정 읽기 */
export async function loadSettings() {
  const data = await browserApi.storage.local.get(KEYS.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(data[KEYS.settings] || {}) };
  if (settings.installedAt == null) {
    settings.installedAt = Date.now();
    await saveSettings(settings);
  }
  return settings;
}

/** 설정 저장 */
export async function saveSettings(settings) {
  await browserApi.storage.local.set({
    [KEYS.settings]: settings,
  });
}

/** meta 읽기 */
export async function loadMeta() {
  const data = await browserApi.storage.local.get(KEYS.meta);
  return data[KEYS.meta] || { schemaVersion: SCHEMA_VERSION, revision: 1 };
}

/** meta 저장 */
export async function saveMeta(meta) {
  await browserApi.storage.local.set({ [KEYS.meta]: meta });
}

/** 백업 상태 읽기 */
export async function loadBackupState() {
  const data = await browserApi.storage.local.get(KEYS.backupState);
  return { ...DEFAULT_BACKUP_STATE, ...(data[KEYS.backupState] || {}) };
}

/** 백업 상태 저장 */
export async function saveBackupState(state) {
  await browserApi.storage.local.set({ [KEYS.backupState]: state });
}

/** undo 읽기 */
export async function loadUndo() {
  const data = await browserApi.storage.local.get(KEYS.undo);
  return data[KEYS.undo] || null;
}

/** undo 저장 */
export async function saveUndo(undo) {
  await browserApi.storage.local.set({ [KEYS.undo]: undo });
}

/** undo 삭제 */
export async function clearUndo() {
  await browserApi.storage.local.remove(KEYS.undo);
}

/** 모든 그룹 읽기 */
export async function loadGroups() {
  return withDb((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readonly');
      const store = tx.objectStore(STORE_GROUPS);
      const req = store.getAll();
      req.onsuccess = () => {
        const groups = req.result || [];
        groups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(groups);
      };
      req.onerror = () => reject(req.error);
    })
  );
}

/** 그룹 전체 저장 (교체) */
export async function saveAllGroups(groups) {
  return withDb((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readwrite');
      const store = tx.objectStore(STORE_GROUPS);
      store.clear();
      for (const g of groups) {
        store.put(g);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    })
  );
}

/** 원자적 그룹 갱신 */
export async function applyGroupChanges({ put = [], remove = [] }) {
  return withDb((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readwrite');
      const store = tx.objectStore(STORE_GROUPS);
      for (const id of remove) {
        store.delete(id);
      }
      for (const g of put) {
        store.put(g);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    })
  );
}

/** 단일 그룹 저장 */
export async function saveGroup(group) {
  return applyGroupChanges({ put: [group] });
}

/** 그룹 삭제 */
export async function deleteGroup(id) {
  return applyGroupChanges({ remove: [id] });
}

/** 휴지통 정리 후 저장 */
export async function purgeAndSave(groups) {
  const cleaned = purgeExpiredTrash(groups);
  await saveAllGroups(cleaned);
  return cleaned;
}

/** 백업 링에 스냅샷 추가 (같은 revision 중복 금지) */
export async function pushBackupRing(groups, settings, revision) {
  const snapshot = createSnapshot(groups, settings);
  const json = JSON.stringify(snapshot);
  const size = new Blob([json]).size;

  const data = await browserApi.storage.local.get(KEYS.backupRing);
  let ring = data[KEYS.backupRing] || [];

  if (ring.some((e) => e.revision === revision)) {
    return snapshot;
  }

  ring.unshift({
    revision,
    exportedAt: snapshot.exportedAt,
    version: SCHEMA_VERSION,
    data: snapshot,
    size,
  });

  if (ring.length > BACKUP_RING_MAX) {
    ring = ring.slice(0, BACKUP_RING_MAX);
  }

  let total = ring.reduce((s, e) => s + (e.size || 0), 0);
  while (total > BACKUP_RING_MAX_BYTES && ring.length > 1) {
    const removed = ring.pop();
    total -= removed.size || 0;
  }

  await browserApi.storage.local.set({ [KEYS.backupRing]: ring });
  return snapshot;
}

/** 백업 링 읽기 */
export async function loadBackupRing() {
  const data = await browserApi.storage.local.get(KEYS.backupRing);
  return data[KEYS.backupRing] || [];
}

/** 마이그레이션 (멱등) */
export async function ensureMigrated() {
  const all = await browserApi.storage.local.get(null);
  const updates = {};
  const removes = [];

  if (!all[KEYS.meta]) {
    updates[KEYS.meta] = { schemaVersion: SCHEMA_VERSION, revision: 1 };
  }

  if (!all[KEYS.backupState]) {
    const meta = updates[KEYS.meta] || all[KEYS.meta] || { revision: 1 };
    const groups = await loadGroups();
    const state = { ...DEFAULT_BACKUP_STATE };
    if (groups.length === 0) {
      state.lastFileOkRevision = meta.revision;
    }
    updates[KEYS.backupState] = state;
  }

  const settings = { ...DEFAULT_SETTINGS, ...(all[KEYS.settings] || {}) };
  let settingsChanged = false;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (settings[k] === undefined) {
      settings[k] = v;
      settingsChanged = true;
    }
  }
  if (settingsChanged || !all[KEYS.settings]) {
    updates[KEYS.settings] = settings;
  }

  const undo = all[KEYS.undo];
  if (undo && undo.version !== undefined && undo.kind === undefined) {
    updates[KEYS.undo] = {
      kind: 'import',
      at: 0,
      revisionAfter: -1,
      payload: { snapshot: undo },
    };
  }

  if (all.tk_backup_day !== undefined) removes.push('tk_backup_day');
  if (all.tk_onboarding !== undefined) removes.push('tk_onboarding');

  if (Object.keys(updates).length > 0) {
    await browserApi.storage.local.set(updates);
  }
  if (removes.length > 0) {
    await browserApi.storage.local.remove(removes);
  }

  await alarms.clear(OLD_ALARM_BACKUP);
}
