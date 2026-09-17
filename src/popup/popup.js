// 툴바 드롭다운: 보관·목록·되돌리기
import { browserApi } from '../shared/browser.js';
import { fileBackupStatusParts } from '../shared/backup-status-ui.js';
import { displayGroupTitle, filterGroups } from '../shared/model.js';

const GROUPS_INITIAL = 15;
const GROUPS_MORE = 15;
const PICK_TABS_VISIBLE = 5;
const GROUP_TABS_VISIBLE = 3;
const GROUP_TABS_STEP = 100;
// 그룹별로 펼쳐 보여 줄 탭 수(더 보기를 누를 때마다 늘어남)
const groupTabsShown = new Map();
const LARGE_RESTORE = 30;
const DATA_FAVICON_RE =
  /^data:image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
const AVATAR_VARS = [
  '--avatar-1', '--avatar-2', '--avatar-3', '--avatar-4',
  '--avatar-5', '--avatar-6', '--avatar-7', '--avatar-8',
];

const $ = (sel) => document.querySelector(sel);

let windowId = null;
let collapseTabs = [];
let selectedIds = new Set();
let pickExpanded = false;
let pickShowAll = false;
let allGroups = [];
let groupsVisible = GROUPS_INITIAL;
let expandedGroupIds = new Set();
let renamingGroupId = null;
let pendingRestoreGroupId = null;
let backupStatus = null;
let hasFaviconPermission = false;
let faviconExtBase = '';
let localToastCount = null;

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
  return d ? d[0].toUpperCase() : '?';
}

function avatarColorVar(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  return AVATAR_VARS[Math.abs(hash) % AVATAR_VARS.length];
}

function faviconSrcFor(tab) {
  const fav = (tab.favIconUrl || '').trim();
  if (fav && DATA_FAVICON_RE.test(fav) && fav.length <= 16 * 1024) {
    return { kind: 'img', src: fav };
  }
  const url = tab.url || '';
  if (hasFaviconPermission && /^https?:/i.test(url)) {
    const size = window.devicePixelRatio > 1 ? 32 : 16;
    const src = faviconExtBase + '?pageUrl=' + encodeURIComponent(url) + '&size=' + size;
    return { kind: 'img', src };
  }
  const domain = domainFromUrl(url);
  return {
    kind: 'letter',
    letter: domainLetter(url),
    colorVar: avatarColorVar(domain || '?'),
  };
}

