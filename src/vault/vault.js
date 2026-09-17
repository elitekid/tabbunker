// Vault 페이지: 그룹 목록, 검색, 가져오기/보내기, 페이지네이션

import { browserApi } from '../shared/browser.js';
import { exportByFormat } from '../shared/exporters.js';
import { importAutoDetectWithReport } from '../shared/importers.js';
import {
  computeImportImpact,
  deriveFileStatus,
  displayGroupTitle,
  filterGroups,
  findDuplicateUrls,
} from '../shared/model.js';
import { shouldShowReviewPrompt } from '../shared/review-prompt.js';
import { loadSettings } from '../shared/storage.js';
import { getStoreReviewUrl, ISSUES_URL } from '../shared/store-links.js';

const PAGE_SIZE = 200;
const DATA_FAVICON_RE =
  /^data:image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
const AVATAR_VARS = [
  '--avatar-1', '--avatar-2', '--avatar-3', '--avatar-4',
  '--avatar-5', '--avatar-6', '--avatar-7', '--avatar-8',
];

let hasFaviconPermission = false;
let faviconExtBase = '';

let allGroups = [];
let settings = {};
let backupStatus = null;
let pendingImportGroups = [];
let pendingImportSkipped = { badLines: 0, noUrl: 0, trashedGroups: 0 };
let flatTabItems = [];
let expandedCardIds = new Set();
let currentPage = 0;
let collapseBanner = null;
let statusMessageTimer = null;

const $ = (sel) => document.querySelector(sel);

