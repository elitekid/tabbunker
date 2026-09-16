// 데모 GIF(영어·한국어): 실제 확장 화면만 사용. 빈 보관함 → 접기(배너+그룹) → 백업 상태 확대 → 다른 탭 관리자 파일 가져오기 미리보기
// 출력: docs/assets/demo-{en,ko}.gif (사이트용), docs/store/demo.gif·demo.mp4 (영어, 스토어·README용)
// 사용: node tools/make-demo-gif.mjs [en|ko|all]   (기본 all)
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, cpSync, realpathSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const require = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR + '/package.json' : '/tmp/tb-ff/package.json');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const EXT = decodeURIComponent(new URL('../dist/chrome', import.meta.url).pathname);
const STORE = decodeURIComponent(new URL('../docs/store', import.meta.url).pathname);
const SITE = decodeURIComponent(new URL('../docs/assets', import.meta.url).pathname);
mkdirSync(SITE, { recursive: true });
const SUB = 'TabBunker'; // 실제 ~/Downloads/TabBunker(기본 폴더 이름이 화면에 보이게). 끝나면 removeFile+erase 로 정리
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = {
  en: {
    font: '/System/Library/Fonts/Supplemental/Arial.ttf',
    pages: [
      ['IndexedDB API - MDN', 'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API'],
      ['Hacker News', 'https://news.ycombinator.com/'],
      ['browser-extension - GitHub Topics', 'https://github.com/topics/browser-extension'],
      ['Technology - The New York Times', 'https://www.nytimes.com/section/technology'],
    ],
    captions: [
      'Too many tabs open? Click the TabBunker icon once.',
      'Every tab in the window is closed and saved as a group.',
      'Every change is saved to a JSON file in Downloads/TabBunker.',
      'Moving from another tab manager? Preview the import first.',
    ],
  },
  ko: {
    font: '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    pages: [
      ['IndexedDB API - Web API | MDN', 'https://developer.mozilla.org/ko/docs/Web/API/IndexedDB_API'],
      ['GeekNews - 개발자 뉴스', 'https://news.hada.io/'],
      ['browser-extension · GitHub Topics', 'https://github.com/topics/browser-extension'],
      ['과학·기술 : 한겨레', 'https://www.hani.co.kr/arti/science'],
    ],
    captions: [
      '탭이 너무 많나요? TabBunker 아이콘을 한 번 누르세요.',
      '창의 탭이 모두 닫히고 그룹 하나로 저장됩니다.',
      '모든 변경은 다운로드/TabBunker 폴더의 JSON 파일로 저장됩니다.',
      '다른 탭 관리자에서 옮기나요? 가져오기 결과를 먼저 확인하세요.',
    ],
  },
};
const ONETAB = 'https://github.com/ | GitHub\nhttps://developer.mozilla.org/ | MDN Web Docs\nhttps://news.ycombinator.com/ | Hacker News\n\nhttps://www.notion.so/ | Notion\nhttps://calendar.google.com/ | Google Calendar';

// 화면용 파비콘: 도구(node)가 받아 data: 로 심는다. 확장 자체는 네트워크를 쓰지 않는다.
async function faviconDataUrl(url) {
  try {
    const host = new URL(url).hostname;
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length < 16 * 1024 ? `data:${res.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}` : '';
  } catch { return ''; }
}