function appendFavicon(parent, tab) {
  const info = faviconSrcFor(tab);
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

function renderBackupStatus() {
  const el = $('#backup-status');
  if (!backupStatus?.ok) {
    el.textContent = '';
    return;
  }
  const { dotClass, text } = fileBackupStatusParts(backupStatus, t);
  el.innerHTML = `<span class="${dotClass}" aria-hidden="true"></span><span>${text}</span>`;
}

function excludeNote(pinnedExcluded, systemExcluded) {
  if (pinnedExcluded > 0 && systemExcluded > 0) {
    return t('popupExcludedBoth', [pinnedExcluded, systemExcluded]);
  }
  if (pinnedExcluded > 0) return t('popupExcludedPinned', [pinnedExcluded]);
  if (systemExcluded > 0) return t('popupExcludedSystem', [systemExcluded]);
  return '';
}

function selectedCount() {
  return collapseTabs.filter((tab) => selectedIds.has(tab.id)).length;
}

function updateSaveSection(targets) {
  const heading = $('#save-heading');
  const note = $('#exclude-note');
  const btnClose = $('#btn-save-close');
  const btnKeep = $('#btn-save-keep');
  const pickToggle = $('#btn-pick-toggle');
  const total = collapseTabs.length;
  const selected = selectedCount();
  const allSelected = selected === total && total > 0;

  if (targets?.incognito) {
    heading.textContent = t('collapseIncognito');
    note.textContent = '';
    note.classList.add('hidden');
    btnClose.disabled = true;
    btnKeep.disabled = true;
    pickToggle.classList.add('hidden');
    return;
  }

  pickToggle.classList.remove('hidden');
  if (pickExpanded && total > 0 && selected < total) {
    heading.textContent = t('popupTabsSelected', [total, selected]);
  } else {
    heading.textContent = t('popupTabsInWindow', [total]);
  }

  const excl = excludeNote(targets?.pinnedExcluded ?? 0, targets?.systemExcluded ?? 0);
  if (excl) {
    note.textContent = excl;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  const disabled = selected === 0 || total === 0;
  btnClose.disabled = disabled;
  btnKeep.disabled = disabled;

  if (allSelected || selected === total) {
    btnClose.textContent = t('popupSaveClose');
  } else {
    btnClose.textContent = t('popupSaveCloseN', [selected]);
  }

  pickToggle.textContent = pickExpanded ? t('popupFold') : t('popupPickTabs');
  pickToggle.setAttribute('aria-expanded', String(pickExpanded));
  pickToggle.setAttribute('aria-controls', 'pick-list');
}

function renderPickList() {
  const list = $('#pick-list');
  list.innerHTML = '';
  if (!pickExpanded || collapseTabs.length === 0) {
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');

  const visible = pickShowAll ? collapseTabs : collapseTabs.slice(0, PICK_TABS_VISIBLE);
  for (const tab of visible) {
    const row = document.createElement('label');
    row.className = 'pick-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedIds.has(tab.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(tab.id);
      else selectedIds.delete(tab.id);
      updateSaveSection(lastTargets);
      renderPickList();
    });
    row.appendChild(cb);
    appendFavicon(row, tab);
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;
    row.appendChild(title);
    list.appendChild(row);
  }

  if (!pickShowAll && collapseTabs.length > PICK_TABS_VISIBLE) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'link-btn tab-more';
    more.textContent = t('popupMoreTabsPick', [collapseTabs.length - PICK_TABS_VISIBLE]);
    more.addEventListener('click', () => {
      pickShowAll = true;
      renderPickList();
    });
    list.appendChild(more);
  }
}

let lastTargets = null;

async function loadCollapseTargets({ keepSelection = false } = {}) {
  // 탭이 바뀌어 다시 셀 때는 사용자가 끈 탭만 기억하고 새 탭은 선택된 상태로 둔다
  const unchecked = keepSelection
    ? new Set(collapseTabs.filter((tab) => !selectedIds.has(tab.id)).map((tab) => tab.id))
    : new Set();
  const res = await send('getCollapseTargets', { windowId });
  lastTargets = res;
  if (res?.ok) {
    collapseTabs = res.tabs || [];
    selectedIds = new Set(collapseTabs.filter((tab) => !unchecked.has(tab.id)).map((tab) => tab.id));
    if (!keepSelection) pickShowAll = false;
    updateSaveSection(res);
    renderPickList();
  }
  return res;
}

function showToast(count) {
  localToastCount = count;
  const toast = $('#toast');
  const text = $('#toast-text');
  text.textContent = tPlural('popupSavedToastOne', 'popupSavedToast', count);
  toast.classList.remove('hidden');
}

function hideToast() {
  localToastCount = null;
  $('#toast').classList.add('hidden');
}

function syncToastFromUndo() {
  const undo = backupStatus?.undo;
  if (undo?.kind === 'collapse' || undo?.kind === 'collapse-keep') {
    showToast(undo.count || 0);
  } else {
    hideToast();
  }
}

