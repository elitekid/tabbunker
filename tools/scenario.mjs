// §12 스모크 시나리오 (크롬 CfT 헤드리스)
// 사용: node tools/scenario.mjs <dist/chrome 절대경로>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync,
  mkdirSync, unlinkSync, rmdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const calcExtId = p => createHash('sha256').update(p).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, c => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));

const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const ext = process.argv[2];
if (!ext) { console.error('dist/chrome 경로 필요'); process.exit(2); }

const smokeSubfolder = `TabBunkerSmoke-${process.pid}`;
const smokeDir = join(homedir(), 'Downloads', smokeSubfolder);
const port = 9600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'tk-scn-'));
const trackedIds = new Set();
const fResults = {};
const results = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SMOKE_IDS = [
  ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`),
  'F20', 'F20b', 'F20c', 'F20d', 'F21', 'F22', 'F23', 'F24',
];

function step(id, pass, detail = '') {
  const status = pass === null ? 'SKIP' : (pass ? 'PASS' : 'FAIL');
  fResults[id] = [status, detail];
  results.push([status, id, detail]);
  console.log(status + ' ' + id + (detail ? ' - ' + detail : ''));
}

function printTable() {
  console.log('\n=== §12 단계 결과 (Chrome) ===');
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

async function waitTabStatus(bg, tabId, status = 'complete', ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await bg.ev(`chrome.tabs.get(${tabId}).then(t=>t.status)`);
    if (st === status) return true;
    await sleep(300);
  }
  return false;
}

function writeChromePrefs(profilePath, downloadExtra = {}) {
  const def = join(profilePath, 'Default');
  mkdirSync(def, { recursive: true });
  writeFileSync(join(def, 'Preferences'), JSON.stringify({
    download: { default_directory: join(homedir(), 'Downloads'), ...downloadExtra },
  }));
}

let seq = 0;
async function targets() { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
async function waitFor(pred, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const t = (await targets()).find(pred);
      if (t) return t;
    } catch { /* retry */ }
    await sleep(300);
  }
  return null;
}

async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
  const pend = new Map();
  const logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') logs.push(m);
  };
  // 소켓이 닫히거나 60초 안에 응답이 없으면 거부(정리 단계에서 영원히 매달리지 않게)
  const send = (method, params = {}) => new Promise((r, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pend.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 60000);
    pend.set(id, (m) => { clearTimeout(timer); r(m); });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); pend.delete(id); rej(e); }
  });
  ws.onclose = () => { for (const [id, fn] of pend) { pend.delete(id); fn({ id, error: { message: 'socket closed' } }); } };
  await send('Runtime.enable');
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(r.error.message || 'CDP error');
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'exception');
    return r.result?.result?.value;
  };
  return { ws, ev, logs, send };
}

async function trackDownloads(bg) {
  const st = await bg.ev(`chrome.storage.local.get('tk_backup_state').then(r=>r.tk_backup_state||{})`);
  if (st.latestDownloadId) trackedIds.add(st.latestDownloadId);
  for (const d of st.datedFiles || []) trackedIds.add(d.downloadId);
  const ids = await bg.ev(`chrome.downloads.search({}).then(ds=>ds.filter(x=>x.filename&&x.filename.includes('${smokeSubfolder}')).map(x=>x.id))`);
  for (const id of ids || []) trackedIds.add(id);
}

async function getBackupState(bg) {
  return bg.ev(`chrome.storage.local.get('tk_backup_state').then(r=>r.tk_backup_state||{})`);
}

async function getMeta(bg) {
  return bg.ev(`chrome.storage.local.get('tk_meta').then(r=>r.tk_meta||{})`);
}

async function waitBackupNow(vp) {
  const res = await vp.ev(`chrome.runtime.sendMessage({type:'backupNow'})`);
  await sleep(500);
  return res;
}

async function waitDatedSettle(bg, expectedLen, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await getBackupState(bg);
    if ((st.datedFiles || []).length >= expectedLen) {
      let ok = true;
      for (const d of st.datedFiles || []) {
        const item = await bg.ev(`chrome.downloads.search({id:${d.downloadId}}).then(x=>x[0]||null)`);
        if (!item || item.state !== 'complete' || !item.exists) { ok = false; break; }
      }
      if (ok && st.datedFiles.length === expectedLen) return st;
    }
    await sleep(400);
  }
  return getBackupState(bg);
}

async function f5Pattern(bg, vp, groupId, renameCounter) {
  const ago = Date.now() - 61 * 60 * 1000;
  await bg.ev(`chrome.storage.local.get('tk_backup_state').then(async r=>{const s=r.tk_backup_state||{}; s.lastDatedAt=${ago}; await chrome.storage.local.set({tk_backup_state:s});})`);
  const title = `smoke-dated-${renameCounter}`;
  await vp.ev(`chrome.runtime.sendMessage({type:'renameGroup',id:'${groupId}',title:${JSON.stringify(title)}})`);
  const bn = await waitBackupNow(vp);
  await trackDownloads(bg);
  await waitDatedSettle(bg, renameCounter + 1, 30000);
  return { bn, title };
}

async function countExampleTabs(bg, win) {
  return bg.ev(`chrome.tabs.query({windowId:${win}}).then(ts=>ts.filter(t=>/^https:\\/\\/example\\./.test(t.url||t.pendingUrl||'')).length)`);
}

async function openExampleTabs(bg, win, n = 3) {
  const urls = ['https://example.com/', 'https://example.org/', 'https://example.net/'];
  for (let i = 0; i < n; i++) {
    await bg.ev(`chrome.tabs.create({windowId:${win},url:'${urls[i % urls.length]}',active:false})`);
  }
  await sleep(2500);
}

async function closeNonVaultTabs(bg, win) {
  await bg.ev(`chrome.tabs.query({windowId:${win}}).then(ts=>Promise.all(ts.filter(t=>!(t.url||t.pendingUrl||'').includes('vault.html')).map(t=>chrome.tabs.remove(t.id))))`);
  await sleep(800);
}

async function ensureVaultInWindow(bg, extId, win) {
  await bg.ev(`chrome.tabs.query({url:'chrome-extension://${extId}/vault/vault.html'}).then(ts=>ts.length?chrome.tabs.move(ts[0].id,{windowId:${win},index:-1}):null)`);
}

async function connectSession(extId) {
  await waitFor(() => true, 20000);
  await sleep(2000);
  await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/vault/vault.html`, { method: 'PUT' });
  const sw = await waitFor(t => t.type === 'service_worker' && t.url.includes(`${extId}/background.js`));
  const vault = await waitFor(t => t.type === 'page' && t.url.includes('/vault/vault.html'));
  if (!sw || !vault) throw new Error('SW 또는 vault 타겟 없음');
  const bg = await attach(sw);
  const vp = await attach(vault);
  return { bg, vp, sw, vault };
}

