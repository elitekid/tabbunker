// 그룹·탭 스키마, 검증, 병합·중복 계산 (순수 함수)

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = {
  includePinned: false,
  removeAfterRestore: true,
  autoFileBackup: true,
  backupSubfolder: 'TabBunker',
  backupIntervalSec: 30,
  dedupeUrls: false,
  firstRunComplete: false,
  savedLinksGroupId: null,
  installedAt: null,
  collapseCount: 0,
};

const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** 고유 ID 생성 (브라우저 crypto 미의존) */
export function generateId() {
  return (
    'tk-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 11)
  );
}

/** 탭 객체 생성 */
export function createTab({ url, title = '', favIconUrl = '', pinned = false }) {
  return { url, title: title || '', favIconUrl: favIconUrl || '', pinned: !!pinned };
}

/** 그룹 객체 생성 */
export function createGroup({
  title,
  tabs = [],
  createdAt = Date.now(),
  id = null,
  locked = false,
  trashedAt = null,
}) {
  return {
    id: id || generateId(),
    title: title || defaultGroupTitle(createdAt),
    createdAt,
    locked: !!locked,
    trashedAt,
    tabs: tabs.map((t) => createTab(t)),
  };
}

/** 기본 그룹 제목: 날짜시간 */
export function defaultGroupTitle(date = Date.now()) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** 접기 시 그룹 제목: 날짜시간 + 첫 탭 제목 */
export function collapseGroupTitle(tabs, date = Date.now()) {
  const base = defaultGroupTitle(date);
  const first = tabs.find((t) => t.title)?.title;
  return first ? `${base} - ${first}` : base;
}