function t(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

function tPlural(oneKey, manyKey, count) {
  return t(count === 1 ? oneKey : manyKey, [count]);
}

function formatBackupLine(text) {
  const idx = text.indexOf(':');
  if (idx === -1) return escapeHtml(text);
  const label = text.slice(0, idx + 1);
  const rest = text.slice(idx + 1);
  return `<span class="backup-line-label">${escapeHtml(label)}</span>${escapeHtml(rest)}`;
}

async function send(type, payload = {}) {
  try {
    return await browserApi.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    return { ok: false, code: 'error', message: err?.message || String(err) };
  }
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function domainLetter(url) {
  const d = domainFromUrl(url);
  if (!d) return '?';
  return d[0].toUpperCase();
}

function avatarColorVar(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  return AVATAR_VARS[Math.abs(hash) % AVATAR_VARS.length];
}

/** 파비콘 출처 결정 (단일 정본) */
export function faviconSrcFor(tab, { hasFaviconPermission: hasPerm, extBase }) {
  const fav = (tab.favIconUrl || '').trim();
  if (fav && DATA_FAVICON_RE.test(fav) && fav.length <= 16 * 1024) {
    return { kind: 'img', src: fav };
  }
  const url = tab.url || '';
  if (hasPerm && /^https?:/i.test(url)) {
    const size = window.devicePixelRatio > 1 ? 32 : 16;
    const src = extBase + '?pageUrl=' + encodeURIComponent(url) + '&size=' + size;
    return { kind: 'img', src };
  }
  const domain = domainFromUrl(url);
  return { kind: 'letter', letter: domainLetter(url), colorVar: avatarColorVar(domain || '?') };
}

function appendFavicon(parent, tab) {
  const info = faviconSrcFor(tab, {
    hasFaviconPermission,
    extBase: faviconExtBase,
  });
  if (info.kind === 'img') {
    const img = document.createElement('img');
    img.className = 'favicon';
    img.alt = '';
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'favicon letter';
      const domain = domainFromUrl(tab.url);
      span.textContent = domainLetter(tab.url);
      span.style.background = `var(${avatarColorVar(domain || '?')})`;
      img.replaceWith(span);
    }, { once: true });
    img.src = info.src;
    parent.appendChild(img);
    return;
  }
  const span = document.createElement('span');
  span.className = 'favicon letter';
  span.textContent = info.letter;
  span.style.background = `var(${info.colorVar})`;
  parent.appendChild(span);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDateTime(ts) {
  if (!ts) return '';
  try {
    const uiLang = browserApi.i18n.getUILanguage?.() || navigator.language || 'en';
    return new Date(ts).toLocaleString(uiLang, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function showStatusMessage(text) {
  const el = $('#status-message');
  if (!text) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(statusMessageTimer);
  statusMessageTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 8000);
}

function backupErrorMessage(code) {
  const map = {
    access: 'backupErrAccess',
    disk: 'backupErrDisk',
    name: 'backupErrName',
    stalled: 'backupErrStalled',
    unknown: 'backupErrUnknown',
  };
  return t(map[code] || 'backupErrUnknown');
}

function fileStatusLine(status, state, settings) {
  switch (status) {
    case 'off':
      return t('backupFileOff');
    case 'paused':
      return t('backupFilePaused');
    case 'writing':
      return t('backupFileWriting');
    case 'failed':
      return t('backupFileFailed', [backupErrorMessage(state?.lastError?.code)]);
    case 'pending':
      if (state?.lastFileOkAt) {
        return t('backupFilePending', [formatDateTime(state.lastFileOkAt)]);
      }
      return t('backupFilePendingNever');
    case 'ok':
      return t('backupFileOk', [formatDateTime(state?.lastFileOkAt)]);
    case 'never':
    default:
      return t('backupFileNever');
  }
}

function renderBackupHeader() {
  const line1 = $('#backup-line1');
  const line2 = $('#backup-line2');
  const cleanupEl = $('#backup-cleanup-failed');
  const datedEl = $('#backup-dated-failed');

  if (!backupStatus?.ok) {
    line1.textContent = t('backupRingNone');
    line2.textContent = t('backupFileNever');
    cleanupEl.classList.add('hidden');
    datedEl.classList.add('hidden');
    return;
  }

  const { revision, state, settings: st } = backupStatus;
  const meta = { revision };
  if (state?.lastRingAt) {
    line1.innerHTML = formatBackupLine(t('backupRingSaved', [formatDateTime(state.lastRingAt)]));
  } else {
    line1.innerHTML = formatBackupLine(t('backupRingNone'));
  }

  const status = deriveFileStatus(meta, state, st || settings);
  line2.innerHTML = formatBackupLine(fileStatusLine(status, state, st || settings));

  if (state?.cleanupBlocked) {
    cleanupEl.textContent = t('backupCleanupFailed');
    cleanupEl.classList.remove('hidden');
  } else {
    cleanupEl.classList.add('hidden');
  }

  if (state?.datedError) {
    datedEl.textContent = t('backupDatedFailed');
    datedEl.classList.remove('hidden');
  } else {
    datedEl.classList.add('hidden');
  }
}

async function reloadGroups() {
  const res = await send('getGroups');
  if (res?.ok) {
    allGroups = res.groups || [];
  }
  return res;
}

async function reloadBackupStatus() {
  backupStatus = await send('getBackupStatus');
  if (backupStatus?.ok && backupStatus.settings) {
    settings = backupStatus.settings;
  }
  renderBackupHeader();
  renderReviewBanner();
  syncCollapseBannerWithUndo();
  return backupStatus;
}

function isReviewBannerBlocked() {
  if (!settings.firstRunComplete) return true;
  if (!$('#onboarding').classList.contains('hidden')) return true;
  if ($('#import-dialog').open) return true;
  return false;
}

function renderReviewBanner() {
  const banner = $('#review-banner');
  if (!backupStatus?.ok) {
    banner.classList.add('hidden');
    return;
  }
  const st = backupStatus.settings || settings;
  const show =
    shouldShowReviewPrompt({
      settings: st,
      backupState: backupStatus.state,
    }) && !isReviewBannerBlocked();
  if (!show) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
}

function renderCollapseBanner() {
  const banner = $('#collapse-banner');
  const textEl = $('#collapse-banner-text');
  if (!collapseBanner) {
    banner.classList.add('hidden');
    return;
  }
  const { count, closed, remaining } = collapseBanner;
  let text = tPlural('collapseDoneOne', 'collapseDone', count);
  if (remaining > 0) {
    text = t('collapsePartial', [count, closed, remaining]);
  }
  textEl.textContent = text;
  banner.classList.remove('hidden');
}

function syncCollapseBannerWithUndo() {
  const undo = backupStatus?.undo;
  if (undo?.kind === 'collapse' || undo?.kind === 'collapse-keep') return;
  collapseBanner = null;
  renderCollapseBanner();
}

function showCollapseBanner(data) {
  collapseBanner = {
    count: data.count,
    closed: data.closed,
    remaining: data.remaining,
    groupId: data.groupId,
  };
  renderCollapseBanner();
}

async function handleStale() {
  showStatusMessage(t('staleEdit'));
  await reloadGroups();
  render();
}

async function handleUndoResult(res) {
  if (!res?.ok) {
    if (res.code === 'stale') {
      showStatusMessage(t('undoUnavailable'));
    } else if (res.code === 'none') {
      collapseBanner = null;
      renderCollapseBanner();
    }
    return;
  }
  if (res.kind === 'import') {
    showStatusMessage(t('undoImportDone'));
    collapseBanner = null;
    renderCollapseBanner();
  } else if (res.kind === 'collapse') {
    const remaining = res.remaining ?? 0;
    if (remaining > 0) {
      showStatusMessage(t('undoPartial', [res.reopened, remaining]));
    } else {
      showStatusMessage(tPlural('undoDoneOne', 'undoDone', res.reopened));
    }
    collapseBanner = null;
    renderCollapseBanner();
  } else if (res.kind === 'collapse-keep') {
    showStatusMessage(t('undoKeepDone'));
    collapseBanner = null;
    renderCollapseBanner();
  }
  await reloadGroups();
  await reloadBackupStatus();
  render();
}

async function doUndo() {
  const res = await send('undo');
  if (!res?.ok && res.code === 'stale') {
    showStatusMessage(t('undoUnavailable'));
    return;
  }
  if (res?.ok) {
    collapseBanner = null;
    renderCollapseBanner();
  }
  await handleUndoResult(res);
}

async function updateOnboarding() {
  const onboarding = $('#onboarding');
  const tips = $('#onboarding-tips');
  if (!settings.firstRunComplete) {
    onboarding.classList.remove('hidden');
    tips.classList.remove('hidden');
  } else {
    onboarding.classList.add('hidden');
    tips.classList.add('hidden');
  }

  try {
    const cmds = await browserApi.commands.getAll();
    const collapse = cmds.find((c) => c.name === 'collapse-tabs');
    const shortcutEl = $('#tip-shortcut');
    if (collapse?.shortcut) {
      shortcutEl.textContent = t('tipShortcut', [collapse.shortcut]);
    } else {
      shortcutEl.textContent = t('tipShortcutNone');
    }
  } catch {
    $('#tip-shortcut').textContent = t('tipShortcutNone');
  }
}

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.title = t('vaultTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.setAttribute('aria-label', msg);
  });
}

function setupEventListeners() {
  $('#search').addEventListener('input', () => {
    currentPage = 0;
    render();
  });

  $('#btn-import').addEventListener('click', () => {
    $('#backup-restore-hint').classList.add('hidden');
    $('#file-input').click();
  });
  $('#btn-import-existing').addEventListener('click', () => {
    $('#backup-restore-hint').classList.add('hidden');
    $('#file-input').click();
  });
  $('#btn-export').addEventListener('click', () => $('#export-dialog').showModal());
  $('#btn-settings').addEventListener('click', () => {
    browserApi.runtime.openOptionsPage();
  });

  $('#btn-dismiss-onboarding').addEventListener('click', async () => {
    const res = await send('updateSettings', { patch: { firstRunComplete: true } });
    if (res?.ok) {
      settings = res.settings || { ...settings, firstRunComplete: true };
    }
    $('#onboarding-tips').classList.add('hidden');
    $('#onboarding').classList.add('hidden');
    renderReviewBanner();
  });

  $('#link-review-report').href = ISSUES_URL;

  $('#btn-review-write').addEventListener('click', async () => {
    browserApi.tabs.create({ url: getStoreReviewUrl() });
    const res = await send('updateSettings', { patch: { reviewPrompt: 'rated' } });
    if (res?.ok) {
      settings = res.settings || { ...settings, reviewPrompt: 'rated' };
      if (backupStatus?.ok) {
        backupStatus = { ...backupStatus, settings };
      }
    }
    renderReviewBanner();
  });

  $('#btn-review-dismiss').addEventListener('click', async () => {
    const res = await send('updateSettings', { patch: { reviewPrompt: 'dismissed' } });
    if (res?.ok) {
      settings = res.settings || { ...settings, reviewPrompt: 'dismissed' };
      if (backupStatus?.ok) {
        backupStatus = { ...backupStatus, settings };
      }
    }
    renderReviewBanner();
  });


  $('#btn-backup-now').addEventListener('click', async () => {
    const res = await send('backupNow');
    await reloadBackupStatus();
    if (!res?.ok && res.code === 'timeout') {
      showStatusMessage(t('backupTimeout'));
    }
  });

  $('#btn-backup-restore').addEventListener('click', () => {
    const hint = $('#backup-restore-hint');
    hint.textContent = t('backupRestoreHint');
    hint.classList.remove('hidden');
    $('#file-input').click();
  });

  $('#btn-collapse-undo').addEventListener('click', () => doUndo());

  $('#file-input').addEventListener('change', handleFileSelect);

  $('#btn-import-merge').addEventListener('click', () => doImport('merge'));
  $('#btn-import-replace').addEventListener('click', () => doImport('replace'));
  $('#btn-import-cancel').addEventListener('click', () => {
    $('#import-dialog').close();
    renderReviewBanner();
  });

  $('#btn-export-download').addEventListener('click', handleExport);
  $('#btn-export-cancel').addEventListener('click', () => $('#export-dialog').close());

  browserApi.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'vaultChanged') {
      reloadGroups().then(() => render());
      reloadBackupStatus();
    } else if (msg.type === 'collapsed') {
      showCollapseBanner(msg);
      reloadGroups().then(() => render());
      reloadBackupStatus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reloadGroups().then(() => render());
      reloadBackupStatus();
      updateOnboarding();
    }
  });


  browserApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tk_backup_state || changes.tk_meta || changes.tk_settings) {
      reloadBackupStatus();
    }
  });

  document.addEventListener('keydown', async (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'z') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    await doUndo();
  });
}

