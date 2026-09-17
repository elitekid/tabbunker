// 스토어 스크린샷 1280x800 (영어·한국어): 드롭다운, 보관함, 가져오기, 되돌리기, 설정, 다크
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, cpSync, realpathSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const require = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR + '/package.json' : '/tmp/tb-ff/package.json');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const EXT = decodeURIComponent(new URL('../dist/chrome', import.meta.url).pathname);
const OUT = decodeURIComponent(new URL('../docs/store', import.meta.url).pathname);
const KO_FONT = '/System/Library/Fonts/AppleSDGothicNeo.ttc';
const SHEET_DIR = '/tmp/tb-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTIONS = {
  en: [
    'Pick which tabs to save from the toolbar.',
    'Open one tab or a whole group again.',
    'See what an import will change first.',
    'Saved by mistake? Undo right away.',
    'Automatic backup file in your Downloads folder.',
    'Dark mode follows your system.',
  ],
  ko: [
    '툴바에서 보관할 탭을 골라요',
    '탭 하나도, 그룹 전체도 다시 열어요',
    '가져오기 전에 무엇이 바뀌는지 봐요',
    '잘못 보관했으면 바로 되돌려요',
    '다운로드 폴더에 백업 파일을 자동으로 남겨요',
    '시스템 설정을 따르는 다크 모드',
  ],
};

const DATA = {
  en: [
    { locked: true, tabs: [['https://developer.chrome.com/docs/webstore/publish', 'Publish in the Chrome Web Store'], ['https://extensionworkshop.com/documentation/publish/', 'Publishing your extension | Firefox Extension Workshop'], ['https://news.ycombinator.com/item?id=42217504', 'Ask HN: How did you grow your browser extension?'], ['https://github.com/topics/browser-extension', 'browser-extension · GitHub Topics'], ['https://www.reddit.com/r/chrome/', 'r/chrome']] },
    { tabs: [['https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API', 'IndexedDB API - Web APIs | MDN'], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Rebuilding my desk setup (2026) - YouTube'], ['https://stackoverflow.com/questions/tagged/chrome-extension', 'Newest chrome-extension Questions - Stack Overflow'], ['https://www.nytimes.com/section/technology', 'Technology - The New York Times']] },
    { tabs: [['https://www.google.com/travel/flights', 'Google Flights'], ['https://www.booking.com/', 'Booking.com | Official site'], ['https://www.japan-guide.com/e/e2018.html', 'Tokyo Travel Guide - japan-guide.com']] },
  ],
  ko: [
    { locked: true, tabs: [['https://developer.chrome.com/docs/webstore/publish?hl=ko', 'Chrome 웹 스토어에 게시하기'], ['https://extensionworkshop.com/documentation/publish/', 'Publishing your extension | Firefox Extension Workshop'], ['https://news.hada.io/', 'GeekNews - 개발자 뉴스'], ['https://github.com/topics/browser-extension', 'browser-extension · GitHub Topics'], ['https://www.reddit.com/r/chrome/', 'r/chrome']] },
    { tabs: [['https://developer.mozilla.org/ko/docs/Web/API/IndexedDB_API', 'IndexedDB API - Web API | MDN'], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', '2026 책상 세팅 다시 하기 - YouTube'], ['https://stackoverflow.com/questions/tagged/chrome-extension', 'Newest chrome-extension Questions - Stack Overflow'], ['https://www.hani.co.kr/arti/science', '과학·기술 : 한겨레']] },
    { tabs: [['https://www.google.com/travel/flights?hl=ko', 'Google 항공편 검색'], ['https://www.booking.com/index.ko.html', 'Booking.com | 공식 사이트'], ['https://www.japan-guide.com/e/e2018.html', 'Tokyo Travel Guide - japan-guide.com']] },
  ],
};

const COLLAPSE_TABS = {
  en: [['https://www.wikipedia.org/', 'Wikipedia'], ['https://www.bbc.com/news', 'BBC News'], ['https://developer.mozilla.org/en-US/', 'MDN Web Docs'], ['https://news.ycombinator.com/', 'Hacker News']],
  ko: [['https://ko.wikipedia.org/', '위키백과, 우리 모두의 백과사전'], ['https://www.bbc.com/korean', 'BBC News 코리아'], ['https://developer.mozilla.org/ko/', 'MDN Web Docs'], ['https://news.hada.io/', 'GeekNews - 개발자 뉴스']],
};

const ONETAB = 'https://github.com/ | GitHub\nhttps://developer.mozilla.org/ | MDN Web Docs\nhttps://news.ycombinator.com/ | Hacker News\n\nhttps://www.notion.so/ | Notion\nhttps://calendar.google.com/ | Google Calendar';

const OLD_SUFFIXES = ['collapse', 'backup', 'onboarding', 'options'];

const favCache = new Map();
async function faviconDataUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return ''; }
  if (!host) return '';
  if (favCache.has(host)) return favCache.get(host);
  let out = '';
  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && buf.length < 16 * 1024) out = `data:${res.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`;
    }
  } catch { /* offline: 글자 아바타 */ }
  favCache.set(host, out);
  return out;
}

