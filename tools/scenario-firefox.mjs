// §12 스모크 시나리오 (파이어폭스, puppeteer BiDi)
// 사용: node tools/scenario-firefox.mjs <dist/firefox 절대경로>
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
  unlinkSync, rmdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(process.env.PPTR_DIR ? join(process.env.PPTR_DIR, 'package.json') : '/tmp/tb-ff/package.json');
const puppeteer = require('puppeteer-core');
const FIREFOX = process.env.TB_FIREFOX || `${process.env.HOME}/.cache/chrome-for-testing/firefox/mac_arm-stable_155.0.1/Firefox.app/Contents/MacOS/firefox`;
const ext = process.argv[2];
if (!ext) { console.error('dist/firefox 경로 필요'); process.exit(2); }

const smokeSubfolder = `TabBunkerSmoke-${process.pid}`;
const smokeDir = join(homedir(), 'Downloads', smokeSubfolder);
const profile = mkdtempSync(join(tmpdir(), 'tb-ff-'));
const trackedIds = new Set();
const fResults = {};
const results = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function step(id, pass, detail = '') {
  const status = pass ? 'PASS' : (pass === null ? 'SKIP' : 'FAIL');
  fResults[id] = [status, detail];
  results.push([status, id, detail]);
  console.log(status + ' ' + id + (detail ? ' - ' + detail : ''));
}

