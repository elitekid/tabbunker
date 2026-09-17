// Vault 페이지: 그룹 목록, 검색, 가져오기/보내기, 페이지네이션

import { browserApi } from '../shared/browser.js';
import {
  fileBackupStatusParts,
  snapshotStatusParts,
  statusLineHtml,
} from '../shared/backup-status-ui.js';
import { exportByFormat } from '../shared/exporters.js';
import { importAutoDetectWithReport } from '../shared/importers.js';
import {
  computeImportImpact,
  displayGroupTitle,
  filterGroups,
  findDuplicateUrls,
} from '../shared/model.js';
import { shouldShowReviewPrompt } from '../shared/review-prompt.js';
import { loadSettings } from '../shared/storage.js';
import { getStoreReviewUrl, ISSUES_URL } from '../shared/store-links.js';
import { showToast } from '../shared/ui-toast.js';

const PAGE_SIZE = 200;
const LARGE_OPEN = 30;
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
let renamingGroupId = null;
let pendingOpenGroupId = null;

const $ = (sel) => document.querySelector(sel);

function t(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

function tPlural(oneKey, manyKey, count) {
  return t(count === 1 ? oneKey : manyKey, [count]);
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

function notify(text, warn = false) {
  const el = $('#toast');
  el.classList.toggle('warn', warn);
  showToast(el, text);
}

function renderBackupHeader() {
  const snapshotEl = $('#backup-line-snapshot');
  const fileEl = $('#backup-line-file');
  const cleanupEl = $('#backup-cleanup-failed');
  const datedEl = $('#backup-dated-failed');
  const locale = browserApi.i18n.getUILanguage?.();

  if (!backupStatus?.ok) {
    snapshotEl.innerHTML = statusLineHtml(
      'vaultSnapshotLabel',
      snapshotStatusParts(null, t, locale),
      t
    );
    fileEl.innerHTML = statusLineHtml(
      null,
      fileBackupStatusParts(null, t),
      t
    );
    cleanupEl.classList.add('hidden');
    datedEl.classList.add('hidden');
    return;
  }

  const { state } = backupStatus;
  snapshotEl.innerHTML = statusLineHtml(
    'vaultSnapshotLabel',
    snapshotStatusParts(state, t, locale),
    t
  );
  fileEl.innerHTML = statusLineHtml(
    null,
    fileBackupStatusParts(backupStatus, t),
    t
  );

  cleanupEl.classList.toggle('hidden', !state?.cleanupBlocked);
  datedEl.classList.toggle('hidden', !state?.datedError);
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
  banner.classList.toggle('hidden', !show);
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
  notify(t('staleEdit'), true);
  await reloadGroups();
  render();
}

async function handleUndoResult(res) {
  if (!res?.ok) {
    if (res.code === 'stale') {
      notify(t('undoUnavailable'), true);
    } else if (res.code === 'none') {
      collapseBanner = null;
      renderCollapseBanner();
    }
    return;
  }
  if (res.kind === 'import') {
    notify(t('undoImportDone'));
    collapseBanner = null;
    renderCollapseBanner();
  } else if (res.kind === 'collapse') {
    const remaining = res.remaining ?? 0;
    if (remaining > 0) {
      notify(t('undoPartial', [res.reopened, remaining]));
    } else {
      notify(tPlural('undoDoneOne', 'undoDone', res.reopened));
    }
    collapseBanner = null;
    renderCollapseBanner();
  } else if (res.kind === 'collapse-keep') {
    notify(t('undoKeepDone'));
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
    notify(t('undoUnavailable'), true);
    return;
  }
  if (res?.ok) {
    collapseBanner = null;
    renderCollapseBanner();
  }
  await handleUndoResult(res);
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

function openFilePicker() {
  $('#backup-restore-hint').classList.add('hidden');
  $('#file-input').click();
}

function setupEventListeners() {
  $('#search').addEventListener('input', () => {
    currentPage = 0;
    render();
  });

  $('#btn-import').addEventListener('click', openFilePicker);
  $('#btn-import-empty').addEventListener('click', openFilePicker);
  $('#btn-export').addEventListener('click', () => $('#export-dialog').showModal());
  $('#btn-settings').addEventListener('click', () => {
    browserApi.runtime.openOptionsPage();
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
      notify(t('backupTimeout'), true);
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

  $('#btn-confirm-ok').addEventListener('click', async () => {
    $('#confirm-dialog').close();
    if (pendingOpenGroupId) {
      await doOpenGroup(pendingOpenGroupId, true);
      pendingOpenGroupId = null;
    }
  });
  $('#btn-confirm-cancel').addEventListener('click', () => {
    pendingOpenGroupId = null;
    $('#confirm-dialog').close();
  });

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
    notify(t('noValidData'), true);
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

function hasActiveGroups() {
  return allGroups.some((g) => !g.trashedAt);
}

function render() {
  const query = $('#search').value.trim();
  const filtered = filterGroups(allGroups, query);
  const active = filtered.filter((g) => !g.trashedAt);
  const trashed = allGroups.filter((g) => g.trashedAt);
  const anyActive = hasActiveGroups();

  const emptyEl = $('#empty-state');
  const nomatchEl = $('#search-nomatch');
  const list = $('#group-list');
  const pag = $('#pagination');

  if (!anyActive) {
    emptyEl.classList.remove('hidden');
    nomatchEl.classList.add('hidden');
    list.innerHTML = '';
    pag.classList.add('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  if (query && active.length === 0) {
    nomatchEl.classList.remove('hidden');
    list.innerHTML = '';
    pag.classList.add('hidden');
    return;
  }

  nomatchEl.classList.add('hidden');

  flatTabItems = buildFlatItems(active);
  const totalPages = Math.max(1, Math.ceil(flatTabItems.length / PAGE_SIZE));
  if (currentPage >= totalPages) currentPage = totalPages - 1;

  const duplicates = findDuplicateUrls(allGroups);
  list.innerHTML = '';

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

  if (renamingGroupId === group.id && !isTrash) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input group-title-input';
    input.value = group.title;
    input.setAttribute('aria-label', t('rename'));
    // Enter·입력칸 벗어남은 저장, Esc는 취소. 입력칸이 사라질 때 생기는 blur 로 한 번 더 처리되지 않게 막는다
    let renameDone = false;
    input.addEventListener('keydown', async (e) => {
      if (renameDone) return;
      if (e.key === 'Enter') {
        renameDone = true;
        e.preventDefault();
        await finishRename(group.id, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        renameDone = true;
        renamingGroupId = null;
        render();
      }
    });
    input.addEventListener('blur', () => {
      if (renameDone) return;
      renameDone = true;
      finishRename(group.id, input.value);
    });
    header.appendChild(input);
    card.appendChild(header);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  } else {
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
  }

  const tabList = document.createElement('ul');
  tabList.className = 'tab-list';

  const showAll = query || expandedCardIds.has(group.id);
  const tabsToShow = group._filtered
    ? group.tabs
    : group.tabs?.slice(0, showAll ? undefined : 50);

  for (const tab of tabsToShow || []) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tab-item';
    row.draggable = !group.locked && !isTrash;
    row.dataset.tabUrl = tab.url;
    row.setAttribute('aria-label', t('openTabAria', [tab.title || tab.url]));

    if (duplicates.has(normalizeUrlLocal(tab.url))) {
      row.classList.add('duplicate');
    }

    appendFavicon(row, tab);

    const main = document.createElement('div');
    main.className = 'tab-main';
    const titleText = document.createElement('span');
    titleText.className = 'tab-title-text';
    titleText.textContent = tab.title || tab.url;
    const domain = document.createElement('span');
    domain.className = 'tab-domain';
    domain.textContent = domainFromUrl(tab.url);
    main.append(titleText, domain);
    row.appendChild(main);

    if (row.classList.contains('duplicate')) {
      const badge = document.createElement('span');
      badge.className = 'dup-badge';
      badge.textContent = t('duplicateLabel');
      row.appendChild(badge);
    }

    if (!isTrash) {
      row.addEventListener('click', () => openTab(original, tab));
      row.addEventListener('dragstart', (e) => {
        const idx = original.tabs.findIndex((tb) => tb.url === tab.url);
        e.dataTransfer.setData('text/tab-url', tab.url);
        e.dataTransfer.setData('text/group-id', group.id);
        e.dataTransfer.setData('text/tab-index', String(idx));
      });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => handleTabDrop(e, group));
    }

    li.appendChild(row);
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
    addLinkAction(actions, t('openAllCount', [totalTabs]), () => openGroup(original));
    addLinkAction(actions, t('rename'), () => {
      renamingGroupId = group.id;
      render();
    });
    addLinkAction(actions, group.locked ? t('unlock') : t('lock'), () => toggleLock(group));
    addLinkAction(actions, t('delete'), () => trashGroup(group), true);
  } else {
    addLinkAction(actions, t('recoverFromTrash'), () => untrashGroup(group));
    addLinkAction(actions, t('deleteForever'), () => deleteGroupPermanently(group), true);
  }

  card.appendChild(actions);
  return card;
}

function addLinkAction(container, label, handler, danger = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-btn' + (danger ? ' danger' : '');
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

async function openTab(group, tab) {
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

async function openGroup(group) {
  const count = group.tabs?.length || 0;
  if (count >= LARGE_OPEN) {
    pendingOpenGroupId = group.id;
    $('#confirm-title').textContent = tPlural('restoreConfirmOne', 'restoreConfirm', count);
    $('#confirm-dialog').showModal();
    return;
  }
  await doOpenGroup(group.id, false);
}

async function doOpenGroup(groupId, confirmLarge) {
  const res = await send('restoreGroup', { groupId, confirmLarge });
  if (!res?.ok) {
    if (res.code === 'stale') await handleStale();
    return;
  }
  if (res.failed > 0) {
    notify(t('restoreFailedSome', [res.failed]), true);
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

async function finishRename(groupId, title) {
  const trimmed = (title || '').trim();
  renamingGroupId = null;
  if (!trimmed) {
    render();
    return;
  }
  const group = allGroups.find((g) => g.id === groupId);
  if (group && trimmed === group.title) {
    render();
    return;
  }
  const res = await send('renameGroup', { id: groupId, title: trimmed });
  if (!res?.ok && res.code === 'stale') await handleStale();
  await reloadGroups();
  render();
}

async function trashGroup(group) {
  const res = await send('trashGroup', { id: group.id });
  if (!res?.ok) {
    if (res.code === 'locked') {
      notify(t('lockedNoDelete'), true);
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
      notify(t('lockedNoDelete'), true);
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
  renderReviewBanner();
  render();
}

init();
