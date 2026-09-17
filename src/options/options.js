// 설정 페이지

import { browserApi } from '../shared/browser.js';
import { formatRelativeTime, backupErrorMessage } from '../shared/backup-status-ui.js';
import { deriveFileStatus, sanitizeSubfolder } from '../shared/model.js';
import { loadSettings } from '../shared/storage.js';
import { getStoreReviewUrl, ISSUES_URL } from '../shared/store-links.js';
import { showToast } from '../shared/ui-toast.js';

const $ = (id) => document.getElementById(id);

let backupStatus = null;
let backupInProgress = false;
let saveHintTimer = null;

function t(key, subs = []) {
  return browserApi.i18n.getMessage(key, subs.map(String)) || key;
}

async function send(type, payload = {}) {
  try {
    return await browserApi.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    return { ok: false, code: 'error', message: err?.message || String(err) };
  }
}

function applyI18n() {
  const uiLang = browserApi.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = uiLang.split('-')[0] || 'en';
  document.title = t('settingsTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

function notify(text, warn = false) {
  const el = $('toast');
  el.classList.toggle('warn', warn);
  showToast(el, text);
}

function flashSaved() {
  const el = $('save-hint');
  el.textContent = t('optionsSavedFlash');
  el.classList.add('saved');
  clearTimeout(saveHintTimer);
  saveHintTimer = setTimeout(() => {
    el.textContent = t('optionsAutoSaveHint');
    el.classList.remove('saved');
  }, 2000);
}

function setIntervalRadio(sec) {
  const val = String(sec ?? 30);
  const radio = document.querySelector(`input[name="backupIntervalSec"][value="${val}"]`);
  if (radio) radio.checked = true;
}

function renderBackupStatusDesc() {
  const el = $('backup-status-desc');
  if (!backupStatus?.ok) {
    el.textContent = t('optionsBackupRecoverHint');
    return;
  }
  const { revision, state, settings } = backupStatus;
  const status = deriveFileStatus({ revision }, state, settings);
  let dotClass = 'status-dot';
  let text = '';
  switch (status) {
    case 'off':
      dotClass += ' off';
      text = t('optionsBackupStatusOff');
      break;
    case 'paused':
      dotClass += ' failed';
      text = t('optionsBackupStatusPaused');
      break;
    case 'writing':
      dotClass += ' writing';
      text = t('optionsBackupStatusWriting');
      break;
    case 'failed':
      dotClass += ' failed';
      text = t('optionsBackupStatusFailed', [backupErrorMessage(state?.lastError?.code, t)]);
      break;
    case 'pending':
      dotClass += ' pending';
      text = state?.lastFileOkAt
        ? t('optionsBackupStatusPending', [formatRelativeTime(state.lastFileOkAt, t)])
        : t('optionsBackupStatusPendingNever');
      break;
    case 'ok':
      text = t('optionsBackupStatusOk', [formatRelativeTime(state?.lastFileOkAt, t)]);
      break;
    default:
      dotClass += ' off';
      text = t('optionsBackupStatusNever');
  }
  el.innerHTML = `<span class="${dotClass}" aria-hidden="true"></span><span>${text}</span>`;
}

function updateBackupDependentUI() {
  const on = $('autoFileBackup').checked;
  document.querySelectorAll('[data-backup-dependent]').forEach((row) => {
    row.classList.toggle('disabled', !on);
  });
  $('backupSubfolder').disabled = !on;
  document.querySelectorAll('input[name="backupIntervalSec"]').forEach((radio) => {
    radio.disabled = !on;
  });
  $('btn-backup-now').disabled = !on || backupInProgress;
}

async function refreshBackupStatus() {
  backupStatus = await send('getBackupStatus');
  renderBackupStatusDesc();
}

async function patchSettings(patch, { folderSanitize = false } = {}) {
  let folderNotice = null;
  if (folderSanitize && patch.backupSubfolder !== undefined) {
    const raw = patch.backupSubfolder;
    const sanitized = sanitizeSubfolder(raw);
    if (sanitized !== raw) {
      patch.backupSubfolder = sanitized;
      $('backupSubfolder').value = sanitized;
      folderNotice = t('backupFolderChanged', [sanitized]);
    }
  }

  const res = await send('updateSettings', { patch });
  if (res?.ok) {
    flashSaved();
    if (folderNotice) notify(folderNotice);
    if (
      patch.autoFileBackup !== undefined ||
      patch.backupSubfolder !== undefined ||
      patch.backupIntervalSec !== undefined
    ) {
      await refreshBackupStatus();
    }
    updateBackupDependentUI();
    return true;
  }
  notify(res?.message || String(res?.code || 'error'), true);
  return false;
}

function renderShortcutKeys(shortcut) {
  const container = $('shortcut-keys');
  container.replaceChildren();
  if (!shortcut) {
    const span = document.createElement('span');
    span.className = 'shortcut-none';
    span.textContent = t('optionsShortcutNone');
    container.appendChild(span);
    return;
  }
  const parts = shortcut.includes('+')
    ? shortcut.split('+').map((s) => s.trim()).filter(Boolean)
    : [...shortcut.replace(/\s/g, '')];
  for (const part of parts) {
    const kbd = document.createElement('kbd');
    kbd.className = 'keycap';
    kbd.textContent = part;
    container.appendChild(kbd);
  }
}

async function loadShortcutDisplay() {
  const isFirefox = typeof browserApi.runtime.getBrowserInfo === 'function';
  const changeBtn = $('btn-shortcut-change');
  const firefoxHint = $('shortcut-firefox-hint');
  if (isFirefox) {
    changeBtn.classList.add('hidden');
    firefoxHint.classList.remove('hidden');
  } else {
    changeBtn.classList.remove('hidden');
    firefoxHint.classList.add('hidden');
  }

  try {
    const cmds = await browserApi.commands.getAll();
    const collapse = cmds.find((c) => c.name === 'collapse-tabs');
    renderShortcutKeys(collapse?.shortcut || '');
  } catch {
    renderShortcutKeys('');
  }
}

async function openShortcutSettings() {
  if (typeof browserApi.runtime.getBrowserInfo === 'function') return;
  const url = navigator.userAgent.includes('Edg/')
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
  try {
    await browserApi.tabs.create({ url });
  } catch {
    $('btn-shortcut-change').classList.add('hidden');
    $('shortcut-fallback-hint').classList.remove('hidden');
  }
}

async function saveBackupFolder() {
  const raw = $('backupSubfolder').value.trim() || 'TabBunker';
  await patchSettings({ backupSubfolder: raw }, { folderSanitize: true });
}

function deleteAll() {
  $('confirm-dialog').showModal();
}

async function confirmDeleteAll() {
  $('confirm-dialog').close();
  const res = await send('deleteAllData');
  if (res?.ok) {
    notify(t('deleted'));
    await refreshBackupStatus();
  } else {
    notify(res?.message || String(res?.code || 'error'), true);
  }
}

function bindAutoSave() {
  $('includePinned').addEventListener('change', () => {
    patchSettings({ includePinned: $('includePinned').checked });
  });
  $('removeAfterRestore').addEventListener('change', () => {
    patchSettings({ removeAfterRestore: $('removeAfterRestore').checked });
  });
  $('dedupeUrls').addEventListener('change', () => {
    patchSettings({ dedupeUrls: $('dedupeUrls').checked });
  });
  $('autoFileBackup').addEventListener('change', async () => {
    await patchSettings({ autoFileBackup: $('autoFileBackup').checked });
  });
  document.querySelectorAll('input[name="backupIntervalSec"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      patchSettings({ backupIntervalSec: parseInt(radio.value, 10) });
    });
  });

  const folderInput = $('backupSubfolder');
  folderInput.addEventListener('blur', saveBackupFolder);
  folderInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      folderInput.blur();
    }
  });

  $('btn-backup-now').addEventListener('click', async () => {
    backupInProgress = true;
    updateBackupDependentUI();
    await send('backupNow');
    backupInProgress = false;
    await refreshBackupStatus();
    updateBackupDependentUI();
  });

  $('btn-open-vault').addEventListener('click', () => {
    send('openVault');
  });
  $('btn-shortcut-change').addEventListener('click', openShortcutSettings);
  $('btn-delete-all').addEventListener('click', deleteAll);
  $('btn-confirm-delete').addEventListener('click', confirmDeleteAll);
  $('btn-confirm-cancel').addEventListener('click', () => {
    $('confirm-dialog').close();
  });
}

async function init() {
  const settings = await loadSettings();
  applyI18n();

  $('includePinned').checked = settings.includePinned;
  $('removeAfterRestore').checked = settings.removeAfterRestore;
  $('dedupeUrls').checked = settings.dedupeUrls;
  $('autoFileBackup').checked = settings.autoFileBackup;
  $('backupSubfolder').value = settings.backupSubfolder || 'TabBunker';
  setIntervalRadio(settings.backupIntervalSec ?? 30);

  $('link-about-review').href = getStoreReviewUrl();
  $('link-about-report').href = ISSUES_URL;
  $('version-label').textContent = t('optionsVersion', [browserApi.runtime.getManifest().version]);

  bindAutoSave();
  await loadShortcutDisplay();
  await refreshBackupStatus();
  updateBackupDependentUI();
}

init();
