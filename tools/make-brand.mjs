// 브랜드 마크(SVG) → 아이콘 16/32/48/128, 로고 300, 홍보 타일 440x280, 큰 홍보 1400x560
import { createRequire } from 'node:module'; import { writeFileSync, mkdirSync } from 'node:fs';
const require = createRequire(process.env.PPTR_DIR ? process.env.PPTR_DIR + '/package.json' : '/tmp/tb-ff/package.json'); const puppeteer = require('puppeteer-core');
const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const OUT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, ''); mkdirSync(OUT + '/docs/store', { recursive: true });
// 마크: 짙은 남색 둥근 사각형, 벙커 아치(밝은 회색), 아치 안에 탭 줄 3개(노란빛 흰색)
const mark = (size, radius = 0.22) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3a55"/><stop offset="1" stop-color="#16213a"/></linearGradient></defs>
  <rect x="0" y="0" width="128" height="128" rx="${128 * radius}" fill="url(#g)"/>
  <path d="M24 104 V64 a40 40 0 0 1 80 0 V104 Z" fill="#e8ecf3"/>
  <rect x="24" y="96" width="80" height="10" fill="#c9d1de"/>
  <rect x="40" y="58" width="48" height="9" rx="4.5" fill="#f5b83d"/>
  <rect x="40" y="73" width="48" height="9" rx="4.5" fill="#f5b83d"/>
  <rect x="40" y="88" width="30" height="9" rx="4.5" fill="#f5b83d"/>
</svg>`;
const page = (w, h, body, bg = 'transparent') => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden;font-family:-apple-system,"Segoe UI",Inter,sans-serif}</style></head><body>${body}</body></html>`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'] });
const p = await browser.newPage();
async function shot(w, h, html, file, omitBg = true) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await p.setContent(html, { waitUntil: 'load' }); await p.screenshot({ path: file, omitBackground: omitBg, clip: { x: 0, y: 0, width: w, height: h } }); console.log('wrote', file); }
for (const s of [16, 32, 48, 128]) await shot(s, s, page(s, s, mark(s)), `${OUT}/src/icons/icon${s}.png`);
await shot(300, 300, page(300, 300, `<div style="width:300px;height:300px;display:grid;place-items:center;background:#fff">${mark(240)}</div>`), `${OUT}/docs/store/logo-300.png`, false);
// 작은 홍보 타일 440x280: 글자 없이 마크 + 배경 패턴
const tileBg = `background:radial-gradient(circle at 20% 20%, #34496e 0, #16213a 60%);`;
await shot(440, 280, page(440, 280, `<div style="width:440px;height:280px;display:grid;place-items:center;${tileBg}">${mark(170, 0.22)}</div>`), `${OUT}/docs/store/promo-small-440x280.png`, false);
// 큰 홍보 1400x560: 마크 + 이름 + 태그라인
await shot(1400, 560, page(1400, 560, `<div style="width:1400px;height:560px;display:flex;align-items:center;gap:72px;padding:0 140px;box-sizing:border-box;${tileBg}color:#fff">${mark(300, 0.22)}<div><div style="font-size:92px;font-weight:700;letter-spacing:-2px;line-height:1">TabBunker</div><div style="font-size:38px;margin-top:22px;color:#dbe3f0">Pick the tabs to save. Reopen them anytime.</div><div style="font-size:26px;margin-top:18px;color:#f5b83d">Automatic backup file in your Downloads folder.</div></div></div>`), `${OUT}/docs/store/promo-marquee-1400x560.png`, false);
await browser.close();