async function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const report = importAutoDetectWithReport(text);
  pendingImportGroups = report.groups.map((g) => {
    const m = /^Imported (\d+)$/.exec(g.title || '');
    return m ? { ...g, title: t('importedGroup', [m[1]]) } : g;
  });
  pendingImportSkipped = report.skipped || { badLines: 0, noUrl: 0, trashedGroups: 0 };
  if (pendingImportGroups.length === 0) {
    alert(t('noValidData'));
    e.target.value = '';
    return;
  }
  showImportPreview();
  e.target.value = '';
}

function importExcludedCount(skipped) {
  return (skipped?.badLines || 0) + (skipped?.noUrl || 0) + (skipped?.trashedGroups || 0);
}

function showImportPreview() {
  const linkCount = pendingImportGroups.reduce(
    (sum, g) => sum + (g.tabs?.length || 0),
    0
  );
  const excluded = importExcludedCount(pendingImportSkipped);
  const dedupe = settings.dedupeUrls;

  const mergeImpact = computeImportImpact(allGroups, pendingImportGroups, 'merge', dedupe);
  const replaceImpact = computeImportImpact(allGroups, pendingImportGroups, 'replace', dedupe);

  const el = $('#import-preview');
  el.innerHTML =
    `<p>${escapeHtml(t('importCounts', [pendingImportGroups.length, linkCount, excluded]))}</p>` +
    `<p>${escapeHtml(t('importMergeImpact', [mergeImpact.groupsAdded, mergeImpact.linksAdded, mergeImpact.duplicatesSkipped]))}</p>` +
    `<p>${escapeHtml(t('importReplaceImpact', [replaceImpact.groupsTrashed, replaceImpact.lockedKept, replaceImpact.groupsAdded]))}</p>`;
  $('#import-dialog').showModal();
  renderReviewBanner();
}

