// 설정 페이지

import { browserApi } from '../shared/browser.js';
import { sanitizeSubfolder } from '../shared/model.js';
import { loadSettings } from '../shared/storage.js';
import { getStoreReviewUrl, ISSUES_URL } from '../shared/store-links.js';

const $ = (id) => document.getElementById(id);

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

function setIntervalRadio(sec) {
  const val = String(sec ?? 30);
  const radio = document.querySelector(`input[name="backupIntervalSec"][value="${val}"]`);
  if (radio) radio.checked = true;
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

  $('btn-save').addEventListener('click', save);
  $('btn-delete-all').addEventListener('click', deleteAll);
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
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    const msg = browserApi.i18n.getMessage(key);
    if (msg) el.setAttribute('aria-label', msg);
  });
}

function readFormPatch() {
  const intervalEl = document.querySelector('input[name="backupIntervalSec"]:checked');
  return {
    includePinned: $('includePinned').checked,
    removeAfterRestore: $('removeAfterRestore').checked,
    dedupeUrls: $('dedupeUrls').checked,
    autoFileBackup: $('autoFileBackup').checked,
    backupSubfolder: $('backupSubfolder').value.trim() || 'TabBunker',
    backupIntervalSec: parseInt(intervalEl?.value || '30', 10),
  };
}

async function save() {
  const patch = readFormPatch();
  const rawFolder = patch.backupSubfolder;
  const sanitized = sanitizeSubfolder(rawFolder);
  let statusMsg = null;
  if (sanitized !== rawFolder) {
    patch.backupSubfolder = sanitized;
    $('backupSubfolder').value = sanitized;
    statusMsg = t('backupFolderChanged', [sanitized]);
  }

  const res = await send('updateSettings', { patch });
  if (res?.ok) {
    $('status').textContent = statusMsg || t('saved');
  } else {
    $('status').textContent = res.message || String(res.code || 'error');
  }
}

async function deleteAll() {
  if (!confirm(t('deleteAllConfirm'))) return;

  const res = await send('deleteAllData');
  if (res?.ok) {
    $('status').textContent = t('deleted');
  }
}

init();
