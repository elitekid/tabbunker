// 데모 GIF: 실제 확장 화면만 사용. 빈 보관함 → 접기(배너+그룹) → 즉시 백업된 tabbunker-latest.json → OneTab 파일 가져오기 미리보기
import { createRequire } from 'node:module'; import { mkdtempSync, rmSync, cpSync, realpathSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { createHash } from 'node:crypto'; import { execSync } from 'node:child_process';
const require = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR + '/package.json' : '/tmp/tb-ff/package.json'); const puppeteer = require('puppeteer-core');
const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const EXT = decodeURIComponent(new URL('../dist/chrome', import.meta.url).pathname); const OUT = decodeURIComponent(new URL('../docs/store', import.meta.url).pathname); const FR = mkdtempSync(join(tmpdir(), 'tb-gif-'));
const SUB = 'TabBunker'; // 실제 ~/Downloads/TabBunker(기본 폴더 이름이 캡처에 보이게). 끝나면 removeFile+erase 로 정리
import { existsSync, readdirSync } from 'node:fs'; import { homedir } from 'node:os';
if (existsSync(join(homedir(), 'Downloads', SUB)) && readdirSync(join(homedir(), 'Downloads', SUB)).length) { console.error('~/Downloads/TabBunker 에 실제 파일이 있어 중단(덮어쓰기 방지)'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// macOS 크롬은 --lang 을 무시하고 시스템 언어(ko)를 쓴다 → 영어 데모는 ko 문구 폴더를 뺀 복사본으로
const extTmp = mkdtempSync(join(tmpdir(), 'tb-ext-')); cpSync(EXT, join(extTmp, 'chrome'), { recursive: true }); rmSync(join(extTmp, 'chrome', '_locales', 'ko'), { recursive: true, force: true }); const ext = realpathSync(join(extTmp, 'chrome'));
const extId = createHash('sha256').update(ext).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const profile = mkdtempSync(join(tmpdir(), 'tb-gifp-'));
execSync('defaults write com.google.chrome.for.testing AppleLanguages -array en'); // 시스템 언어(ko) 대신 영어 날짜 표기, 끝나면 제거
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', `--load-extension=${ext}`, `--disable-extensions-except=${ext}`] });
await sleep(2500);
const openExt = async (path) => { const cdp = await browser.target().createCDPSession(); const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/${path}` }); await cdp.detach(); const target = await browser.waitForTarget((t) => t._targetId === targetId || t.url().endsWith(path), { timeout: 10000 }); const pg = await target.page(); await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 }); await sleep(800); return pg; };
const vault = await openExt('vault/vault.html');
await vault.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); // 시스템 다크와 무관하게 라이트로
// 데모용 파비콘: 도구(node)가 받아 data: 로 심는다. 확장은 네트워크를 쓰지 않는다.
async function faviconDataUrl(url) {
  try { const host = new URL(url).hostname; const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`, { signal: AbortSignal.timeout(4000) }); if (!res.ok) return ''; const buf = Buffer.from(await res.arrayBuffer()); return buf.length && buf.length < 16 * 1024 ? `data:${res.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}` : ''; } catch { return ''; }
}
const send = (msg) => vault.evaluate((m) => chrome.runtime.sendMessage(m), msg);
await send({ type: 'updateSettings', patch: { firstRunComplete: true, backupSubfolder: SUB } });
await vault.reload({ waitUntil: 'load' }); await sleep(600);
const shots = []; const shot = async (pg, name, caption) => { const f = join(FR, name + '.png'); await pg.screenshot({ path: f }); shots.push([f, caption]); console.log('frame', name); };
await shot(vault, '0-empty', 'Too many tabs open? Click the TabBunker icon once.');
const win = await vault.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
// 헤드리스 탭은 실제 페이지를 못 받아 제목이 비므로 data: 페이지에 제목을 박아 연다(실제 tabs.create 경로)
const pages = [['IndexedDB API - MDN', 'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API'], ['Hacker News', 'https://news.ycombinator.com/'], ['browser-extension - GitHub Topics', 'https://github.com/topics/browser-extension'], ['Technology - The New York Times', 'https://www.nytimes.com/section/technology']];
for (const [title, real] of pages) await vault.evaluate((t, h, w) => chrome.tabs.create({ url: `data:text/html;charset=utf-8,<title>${encodeURIComponent(t)}</title><h1>${encodeURIComponent(h)}</h1>`, windowId: w, active: false }), title, new URL(real).host, win);
await sleep(2500);
const col = await send({ type: 'collapse', windowId: win }); console.log('collapse', JSON.stringify(col).slice(0, 160));
await sleep(1500); await vault.bringToFront().catch(() => {});
await shot(vault, '1-collapsed', 'All tabs in the window are closed and saved as a group.');
const pagesWithFav = await Promise.all(pages.map(async ([title, real]) => [title, real, await faviconDataUrl(real)]));
await vault.evaluate(async (pages) => { const st = await import('/shared/storage.js'); const gs = await st.loadGroups(); for (const g of gs) for (const t of g.tabs) { const m = pages.find(([title]) => title === t.title); if (m) { t.url = m[1]; t.favIconUrl = m[2] || ''; } } await st.saveAllGroups(gs); }, pagesWithFav);
await vault.reload({ waitUntil: 'load' }); await sleep(600);
const bk = await vault.evaluate(() => Promise.race([chrome.runtime.sendMessage({ type: 'backupNow' }), new Promise((r) => setTimeout(() => r({ timeout: true }), 25000))])); console.log('backupNow', JSON.stringify(bk).slice(0, 160));
// 실제 보관함의 백업 상태 영역을 확대해 보여 준다(합성 화면 금지). 640x400 영역을 잘라 합성 단계에서 1.5배로 키운다.
await vault.reload({ waitUntil: 'load' }); await sleep(900);
{ const f = join(FR, '2-backup.png'); await vault.screenshot({ path: f, clip: { x: 0, y: 0, width: 640, height: 400 } }); shots.push([f, 'Every change is saved to a JSON file in Downloads/TabBunker.']); console.log('frame', '2-backup'); }
// OneTab 텍스트 파일 가져오기: 실제 파일 입력 경로(버튼 클릭은 OS 파일 창을 띄워 헤드리스가 멈춤)
const oneTabFile = join(extTmp, 'onetab.txt'); writeFileSync(oneTabFile, 'https://github.com/ | GitHub\nhttps://developer.mozilla.org/ | MDN Web Docs\nhttps://news.ycombinator.com/ | Hacker News\n\nhttps://www.notion.so/ | Notion\nhttps://calendar.google.com/ | Google Calendar');
await vault.evaluate(() => document.querySelector('#backup-restore-hint')?.classList.add('hidden'));
const fileInput = await vault.$('#file-input'); await fileInput.uploadFile(oneTabFile); await sleep(900);
await shot(vault, '3-import', 'Moving from another tab manager? Import the export and preview the merge.');
// 정리: 데모용 백업 파일 삭제(실제 ~/Downloads/TabBunkerGif)
await vault.evaluate(async (sub) => { const ds = await chrome.downloads.search({}); for (const d of ds) { if ((d.filename || '').includes(sub)) { try { if (d.exists) await chrome.downloads.removeFile(d.id); } catch {} try { await chrome.downloads.erase({ id: d.id }); } catch {} } } }, SUB);
await browser.close(); rmSync(profile, { recursive: true, force: true }); rmSync(extTmp, { recursive: true, force: true }); execSync('defaults delete com.google.chrome.for.testing AppleLanguages');
// 자막 붙이고 GIF 합성 (ImageMagick + ffmpeg)
let i = 0; const capFiles = [];
for (const [f, cap] of shots) { const o = join(FR, `cap-${i++}.png`); execSync(`magick "${f}" -resize 960x600 -gravity south -background "#16213a" -splice 0x64 -fill white -pointsize 26 -font /System/Library/Fonts/Supplemental/Arial.ttf -annotate +0+18 "${cap.replace(/"/g, '\\"')}" "${o}"`); capFiles.push(o); }
const list = join(FR, 'list.txt'); execSync(`printf '' > "${list}"`); for (const c of capFiles) execSync(`printf "file '%s'\\nduration 2.2\\n" "${c}" >> "${list}"`); execSync(`printf "file '%s'\\n" "${capFiles[capFiles.length - 1]}" >> "${list}"`);
execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -vf "fps=8,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${OUT}/demo.gif"`);
execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -vf "fps=8,format=yuv420p,scale=960:-2" -movflags +faststart "${OUT}/demo.mp4"`);
console.log('wrote', `${OUT}/demo.gif`, `${OUT}/demo.mp4`); rmSync(FR, { recursive: true, force: true });