async function doImport(mode) {
  const res = await send('importApply', { mode, groups: pendingImportGroups });
  if (!res?.ok) {
    if (res.code === 'stale') await handleStale();
    return;
  }
  pendingImportGroups = [];
  $('#import-dialog').close();
  renderReviewBanner();
  await reloadGroups();
  await reloadBackupStatus();
  render();
}

function handleExport() {
  const format = $('#export-format').value;
  const content = exportByFormat(format, allGroups, settings);
  const ext = format === 'json' ? 'json' : format === 'html' ? 'html' : 'txt';
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabbunker-export.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  $('#export-dialog').close();
}

function buildFlatItems(groups) {
  const items = [];
  for (const group of groups) {
    items.push({ type: 'group-header', group });
    for (const tab of group.tabs || []) {
      items.push({ type: 'tab', group, tab });
    }
  }
  return items;
}

function getOriginalGroup(groupId) {
  return allGroups.find((g) => g.id === groupId);
}

function render() {
  const query = $('#search').value;
  const filtered = filterGroups(allGroups, query);
  const active = filtered.filter((g) => !g.trashedAt);
  const trashed = allGroups.filter((g) => g.trashedAt);

  flatTabItems = buildFlatItems(active);
  const totalPages = Math.max(1, Math.ceil(flatTabItems.length / PAGE_SIZE));
  if (currentPage >= totalPages) currentPage = totalPages - 1;

  const duplicates = findDuplicateUrls(allGroups);
  const list = $('#group-list');
  list.innerHTML = '';

  if (active.length === 0 && trashed.length === 0) {
    $('#empty-state').classList.remove('hidden');
    $('#pagination').classList.add('hidden');
    return;
  }
  $('#empty-state').classList.add('hidden');

  const start = currentPage * PAGE_SIZE;
  const pageItems = flatTabItems.slice(start, start + PAGE_SIZE);
  const renderedGroups = new Set();

  for (const item of pageItems) {
    if (!renderedGroups.has(item.group.id)) {
      const card = renderGroupCard(item.group, duplicates, query);
      list.appendChild(card);
      renderedGroups.add(item.group.id);
    }
  }

  renderPagination(totalPages);

  if (trashed.length > 0) {
    const trashSection = document.createElement('section');
    trashSection.className = 'trash-section';
    trashSection.innerHTML = `<h2>${escapeHtml(t('trash'))}</h2>`;
    for (const g of trashed) {
      trashSection.appendChild(renderGroupCard(g, duplicates, query, true));
    }
    list.appendChild(trashSection);
  }
}

