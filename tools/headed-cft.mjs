// 우클릭 메뉴 실측용: 확장을 올린 CfT 를 헤드 모드로 띄우고 예시 페이지를 연다. 종료는 SIGTERM.
import { createRequire } from 'node:module'; import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { createServer } from 'node:http';
const require = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR + '/package.json' : '/tmp/tb-ff/package.json'); const puppeteer = require('puppeteer-core');
const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const EXT = process.argv[2] || decodeURIComponent(new URL('../dist/chrome', import.meta.url).pathname);
const profile = mkdtempSync(join(tmpdir(), 'tb-headed-'));
const srv = createServer((req, res) => { const t = decodeURIComponent((req.url || '/').slice(1)) || 'Headed page'; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<title>${t}</title><h1 style="font:32px system-ui">${t}</h1><p style="font:20px system-ui"><a href="http://127.0.0.1:${srv.address().port}/Linked%20page">A link to send</a></p>`); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, userDataDir: profile, defaultViewport: null, ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'], args: ['--no-sandbox', '--no-first-run', '--use-mock-keychain', '--password-store=basic', '--disable-features=Translate', `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--window-size=1280,900', '--window-position=40,40'] });
await new Promise((r) => setTimeout(r, 3000));
const page = (await browser.pages())[0] || (await browser.newPage()); await page.goto(base + 'Right-click%20test%20page');
console.log('ready', base, 'profile', profile);
const bye = async () => { try { await browser.close(); } catch {} srv.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