const SMOKE_IDS = [
  ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`),
  'F20', 'F20b', 'F20c', 'F20d', 'F21', 'F22', 'F23', 'F24',
];

function printTable() {
  console.log('\n=== §12 단계 결과 (Firefox) ===');
  console.log('| # | 결과 | 비고 |');
  console.log('|---|---|---|');
  for (const id of SMOKE_IDS) {
    const [r, d] = fResults[id] || ['SKIP', ''];
    console.log(`| ${id} | ${r} | ${String(d).replace(/\|/g, '\\|').slice(0, 120)} |`);
  }
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Smoke HTTP</title></head><body>ok</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
    server.on('error', reject);
  });
}

async function bgMsg(type, payload = {}) {
  return vault.evaluate((t, p) => browser.runtime.sendMessage({ type: t, ...p }), type, payload);
}

async function waitTabComplete(tabId) {
  for (let i = 0; i < 40; i++) {
    const st = await vault.evaluate((id) => browser.tabs.get(id).then((t) => t.status), tabId);
    if (st === 'complete') return true;
    await sleep(300);
  }
  return false;
}

let browser;
let vault;
let f18Capture = null;
let renameCounter = 0;

async function msg(type, payload = {}) {
  return vault.evaluate((t, p) => browser.runtime.sendMessage({ type: t, ...p }), type, payload);
}

async function bgStorage() {
  return vault.evaluate(() => browser.storage.local.get(['tk_backup_state', 'tk_meta']).then(r => r));
}

async function trackDownloads() {
  const st = (await bgStorage()).tk_backup_state || {};
  if (st.latestDownloadId) trackedIds.add(st.latestDownloadId);
  for (const d of st.datedFiles || []) trackedIds.add(d.downloadId);
  const ids = await vault.evaluate((sub) =>
    browser.downloads.search({}).then(ds => ds.filter(x => x.filename && x.filename.includes(sub)).map(x => x.id)),
    smokeSubfolder);
  for (const id of ids || []) trackedIds.add(id);
}

async function waitBackupNow() {
  const res = await msg('backupNow');
  await sleep(500);
  return res;
}

async function waitDatedSettle(expectedLen, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = (await bgStorage()).tk_backup_state || {};
    if ((st.datedFiles || []).length >= expectedLen) {
      let ok = true;
      for (const d of st.datedFiles || []) {
        const item = await vault.evaluate((id) =>
          browser.downloads.search({ id }).then(x => x[0] || null), d.downloadId);
        if (!item || item.state !== 'complete' || !item.exists) { ok = false; break; }
      }
      if (ok && st.datedFiles.length === expectedLen) return st;
    }
    await sleep(400);
  }
  return (await bgStorage()).tk_backup_state || {};
}

async function f5Pattern(groupId, counter) {
  const ago = Date.now() - 61 * 60 * 1000;
  await vault.evaluate((t) =>
    browser.storage.local.get('tk_backup_state').then(async r => {
      const s = r.tk_backup_state || {};
      s.lastDatedAt = t;
      await browser.storage.local.set({ tk_backup_state: s });
    }), ago);
  const title = `smoke-dated-${counter}`;
  await msg('renameGroup', { id: groupId, title });
  const bn = await waitBackupNow();
  await trackDownloads();
  await waitDatedSettle(counter + 1, 30000);
  return { bn, title };
}

async function countExample(win) {
  return vault.evaluate((w) =>
    browser.tabs.query({ windowId: w }).then(ts =>
      ts.filter(t => /^https:\/\/example\./.test(t.url || '')).length), win);
}

async function openExampleTabs(win, n = 3) {
  const urls = ['https://example.com/', 'https://example.org/', 'https://example.net/'];
  for (let i = 0; i < n; i++) {
    await vault.evaluate((u, w) => browser.tabs.create({ url: u, windowId: w, active: false }), urls[i % urls.length], win);
  }
  await sleep(2500);
}

async function closeNonVaultTabs(win) {
  await vault.evaluate((w) =>
    browser.tabs.query({ windowId: w }).then(ts =>
      Promise.all(ts.filter(t => !(t.url || '').includes('vault.html')).map(t => browser.tabs.remove(t.id)))),
    win);
  await sleep(800);
}

async function cleanupSmoke() {
  await trackDownloads();
  for (const id of trackedIds) {
    try {
      await vault.evaluate((dlId) =>
        browser.downloads.search({ id: dlId }).then(async ds => {
          if (!ds[0]) return;
          if (ds[0].exists) await browser.downloads.removeFile(dlId);
          await browser.downloads.erase({ id: dlId });
        }), id);
    } catch { /* ignore */ }
  }
  try {
    if (existsSync(smokeDir)) {
      for (const f of readdirSync(smokeDir)) unlinkSync(join(smokeDir, f));
      rmdirSync(smokeDir);
    }
  } catch { /* ignore */ }
}

try {
  browser = await puppeteer.launch({
    browser: 'firefox', executablePath: FIREFOX, headless: true, userDataDir: profile,
    protocolTimeout: 300000,
    args: ['--remote-allow-system-access', '--width=1280', '--height=900'],
    extraPrefsFirefox: {
      'ui.systemUsesDarkTheme': 1,
      'remote.system-access-check.enabled': false,
      'xpinstall.signatures.required': false,
      'extensions.langpacks.signatures.required': false,
      'browser.download.folderList': 2,
      'browser.download.dir': join(homedir(), 'Downloads'),
      'browser.download.useDownloadDir': true,
      'browser.download.alwaysOpenPanel': false,
      'browser.download.manager.showWhenStarting': false,
    },
  });

  const extId = await browser.installExtension(ext);
  let uuid = null;
  for (let i = 0; i < 20 && !uuid; i++) {
    await sleep(500);
    const pf = join(profile, 'prefs.js');
    if (existsSync(pf)) {
      const m = /extensions\.webextensions\.uuids", "(.*?)"\)/.exec(readFileSync(pf, 'utf8'));
      if (m) {
        const map = JSON.parse(m[1].replace(/\\"/g, '"'));
        uuid = map['tabbunker@elitekid.dev'] || null;
      }
    }
  }
  if (!uuid) throw new Error('UUID 없음');

  const base = `moz-extension://${uuid}/`;
  // 설치 직후 보관함 탭은 몇 초 뒤에 열린다. 최대 10초 기다린다.
  let vaultEarly = 0;
  for (let i = 0; i < 20 && vaultEarly === 0; i++) {
    await sleep(500);
    try { vaultEarly = (await browser.pages()).filter(p => p.url().includes('/vault/vault.html')).length; } catch { /* retry */ }
  }

  vault = await browser.newPage();
  await vault.goto(base + 'vault/vault.html', { waitUntil: 'load', timeout: 8000 }).catch(() => {});
  await sleep(1500);
  // BiDi 의 browser.pages() 는 확장이 연 탭을 보여주지 않는다(09-14 실측). 확장 API 로 센다: 내가 연 1개를 뺀다.
  try {
    const vaultTabs = await vault.evaluate(async () => (await browser.tabs.query({})).filter(t => (t.url || '').includes('/vault/vault.html')).length);
    if (vaultTabs > 0) vaultEarly = Math.max(vaultEarly, vaultTabs - 1);
  } catch { /* keep BiDi count */ }

  const win = await vault.evaluate(async () => (await browser.windows.getCurrent()).id);
  await msg('updateSettings', { patch: { autoFileBackup: true, firstRunComplete: true, backupSubfolder: smokeSubfolder } });
  await openExampleTabs(win, 3);

  const preview = await msg('getCollapsePreview', { windowId: win });
  const exCount = await countExample(win);
  f18Capture = { vaultTabs: vaultEarly, eligible: preview?.eligible, exampleTabs: exCount };

  // F1
  const res1 = await msg('collapse', { windowId: win });
  await sleep(1500);
  const st1 = await msg('getBackupStatus');
  const meta1 = (await bgStorage()).tk_meta || {};
  const ex1 = await countExample(win);
  const vaultCnt1 = await vault.evaluate((w) =>
    browser.tabs.query({ windowId: w }).then(ts => ts.filter(t => (t.url || '').includes('vault.html')).length), win);
  step('F1',
    res1?.ok && res1.closed === 3 && res1.remaining === 0 &&
    vaultCnt1 >= 1 && ex1 === 0 &&
    meta1.revision > (st1.state?.lastFileOkRevision ?? 0) &&
    st1.undo?.kind === 'collapse' && st1.undo?.count === 3,
    `closed=${res1?.closed}`);

  const gid3 = res1?.groupId;

  // F2
  const res2 = await msg('undo');
  await sleep(2000);
  const ex2 = await countExample(win);
  const g2 = await msg('getGroups').then(r => r.groups || []);
  step('F2', res2?.ok && res2.reopened === 3 && ex2 === 3 && g2.length === 0, `reopened=${res2?.reopened}`);

  // F3
  await closeNonVaultTabs(win);
  await openExampleTabs(win, 3);
  const res3c = await msg('collapse', { windowId: win });
  await sleep(1000);
  const gid3b = res3c?.groupId;
  const bn3 = await waitBackupNow();
  await trackDownloads();
  await waitDatedSettle(1);
  const st3 = (await bgStorage()).tk_backup_state || {};
  const meta3 = (await bgStorage()).tk_meta || {};
  const latest3 = st3.latestDownloadId
    ? await vault.evaluate(id => browser.downloads.search({ id }).then(x => x[0] || null), st3.latestDownloadId) : null;
  let body3 = null;
  if (latest3?.filename && existsSync(latest3.filename)) body3 = JSON.parse(readFileSync(latest3.filename, 'utf8'));
  step('F3',
    bn3?.ok && latest3?.state === 'complete' && latest3?.exists &&
    latest3.filename?.endsWith('/tabbunker-latest.json') &&
    body3?.version === 1 && body3?.groups?.length === 1 &&
    meta3.revision === st3.lastFileOkRevision && st3.datedFiles?.length === 1,
    `dated=${st3.datedFiles?.length}`);
  const firstDatedId = st3.datedFiles?.[0]?.downloadId;

  // F4
  const title4 = 'smoke-renamed-A';
  await msg('renameGroup', { id: gid3b, title: title4 });
  const bn4 = await waitBackupNow();
  await trackDownloads();
  const st4 = (await bgStorage()).tk_backup_state || {};
  const item4 = st4.latestDownloadId
    ? await vault.evaluate(id => browser.downloads.search({ id }).then(x => x[0] || null), st4.latestDownloadId) : null;
  const dir4 = existsSync(smokeDir) ? readdirSync(smokeDir).filter(f => f.endsWith('.json')) : [];
  const body4 = item4?.filename && existsSync(item4.filename) ? JSON.parse(readFileSync(item4.filename, 'utf8')) : null;
  step('F4',
    bn4?.ok && dir4.filter(f => f.startsWith('tabbunker-latest')).length === 1 &&
    !dir4.some(f => f.includes(' (1)')) && body4?.groups?.[0]?.title === title4 &&
    st4.datedFiles?.length === 1,
    `files=${dir4.length}`);

  // F5
  renameCounter = 1;
  const f5 = await f5Pattern(gid3b, renameCounter);
  const st5 = (await bgStorage()).tk_backup_state || {};
  step('F5', f5.bn?.ok && st5.datedFiles?.length === 2, `dated=${st5.datedFiles?.length}`);

  // F6
  let f6pass = false;
  let f6detail = '';
  for (let n = 2; n <= 31; n++) {
    renameCounter = n;
    await f5Pattern(gid3b, renameCounter);
    if (n === 31) {
      const st6 = (await bgStorage()).tk_backup_state || {};
      const firstId = firstDatedId;
      const stillTracked = (st6.datedFiles||[]).some(f => f.downloadId === firstId);
      const firstItem = firstId
        ? await vault.evaluate(id => browser.downloads.search({ id }).then(x => x[0] || null), firstId) : null;
      const fsMissing = !firstItem?.filename || !existsSync(firstItem.filename);
      const latestOnly = existsSync(smokeDir) ? readdirSync(smokeDir).filter(f => f.startsWith('tabbunker-latest')).length : 0;
      f6pass = st6.datedFiles?.length === 30 && !stillTracked && (!firstItem || !firstItem.exists) && fsMissing &&
        latestOnly === 1 && !st6.cleanupBlocked;
      f6detail = `dated=${st6.datedFiles?.length} firstGone=${!firstItem || !firstItem.exists} fsMissing=${fsMissing}`;
    }
  }
  step('F6', f6pass, f6detail);

  // F7 — puppeteer 재기동 시 프로필·확장 상태 재사용 불가
  step('F7', null, '파이어폭스: 동일 프로필 재기동 경로 없음(SKIP)');

  // F8
  const tabs35 = Array.from({ length: 35 }, (_, i) => ({ url: `https://example.com/p${i}`, title: `P${i}` }));
  const big = { id: 'g-big', title: 'Big35', tabs: tabs35, locked: false };
  await msg('importApply', { mode: 'replace', groups: [big] });
  await closeNonVaultTabs(win);
  const gidBig = await msg('getGroups').then(r => (r.groups || []).find(g => g.title === 'Big35')?.id);
  const r8a = await msg('restoreGroup', { groupId: gidBig, windowId: win });
  const r8b = await msg('restoreGroup', { groupId: gidBig, confirmLarge: true, windowId: win });
  await sleep(3000);
  const ex8 = await countExample(win);
  const g8 = await msg('getGroups').then(r => r.groups || []);
  step('F8',
    r8a?.ok === false && r8a?.code === 'confirm-required' && r8a?.count === 35 &&
    r8b?.ok && ex8 === 35 && !g8.some(g => g.title === 'Big35' && !g.trashedAt),
    `confirm=${r8a?.code} opened=${ex8}`);

  // F9
  const rep9 = await vault.evaluate(async () => {
    const m = await import('/shared/importers.js');
    return m.importAutoDetectWithReport('https://a.com/ | A\nnot a url\n\nhttps://b.com/ | B');
  });
  step('F9',
    rep9?.groups?.length === 2 && rep9?.skipped?.badLines === 1,
    JSON.stringify({ groups: rep9?.groups?.length, bad: rep9?.skipped?.badLines }));

  // F10
  await closeNonVaultTabs(win);
  await openExampleTabs(win, 3);
  await msg('collapse', { windowId: win });
  await sleep(1000);
  const revB = ((await bgStorage()).tk_meta || {}).revision;
  const activePre = await msg('getGroups').then(r => (r.groups || []).filter(g => !g.trashedAt).length);
  const trashPre = await msg('getGroups').then(r => (r.groups || []).filter(g => g.trashedAt).length);
  await msg('importApply', {
    mode: 'replace',
    groups: [
      { id: 'ia', title: 'IA', tabs: [{ url: 'https://a.com/', title: 'A' }] },
      { id: 'ib', title: 'IB', tabs: [{ url: 'https://b.com/', title: 'B' }] },
    ],
  });
  const activeA = await msg('getGroups').then(r => (r.groups || []).filter(g => !g.trashedAt).length);
  const trashA = await msg('getGroups').then(r => (r.groups || []).filter(g => g.trashedAt).length);
  const u10 = await msg('undo');
  const activeB = await msg('getGroups').then(r => (r.groups || []).filter(g => !g.trashedAt).length);
  const trashB = await msg('getGroups').then(r => (r.groups || []).filter(g => g.trashedAt).length);
  const revA = ((await bgStorage()).tk_meta || {}).revision;
  step('F10', activeA === 2 && trashA === trashPre + activePre && u10?.ok && activeB === activePre && trashB === trashPre && revA > revB,
    `active ${activeA}->${activeB}`);

  // F11
  const gid11 = await msg('getGroups').then(r => (r.groups || []).find(g => !g.trashedAt)?.id);
  await msg('setLocked', { id: gid11, locked: true });
  const tr11 = await msg('trashGroup', { id: gid11 });
  step('F11', tr11?.ok === false && tr11?.code === 'locked', JSON.stringify(tr11));
  await msg('setLocked', { id: gid11, locked: false });

  // F12 — 크롬만
  step('F12', null, '크롬 전용(SKIP)');

  // F13
  await vault.evaluate(() =>
    browser.storage.local.get('tk_backup_state').then(async r => {
      const s = r.tk_backup_state || {};
      s.paused = 'canceled';
      s.lastError = { code: 'canceled' };
      await browser.storage.local.set({ tk_backup_state: s });
    }));
  await vault.reload({ waitUntil: 'load', timeout: 8000 }).catch(() => {});
  await sleep(1500);
  const hdr13 = await vault.evaluate(() => document.getElementById('backup-line2')?.textContent || '');
  const bn13 = await waitBackupNow();
  const st13 = (await bgStorage()).tk_backup_state || {};
  const lat13 = st13.latestDownloadId
    ? await vault.evaluate(id => browser.downloads.search({ id }).then(x => x[0] || null), st13.latestDownloadId) : null;
  step('F13', /paused|일시|중지/i.test(hdr13) && bn13?.ok && st13.paused === false && lat13?.state === 'complete',
    `paused=${st13.paused}`);

  // F14
  const st14b = (await bgStorage()).tk_backup_state || {};
  const lat14 = st14b.latestDownloadId;
  const item14 = lat14 ? await vault.evaluate(id => browser.downloads.search({ id }).then(x => x[0] || null), lat14) : null;
  const bytes14 = item14?.filename && existsSync(item14.filename) ? readFileSync(item14.filename) : null;
  const okRev14 = st14b.lastFileOkRevision;
  await msg('deleteAllData');
  await sleep(40000);
  const g14 = await msg('getGroups').then(r => r.groups || []);
  const st14a = (await bgStorage()).tk_backup_state || {};
  const bytes14b = item14?.filename && existsSync(item14.filename) ? readFileSync(item14.filename) : null;
  const meta14 = (await bgStorage()).tk_meta || {};
  step('F14',
    g14.length === 0 && st14a.latestDownloadId === lat14 &&
    bytes14 && bytes14b && Buffer.compare(bytes14, bytes14b) === 0 &&
    meta14.revision === st14a.lastFileOkRevision,
    `groups=${g14.length}`);
  // 전체 삭제로 설정이 기본값(TabBunker 폴더)으로 돌아가므로 스모크 폴더를 다시 지정
  await msg('updateSettings', { patch: { firstRunComplete: true, backupSubfolder: smokeSubfolder } });

  // F15
  // 파이어폭스는 확장이 data: 주소 탭을 열 수 없으므로(Illegal URL) 한글은 그룹 이름으로 넣는다
  await closeNonVaultTabs(win);
  await openExampleTabs(win, 1);
  await sleep(1500);
  const c15 = await msg('collapse', { windowId: win });
  await sleep(1000);
  if (c15?.groupId) await msg('renameGroup', { id: c15.groupId, title: '한국어 테스트' });
  const bn15 = await waitBackupNow();
  await trackDownloads();
  const st15 = (await bgStorage()).tk_backup_state || {};
  const it15 = st15.latestDownloadId
    ? await vault.evaluate(id => browser.downloads.search({ id }).then(x => x[0] || null), st15.latestDownloadId) : null;
  const body15 = it15?.filename && existsSync(it15.filename) ? readFileSync(it15.filename, 'utf8') : '';
  step('F15', bn15?.ok && body15.includes('한국어 테스트'), `found=${body15.includes('한국어 테스트')}`);

  // F16
  const c16a = await vault.evaluate(sub =>
    browser.downloads.search({}).then(d => d.filter(x => x.filename && x.filename.includes(sub)).length), smokeSubfolder);
  await sleep(90000);
  const c16b = await vault.evaluate(sub =>
    browser.downloads.search({}).then(d => d.filter(x => x.filename && x.filename.includes(sub)).length), smokeSubfolder);
  step('F16', c16a === c16b, `${c16a}->${c16b}`);

  // F17
  await closeNonVaultTabs(win);
  const gs17 = await msg('getGroups').then(r => r.groups || []);
  for (const g of gs17) {
    if (g.trashedAt) await msg('deleteGroupForever', { id: g.id });
    else await msg('trashGroup', { id: g.id });
  }
  await openExampleTabs(win, 3);
  const c17 = await msg('collapse', { windowId: win });
  await sleep(1000);
  const gid17 = c17?.groupId;
  await msg('restoreGroup', { groupId: gid17 });
  await sleep(2500);
  const ex17 = await countExample(win);
  const g17 = await msg('getGroups').then(r => r.groups || []);
  const prev17 = await vault.evaluate(async () => {
    const m = await import('/shared/importers.js');
    const mm = await import('/shared/model.js');
    const g = m.parseOneTabText('https://a.com/ | A\nhttps://b.com/ | B\n\nhttps://c.com/ | C');
    const cur = (await browser.runtime.sendMessage({ type: 'getGroups' })).groups;
    return { groups: g.length, links: g.reduce((s, x) => s + (x.tabs?.length || 0), 0) };
  });
  step('F17', c17?.ok && ex17 === 3 && g17.filter(g => !g.trashedAt).length === 0 && prev17?.groups === 2 && prev17?.links === 3,
    `preview=${prev17?.groups}/${prev17?.links}`);

  // F18
  step('F18',
    f18Capture && f18Capture.vaultTabs >= 1 && f18Capture.eligible === f18Capture.exampleTabs,
    `vault=${f18Capture?.vaultTabs} eligible=${f18Capture?.eligible}/${f18Capture?.exampleTabs}`);

  // F19
  await closeNonVaultTabs(win);
  await openExampleTabs(win, 3);
  await msg('collapse', { windowId: win });
  await sleep(1000);
  await vault.reload({ waitUntil: 'load', timeout: 8000 }).catch(() => {});
  await sleep(1500);
  await vault.evaluate(() => {
    const el = document.getElementById('search');
    el.value = 'example.org';
    el.dispatchEvent(new Event('input'));
  });
  await sleep(500);
  const ui19 = await vault.evaluate(() => {
    const card = document.querySelector('.group-card');
    const meta = card?.querySelector('.group-meta')?.textContent || '';
    const btn = [...(card?.querySelectorAll('button') || [])].find(b => /restore all|모두 복원/i.test(b.textContent))?.textContent || '';
    return { meta, btn };
  });
  step('F19', /3/.test(ui19?.btn) && /1/.test(ui19?.meta) && /3/.test(ui19?.meta), JSON.stringify(ui19));

  await vault.evaluate(() => {
    const el = document.getElementById('search');
    el.value = '';
    el.dispatchEvent(new Event('input'));
  });

  const { server: httpSrv, url: httpUrl } = await startHttpServer();

  // F20
  await closeNonVaultTabs(win);
  const tabIdA = await vault.evaluate((u, w) => browser.tabs.create({ url: u, windowId: w, active: false }).then((t) => t.id), httpUrl, win);
  const tabIdB = await vault.evaluate((u, w) => browser.tabs.create({ url: u, windowId: w, active: false }).then((t) => t.id), httpUrl, win);
  await waitTabComplete(tabIdA);
  await waitTabComplete(tabIdB);
  const r20 = await bgMsg('collapseTabs', { tabIds: [tabIdA] });
  await sleep(1000);
  const ex20a = await vault.evaluate((w, id) => browser.tabs.query({ windowId: w }).then((ts) => ts.some((t) => t.id === id)), win, tabIdA);
  const ex20b = await vault.evaluate((w, id) => browser.tabs.query({ windowId: w }).then((ts) => ts.some((t) => t.id === id)), win, tabIdB);
  const g20 = await msg('getGroups').then((r) => (r.groups || []).find((g) => !g.trashedAt));
  const u20 = await bgMsg('undo');
  await sleep(1500);
  const gid20 = r20?.groupId;
  const g20gone = gid20 ? await msg('getGroups').then((r) => !(r.groups || []).some((g) => g.id === gid20 && !g.trashedAt)) : false;
  const vaultTab = await vault.evaluate((w) => browser.tabs.query({ windowId: w }).then((ts) => ts.find((t) => (t.url || '').includes('vault.html'))?.id || 0), win);
  const r20sys = vaultTab ? await bgMsg('collapseTabs', { tabIds: [vaultTab] }) : { code: 'missing' };
  const r20empty = await bgMsg('collapseTabs', { tabIds: [999999] });
  step('F20',
    r20?.ok && r20.count === 1 && r20.closed === 1 && !ex20a && ex20b &&
    g20?.tabs?.length === 1 && u20?.ok && u20.reopened === 1 && g20gone &&
    r20sys?.code === 'system' && r20empty?.code === 'empty',
    `collapse=${JSON.stringify(r20)} g20gone=${g20gone}`);

  // F20b
  const win20b = await vault.evaluate((u) => browser.windows.create({ url: u }).then((w) => w.id), httpUrl);
  await sleep(2000);
  const tab20b = await vault.evaluate((w) => browser.tabs.query({ windowId: w }).then((ts) => ts[0]?.id), win20b);
  const r20b = await bgMsg('collapseTabs', { tabIds: [tab20b] });
  await sleep(1500);
  const w20bOk = await vault.evaluate((w) => browser.windows.get(w).then(() => true).catch(() => false), win20b);
  const v20b = await vault.evaluate((w) => browser.tabs.query({ windowId: w }).then((ts) => ts.find((t) => (t.url || '').includes('vault.html'))?.url || ''), win20b);
  const g20bCount = await msg('getGroups').then((r) => (r.groups || []).reduce((n, g) => n + (g.tabs?.length || 0), 0));
  step('F20b', r20b?.ok && r20b.closed === 1 && w20bOk && v20b.includes('collapsed=1') && g20bCount >= 1,
    `vault=${v20b.includes('collapsed=1')}`);
  await vault.evaluate((w) => browser.windows.remove(w).catch(() => {}), win20b);

  // F20c
  await msg('updateSettings', { patch: { includePinned: false } });
  await closeNonVaultTabs(win);
  const pinTab = await vault.evaluate((u, w) => browser.tabs.create({ url: u, windowId: w, active: false }).then((t) => t.id), httpUrl, win);
  await waitTabComplete(pinTab);
  await vault.evaluate((id) => browser.tabs.update(id, { pinned: true }), pinTab);
  const r20c = await bgMsg('collapseTabs', { tabIds: [pinTab, pinTab, 999999] });
  await sleep(1000);
  const groups20c = await msg('getGroups').then((r) => r.groups || []);
  const g20c = groups20c.find((x) => x.id === r20c?.groupId);
  const pinnedInGroup = g20c?.tabs?.[0]?.pinned;
  const diag20c = JSON.stringify({ r: r20c, found: !!g20c, tab: g20c?.tabs?.[0] ? { pinned: g20c.tabs[0].pinned, url: String(g20c.tabs[0].url).slice(0, 40) } : null, ids: groups20c.map((x) => x.id).slice(0, 5) });
  const u20c = await bgMsg('undo');
  await sleep(1500);
  const reopenedPinned = await vault.evaluate((w) =>
    browser.tabs.query({ windowId: w, pinned: true }).then((ts) => ts.length > 0), win);
  step('F20c', r20c?.count === 1 && pinnedInGroup === true && u20c?.reopened === 1 && reopenedPinned === true,
    `pinned=${pinnedInGroup} reopenedPinned=${reopenedPinned} diag=${diag20c}`);

  step('F20d', null, '헤드리스에서 tabs.create 실패를 안정적으로 강제하기 어려움');

  // F21
  const sl1 = await bgMsg('saveLink', { url: 'https://example.com/a', title: 'A' });
  const sl2 = await bgMsg('saveLink', { url: 'https://example.com/a', title: 'A' });
  const gid21 = sl1?.groupId;
  await msg('renameGroup', { id: gid21, title: 'renamed-links' });
  const sl3 = await bgMsg('saveLink', { url: 'https://example.com/b', title: 'B' });
  const g21 = await msg('getGroups').then((r) => (r.groups || []).find((g) => g.id === gid21));
  const inv21a = await bgMsg('saveLink', { url: 'ftp://x' });
  const inv21b = await bgMsg('saveLink', { url: 'mailto:a@b' });
  const st21 = await msg('getBackupStatus');
  step('F21',
    sl1?.added === true && sl2?.added === false && g21?.tabs?.length === 2 &&
    g21?.id === gid21 && inv21a?.code === 'invalid' && inv21b?.code === 'invalid' &&
    st21?.settings?.savedLinksGroupId === gid21,
    `tabs=${g21?.tabs?.length}`);

  // F22
  const tabItems22 = await vault.evaluate(() => document.querySelectorAll('.tab-item').length);
  const favOk = await vault.evaluate(() =>
    [...document.querySelectorAll('.tab-item')].every((li) => {
      const fav = li.querySelector('.favicon');
      if (!fav) return false;
      if (fav.tagName === 'IMG') return (fav.src || '').startsWith('data:');
      return fav.classList.contains('letter');
    }));
  step('F22', tabItems22 >= 1 && favOk, `tabs=${tabItems22} favOk=${favOk}`);

  // F23 (전 구간 다크 프리퍼런스)
  const darkBg = await vault.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await vault.evaluate(() => document.getElementById('import-dialog').showModal());
  const dialogBg = await vault.evaluate(() => getComputedStyle(document.getElementById('import-dialog')).backgroundColor);
  await vault.evaluate(() => document.getElementById('import-dialog').close());
  const optPage = await browser.newPage();
  await optPage.goto(base + 'options/options.html', { waitUntil: 'load', timeout: 8000 }).catch(() => {});
  await sleep(800);
  const optBg = await optPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await optPage.close();
  step('F23', darkBg === 'rgb(15, 23, 42)' && dialogBg === 'rgb(30, 41, 59)' && optBg === 'rgb(15, 23, 42)',
    `dark=${darkBg} dialog=${dialogBg} opt=${optBg}`);

  httpSrv.close();

  const manifest24 = await vault.evaluate(() => browser.runtime.getManifest());
  const perms24 = manifest24.permissions || [];
  const csp24 = manifest24.content_security_policy?.extension_pages || '';
  step('F24',
    perms24.includes('contextMenus') && !perms24.includes('favicon') && csp24.includes("img-src 'self' data:"),
    `perms=${perms24.join(',')}`);

} catch (e) {
  console.log('ERROR', e.stack || e.message);
  for (const id of SMOKE_IDS) {
    if (!fResults[id]) step(id, false, e.message);
  }
} finally {
  // 정리는 확장 페이지가 살아 있을 때(브라우저 닫기 전) 해야 한다
  try { await cleanupSmoke(); } catch (e) { console.log('cleanup error', e.message); }
  try { await browser?.close(); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  printTable();
  const failCount = Object.values(fResults).filter(r => r[0] === 'FAIL').length;
  const left = existsSync(smokeDir) ? readdirSync(smokeDir) : [];
  if (left.length) console.log(`WARN: smokeDir 잔여 ${left.join(', ')}`);
  process.exit(failCount ? 1 : 0);
}