function spawnChrome() {
  mkdirSync(join(profile, 'crash'), { recursive: true });
  return spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--no-sandbox', '--use-mock-keychain', '--password-store=basic', '--disable-setuid-sandbox',
    '--remote-allow-origins=*', '--disable-breakpad',
    `--crash-dumps-dir=${join(profile, 'crash')}`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function cleanupSmoke(bg) {
  if (bg) await trackDownloads(bg);
  for (const id of trackedIds) {
    try {
      await bg?.ev(`chrome.downloads.search({id:${id}}).then(async ds=>{if(!ds[0])return; if(ds[0].exists) await chrome.downloads.removeFile(${id}); await chrome.downloads.erase({id:${id}});})`);
    } catch { /* ignore */ }
  }
  try {
    if (existsSync(smokeDir)) {
      for (const f of readdirSync(smokeDir)) unlinkSync(join(smokeDir, f));
      rmdirSync(smokeDir);
    }
  } catch { /* ignore */ }
}

let chrome = null;
let chromeStderr = '';
let bg = null;
let vp = null;
let win = null;
let extId = null;
let f18Capture = null;
let renameCounter = 0;
let consoleLogs = [];

try {
  writeChromePrefs(profile);
  chrome = spawnChrome();
  chrome.stderr.on('data', d => { chromeStderr += d.toString(); });
  extId = calcExtId(ext);

  await sleep(3000);
  // 설치 직후 보관함 탭은 약 3초 뒤에 열린다(실측). 최대 10초 기다린다.
  const earlyTabs = await (async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const ts = await targets();
        const n = ts.filter(t => t.type === 'page' && t.url?.includes('/vault/vault.html')).length;
        if (n > 0) return n;
      } catch { /* retry */ }
      await sleep(500);
    }
    return 0;
  })();

  ({ bg, vp } = await connectSession(extId));
  consoleLogs.push(...bg.logs, ...vp.logs);

  win = await bg.ev('chrome.windows.getLastFocused().then(w=>w.id)');

  await vp.ev(`chrome.runtime.sendMessage({type:'updateSettings',patch:{autoFileBackup:true,firstRunComplete:true,backupSubfolder:${JSON.stringify(smokeSubfolder)}}})`);
  await openExampleTabs(bg, win, 3);
  await ensureVaultInWindow(bg, extId, win);

  const preview = await vp.ev(`chrome.runtime.sendMessage({type:'getCollapsePreview',windowId:${win}})`);
  const exCount = await countExampleTabs(bg, win);
  f18Capture = {
    vaultTabs: earlyTabs,
    eligible: preview?.eligible,
    exampleTabs: exCount,
  };

  // F1
  const res1 = await vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${win}})`);
  await sleep(1500);
  const st1 = await vp.ev(`chrome.runtime.sendMessage({type:'getBackupStatus'})`);
  const meta1 = await getMeta(bg);
  const exAfter1 = await countExampleTabs(bg, win);
  const vaultAfter1 = await bg.ev(`chrome.tabs.query({windowId:${win}}).then(ts=>ts.filter(t=>(t.url||'').includes('vault.html')).length)`);
  step('F1',
    res1?.ok && res1.closed === 3 && res1.remaining === 0 &&
    vaultAfter1 >= 1 && exAfter1 === 0 &&
    meta1.revision > (st1.state?.lastFileOkRevision ?? 0) &&
    st1.undo?.kind === 'collapse' && st1.undo?.count === 3,
    `closed=${res1?.closed} undo=${st1.undo?.kind}/${st1.undo?.count}`);

  const groupId = res1?.groupId;

  // F2
  const res2 = await vp.ev(`chrome.runtime.sendMessage({type:'undo'})`);
  await sleep(2000);
  const ex2 = await countExampleTabs(bg, win);
  const groups2 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>r.groups||[])`);
  step('F2', res2?.ok && res2.reopened === 3 && ex2 === 3 && groups2.length === 0,
    `reopened=${res2?.reopened} groups=${groups2.length}`);

  // F3
  await closeNonVaultTabs(bg, win);
  await openExampleTabs(bg, win, 3);
  const res3c = await vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${win}})`);
  await sleep(1000);
  const gid3 = res3c?.groupId;
  const bn3 = await waitBackupNow(vp);
  await trackDownloads(bg);
  await waitDatedSettle(bg, 1);
  const st3 = await getBackupState(bg);
  const meta3 = await getMeta(bg);
  const latest3 = st3.latestDownloadId
    ? await bg.ev(`chrome.downloads.search({id:${st3.latestDownloadId}}).then(x=>x[0]||null)`) : null;
  let body3 = null;
  if (latest3?.filename && existsSync(latest3.filename)) body3 = JSON.parse(readFileSync(latest3.filename, 'utf8'));
  step('F3',
    bn3?.ok && latest3?.state === 'complete' && latest3?.exists &&
    latest3.filename?.endsWith('/tabbunker-latest.json') &&
    body3?.version === 1 && body3?.groups?.length === 1 && body3?.groups[0]?.tabs?.length === 3 &&
    meta3.revision === st3.lastFileOkRevision && st3.datedFiles?.length === 1,
    `latest=${latest3?.state} exists=${latest3?.exists} dated=${st3.datedFiles?.length} groups=${body3?.groups?.length} tabs=${body3?.groups?.[0]?.tabs?.length} rev=${meta3.revision}/${st3.lastFileOkRevision}`);
  const firstDatedId = st3.datedFiles?.[0]?.downloadId;

  // F4
  const newTitle4 = 'smoke-renamed-A';
  await vp.ev(`chrome.runtime.sendMessage({type:'renameGroup',id:'${gid3}',title:${JSON.stringify(newTitle4)}})`);
  const bn4 = await waitBackupNow(vp);
  await trackDownloads(bg);
  const latest4 = (await getBackupState(bg)).latestDownloadId;
  const item4 = latest4 ? await bg.ev(`chrome.downloads.search({id:${latest4}}).then(x=>x[0]||null)`) : null;
  let dirFiles4 = existsSync(smokeDir) ? readdirSync(smokeDir).filter(f => f.endsWith('.json')) : [];
  let body4 = item4?.filename && existsSync(item4.filename) ? JSON.parse(readFileSync(item4.filename, 'utf8')) : null;
  const st4 = await getBackupState(bg);
  step('F4',
    bn4?.ok && dirFiles4.filter(f => f.startsWith('tabbunker-latest')).length === 1 &&
    !dirFiles4.some(f => f.includes(' (1)')) &&
    body4?.groups?.[0]?.title === newTitle4 && st4.datedFiles?.length === 1,
    `files=${dirFiles4.join(',')} title=${body4?.groups?.[0]?.title}`);

  // F5
  renameCounter = 1;
  const f5 = await f5Pattern(bg, vp, gid3, renameCounter);
  const st5 = await getBackupState(bg);
  let f5exists = true;
  for (const d of st5.datedFiles || []) {
    const it = await bg.ev(`chrome.downloads.search({id:${d.downloadId}}).then(x=>x[0]||null)`);
    if (!it?.exists) f5exists = false;
  }
  step('F5', f5.bn?.ok && st5.datedFiles?.length === 2 && f5exists, `dated=${st5.datedFiles?.length}`);

  // F6
  let f6pass = false;
  let f6detail = '';
  for (let n = 2; n <= 31; n++) {
    renameCounter = n;
    await f5Pattern(bg, vp, gid3, renameCounter);
    if (n === 31) {
      const st6 = await getBackupState(bg);
      const firstId = firstDatedId;
      const firstItem = firstId ? await bg.ev(`chrome.downloads.search({id:${firstId}}).then(x=>x[0]||null)`) : null;
      const stillTracked = (st6.datedFiles||[]).some(f => f.downloadId === firstId);
      const fsMissing = !firstItem?.filename || !existsSync(firstItem.filename);
      const latestOnly = existsSync(smokeDir)
        ? readdirSync(smokeDir).filter(f => f.startsWith('tabbunker-latest')).length : 0;
      f6pass = st6.datedFiles?.length === 30 && !stillTracked &&
        (!firstItem || !firstItem.exists) && fsMissing &&
        latestOnly === 1 && !st6.cleanupBlocked;
      f6detail = `dated=${st6.datedFiles?.length} firstGone=${!firstItem || !firstItem.exists} fsMissing=${fsMissing} cleanupBlocked=${st6.cleanupBlocked}`;
    }
  }
  step('F6', f6pass, f6detail);

  // F7 — dirty rename 후 재기동
  const f7title = 'smoke-after-restart';
  await vp.ev(`chrome.runtime.sendMessage({type:'renameGroup',id:'${gid3}',title:${JSON.stringify(f7title)}})`);
  bg.ws.close(); vp.ws.close();
  chrome.kill('SIGTERM');
  await sleep(1500);
  chrome = spawnChrome();
  chrome.stderr.on('data', d => { chromeStderr += d.toString(); });
  ({ bg, vp } = await connectSession(extId));
  win = await bg.ev('chrome.windows.getLastFocused().then(w=>w.id)');
  await ensureVaultInWindow(bg, extId, win);
  await vp.ev(`chrome.runtime.sendMessage({type:'updateSettings',patch:{autoFileBackup:true,backupSubfolder:${JSON.stringify(smokeSubfolder)}}})`);
  let f7pass = false;
  let f7detail = '';
  const t7 = Date.now();
  while (Date.now() - t7 < 20000) {
    const meta7 = await getMeta(bg);
    const st7 = await getBackupState(bg);
    const lat7 = st7.latestDownloadId
      ? await bg.ev(`chrome.downloads.search({id:${st7.latestDownloadId}}).then(x=>x[0]||null)`) : null;
    let b7 = null;
    if (lat7?.filename && existsSync(lat7.filename)) b7 = JSON.parse(readFileSync(lat7.filename, 'utf8'));
    if (meta7.revision === st7.lastFileOkRevision && b7?.groups?.[0]?.title === f7title) {
      f7pass = true;
      f7detail = `revision=${meta7.revision} title=${b7?.groups?.[0]?.title}`;
      break;
    }
    await sleep(500);
  }
  if (!f7pass) f7detail = '20초 내 revision===lastFileOkRevision 또는 새 이름 미확인';
  step('F7', f7pass, f7detail);

  // F8
  const tabs35 = Array.from({ length: 35 }, (_, i) => ({
    url: `https://example.com/page${i}`, title: `P${i}`, favIconUrl: '', pinned: false,
  }));
  const bigGroup = { id: 'g-big', title: 'Big35', tabs: tabs35, locked: false, trashedAt: null };
  await vp.ev(`chrome.runtime.sendMessage({type:'importApply',mode:'replace',groups:[${JSON.stringify(bigGroup)}]})`);
  await closeNonVaultTabs(bg, win);
  const gidBig = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).find(g=>g.title==='Big35')?.id)`);
  const r8a = await vp.ev(`chrome.runtime.sendMessage({type:'restoreGroup',groupId:'${gidBig}',windowId:${win}})`);
  const tabsBefore8 = await countExampleTabs(bg, win);
  const r8b = await vp.ev(`chrome.runtime.sendMessage({type:'restoreGroup',groupId:'${gidBig}',confirmLarge:true,windowId:${win}})`);
  await sleep(3000);
  const ex8 = await countExampleTabs(bg, win);
  const groups8 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>r.groups||[])`);
  step('F8',
    r8a?.ok === false && r8a?.code === 'confirm-required' && r8a?.count === 35 &&
    tabsBefore8 === 0 && r8b?.ok && ex8 === 35 && !groups8.some(g => g.title === 'Big35' && !g.trashedAt),
    `confirm=${r8a?.code} opened=${ex8} r8b=${JSON.stringify(r8b)}`);

  // F9
  const rep9 = await vp.ev(`import('/shared/importers.js').then(m=>m.importAutoDetectWithReport(${JSON.stringify('https://a.com/ | A\nnot a url\n\nhttps://b.com/ | B')}))`);
  step('F9',
    rep9?.groups?.length === 2 && rep9?.groups?.reduce((s, g) => s + (g.tabs?.length || 0), 0) === 2 &&
    rep9?.skipped?.badLines === 1,
    JSON.stringify({ groups: rep9?.groups?.length, bad: rep9?.skipped?.badLines }));

  // F10
  await closeNonVaultTabs(bg, win);
  await openExampleTabs(bg, win, 3);
  const c10 = await vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${win}})`);
  await sleep(1000);
  const rev10b = (await getMeta(bg)).revision;
  const active10pre = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).filter(g=>!g.trashedAt).length)`);
  const trash10pre = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).filter(g=>g.trashedAt).length)`);
  const g10a = [{ id: 'imp-a', title: 'IA', tabs: [{ url: 'https://a.com/', title: 'A' }], locked: false }];
  const g10b = [{ id: 'imp-b', title: 'IB', tabs: [{ url: 'https://b.com/', title: 'B' }], locked: false }];
  await vp.ev(`chrome.runtime.sendMessage({type:'importApply',mode:'replace',groups:${JSON.stringify([...g10a, ...g10b])}})`);
  const active10 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).filter(g=>!g.trashedAt).length)`);
  const trash10 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).filter(g=>g.trashedAt).length)`);
  const u10 = await vp.ev(`chrome.runtime.sendMessage({type:'undo'})`);
  await sleep(500);
  const active10b = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).filter(g=>!g.trashedAt).length)`);
  const trash10b = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).filter(g=>g.trashedAt).length)`);
  const rev10a = (await getMeta(bg)).revision;
  step('F10',
    c10?.ok && active10 === 2 && trash10 === trash10pre + active10pre && u10?.ok &&
    active10b === active10pre && trash10b === trash10pre && rev10a > rev10b,
    `active ${active10}->${active10b} trash ${trash10}->${trash10b} rev+${rev10a - rev10b}`);

  // F11
  const gid11 = (await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).find(g=>!g.trashedAt)?.id)`));
  await vp.ev(`chrome.runtime.sendMessage({type:'setLocked',id:'${gid11}',locked:true})`);
  const tr11 = await vp.ev(`chrome.runtime.sendMessage({type:'trashGroup',id:'${gid11}'})`);
  step('F11', tr11?.ok === false && tr11?.code === 'locked', JSON.stringify(tr11));
  await vp.ev(`chrome.runtime.sendMessage({type:'setLocked',id:'${gid11}',locked:false})`);

  // F12 — 별도 프로필 (prompt_for_download), 메인 세션은 유지
  const f12Profile = mkdtempSync(join(tmpdir(), 'tk-f12-'));
  writeChromePrefs(f12Profile, { prompt_for_download: true });
  const f12Port = port + 1;
  const f12Chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--disable-gpu', '--use-mock-keychain', '--password-store=basic',
    `--remote-debugging-port=${f12Port}`, `--user-data-dir=${f12Profile}`,
    `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, 'about:blank',
  ], { stdio: 'ignore' });
  let f12pass = false;
  let f12detail = '';
  try {
    await sleep(3000);
    const f12Targets = async () => (await fetch(`http://127.0.0.1:${f12Port}/json/list`)).json();
    const f12Wait = async pred => {
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const t = (await f12Targets()).find(pred);
        if (t) return t;
        await sleep(300);
      }
      return null;
    };
    await fetch(`http://127.0.0.1:${f12Port}/json/new?chrome-extension://${extId}/vault/vault.html`, { method: 'PUT' });
    const f12sw = await f12Wait(t => t.type === 'service_worker' && t.url.includes(extId));
    const f12vault = await f12Wait(t => t.type === 'page' && t.url.includes('vault.html'));
    const f12bg = await attach(f12sw);
    for (let i = 0; i < 20; i++) { if ((await f12bg.ev('typeof chrome.storage')) === 'object') break; await sleep(250); }
    const f12vp = await attach(f12vault);
    const f12win = await f12bg.ev('chrome.windows.getLastFocused().then(w=>w.id)');
    await f12vp.ev(`chrome.runtime.sendMessage({type:'updateSettings',patch:{autoFileBackup:true,firstRunComplete:true,backupSubfolder:${JSON.stringify(smokeSubfolder + '-f12')}}})`);
    for (const u of ['https://example.com/', 'https://example.org/', 'https://example.net/']) {
      await f12bg.ev(`chrome.tabs.create({windowId:${f12win},url:'${u}',active:false})`);
    }
    await sleep(2000);
    await f12vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${f12win}})`);
    await sleep(1000);
    const bn12 = await f12vp.ev(`chrome.runtime.sendMessage({type:'backupNow'})`);
    const st12 = await f12bg.ev(`chrome.storage.local.get('tk_backup_state').then(r=>r.tk_backup_state||{})`);
    await f12vp.ev(`chrome.runtime.sendMessage({type:'getBackupStatus'}).then(()=>location.reload())`);
    await sleep(1500);
    const hdr12 = await f12vp.ev(`document.getElementById('backup-line2')?.textContent||''`);
    const gid12 = (await f12vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[])[0]?.id)`));
    const idBefore = st12.latestDownloadId;
    await f12vp.ev(`chrome.runtime.sendMessage({type:'renameGroup',id:'${gid12}',title:'f12-renamed'})`);
    await sleep(40000);
    const st12b = await f12bg.ev(`chrome.storage.local.get('tk_backup_state').then(r=>r.tk_backup_state||{})`);
    f12pass = st12.paused === 'canceled' && st12.lastError?.code === 'canceled' &&
      /paused|일시|중지/i.test(hdr12) && st12b.latestDownloadId === idBefore;
    f12detail = `paused=${st12.paused} hdr=${hdr12.slice(0, 40)} idSame=${st12b.latestDownloadId === idBefore}`;
    const f12ids = await f12bg.ev(`chrome.downloads.search({}).then(ds=>ds.filter(d=>d.filename&&d.filename.includes('TabBunkerSmoke')).map(d=>d.id))`);
    for (const id of f12ids || []) {
      trackedIds.add(id);
      await f12bg.ev(`chrome.downloads.search({id:${id}}).then(async ds=>{if(ds[0]?.exists)await chrome.downloads.removeFile(${id}); await chrome.downloads.erase({id:${id}});})`);
    }
    f12bg.ws.close(); f12vp.ws.close();
  } catch (e) { f12detail = e.message; }
  finally {
    try { f12Chrome.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(800);
    try { f12Chrome.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(f12Profile, { recursive: true, force: true }); } catch { /* ignore */ }
    // 파일은 removeFile 로 지웠지만 폴더가 남으므로 함께 제거
    try { const d = smokeDir + '-f12'; if (existsSync(d)) { for (const f of readdirSync(d)) unlinkSync(join(d, f)); rmdirSync(d); } } catch { /* ignore */ }
  }
  step('F12', f12pass, f12detail);

  // F13
  await bg.ev(`chrome.storage.local.get('tk_backup_state').then(async r=>{const s=r.tk_backup_state||{}; s.paused='canceled'; s.lastError={code:'canceled'}; await chrome.storage.local.set({tk_backup_state:s});})`);
  await vp.ev(`location.reload()`);
  await sleep(1500);
  const hdr13a = await vp.ev(`document.getElementById('backup-line2')?.textContent||''`);
  const bn13 = await waitBackupNow(vp);
  const st13 = await getBackupState(bg);
  const lat13 = st13.latestDownloadId
    ? await bg.ev(`chrome.downloads.search({id:${st13.latestDownloadId}}).then(x=>x[0]||null)`) : null;
  step('F13',
    /paused|일시|중지/i.test(hdr13a) && bn13?.ok && st13.paused === false &&
    lat13?.state === 'complete',
    `hdr=${hdr13a.slice(0, 30)} paused=${st13.paused}`);

  // F14
  const st14b = await getBackupState(bg);
  const lat14 = st14b.latestDownloadId;
  const item14 = lat14 ? await bg.ev(`chrome.downloads.search({id:${lat14}}).then(x=>x[0]||null)`) : null;
  const bytes14 = item14?.filename && existsSync(item14.filename) ? readFileSync(item14.filename) : null;
  const rev14 = (await getMeta(bg)).revision;
  const okRev14 = st14b.lastFileOkRevision;
  await vp.ev(`chrome.runtime.sendMessage({type:'deleteAllData'})`);
  await sleep(40000);
  const groups14 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>r.groups||[])`);
  const st14a = await getBackupState(bg);
  const item14b = lat14 ? await bg.ev(`chrome.downloads.search({id:${lat14}}).then(x=>x[0]||null)`) : null;
  const bytes14b = item14?.filename && existsSync(item14.filename) ? readFileSync(item14.filename) : null;
  const meta14 = await getMeta(bg);
  step('F14',
    groups14.length === 0 && st14a.latestDownloadId === lat14 &&
    bytes14 && bytes14b && Buffer.compare(bytes14, bytes14b) === 0 && meta14.revision === st14a.lastFileOkRevision &&
    true,
    `groups=${groups14.length} idSame=${st14a.latestDownloadId === lat14}`);
  // 전체 삭제로 설정이 기본값(TabBunker 폴더)으로 돌아가므로 이후 백업이 실제 폴더에 떨어지지 않게 스모크 폴더를 다시 지정
  await vp.ev(`chrome.runtime.sendMessage({type:'updateSettings',patch:{firstRunComplete:true,backupSubfolder:${JSON.stringify(smokeSubfolder)}}})`);

  // F15
  await closeNonVaultTabs(bg, win);
  await bg.ev(`chrome.tabs.create({windowId:${win},url:${JSON.stringify('data:text/html;charset=utf-8,' + encodeURIComponent('<title>한국어 테스트</title><p>ko</p>'))},active:false})`);
  await sleep(1500);
  await vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${win}})`);
  await sleep(1000);
  const bn15 = await waitBackupNow(vp);
  await trackDownloads(bg);
  const st15 = await getBackupState(bg);
  const it15 = st15.latestDownloadId
    ? await bg.ev(`chrome.downloads.search({id:${st15.latestDownloadId}}).then(x=>x[0]||null)`) : null;
  const body15 = it15?.filename && existsSync(it15.filename) ? readFileSync(it15.filename, 'utf8') : '';
  step('F15', bn15?.ok && body15.includes('한국어 테스트'), `found=${body15.includes('한국어 테스트')}`);

  // F16
  const cnt16a = await bg.ev(`chrome.downloads.search({}).then(d=>d.filter(x=>x.filename&&x.filename.includes('${smokeSubfolder}')).length)`);
  await sleep(90000);
  const cnt16b = await bg.ev(`chrome.downloads.search({}).then(d=>d.filter(x=>x.filename&&x.filename.includes('${smokeSubfolder}')).length)`);
  step('F16', cnt16a === cnt16b, `${cnt16a}->${cnt16b}`);

  // F17
  await closeNonVaultTabs(bg, win);
  const gs17 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>r.groups||[])`);
  for (const g of gs17) {
    if (g.trashedAt) await vp.ev(`chrome.runtime.sendMessage({type:'deleteGroupForever',id:'${g.id}'})`);
    else await vp.ev(`chrome.runtime.sendMessage({type:'trashGroup',id:'${g.id}'})`);
  }
  await openExampleTabs(bg, win, 3);
  const c17 = await vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${win}})`);
  await sleep(1000);
  const gid17 = c17?.groupId;
  await vp.ev(`chrome.runtime.sendMessage({type:'restoreGroup',groupId:'${gid17}'})`);
  await sleep(2500);
  const ex17 = await countExampleTabs(bg, win);
  const g17 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>r.groups||[])`);
  const prev17 = await vp.ev(`import('/shared/importers.js').then(async m=>{const g=m.parseOneTabText('https://a.com/ | A\\nhttps://b.com/ | B\\n\\nhttps://c.com/ | C'); const mm=await import('/shared/model.js'); const cur=(await chrome.runtime.sendMessage({type:'getGroups'})).groups; return {groups:g.length, links:g.reduce((s,x)=>s+(x.tabs?.length||0),0), preview:mm.computeMergePreview(cur,g)};})`);
  consoleLogs.push(...bg.logs, ...vp.logs);
  const errs17 = consoleLogs.filter(m => m.method === 'Runtime.exceptionThrown' || m.params?.type === 'error');
  step('F17',
    c17?.ok && ex17 === 3 && g17.filter(g => !g.trashedAt).length === 0 &&
    prev17?.groups === 2 && prev17?.links === 3 && errs17.length === 0,
    `ex=${ex17} preview=${prev17?.groups}/${prev17?.links} errs=${errs17.length}`);

  // F18 (시작 시 캡처)
  step('F18',
    f18Capture && f18Capture.vaultTabs >= 1 &&
    f18Capture.eligible === f18Capture.exampleTabs,
    `vault=${f18Capture?.vaultTabs} eligible=${f18Capture?.eligible}/${f18Capture?.exampleTabs}`);

  // F19
  await closeNonVaultTabs(bg, win);
  await openExampleTabs(bg, win, 3);
  const c19 = await vp.ev(`chrome.runtime.sendMessage({type:'collapse',windowId:${win}})`);
  await sleep(1000);
  try { await vp.ev('location.reload()'); } catch { /* 컨텍스트 교체 */ }
  await sleep(1500);
  await vp.ev(`document.getElementById('search').value='example.org'; document.getElementById('search').dispatchEvent(new Event('input'));`);
  await sleep(500);
  const ui19 = await vp.ev(`(()=>{const card=document.querySelector('.group-card'); const meta=card?.querySelector('.group-meta')?.textContent||''; const btn=[...card?.querySelectorAll('button')||[]].find(b=>/restore all|모두 복원/i.test(b.textContent))?.textContent||''; return {meta,btn};})()`);
  step('F19',
    /3/.test(ui19?.btn) && /1/.test(ui19?.meta) && /3/.test(ui19?.meta),
    JSON.stringify(ui19));

  await vp.ev(`document.getElementById('search').value=''; document.getElementById('search').dispatchEvent(new Event('input'));`);

  const { server: httpSrv, url: httpUrl } = await startHttpServer();

  // F20
  await closeNonVaultTabs(bg, win);
  const tabIdA = await bg.ev(`chrome.tabs.create({windowId:${win},url:${JSON.stringify(httpUrl)},active:false}).then(t=>t.id)`);
  const tabIdB = await bg.ev(`chrome.tabs.create({windowId:${win},url:${JSON.stringify(httpUrl)},active:false}).then(t=>t.id)`);
  await waitTabStatus(bg, tabIdA);
  await waitTabStatus(bg, tabIdB);
  const r20 = await vp.ev(`chrome.runtime.sendMessage({type:'collapseTabs',tabIds:[${tabIdA}]})`);
  await sleep(1000);
  const ex20a = await bg.ev(`chrome.tabs.query({windowId:${win}}).then(ts=>ts.some(t=>t.id===${tabIdA}))`);
  const ex20b = await bg.ev(`chrome.tabs.query({windowId:${win}}).then(ts=>ts.some(t=>t.id===${tabIdB}))`);
  const g20 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).find(g=>!g.trashedAt))`);
  const u20 = await vp.ev(`chrome.runtime.sendMessage({type:'undo'})`);
  await sleep(1500);
  const gid20 = r20?.groupId;
  const g20gone = gid20 ? await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>!(r.groups||[]).some(g=>g.id==='${gid20}'&&!g.trashedAt))`) : false;
  const vaultTab = await bg.ev(`chrome.tabs.query({windowId:${win}}).then(ts=>ts.find(t=>(t.url||'').includes('vault.html'))?.id||0)`);
  const r20sys = vaultTab ? await vp.ev(`chrome.runtime.sendMessage({type:'collapseTabs',tabIds:[${vaultTab}]})`) : { code: 'missing' };
  const r20empty = await vp.ev(`chrome.runtime.sendMessage({type:'collapseTabs',tabIds:[999999]})`);
  step('F20',
    r20?.ok && r20.count === 1 && r20.closed === 1 && !ex20a && ex20b &&
    g20?.tabs?.length === 1 && u20?.ok && u20.reopened === 1 && g20gone &&
    r20sys?.code === 'system' && r20empty?.code === 'empty',
    `collapse=${JSON.stringify(r20)} undo=${JSON.stringify(u20)} g20gone=${g20gone}`);

  // F20b
  const win20b = await bg.ev(`chrome.windows.create({url:${JSON.stringify(httpUrl)}}).then(w=>w.id)`);
  await sleep(2000);
  const tab20b = await bg.ev(`chrome.tabs.query({windowId:${win20b}}).then(ts=>ts[0]?.id)`);
  const r20b = await vp.ev(`chrome.runtime.sendMessage({type:'collapseTabs',tabIds:[${tab20b}]})`);
  await sleep(1500);
  const w20bOk = await bg.ev(`chrome.windows.get(${win20b}).then(()=>true).catch(()=>false)`);
  const v20b = await bg.ev(`chrome.tabs.query({windowId:${win20b}}).then(ts=>ts.find(t=>(t.url||'').includes('vault.html'))?.url||'')`);
  const g20bCount = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).reduce((n,g)=>n+(g.tabs?.length||0),0))`);
  step('F20b', r20b?.ok && r20b.closed === 1 && w20bOk && v20b.includes('collapsed=1') && g20bCount >= 1,
    `closed=${r20b?.closed} vault=${v20b.includes('collapsed=1')}`);
  await bg.ev(`chrome.windows.remove(${win20b})`).catch(() => {});

  // F20c
  await vp.ev(`chrome.runtime.sendMessage({type:'updateSettings',patch:{includePinned:false}})`);
  await closeNonVaultTabs(bg, win);
  const pinTab = await bg.ev(`chrome.tabs.create({windowId:${win},url:${JSON.stringify(httpUrl)},active:false}).then(t=>t.id)`);
  await waitTabStatus(bg, pinTab);
  await bg.ev(`chrome.tabs.update(${pinTab},{pinned:true})`);
  const r20c = await vp.ev(`chrome.runtime.sendMessage({type:'collapseTabs',tabIds:[${pinTab},${pinTab},999999]})`);
  await sleep(1000);
  const pinnedInGroup = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>{const g=(r.groups||[]).find(x=>x.id===${JSON.stringify(r20c?.groupId || '')}); return g?.tabs?.[0]?.pinned;})`);
  const u20c = await vp.ev(`chrome.runtime.sendMessage({type:'undo'})`);
  await sleep(1500);
  const reopenedPinned = await bg.ev(`chrome.tabs.query({windowId:${win},pinned:true}).then(ts=>ts.length>0)`);
  step('F20c', r20c?.count === 1 && pinnedInGroup === true && u20c?.reopened === 1 && reopenedPinned === true,
    `count=${r20c?.count} pinned=${pinnedInGroup} reopenedPinned=${reopenedPinned}`);

  // F20d
  step('F20d', null, '헤드리스에서 tabs.create 실패를 안정적으로 강제하기 어려움');

  // F21
  const sl1 = await vp.ev(`chrome.runtime.sendMessage({type:'saveLink',url:'https://example.com/a',title:'A'})`);
  const sl2 = await vp.ev(`chrome.runtime.sendMessage({type:'saveLink',url:'https://example.com/a',title:'A'})`);
  const gid21 = sl1?.groupId;
  await vp.ev(`chrome.runtime.sendMessage({type:'renameGroup',id:'${gid21}',title:'renamed-links'})`);
  const sl3 = await vp.ev(`chrome.runtime.sendMessage({type:'saveLink',url:'https://example.com/b',title:'B'})`);
  const g21 = await vp.ev(`chrome.runtime.sendMessage({type:'getGroups'}).then(r=>(r.groups||[]).find(g=>g.id==='${gid21}'))`);
  const inv21a = await vp.ev(`chrome.runtime.sendMessage({type:'saveLink',url:'ftp://x'})`);
  const inv21b = await vp.ev(`chrome.runtime.sendMessage({type:'saveLink',url:'mailto:a@b'})`);
  const st21 = await vp.ev(`chrome.runtime.sendMessage({type:'getBackupStatus'})`);
  step('F21',
    sl1?.added === true && sl2?.added === false && g21?.tabs?.length === 2 &&
    g21?.id === gid21 && inv21a?.code === 'invalid' && inv21b?.code === 'invalid' &&
    st21?.settings?.savedLinksGroupId === gid21,
    `sl1=${sl1?.added} sl2=${sl2?.added} tabs=${g21?.tabs?.length}`);

  // F22
  const tabItems22 = await vp.ev(`document.querySelectorAll('.tab-item').length`);
  const favPerTab = await vp.ev(`[...document.querySelectorAll('.tab-item')].every(li=>li.querySelectorAll('.favicon').length===1)`);
  const extFavCount = await vp.ev(`document.querySelectorAll('img[src*="_favicon"]').length`);
  const networkReqs = [];
  const netHandler = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.method === 'Network.requestWillBeSent') networkReqs.push(m.params.request.url);
    } catch { /* ignore */ }
  };
  vp.ws.addEventListener('message', netHandler);
  await vp.send('Network.enable');
  await vp.ev('location.reload()');
  await sleep(2000);
  vp.ws.removeEventListener('message', netHandler);
  const badNet = networkReqs.filter((u) => !u.startsWith('chrome-extension://') && !u.startsWith('data:'));
  step('F22', tabItems22 >= 1 && favPerTab && extFavCount >= 1 && badNet.length === 0,
    `tabs=${tabItems22} extFav=${extFavCount} badNet=${badNet.length}`);

  // F23
  await vp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await vp.ev('location.reload()');
  await sleep(800);
  const lightBg = await vp.ev(`getComputedStyle(document.body).backgroundColor`);
  await vp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await vp.ev('location.reload()');
  await sleep(800);
  const darkBg = await vp.ev(`getComputedStyle(document.body).backgroundColor`);
  await vp.ev(`document.getElementById('import-dialog').showModal()`);
  const dialogBg = await vp.ev(`getComputedStyle(document.getElementById('import-dialog')).backgroundColor`);
  await vp.ev(`document.getElementById('import-dialog').close()`);
  const optUrl = `chrome-extension://${extId}/options/options.html`;
  await bg.ev(`chrome.tabs.create({windowId:${win},url:${JSON.stringify(optUrl)},active:false})`);
  await sleep(1000);
  const optTarget = await waitFor((t) => t.type === 'page' && t.url?.includes('options/options.html'));
  let optBg = '';
  if (optTarget) {
    const optPage = await attach(optTarget);
    optBg = await optPage.ev(`getComputedStyle(document.body).backgroundColor`);
    optPage.ws.close();
  }
  step('F23',
    lightBg === 'rgb(246, 247, 249)' && darkBg === 'rgb(15, 23, 42)' &&
    dialogBg === 'rgb(30, 41, 59)' && optBg === 'rgb(15, 23, 42)',
    `light=${lightBg} dark=${darkBg} dialog=${dialogBg} opt=${optBg}`);

  httpSrv.close();

  consoleLogs.push(...bg.logs, ...vp.logs);
  const menuErrs = consoleLogs.filter((m) => {
    if (m.method === 'Runtime.exceptionThrown') return true;
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') return true;
    const text = JSON.stringify(m);
    return /lastError|duplicate id/i.test(text);
  });
  const manifest24 = await bg.ev(`chrome.runtime.getManifest()`);
  const perms24 = manifest24.permissions || [];
  const csp24 = manifest24.content_security_policy?.extension_pages || '';
  step('F24',
    perms24.includes('contextMenus') && perms24.includes('favicon') &&
    csp24.includes("img-src 'self' data:") && menuErrs.length === 0,
    `perms=${perms24.join(',')} menuErrs=${menuErrs.length}`);
} catch (e) {
  const detail = e.message + (chromeStderr ? ` | ${chromeStderr.slice(-200)}` : '');
  console.log('ERROR', detail);
  for (const id of SMOKE_IDS) {
    if (!fResults[id]) step(id, false, detail);
  }
} finally {
  // 정리는 확장 페이지가 살아 있을 때(소켓 닫기·크롬 종료 전) 해야 한다
  try { await cleanupSmoke(bg); } catch (e) { console.log('cleanup error', e.message); }
  try { bg?.ws.close(); vp?.ws.close(); } catch { /* ignore */ }
  try { chrome?.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(800);
  try { chrome?.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  printTable();
  const failCount = Object.values(fResults).filter(r => r[0] === 'FAIL').length;
  const left = existsSync(smokeDir) ? readdirSync(smokeDir) : [];
  if (left.length) console.log(`WARN: smokeDir 잔여 ${left.join(', ')}`);
  process.exit(failCount ? 1 : 0);
}