async function withFavicons(groups) {
  return Promise.all(groups.map(async (g) => ({
    ...g,
    tabs: await Promise.all(g.tabs.map(async ([url, title]) => [url, title, await faviconDataUrl(url)])),
  })));
}

function groupTimestamps() {
  const now = Date.now();
  const today = new Date();
  today.setHours(14, 30, 0, 0);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(10, 15, 0, 0);
  return [today.getTime(), yesterday.getTime(), now - 3 * 86400000];
}

function addCaption(rawPath, outPath, caption, lang) {
  const font = lang === 'ko' ? KO_FONT : '/System/Library/Fonts/Supplemental/Arial.ttf';
  const safe = caption.replace(/"/g, '\\"');
  execSync(`magick -size 1280x800 xc:"#16213a" \\( "${rawPath}" -resize 1088x680 \\) -gravity north -geometry +0+0 -composite \\( -size 1200x104 -background none -fill white -font "${font}" -pointsize 40 -gravity center caption:"${safe}" \\) -gravity south -geometry +0+8 -composite -alpha off -depth 8 -strip "PNG24:${outPath}"`);
}

function compositeDropdown(popupPath, outPath) {
  execSync(`magick -size 1088x680 xc:"#c8ccd4" \\( -size 1088x40 xc:"#e8ebf0" \\) -geometry +0+0 -composite \\( -size 1088x1 xc:"#b0b5be" \\) -geometry +0+39 -composite \\( "${popupPath}" \\( +clone -background black -shadow 80x4+3+8 \\) +swap -background none -layers merge +repage \\) -gravity northeast -geometry +28+48 -composite "${outPath}"`);
}

async function cleanupDownloads(page, folders) {
  await page.evaluate(async (subs) => {
    const ds = await chrome.downloads.search({});
    for (const d of ds) {
      if (!subs.some((sub) => (d.filename || '').includes(sub))) continue;
      try { if (d.exists) await chrome.downloads.removeFile(d.id); } catch {}
      try { await chrome.downloads.erase({ id: d.id }); } catch {}
    }
  }, folders);
}

async function openPopupInWindow(page, extId) {
  const url = `chrome-extension://${extId}/popup/popup.html`;
  await page.evaluate((u) => chrome.tabs.create({ url: u, active: true }), url);
  await sleep(600);
  const target = await page.browser().waitForTarget((t) => t.url().includes('/popup/popup.html'), { timeout: 10000 });
  const pg = await target.page();
  await pg.setViewport({ width: 380, height: 620, deviceScaleFactor: 1 });
  await sleep(900);
  return pg;
}

async function shotPopupElement(pg, path) {
  const el = await pg.$('.popup');
  if (!el) throw new Error('popup .popup element missing');
  // 뒤 배경이 밝은 브라우저라 드롭다운도 밝은 화면으로 맞춘다(헤드리스 기본은 시스템 다크일 수 있음)
  await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await sleep(300);
  await el.screenshot({ path });
}

async function prepareDropdown(pg) {
  await pg.evaluate(async () => {
    await chrome.storage.local.set({ tk_ui_backupNoticeSeen: true });
    document.getElementById('backup-notice')?.classList.add('hidden');
    document.getElementById('toast')?.classList.add('hidden');
    const toggle = document.getElementById('btn-pick-toggle');
    if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
  });
  await sleep(400);
  await pg.evaluate(() => {
    const cbs = [...document.querySelectorAll('#pick-list input[type=checkbox]')];
    if (cbs.length > 1 && cbs[1].checked) cbs[1].click();
  });
  await sleep(300);
}

async function capturePopupComposite(pg, lang, idx, suffix) {
  const popupRaw = join(tmpdir(), `tb-popup-${lang}-${idx}.png`);
  const sceneRaw = join(tmpdir(), `tb-scene-${lang}-${idx}.png`);
  const out = `${OUT}/shot-${lang}-${idx}-${suffix}.png`;
  await shotPopupElement(pg, popupRaw);
  compositeDropdown(popupRaw, sceneRaw);
  addCaption(sceneRaw, out, CAPTIONS[lang][idx - 1], lang);
  rmSync(popupRaw, { force: true });
  rmSync(sceneRaw, { force: true });
  console.log('wrote', `shot-${lang}-${idx}-${suffix}.png`);
}

function removeOldShots() {
  for (const name of readdirSync(OUT)) {
    if (!name.startsWith('shot-')) continue;
    if (OLD_SUFFIXES.some((s) => name.includes(`-${s}.png`))) {
      unlinkSync(join(OUT, name));
      console.log('removed old', name);
    }
  }
}

function makeSheets() {
  mkdirSync(SHEET_DIR, { recursive: true });
  for (const lang of ['en', 'ko']) {
    const paths = [
      `${OUT}/shot-${lang}-1-dropdown.png`,
      `${OUT}/shot-${lang}-2-vault.png`,
      `${OUT}/shot-${lang}-3-import.png`,
      `${OUT}/shot-${lang}-4-undo.png`,
      `${OUT}/shot-${lang}-5-settings.png`,
      `${OUT}/shot-${lang}-6-dark.png`,
    ];
    const sheet = `${SHEET_DIR}/sheet-${lang}.png`;
    const row1 = paths.slice(0, 2).map((p) => `"${p}"`).join(' ');
    const row2 = paths.slice(2, 4).map((p) => `"${p}"`).join(' ');
    const row3 = paths.slice(4, 6).map((p) => `"${p}"`).join(' ');
    execSync(`magick \\( ${row1} +append \\) \\( ${row2} +append \\) \\( ${row3} +append \\) -append -background "#16213a" -gravity center -splice 8x8 -bordercolor "#16213a" -border 8 "${sheet}"`, { shell: '/bin/bash' });
    console.log('sheet', sheet);
  }
}

async function patchBackupOk(pg) {
  await pg.evaluate(async () => {
    const st = await import('/shared/storage.js');
    const meta = await st.loadMeta();
    const state = await st.loadBackupState();
    await st.saveBackupState({
      ...state,
      paused: null,
      inflight: false,
      lastError: null,
      lastFileOkAt: Date.now(),
      lastFileOkRevision: meta.revision,
    });
  });
  await pg.reload({ waitUntil: 'load' });
  await sleep(700);
}

for (const lang of ['en', 'ko']) {
  const profile = mkdtempSync(join(tmpdir(), 'tb-shot-'));
  const extTmp = mkdtempSync(join(tmpdir(), 'tb-ext-'));
  let ext = EXT;
  if (lang !== 'ko') {
    cpSync(EXT, join(extTmp, 'chrome'), { recursive: true });
    rmSync(join(extTmp, 'chrome', '_locales', 'ko'), { recursive: true, force: true });
    ext = realpathSync(join(extTmp, 'chrome'));
  }
  const extId = createHash('sha256').update(ext).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  execSync(`defaults write com.google.chrome.for.testing AppleLanguages -array ${lang}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic', `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, `--lang=${lang}`],
    env: { ...process.env, LANG: lang === 'ko' ? 'ko_KR.UTF-8' : 'en_US.UTF-8' },
  });
  await sleep(2500);

  const openExt = async (path) => {
    const cdp = await browser.target().createCDPSession();
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/${path}` });
    await cdp.detach();
    const target = await browser.waitForTarget((t) => t._targetId === targetId || t.url().endsWith(path), { timeout: 10000 });
    const pg = await target.page();
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await sleep(800);
    return pg;
  };

  const page = await openExt('vault/vault.html');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  const step = (m) => console.log(`[${lang}] ${m}`);

  step('vault opened');
  const stamps = groupTimestamps();
  await page.evaluate(async (data, stamps) => {
    const st = await import('/shared/storage.js');
    const m = await import('/shared/model.js');
    const groups = data.map((g, i) => {
      const createdAt = stamps[i] ?? Date.now() - i * 3600e3;
      const firstTitle = g.tabs[0]?.[1] || '';
      const title = `${m.defaultGroupTitle(createdAt)} - ${firstTitle}`;
      return m.createGroup({
        title,
        tabs: g.tabs.map(([url, title, fav]) => m.createTab({ url, title, favIconUrl: fav || '' })),
        createdAt,
      });
    });
    for (let i = 0; i < groups.length; i++) groups[i].locked = !!data[i].locked;
    await st.saveAllGroups(groups);
    await chrome.runtime.sendMessage({ type: 'updateSettings', patch: { firstRunComplete: true, backupSubfolder: 'TabBunkerShot' } });
    const b = await Promise.race([
      chrome.runtime.sendMessage({ type: 'backupNow' }),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 25000)),
    ]);
    return { b: b?.ok ?? b };
  }, await withFavicons(DATA[lang]), stamps).then((r) => step('seeded ' + JSON.stringify(r)));
  await page.reload({ waitUntil: 'load' });
  await sleep(900);

  const capture = async (idx, pg, suffix) => {
    const raw = join(tmpdir(), `tb-shot-${lang}-${idx}.png`);
    const out = `${OUT}/shot-${lang}-${idx}-${suffix}.png`;
    await pg.screenshot({ path: raw });
    addCaption(raw, out, CAPTIONS[lang][idx - 1], lang);
    rmSync(raw, { force: true });
    console.log('wrote', `shot-${lang}-${idx}-${suffix}.png`);
  };

  const win = await page.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
  for (const [url] of COLLAPSE_TABS[lang]) {
    await page.evaluate((u, w) => chrome.tabs.create({ url: u, windowId: w, active: false }), url, win);
  }
  await sleep(3500);
  await patchBackupOk(page);

  // 1: 드롭다운 — 탭 고르기 펼침, 하나 해제, 보관 목록
  const popup1 = await openPopupInWindow(page, extId);
  await prepareDropdown(popup1);
  await capturePopupComposite(popup1, lang, 1, 'dropdown');
  await popup1.close().catch(() => {});

  // 2: 보관함
  await page.bringToFront();
  await page.evaluate(() => {
    document.querySelector('#backup-restore-hint')?.classList.add('hidden');
    document.querySelector('#review-banner')?.classList.add('hidden');
  });
  await capture(2, page, 'vault');

  // 3: 가져오기 미리보기
  const oneTabFile = join(extTmp, 'onetab.txt');
  writeFileSync(oneTabFile, ONETAB);
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(oneTabFile);
  await sleep(900);
  await capture(3, page, 'import');
  await page.evaluate(() => document.querySelector('#import-dialog')?.close());

  // 4: 되돌리기 알림 — 보관 직후 드롭다운 합성
  const tabIds = await page.evaluate(async (w) => {
    const tabs = await chrome.tabs.query({ windowId: w });
    const eligible = tabs.filter((t) => !t.url?.startsWith('chrome-extension://'));
    const ids = eligible.slice(0, 2).map((t) => t.id);
    return ids;
  }, win);
  await page.evaluate((ids, w) => chrome.runtime.sendMessage({ type: 'collapseTabs', tabIds: ids, windowId: w, closeTabs: true }), tabIds, win);
  await sleep(1200);
  const popup4 = await openPopupInWindow(page, extId);
  await popup4.evaluate(async () => {
    await chrome.storage.local.set({ tk_ui_backupNoticeSeen: true });
    document.getElementById('backup-notice')?.classList.add('hidden');
  });
  await sleep(500);
  await capturePopupComposite(popup4, lang, 4, 'undo');
  await popup4.close().catch(() => {});

  // 5: 설정 — 단축키 표기를 윈도우식으로
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'updateSettings', patch: { backupSubfolder: 'TabBunker' } }));
  await patchBackupOk(page);
  const opt = await openExt('options/options.html');
  await opt.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await opt.reload({ waitUntil: 'load' });
  await sleep(600);
  await opt.evaluate(() => {
    const container = document.getElementById('shortcut-keys');
    if (!container) return;
    container.replaceChildren();
    for (const part of ['Alt', 'Shift', 'S']) {
      const kbd = document.createElement('kbd');
      kbd.className = 'keycap';
      kbd.textContent = part;
      container.appendChild(kbd);
    }
  });
  await capture(5, opt, 'settings');

  // 6: 다크 모드 보관함
  await page.bringToFront();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.reload({ waitUntil: 'load' });
  await sleep(900);
  await capture(6, page, 'dark');

  await cleanupDownloads(page, ['TabBunkerShot', 'TabBunker']);
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(extTmp, { recursive: true, force: true });
  execSync('defaults delete com.google.chrome.for.testing AppleLanguages');
}

removeOldShots();
makeSheets();
