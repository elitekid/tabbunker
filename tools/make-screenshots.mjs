// 스토어 스크린샷 1280x800 (영어·한국어): 접기, 백업 상태, 가져오기, 온보딩, 설정, 다크
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, cpSync, realpathSync, writeFileSync } from 'node:fs';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTIONS = {
  // 스토어 목록에서 1/3 로 줄어도 읽히게 한 줄·짧게(과장 금지: 되돌리기는 마지막 작업 1회)
  en: [
    'One click saves every tab. Undo with one click.',
    'Backed up twice: in the browser and as a JSON file.',
    'See what an import will change before it happens.',
    'Start with the tabs you have open right now.',
    'No account. No server. Nothing leaves your computer.',
    'Dark mode follows your system.',
  ],
  ko: [
    '클릭 한 번에 모든 탭 보관, 되돌리기도 한 번에',
    '브라우저 안과 JSON 파일, 두 곳에 자동 백업',
    '가져오기 전에 무엇이 바뀌는지 먼저 확인',
    '지금 열린 탭부터 바로 보관',
    '계정도 서버도 없이, 내 컴퓨터에만 저장',
    '시스템 설정을 따르는 다크 모드',
  ],
};


const DATA = {
  en: [
    { title: 'Research: browser extension launch', locked: true, tabs: [['https://developer.chrome.com/docs/webstore/publish', 'Publish in the Chrome Web Store'], ['https://extensionworkshop.com/documentation/publish/', 'Publishing your extension | Firefox Extension Workshop'], ['https://news.ycombinator.com/item?id=42217504', 'Ask HN: How did you grow your browser extension?'], ['https://github.com/topics/browser-extension', 'browser-extension · GitHub Topics'], ['https://www.reddit.com/r/chrome/', 'r/chrome']] },
    { title: '2026-09-14 11:20 - Weekend reading', tabs: [['https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API', 'IndexedDB API - Web APIs | MDN'], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Rebuilding my desk setup (2026) - YouTube'], ['https://stackoverflow.com/questions/tagged/chrome-extension', 'Newest chrome-extension Questions - Stack Overflow'], ['https://www.nytimes.com/section/technology', 'Technology - The New York Times']] },
    { title: 'Flight + hotel for Tokyo', tabs: [['https://www.google.com/travel/flights', 'Google Flights'], ['https://www.booking.com/', 'Booking.com | Official site'], ['https://www.japan-guide.com/e/e2018.html', 'Tokyo Travel Guide - japan-guide.com']] },
  ],
  ko: [
    { title: '자료 조사: 확장 프로그램 출시', locked: true, tabs: [['https://developer.chrome.com/docs/webstore/publish?hl=ko', 'Chrome 웹 스토어에 게시하기'], ['https://extensionworkshop.com/documentation/publish/', 'Publishing your extension | Firefox Extension Workshop'], ['https://news.hada.io/', 'GeekNews - 개발자 뉴스'], ['https://github.com/topics/browser-extension', 'browser-extension · GitHub Topics'], ['https://www.reddit.com/r/chrome/', 'r/chrome']] },
    { title: '2026-09-14 11:20 - 주말에 읽을 것', tabs: [['https://developer.mozilla.org/ko/docs/Web/API/IndexedDB_API', 'IndexedDB API - Web API | MDN'], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', '2026 책상 세팅 다시 하기 - YouTube'], ['https://stackoverflow.com/questions/tagged/chrome-extension', 'Newest chrome-extension Questions - Stack Overflow'], ['https://www.hani.co.kr/arti/science', '과학·기술 : 한겨레']] },
    { title: '도쿄 항공권과 숙소', tabs: [['https://www.google.com/travel/flights?hl=ko', 'Google 항공편 검색'], ['https://www.booking.com/index.ko.html', 'Booking.com | 공식 사이트'], ['https://www.japan-guide.com/e/e2018.html', 'Tokyo Travel Guide - japan-guide.com']] },
  ],
};

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

const COLLAPSE_TABS = {
  en: [['https://www.wikipedia.org/', 'Wikipedia'], ['https://www.bbc.com/news', 'BBC News'], ['https://www.allrecipes.com/', 'Allrecipes | Recipes, How-Tos, Videos and More']],
  ko: [['https://ko.wikipedia.org/', '위키백과, 우리 모두의 백과사전'], ['https://www.bbc.com/korean', 'BBC News 코리아'], ['https://www.10000recipe.com/', '만개의레시피']],
};

const ONETAB = 'https://github.com/ | GitHub\nhttps://developer.mozilla.org/ | MDN Web Docs\nhttps://news.ycombinator.com/ | Hacker News\n\nhttps://www.notion.so/ | Notion\nhttps://calendar.google.com/ | Google Calendar';

function addCaption(rawPath, outPath, caption, lang) {
  const font = lang === 'ko' ? KO_FONT : '/System/Library/Fonts/Supplemental/Arial.ttf';
  const safe = caption.replace(/"/g, '\\"');
  // 스토어 규격 1280x800 유지: 화면을 1088x680 으로 줄여 위에 두고, 아래 120px 띠에 캡션을 줄바꿈해 넣는다
  execSync(`magick -size 1280x800 xc:"#16213a" \\( "${rawPath}" -resize 1088x680 \\) -gravity north -geometry +0+0 -composite \\( -size 1200x104 -background none -fill white -font "${font}" -pointsize 40 -gravity center caption:"${safe}" \\) -gravity south -geometry +0+8 -composite -alpha off -depth 8 -strip "PNG24:${outPath}"`); // 크롬 스토어: 24비트 PNG(알파 없음)만 받음
}

// 사이트(docs/assets)용: 기능 부분만 2배 해상도로 잘라 캡션 없이 저장한다. 스토어 캡처와 달리 크게 읽히는 것이 목적.
const SITE = decodeURIComponent(new URL('../docs/assets', import.meta.url).pathname);
mkdirSync(SITE, { recursive: true });
// opts.vw: 사이트용으로만 창 폭을 좁혀 카드가 폭을 채우게(찍고 1280 으로 되돌림), opts.maxW: 잘라낼 최대 폭(CSS px)
async function siteShot(pg, lang, name, selectors, pad = 20, scale = 2, opts = {}) {
  if (opts.vw) { await pg.setViewport({ width: opts.vw, height: 800, deviceScaleFactor: 1 }); await new Promise((r) => setTimeout(r, 400)); }
  const box = await pg.evaluate((sels, pad) => {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
    }
    if (x1 === Infinity) return null;
    const x = Math.max(0, x1 - pad), y = Math.max(0, y1 - pad);
    return { x, y, width: Math.min(innerWidth, x2 + pad) - x, height: y2 + pad - y };
  }, selectors, pad);
  if (!box) throw new Error(`site shot ${name}: element not found (${selectors.join(', ')})`);
  if (opts.maxW) box.width = Math.min(box.width, opts.maxW);
  const out = `${SITE}/${name}-${lang}.png`;
  await pg.screenshot({ path: out, clip: { ...box, scale }, captureBeyondViewport: true });
  execSync(`magick "${out}" -resize "1800x>" -strip "${out}"`);
  if (opts.vw) { await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 }); await new Promise((r) => setTimeout(r, 400)); }
  console.log('wrote site', `${name}-${lang}.png`);
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
  await page.evaluate(async (data) => {
    const st = await import('/shared/storage.js');
    const m = await import('/shared/model.js');
    const groups = data.map((g, i) => m.createGroup({
      title: g.title,
      tabs: g.tabs.map(([url, title, fav]) => m.createTab({ url, title, favIconUrl: fav || '' })),
      createdAt: Date.now() - i * 3600e3,
    }));
    for (let i = 0; i < groups.length; i++) groups[i].locked = !!data[i].locked;
    await st.saveAllGroups(groups);
    const u = await chrome.runtime.sendMessage({ type: 'updateSettings', patch: { firstRunComplete: true, backupSubfolder: 'TabBunkerShot' } });
    const b = await Promise.race([
      chrome.runtime.sendMessage({ type: 'backupNow' }),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 25000)),
    ]);
    return { u: u?.ok, b: b?.ok ?? b };
  }, await withFavicons(DATA[lang])).then((r) => step('seeded ' + JSON.stringify(r)));
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

  // 2: 백업 상태(상단)
  await capture(2, page, 'backup');
  await siteShot(page, lang, 'backup', ['#backup-line1', '#backup-line2', '#btn-backup-restore'], 24, 2, { maxW: 560 });

  // 3: 가져오기 미리보기
  const oneTabFile = join(extTmp, 'onetab.txt');
  writeFileSync(oneTabFile, ONETAB);
  await page.evaluate(() => document.querySelector('#backup-restore-hint')?.classList.add('hidden'));
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(oneTabFile);
  await sleep(900);
  await capture(3, page, 'import');
  await siteShot(page, lang, 'import', ['#import-dialog'], 0);
  await page.evaluate(() => document.querySelector('#import-dialog')?.close());

  // 4: 온보딩 — 접기 전, 예시 탭 3개 열린 상태
  const win = await page.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
  for (const [url, title] of COLLAPSE_TABS[lang]) {
    await page.evaluate((t, h, w) => chrome.tabs.create({
      url: `data:text/html;charset=utf-8,<title>${encodeURIComponent(t)}</title><h1>${encodeURIComponent(h)}</h1>`,
      windowId: w,
      active: false,
    }), title, new URL(url).host, win);
  }
  await sleep(2500);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'updateSettings', patch: { firstRunComplete: false } }));
  await page.reload({ waitUntil: 'load' });
  await sleep(1200);
  await capture(4, page, 'onboarding');
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'updateSettings', patch: { firstRunComplete: true } }));

  // 1: 접기 직후
  await page.evaluate((w) => chrome.runtime.sendMessage({ type: 'collapse', windowId: w }), win);
  await sleep(1200);
  await page.evaluate(async (tabsInfo) => {
    const st = await import('/shared/storage.js');
    const gs = await st.loadGroups();
    for (const g of gs) {
      for (const t of g.tabs) {
        const m = tabsInfo.find(([, title]) => title === t.title);
        if (m && t.url.startsWith('data:')) {
          t.url = m[0];
          t.favIconUrl = m[2] || '';
        }
      }
    }
    await st.saveAllGroups(gs);
  }, (await withFavicons([{ tabs: COLLAPSE_TABS[lang] }]))[0].tabs);
  await page.evaluate(() => { location.href = location.pathname + '?collapsed=1'; });
  await sleep(1500);
  await page.bringToFront().catch(() => {});
  await capture(1, page, 'collapse');
  await siteShot(page, lang, 'collapse', ['#collapse-banner', '.group-card'], 0, 2, { vw: 860 });
  { const out = `${SITE}/hero-${lang}.png`; await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1280, height: 800 } }); execSync(`magick "${out}" -strip "${out}"`); console.log('wrote site', `hero-${lang}.png`); }

  // 5: 설정 — 폴더명 TabBunker 로 되돌린 뒤(추가 백업 없음)
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'updateSettings', patch: { backupSubfolder: 'TabBunker' } }));
  const opt = await openExt('options/options.html');
  await opt.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await opt.reload({ waitUntil: 'load' });
  await sleep(600);
  await capture(5, opt, 'options');
  await siteShot(opt, lang, 'options', ['fieldset:nth-of-type(3)'], 20);

  // 6: 다크 모드
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.reload({ waitUntil: 'load' });
  await sleep(900);
  const rawDark = join(tmpdir(), `tb-shot-${lang}-6.png`);
  const outDark = `${OUT}/shot-${lang}-6-dark.png`;
  await page.screenshot({ path: rawDark });
  await siteShot(page, lang, 'dark', ['#backup-status', '.group-card'], 0, 2, { vw: 860 });
  addCaption(rawDark, outDark, CAPTIONS[lang][5], lang);
  rmSync(rawDark, { force: true });
  console.log('wrote', `shot-${lang}-6-dark.png`);

  await cleanupDownloads(page, ['TabBunkerShot', 'TabBunker']);
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(extTmp, { recursive: true, force: true });
  execSync('defaults delete com.google.chrome.for.testing AppleLanguages');
}