async function run(lang) {
  const cfg = L[lang];
  if (existsSync(join(homedir(), 'Downloads', SUB)) && readdirSync(join(homedir(), 'Downloads', SUB)).length) {
    throw new Error('~/Downloads/TabBunker 에 실제 파일이 있어 중단(덮어쓰기 방지)');
  }
  const FR = mkdtempSync(join(tmpdir(), `tb-gif-${lang}-`));
  const extTmp = mkdtempSync(join(tmpdir(), 'tb-ext-'));
  // macOS 크롬은 --lang 을 무시하고 시스템 언어를 쓴다 → 영어는 ko 문구 폴더를 뺀 복사본, 날짜 표기는 번들 언어 기본값으로 맞춘다
  let ext = EXT;
  if (lang === 'en') {
    cpSync(EXT, join(extTmp, 'chrome'), { recursive: true });
    rmSync(join(extTmp, 'chrome', '_locales', 'ko'), { recursive: true, force: true });
    ext = realpathSync(join(extTmp, 'chrome'));
  }
  const extId = createHash('sha256').update(ext).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const profile = mkdtempSync(join(tmpdir(), 'tb-gifp-'));
  execSync(`defaults write com.google.chrome.for.testing AppleLanguages -array ${lang}`);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, `--lang=${lang}`] });
  const shots = [];
  try {
    await sleep(2500);
    const cdp = await browser.target().createCDPSession();
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/vault/vault.html` });
    await cdp.detach();
    const vault = await (await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 10000 })).page();
    await vault.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await vault.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await sleep(800);
    const send = (msg) => vault.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const shot = async (name, caption, clip) => { const f = join(FR, name + '.png'); await vault.screenshot(clip ? { path: f, clip } : { path: f }); shots.push([f, caption]); console.log(`[${lang}] frame`, name); };

    await send({ type: 'updateSettings', patch: { firstRunComplete: true, backupSubfolder: SUB } });
    await vault.reload({ waitUntil: 'load' }); await sleep(700);
    await shot('0-empty', cfg.captions[0]);

    const win = await vault.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
    // 헤드리스 탭은 실제 페이지를 못 받아 제목이 비므로 제목을 박은 data: 페이지로 연다(실제 tabs.create 경로)
    for (const [title, real] of cfg.pages) {
      await vault.evaluate((t, h, w) => chrome.tabs.create({ url: `data:text/html;charset=utf-8,<title>${encodeURIComponent(t)}</title><h1>${encodeURIComponent(h)}</h1>`, windowId: w, active: false }), title, new URL(real).host, win);
    }
    await sleep(2500);
    const col = await send({ type: 'collapse', windowId: win });
    if (!col?.ok) throw new Error('collapse failed ' + JSON.stringify(col));
    await sleep(800);
    // 저장된 data: 주소를 실제 주소·파비콘으로 바꾸고, 접기 직후 진입 경로(?collapsed=1)로 다시 열어 배너를 보인다
    const withFav = await Promise.all(cfg.pages.map(async ([title, real]) => [title, real, await faviconDataUrl(real)]));
    await vault.evaluate(async (pages) => { const st = await import('/shared/storage.js'); const gs = await st.loadGroups(); for (const g of gs) for (const t of g.tabs) { const m = pages.find(([title]) => title === t.title); if (m) { t.url = m[1]; t.favIconUrl = m[2] || ''; } } await st.saveAllGroups(gs); }, withFav);
    await vault.evaluate(() => { location.href = location.pathname + '?collapsed=1'; }); await sleep(1500);
    await shot('1-collapsed', cfg.captions[1]);

    const bk = await vault.evaluate(() => Promise.race([chrome.runtime.sendMessage({ type: 'backupNow' }), new Promise((r) => setTimeout(() => r({ timeout: true }), 25000))]));
    if (!bk?.ok) throw new Error('backupNow failed ' + JSON.stringify(bk).slice(0, 200));
    await vault.reload({ waitUntil: 'load' }); await sleep(900);
    // 실제 보관함의 백업 상태 영역을 확대(640x400 → 합성 때 1.5배)
    await shot('2-backup', cfg.captions[2], { x: 0, y: 0, width: 640, height: 400 });

    const oneTabFile = join(extTmp, 'onetab.txt'); writeFileSync(oneTabFile, ONETAB);
    await vault.evaluate(() => document.querySelector('#backup-restore-hint')?.classList.add('hidden'));
    await (await vault.$('#file-input')).uploadFile(oneTabFile); await sleep(900);
    await shot('3-import', cfg.captions[3]);

    await vault.evaluate(async (sub) => { const ds = await chrome.downloads.search({}); for (const d of ds) { if ((d.filename || '').includes(sub)) { try { if (d.exists) await chrome.downloads.removeFile(d.id); } catch {} try { await chrome.downloads.erase({ id: d.id }); } catch {} } } }, SUB);
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true }); rmSync(extTmp, { recursive: true, force: true });
    try { execSync('defaults delete com.google.chrome.for.testing AppleLanguages', { stdio: 'ignore' }); } catch {}
    try { const d = join(homedir(), 'Downloads', SUB); if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true }); } catch {}
  }

  // 자막 띠를 붙여 960x664 프레임으로 합성(ImageMagick) → GIF·MP4(ffmpeg)
  const capFiles = [];
  shots.forEach(([f, cap], i) => {
    const o = join(FR, `cap-${i}.png`);
    const safe = cap.replace(/"/g, '\\"');
    execSync(`magick "${f}" -resize 960x600! -gravity south -background "#16213a" -splice 0x64 -fill white -pointsize 26 -font "${cfg.font}" -annotate +0+18 "${safe}" "${o}"`);
    capFiles.push(o);
  });
  const list = join(FR, 'list.txt');
  writeFileSync(list, capFiles.map((c) => `file '${c}'\nduration 2.4\n`).join('') + `file '${capFiles[capFiles.length - 1]}'\n`);
  const gifOut = `${SITE}/demo-${lang}.gif`;
  execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -vf "fps=8,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${gifOut}"`);
  console.log('wrote', gifOut);
  if (lang === 'en') {
    cpSync(gifOut, `${STORE}/demo.gif`);
    execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -vf "fps=8,format=yuv420p,scale=960:-2" -movflags +faststart "${STORE}/demo.mp4"`);
    console.log('wrote', `${STORE}/demo.gif`, `${STORE}/demo.mp4`);
  }
  rmSync(FR, { recursive: true, force: true });
}

const arg = process.argv[2] || 'all';
for (const lang of arg === 'all' ? ['en', 'ko'] : [arg]) await run(lang);