function activeGroupsSorted() {
  return allGroups
    .filter((g) => !g.trashedAt)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function showTitle(raw) {
  return displayGroupTitle(raw, {
    locale: browserApi.i18n.getUILanguage?.(),
    today: (time) => t('dateToday', [time]),
    yesterday: (time) => t('dateYesterday', [time]),
  });
}

function renderGroups() {
  const query = $('#search').value;
  const filtered = filterGroups(allGroups.filter((g) => !g.trashedAt), query);
  const sorted = filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const visible = sorted.slice(0, groupsVisible);
  const list = $('#group-list');
  list.innerHTML = '';

  // 보관한 그룹이 하나도 없으면 검색창 대신 안내를, 검색 결과가 없으면 한 줄 안내를 보인다
  const hasAny = allGroups.some((g) => !g.trashedAt);
  $('#groups-empty').classList.toggle('hidden', hasAny);
  $('#saved-label').classList.toggle('hidden', !hasAny);
  $('#search').classList.toggle('hidden', !hasAny);
  $('#groups-nomatch').classList.toggle('hidden', !hasAny || !query || sorted.length > 0);

  for (const group of visible) {
    list.appendChild(renderGroupCard(group, query));
  }

  const moreBtn = $('#btn-more-groups');
  if (sorted.length > groupsVisible) {
    moreBtn.classList.remove('hidden');
    moreBtn.textContent = t('popupShowMore');
  } else {
    moreBtn.classList.add('hidden');
  }
}

function renderGroupCard(group, query) {
  const card = document.createElement('article');
  card.className = 'group-card';
  card.setAttribute('role', 'listitem');

  const expanded = expandedGroupIds.has(group.id);
  const totalTabs = group.tabs?.length || 0;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'group-head';
  head.setAttribute('aria-expanded', String(expanded));
  const title = document.createElement('span');
  title.className = 'group-title';
  title.textContent = showTitle(group.title);
  title.title = group.title;
  const meta = document.createElement('span');
  meta.className = 'group-meta';
  meta.textContent = expanded
    ? tPlural('tabCountOne', 'tabCount', totalTabs) + (expanded ? ' ▴' : '')
    : tPlural('tabCountOne', 'tabCount', totalTabs) + ' ▾';
  head.append(title, meta);
  head.addEventListener('click', () => {
    if (expandedGroupIds.has(group.id)) expandedGroupIds.delete(group.id);
    else expandedGroupIds.add(group.id);
    renderGroups();
  });
  card.appendChild(head);

  if (expanded) {
    const tabsEl = document.createElement('div');
    tabsEl.className = 'group-tabs';
    const tabs = group.tabs || [];
    const limit = groupTabsShown.get(group.id) ?? GROUP_TABS_VISIBLE;
    const showCount = query ? tabs.length : Math.min(tabs.length, limit);
    const shown = tabs.slice(0, showCount);

    for (let i = 0; i < shown.length; i++) {
      const tab = shown[i];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tab-row';
      row.setAttribute('aria-label', tab.title || tab.url);
      appendFavicon(row, tab);
      const span = document.createElement('span');
      span.className = 'tab-title';
      span.textContent = tab.title || tab.url;
      row.appendChild(span);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        openOneTab(group, i, tab.url);
      });
      tabsEl.appendChild(row);
    }

    if (!query && tabs.length > showCount) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'link-btn tab-more';
      more.textContent = t('popupMoreTabsPick', [tabs.length - showCount]);
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        groupTabsShown.set(group.id, showCount + GROUP_TABS_STEP);
        renderGroups();
      });
      tabsEl.appendChild(more);
    }

    card.appendChild(tabsEl);

    if (renamingGroupId === group.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'rename-input';
      input.value = group.title;
      input.setAttribute('aria-label', t('rename'));
      // Enter·입력칸 벗어남은 저장, Esc는 취소. 입력칸이 사라질 때 생기는 blur 로 한 번 더 처리되지 않게 막는다
      let renameDone = false;
      input.addEventListener('keydown', async (e) => {
        if (renameDone) return;
        if (e.key === 'Enter') {
          renameDone = true;
          await finishRename(group.id, input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          renameDone = true;
          renamingGroupId = null;
          renderGroups();
        }
      });
      input.addEventListener('blur', () => {
        if (renameDone) return;
        renameDone = true;
        finishRename(group.id, input.value);
      });
      card.appendChild(input);
      // 카드가 목록에 붙은 뒤에야 커서를 넣을 수 있다
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const actions = document.createElement('div');
      actions.className = 'group-actions';

      const openAll = document.createElement('button');
      openAll.type = 'button';
      openAll.className = 'link-btn';
      openAll.textContent = t('popupOpenAll');
      openAll.addEventListener('click', (e) => {
        e.stopPropagation();
        restoreGroup(group);
      });
      actions.appendChild(openAll);

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'link-btn';
      renameBtn.textContent = t('rename');
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renamingGroupId = group.id;
        renderGroups();
      });
      actions.appendChild(renameBtn);

      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'link-btn';
      lockBtn.textContent = group.locked ? t('unlock') : t('lock');
      lockBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await send('setLocked', { id: group.id, locked: !group.locked });
        await reloadGroups();
        renderGroups();
      });
      actions.appendChild(lockBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'link-btn danger';
      delBtn.textContent = t('delete');
      delBtn.disabled = !!group.locked;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (group.locked) return;
        await send('trashGroup', { id: group.id });
        await reloadGroups();
        renderGroups();
      });
      actions.appendChild(delBtn);

      card.appendChild(actions);
    }
  }

  return card;
}