function renderPagination(totalPages) {
  const pag = $('#pagination');
  if (flatTabItems.length <= PAGE_SIZE) {
    pag.classList.add('hidden');
    return;
  }
  pag.classList.remove('hidden');
  pag.innerHTML = '';

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = t('prev');
  prev.disabled = currentPage === 0;
  prev.addEventListener('click', () => {
    currentPage--;
    render();
  });
  pag.appendChild(prev);

  const info = document.createElement('span');
  info.textContent = t('pageInfo', [currentPage + 1, totalPages]);
  info.setAttribute('aria-current', 'page');
  pag.appendChild(info);

  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = t('next');
  next.disabled = currentPage >= totalPages - 1;
  next.addEventListener('click', () => {
    currentPage++;
    render();
  });
  pag.appendChild(next);
}

function renderGroupCard(group, duplicates, query, isTrash = false) {
  const original = getOriginalGroup(group.id) || group;
  const totalTabs = original.tabs?.length || 0;

  const card = document.createElement('article');
  card.className = 'group-card' + (group.locked ? ' locked' : '');
  card.setAttribute('role', 'listitem');
  card.dataset.groupId = group.id;

  const header = document.createElement('div');
  header.className = 'group-header';

  const title = document.createElement('span');
  title.className = 'group-title';
  title.textContent = displayGroupTitle(group.title, {
    locale: browserApi.i18n.getUILanguage?.(),
    today: (time) => t('dateToday', [time]),
    yesterday: (time) => t('dateYesterday', [time]),
  });
  title.title = group.title;

  const meta = document.createElement('span');
  meta.className = 'group-meta';
  if (group._filtered) {
    meta.textContent = t('searchMatchCount', [group.tabs?.length || 0, totalTabs]);
  } else {
    meta.textContent = tPlural('tabCountOne', 'tabCount', totalTabs);
  }

  header.append(title, meta);
  if (group.locked) {
    const locked = document.createElement('span');
    locked.className = 'locked-label';
    locked.textContent = t('lockedLabel');
    header.appendChild(locked);
  }
  card.appendChild(header);

  const tabList = document.createElement('ul');
  tabList.className = 'tab-list';

  const showAll = query || expandedCardIds.has(group.id);
  const tabsToShow = group._filtered
    ? group.tabs
    : group.tabs?.slice(0, showAll ? undefined : 50);

  for (const tab of tabsToShow || []) {
    const li = document.createElement('li');
    li.className = 'tab-item';
    li.draggable = !group.locked && !isTrash;
    li.dataset.tabUrl = tab.url;

    if (duplicates.has(normalizeUrlLocal(tab.url))) {
      li.classList.add('duplicate');
    }

    appendFavicon(li, tab);

    const main = document.createElement('div');
    main.className = 'tab-main';
    const link = document.createElement('a');
    link.className = 'tab-title-link';
    link.href = tab.url;
    link.textContent = tab.title || tab.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const domain = document.createElement('span');
    domain.className = 'tab-domain';
    domain.textContent = domainFromUrl(tab.url);
    main.append(link, domain);

    const actions = document.createElement('div');
    actions.className = 'tab-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn';
    restoreBtn.textContent = t('restore');
    restoreBtn.setAttribute('aria-label', t('restoreTabAria', [tab.title || tab.url]));
    restoreBtn.addEventListener('click', () => restoreTab(original, tab));

    actions.appendChild(restoreBtn);
    if (li.classList.contains('duplicate')) {
      const badge = document.createElement('span');
      badge.className = 'dup-badge';
      badge.textContent = t('duplicateLabel');
      li.append(main, badge, actions);
    } else {
      li.append(main, actions);
    }

    if (!isTrash) {
      li.addEventListener('dragstart', (e) => {
        const idx = original.tabs.findIndex((tb) => tb.url === tab.url);
        e.dataTransfer.setData('text/tab-url', tab.url);
        e.dataTransfer.setData('text/group-id', group.id);
        e.dataTransfer.setData('text/tab-index', String(idx));
      });
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => handleTabDrop(e, group));
    }

    tabList.appendChild(li);
  }

  if (!query && !isTrash && totalTabs > 50 && !expandedCardIds.has(group.id)) {
    const showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'btn show-all-tabs';
    showAllBtn.textContent = t('showAllTabs', [totalTabs]);
    showAllBtn.addEventListener('click', () => {
      expandedCardIds.add(group.id);
      render();
    });
    tabList.appendChild(showAllBtn);
  }

  card.appendChild(tabList);

  const actions = document.createElement('div');
  actions.className = 'group-actions';

  if (!isTrash) {
    addActionButton(actions, t('restoreAllCount', [totalTabs]), () => restoreGroup(original), 'btn primary');
    addActionButton(actions, group.locked ? t('unlock') : t('lock'), () => toggleLock(group));
    addActionButton(actions, t('rename'), () => renameGroup(group));
    addActionButton(actions, t('delete'), () => trashGroup(group), 'btn btn-delete');
  } else {
    addActionButton(actions, t('restore'), () => untrashGroup(group));
    addActionButton(actions, t('deleteForever'), () => deleteGroupPermanently(group), 'btn danger btn-delete');
  }

  card.appendChild(actions);
  return card;
}

