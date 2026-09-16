// 그룹·탭 스키마, 검증, 병합·중복 계산 (순수 함수)

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = {
  includePinned: false,
  removeAfterRestore: true,
  autoFileBackup: true,
  backupSubfolder: 'TabBunker',
  dedupeUrls: false,
  firstRunComplete: false,
};

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

/** 탭 유효성 검사 */
export function validateTab(tab) {
  return !!(tab && typeof tab.url === 'string' && tab.url.trim().length > 0);
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
    const trashed = (existingGroups || []).filter((g) => g.trashedAt);
    return [...trashed, ...incoming];
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
