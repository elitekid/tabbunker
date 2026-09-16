// json / onetab / html보내기 (순수 함수)

import { activeGroups, createSnapshot, SCHEMA_VERSION } from './model.js';

/** TabBunker JSON보내기 */
export function exportTabBunkerJson(groups, settings = {}) {
  const snapshot = createSnapshot(activeGroups(groups), settings);
  return JSON.stringify(snapshot, null, 2);
}

/** OneTab 호환 텍스트보내기 */
export function exportOneTabText(groups) {
  const parts = activeGroups(groups).map((group) => {
    const lines = (group.tabs || []).map((tab) => {
      if (tab.title) {
        return `${tab.url} | ${tab.title}`;
      }
      return tab.url;
    });
    return lines.join('\n');
  });
  return parts.join('\n\n');
}

/** HTML 북마크 파일 (Netscape 형식) */
export function exportHtmlBookmarks(groups, title = 'TabBunker Export') {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- TabBunker export -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(title)}</TITLE>`,
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  for (const group of activeGroups(groups)) {
    lines.push(`    <DT><H3>${escapeHtml(group.title)}</H3>`);
    lines.push('    <DL><p>');
    for (const tab of group.tabs || []) {
      const ts = Math.floor((group.createdAt || Date.now()) / 1000);
      lines.push(
        `        <DT><A HREF="${escapeHtmlAttr(tab.url)}" ADD_DATE="${ts}">${escapeHtml(tab.title || tab.url)}</A>`
      );
    }
    lines.push('    </DL><p>');
  }

  lines.push('</DL><p>');
  return lines.join('\n');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

/**보내기 형식 목록 */
export const EXPORT_FORMATS = ['json', 'onetab', 'html'];

/** 형식별보내기 */
export function exportByFormat(format, groups, settings = {}) {
  switch (format) {
    case 'json':
      return exportTabBunkerJson(groups, settings);
    case 'onetab':
      return exportOneTabText(groups);
    case 'html':
      return exportHtmlBookmarks(groups);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}