function addActionButton(container, label, handler, className = 'btn') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', handler);
  container.appendChild(btn);
}

function normalizeUrlLocal(url) {
  try {
    return new URL(url).href.toLowerCase();
  } catch {
    return (url || '').toLowerCase();
  }
}

async function handleTabDrop(e, targetGroup) {
  e.preventDefault();
  if (targetGroup.locked) return;
  const sourceGroupId = e.dataTransfer.getData('text/group-id');
  const tabUrl = e.dataTransfer.getData('text/tab-url');
  const fromIndex = parseInt(e.dataTransfer.getData('text/tab-index'), 10);
  if (!sourceGroupId || !tabUrl || sourceGroupId === targetGroup.id) return;
  if (Number.isNaN(fromIndex)) return;

  const res = await send('moveTab', {
    fromId: sourceGroupId,
    fromIndex,
    expectUrl: tabUrl,
    toId: targetGroup.id,
  });
  if (!res?.ok) {
    if (res.code === 'stale') await handleStale();
    return;
  }
  await reloadGroups();
  render();
}

async function restoreTab(group, tab) {
  const index = group.tabs.findIndex((tb) => tb.url === tab.url);
  if (index < 0) return;
  const res = await send('restoreTabs', {
    groupId: group.id,
    index,
    expectUrl: tab.url,
  });
  if (!res?.ok) {
    if (res.code === 'stale') await handleStale();
    return;
  }
  await reloadGroups();
  render();
}