async function finishRename(groupId, title) {
  const trimmed = (title || '').trim();
  renamingGroupId = null;
  if (trimmed) {
    await send('renameGroup', { id: groupId, title: trimmed });
    await reloadGroups();
  }
  renderGroups();
}

async function openOneTab(group, index, expectUrl) {
  await send('restoreTabs', {
    groupId: group.id,
    index,
    expectUrl,
    windowId,
  });
  await reloadGroups();
  renderGroups();
}

async function restoreGroup(group) {
  const count = group.tabs?.length || 0;
  if (count >= LARGE_RESTORE) {
    pendingRestoreGroupId = group.id;
    $('#confirm-title').textContent = tPlural('restoreConfirmOne', 'restoreConfirm', count);
    $('#confirm-dialog').showModal();
    return;
  }
  await doRestoreGroup(group.id, false);
}

async function doRestoreGroup(groupId, confirmLarge) {
  const res = await send('restoreGroup', { groupId, windowId, confirmLarge });
  if (!res?.ok && res.code === 'confirm-required') return;
  await reloadGroups();
  renderGroups();
}

async function reloadGroups() {
  const res = await send('getGroups');
  if (res?.ok) allGroups = res.groups || [];
  return res;
}

async function reloadBackupStatus() {
  backupStatus = await send('getBackupStatus');
  renderBackupStatus();
  syncToastFromUndo();
}

async function doCollapse(closeTabs) {
  const tabIds = collapseTabs
    .filter((tab) => selectedIds.has(tab.id))
    .map((tab) => tab.id);
  if (tabIds.length === 0) return;

  const res = await send('collapse', { windowId, tabIds, closeTabs });
  if (!res?.ok) return;

  showToast(res.count || tabIds.length);
  await reloadGroups();
  await reloadBackupStatus();
  await loadCollapseTargets();
  groupsVisible = GROUPS_INITIAL;
  renderGroups();
}

async function doUndo() {
  const res = await send('undo', { windowId });
  if (!res?.ok) {
    hideToast();
    await reloadBackupStatus();
    return;
  }
  {
    hideToast();
    localToastCount = null;
    await reloadGroups();
    await reloadBackupStatus();
    await loadCollapseTargets();
    renderGroups();
  }
}

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = browserApi.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = browserApi.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const msg = browserApi.i18n.getMessage(el.getAttribute('data-i18n-aria'));
    if (msg) el.setAttribute('aria-label', msg);
  });
}