/** 백업 하위 폴더 이름 정규화 */
export function sanitizeSubfolder(s) {
  let name = String(s ?? '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/^\.+$/, '')
    .replace(/\.+$/, '')
    .trim();
  if (!name) return 'TabBunker';
  const upper = name.toUpperCase();
  if (WIN_RESERVED.has(upper) || /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) {
    name = name + '_';
  }
  if (name.length > 64) name = name.slice(0, 64);
  return name || 'TabBunker';
}

/** 파일 백업 상태 판정 */
export function deriveFileStatus(meta, state, settings) {
  const revision = meta?.revision ?? 0;
  const lastOk = state?.lastFileOkRevision ?? 0;
  const dirty = revision > lastOk;

  if (!settings?.autoFileBackup) return 'off';
  if (state?.paused === 'canceled') return 'paused';
  if (state?.inflight) return 'writing';
  if (state?.lastError && dirty) return 'failed';
  if (dirty) return 'pending';
  if (state?.lastFileOkAt) return 'ok';
  return 'never';
}

/** 탭 유효성 검사 */
export function validateTab(tab) {
  return !!(tab && typeof tab.url === 'string' && tab.url.trim().length > 0);
}

/** 링크 저장 중복 비교 (origin·pathname·search, hash 무시, 끝 / 하나 무시) */
export function sameLink(a, b) {
  const norm = (url) => {
    const trimmed = (url || '').trim();
    if (!trimmed) return null;
    try {
      const u = new URL(trimmed);
      let path = u.pathname;
      if (path.endsWith('/') && path.length > 1) path = path.slice(0, -1);
      return `${u.origin.toLowerCase()}${path}${u.search}`;
    } catch {
      return trimmed;
    }
  };
  const na = norm(a);
  const nb = norm(b);
  if (na === null || nb === null) return (a || '') === (b || '');
  return na === nb;
}

/** URL 정규화 (중복 비교용) */
export function normalizeUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    let href = u.href;
    if (href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** 활성(비휴지통) 그룹만 반환 */
export function activeGroups(groups) {
  return (groups || []).filter((g) => !g.trashedAt);
}

/** 전체 그룹에서 중복 URL 집합 반환 */
export function findDuplicateUrls(groups) {
  const seen = new Map();
  const duplicates = new Set();
  for (const group of groups || []) {
    if (group.trashedAt) continue;
    for (const tab of group.tabs || []) {
      const key = normalizeUrl(tab.url);
      if (!key) continue;
      if (seen.has(key)) {
        duplicates.add(key);
      } else {
        seen.set(key, true);
      }
    }
  }
  return duplicates;
}

/** 그룹 내 중복 URL 제거 */
export function dedupeTabsInGroup(tabs) {
  const seen = new Set();
  const result = [];
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(tab);
  }
  return result;
}

/** 가져오기 incoming 전처리 (incoming 내부 dedupe) */
function prepareIncoming(incoming, dedupe) {
  return activeGroups(incoming).map((g) =>
    createGroup({
      ...g,
      id: generateId(),
      tabs: dedupe ? dedupeTabsInGroup(g.tabs || []) : [...(g.tabs || [])],
    })
  );
}

/** merge 모드 링크 추가 계산 */
function mergeIncomingLinks(existing, incoming, dedupe) {
  const titleMap = new Map(
    activeGroups(existing).map((g) => [g.title, g])
  );
  let groupsAdded = 0;
  let groupsMerged = 0;
  let linksAdded = 0;
  let duplicatesSkipped = 0;

  for (const group of incoming) {
    const existingGroup = titleMap.get(group.title);
    if (existingGroup) {
      groupsMerged++;
      const existingUrls = new Set(
        (existingGroup.tabs || []).map((t) => normalizeUrl(t.url))
      );
      for (const tab of group.tabs || []) {
        const key = normalizeUrl(tab.url);
        if (!key) continue;
        if (existingUrls.has(key)) {
          duplicatesSkipped++;
        } else {
          linksAdded++;
          existingUrls.add(key);
        }
      }
    } else {
      groupsAdded++;
      linksAdded += (group.tabs || []).length;
    }
  }

  return { groupsAdded, groupsMerged, linksAdded, duplicatesSkipped };
}

/** 가져오기 영향 미리보기 */
export function computeImportImpact(existing, incoming, mode, dedupe) {
  const prepared = prepareIncoming(incoming, dedupe);

  if (mode === 'replace') {
    const active = activeGroups(existing);
    const groupsTrashed = active.filter((g) => !g.locked).length;
    const lockedKept = active.filter((g) => g.locked).length;
    const { linksAdded, duplicatesSkipped } = mergeIncomingLinks([], prepared, false);
    return {
      groupsTrashed,
      lockedKept,
      groupsAdded: prepared.length,
      linksAdded: prepared.reduce((s, g) => s + (g.tabs?.length || 0), 0),
      duplicatesSkipped,
    };
  }

  return mergeIncomingLinks(existing, prepared, dedupe);
}

/** 가져오기 적용 */
export function applyImport(existing, incoming, mode, dedupe) {
  const prepared = prepareIncoming(incoming, dedupe);

  if (mode === 'merge') {
    const result = (existing || [])
      .filter((g) => !g.trashedAt)
      .map((g) => ({ ...g, tabs: [...(g.tabs || [])] }));
    const titleMap = new Map(result.map((g) => [g.title, g]));

    for (const group of prepared) {
      if (titleMap.has(group.title)) {
        const target = titleMap.get(group.title);
        const existingUrls = new Set(
          (target.tabs || []).map((t) => normalizeUrl(t.url))
        );
        for (const tab of group.tabs || []) {
          const key = normalizeUrl(tab.url);
          if (!key || existingUrls.has(key)) continue;
          existingUrls.add(key);
          target.tabs.push(tab);
        }
      } else {
        result.push(group);
        titleMap.set(group.title, group);
      }
    }

    return [...result, ...(existing || []).filter((g) => g.trashedAt)];
  }

  return mergeGroups(existing, prepared, 'replace');
}

/** 병합 미리보기 계산 */
export function computeMergePreview(existingGroups, incomingGroups) {
  const existing = activeGroups(existingGroups);
  const incoming = activeGroups(incomingGroups);

  const existingTitleSet = new Set(existing.map((g) => g.title));
  const overlapping = incoming.filter((g) => existingTitleSet.has(g.title));

  const existingUrlSet = new Set();
  for (const g of existing) {
    for (const t of g.tabs || []) {
      existingUrlSet.add(normalizeUrl(t.url));
    }
  }

  let newTabCount = 0;
  for (const g of incoming) {
    for (const t of g.tabs || []) {
      const key = normalizeUrl(t.url);
      if (key && !existingUrlSet.has(key)) {
        newTabCount++;
      }
    }
  }

  const tabCount = incoming.reduce((sum, g) => sum + (g.tabs?.length || 0), 0);

  return {
    groupCount: incoming.length,
    tabCount,
    overlappingGroupCount: overlapping.length,
    newTabCount,
    groups: incoming.map((g) => ({
      title: g.title,
      tabCount: g.tabs?.length || 0,
    })),
  };
}

/** 그룹 병합 또는 교체 */
export function mergeGroups(existingGroups, incomingGroups, mode = 'merge') {
  const incoming = activeGroups(incomingGroups).map((g) =>
    createGroup({ ...g, id: generateId() })
  );

  if (mode === 'replace') {
    const now = Date.now();
    const kept = (existingGroups || []).map((g) => {
      if (g.trashedAt) return g;
      if (g.locked) return g;
      return { ...g, trashedAt: now };
    });
    return [...kept, ...incoming];
  }

  const result = (existingGroups || [])
    .filter((g) => !g.trashedAt)
    .map((g) => ({ ...g, tabs: [...(g.tabs || [])] }));

  const titleMap = new Map(result.map((g) => [g.title, g]));

  for (const group of incoming) {
    if (titleMap.has(group.title)) {
      const target = titleMap.get(group.title);
      target.tabs.push(...group.tabs);
    } else {
      result.push(group);
      titleMap.set(group.title, group);
    }
  }

  return [...result, ...(existingGroups || []).filter((g) => g.trashedAt)];
}

/** 휴지통 만료(30일) 그룹 영구 삭제 */
export function purgeExpiredTrash(groups, now = Date.now()) {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  return (groups || []).filter((g) => {
    if (!g.trashedAt) return true;
    return now - g.trashedAt < THIRTY_DAYS;
  });
}

/** 검색 필터 (제목·URL) */
export function filterGroups(groups, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return groups || [];

  return (groups || [])
    .filter((g) => !g.trashedAt)
    .map((g) => {
      if (g.title.toLowerCase().includes(q)) return g;
      const matchedTabs = (g.tabs || []).filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.url.toLowerCase().includes(q)
      );
      if (matchedTabs.length > 0) {
        return { ...g, tabs: matchedTabs, _filtered: true };
      }
      return null;
    })
    .filter(Boolean);
}

/** TabBunker 백업 스냅샷 형식 */
export function createSnapshot(groups, settings) {
  return {
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: { ...settings },
    groups: (groups || []).map((g) => ({
      id: g.id,
      title: g.title,
      createdAt: g.createdAt,
      locked: g.locked,
      trashedAt: g.trashedAt,
      tabs: (g.tabs || []).map((t) => ({
        url: t.url,
        title: t.title,
        favIconUrl: t.favIconUrl || '',
        pinned: !!t.pinned,
      })),
    })),
  };
}

/** 스냅샷에서 그룹 배열 추출 */
export function groupsFromSnapshot(snapshot) {
  if (!snapshot) return [];
  const raw = snapshot.groups || snapshot;
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => createGroup(g));
}