async function restoreGroup(group) {
  let res = await send('restoreGroup', { groupId: group.id });
  if (!res?.ok && res.code === 'confirm-required') {
    if (!confirm(tPlural('restoreConfirmOne', 'restoreConfirm', res.count))) return;
    res = await send('restoreGroup', { groupId: group.id, confirmLarge: true });
  }
  if (!res?.ok) {
    if (res.code === 'stale') await handleStale();
    return;
  }
  if (res.failed > 0) {
    showStatusMessage(t('restoreFailedSome', [res.failed]));
  }
  await reloadGroups();
  render();
}

async function toggleLock(group) {
  const res = await send('setLocked', { id: group.id, locked: !group.locked });
  if (!res?.ok && res.code === 'stale') await handleStale();
  await reloadGroups();
  render();
}

async function renameGroup(group) {
  const newTitle = prompt(t('renamePrompt'), group.title);
  if (!newTitle || newTitle === group.title) return;
  const res = await send('renameGroup', { id: group.id, title: newTitle });
  if (!res?.ok && res.code === 'stale') await handleStale();
  await reloadGroups();
  render();
}

async function trashGroup(group) {
  const res = await send('trashGroup', { id: group.id });
  if (!res?.ok) {
    if (res.code === 'locked') {
      showStatusMessage(t('lockedNoDelete'));
    } else if (res.code === 'stale') {
      await handleStale();
    }
    return;
  }
  await reloadGroups();
  render();
}

async function untrashGroup(group) {
  const res = await send('untrashGroup', { id: group.id });
  if (!res?.ok && res.code === 'stale') await handleStale();
  await reloadGroups();
  render();
}

async function deleteGroupPermanently(group) {
  const res = await send('deleteGroupForever', { id: group.id });
  if (!res?.ok) {
    if (res.code === 'locked') {
      showStatusMessage(t('lockedNoDelete'));
    } else if (res.code === 'stale') {
      await handleStale();
    }
    return;
  }
  await reloadGroups();
  render();
}

async function init() {
  settings = await loadSettings();
  const manifest = browserApi.runtime.getManifest();
  hasFaviconPermission = (manifest.permissions || []).includes('favicon');
  faviconExtBase = browserApi.runtime.getURL('/_favicon/');
  applyI18n();
  setupEventListeners();
  renderBackupHeader();

  await reloadGroups();
  await reloadBackupStatus();
  await updateOnboarding();
  renderReviewBanner();
  render();
}

init();