function setupListeners() {
  $('#btn-pick-toggle').addEventListener('click', () => {
    pickExpanded = !pickExpanded;
    if (!pickExpanded) pickShowAll = false;
    updateSaveSection(lastTargets);
    renderPickList();
  });

  $('#btn-save-close').addEventListener('click', () => doCollapse(true));
  $('#btn-save-keep').addEventListener('click', () => doCollapse(false));
  $('#btn-toast-undo').addEventListener('click', () => doUndo());
  $('#btn-notice-ok').addEventListener('click', () => dismissBackupNotice());
  $('#btn-notice-settings').addEventListener('click', async () => {
    await dismissBackupNotice();
    await browserApi.runtime.openOptionsPage();
    window.close();
  });

  $('#search').addEventListener('input', () => {
    groupsVisible = GROUPS_INITIAL;
    renderGroups();
  });

  $('#btn-more-groups').addEventListener('click', () => {
    groupsVisible += GROUPS_MORE;
    renderGroups();
  });

  $('#btn-open-vault').addEventListener('click', async () => {
    await send('openVault', { windowId });
    window.close();
  });

  $('#btn-settings').addEventListener('click', () => {
    browserApi.runtime.openOptionsPage();
    window.close();
  });

  $('#btn-confirm-ok').addEventListener('click', async () => {
    $('#confirm-dialog').close();
    if (pendingRestoreGroupId) {
      await doRestoreGroup(pendingRestoreGroupId, true);
      pendingRestoreGroupId = null;
    }
  });
  $('#btn-confirm-cancel').addEventListener('click', () => {
    pendingRestoreGroupId = null;
    $('#confirm-dialog').close();
  });

  // 드롭다운이 열린 동안 탭이 열리거나 닫히거나 로딩을 마치면 보관 대상 수를 다시 센다
  // (파이어폭스는 막 열린 탭이 로딩 중일 때 주소가 비어 제외 대상으로 잡힌다)
  let retargetTimer = null;
  const retarget = () => {
    clearTimeout(retargetTimer);
    retargetTimer = setTimeout(() => loadCollapseTargets({ keepSelection: true }), 250);
  };
  browserApi.tabs?.onCreated?.addListener(retarget);
  browserApi.tabs?.onRemoved?.addListener(retarget);
  browserApi.tabs?.onUpdated?.addListener((_id, change) => {
    if (change.url || change.status === 'complete' || change.pinned !== undefined) retarget();
  });

  browserApi.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'vaultChanged') {
      reloadGroups().then(() => renderGroups());
      reloadBackupStatus();
    }
  });
}

// 자동 파일 백업이 켜져 있으면 처음 한 번, 다운로드 폴더에 파일이 저장된다는 안내를 보인다.
// 본 여부는 백업 데이터(설정)와 섞이지 않게 별도 키에 둔다.
const BACKUP_NOTICE_KEY = 'tk_ui_backupNoticeSeen';

async function renderBackupNotice() {
  const notice = $('#backup-notice');
  const settings = backupStatus?.settings;
  const stored = await browserApi.storage.local.get(BACKUP_NOTICE_KEY);
  const show = !!settings?.autoFileBackup && !stored[BACKUP_NOTICE_KEY];
  notice.classList.toggle('hidden', !show);
  if (!show) return;
  // 파이어폭스는 다운로드 표시를 숨기는 API가 없어 저장 때 다운로드 목록이 열릴 수 있다
  const isFirefox = typeof browserApi.runtime.getBrowserInfo === 'function';
  $('#backup-notice-firefox').classList.toggle('hidden', !isFirefox);
}

async function dismissBackupNotice() {
  await browserApi.storage.local.set({ [BACKUP_NOTICE_KEY]: true });
  $('#backup-notice').classList.add('hidden');
}

async function init() {
  const manifest = browserApi.runtime.getManifest();
  hasFaviconPermission = (manifest.permissions || []).includes('favicon');
  faviconExtBase = browserApi.runtime.getURL('/_favicon/');

  applyI18n();
  setupListeners();

  const win = await browserApi.windows.getCurrent();
  windowId = win.id;

  await reloadGroups();
  await reloadBackupStatus();
  await renderBackupNotice();
  await loadCollapseTargets();
  renderGroups();
}

init();
