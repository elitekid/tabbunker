// onetab / sessionbuddy / tabbunker 파서 (순수 함수)

import { createGroup, createTab, groupsFromSnapshot, generateId } from './model.js';

/**
 * OneTab 텍스트 형식:
 *   https://example.com | Example Title
 *   https://other.com
 *   (빈 줄로 그룹 구분)
 */
export function parseOneTabText(text) {
  const lines = (text || '').split(/\r?\n/);
  const rawGroups = [];
  let currentTabs = [];

  const flush = () => {
    if (currentTabs.length === 0) return;
    rawGroups.push({ tabs: currentTabs });
    currentTabs = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const tab = parseOneTabLine(trimmed);
    if (tab) {
      currentTabs.push(tab);
    }
    // 잘못된 줄은 건너뜀
  }
  flush();

  return rawGroups.map((rg, i) =>
    createGroup({
      title: `Imported ${i + 1}`,
      tabs: rg.tabs,
      createdAt: Date.now() - (rawGroups.length - i) * 1000,
    })
  );
}

/** OneTab 한 줄 파싱: "url | title" 또는 url만 */
export function parseOneTabLine(line) {
  const pipeSep = ' | ';
  const idx = line.indexOf(pipeSep);
  let url;
  let title = '';

  if (idx === -1) {
    url = line.trim();
  } else {
    url = line.slice(0, idx).trim();
    title = line.slice(idx + pipeSep.length).trim();
  }

  if (!url || !isLikelyUrl(url)) return null;
  return createTab({ url, title });
}

function isLikelyUrl(str) {
  return /^https?:\/\//i.test(str) || /^[a-z][a-z0-9+.-]*:/i.test(str);
}

/**
 * Session Buddy JSON 형식 (공개 예시, 관대하게 처리):
 *
 * 배열 형태:
 * [
 *   {
 *     "name": "My Session",
 *     "created": 1609459200000,
 *     "windows": [
 *       { "tabs": [ { "url": "https://a.com", "title": "A" } ] }
 *     ]
 *   }
 * ]
 *
 * 또는 { "sessions": [...] } / { "collections": [...] } 래핑
 * 탭은 windows[].tabs[] 또는 flat tabs[] 에 있을 수 있음
 */
export function parseSessionBuddyJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const sessions = extractSessions(data);
  const groups = [];

  for (const session of sessions) {
    const tabs = extractTabsFromSession(session);
    if (tabs.length === 0) continue;
    groups.push(
      createGroup({
        title: session.name || session.title || session.label || 'Session Buddy Import',
        tabs,
        createdAt: session.created || session.createdAt || session.date || Date.now(),
        id: generateId(),
      })
    );
  }

  return groups;
}

function extractSessions(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['sessions', 'collections', 'savedSessions', 'data']) {
      if (Array.isArray(data[key])) return data[key];
    }
    // 단일 세션 객체
    if (data.windows || data.tabs) return [data];
  }
  return [];
}

function extractTabsFromSession(session) {
  const tabs = [];

  const addTab = (raw) => {
    const url = raw?.url || raw?.link || raw?.href || '';
    if (!url) return;
    tabs.push(
      createTab({
        url,
        title: raw.title || raw.name || '',
        favIconUrl: raw.favIconUrl || raw.favicon || raw.icon || '',
        pinned: !!raw.pinned,
      })
    );
  };

  if (Array.isArray(session.tabs)) {
    for (const t of session.tabs) addTab(t);
  }

  if (Array.isArray(session.windows)) {
    for (const win of session.windows) {
      if (Array.isArray(win.tabs)) {
        for (const t of win.tabs) addTab(t);
      }
    }
  }

  if (Array.isArray(session.groups)) {
    for (const grp of session.groups) {
      if (Array.isArray(grp.tabs)) {
        for (const t of grp.tabs) addTab(t);
      }
    }
  }

  return tabs;
}

/** TabBunker 자체 JSON 가져오기 */
export function parseTabBunkerJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return groupsFromSnapshot(data);
}

/** 형식 자동 감지 후 파싱 */
export function importAutoDetect(text) {
  return importAutoDetectWithReport(text).groups;
}

/** 형식 자동 감지 + 제외 통계 */
export function importAutoDetectWithReport(text) {
  const trimmed = (text || '').trim();
  const skipped = { badLines: 0, noUrl: 0, trashedGroups: 0 };

  if (!trimmed) {
    return { groups: [], format: 'unknown', skipped };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.version !== undefined && parsed.groups) {
        const all = parseTabBunkerJson(trimmed);
        skipped.trashedGroups = all.filter((g) => g.trashedAt).length;
        return {
          groups: all.filter((g) => !g.trashedAt),
          format: 'tabbunker',
          skipped,
        };
      }
      skipped.noUrl = countSessionBuddyNoUrl(trimmed);
      return {
        groups: parseSessionBuddyJson(trimmed),
        format: 'sessionbuddy',
        skipped,
      };
    } catch {
      return { groups: [], format: 'unknown', skipped };
    }
  }

  const { groups, badLines } = parseOneTabTextWithStats(trimmed);
  skipped.badLines = badLines;
  return { groups, format: 'onetab', skipped };
}

function countSessionBuddyNoUrl(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return 0;
  }
  const sessions = extractSessions(data);
  let count = 0;
  for (const session of sessions) {
    const addRaw = (raw) => {
      const url = raw?.url || raw?.link || raw?.href || '';
      if (!url) count++;
    };
    if (Array.isArray(session.tabs)) {
      for (const t of session.tabs) addRaw(t);
    }
    if (Array.isArray(session.windows)) {
      for (const win of session.windows) {
        if (Array.isArray(win.tabs)) {
          for (const t of win.tabs) addRaw(t);
        }
      }
    }
    if (Array.isArray(session.groups)) {
      for (const grp of session.groups) {
        if (Array.isArray(grp.tabs)) {
          for (const t of grp.tabs) addRaw(t);
        }
      }
    }
  }
  return count;
}

function parseOneTabTextWithStats(text) {
  const lines = (text || '').split(/\r?\n/);
  const rawGroups = [];
  let currentTabs = [];
  let badLines = 0;

  const flush = () => {
    if (currentTabs.length === 0) return;
    rawGroups.push({ tabs: currentTabs });
    currentTabs = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const tab = parseOneTabLine(trimmed);
    if (tab) {
      currentTabs.push(tab);
    } else {
      badLines++;
    }
  }
  flush();

  const groups = rawGroups.map((rg, i) =>
    createGroup({
      title: `Imported ${i + 1}`,
      tabs: rg.tabs,
      createdAt: Date.now() - (rawGroups.length - i) * 1000,
    })
  );
  return { groups, badLines };
}
