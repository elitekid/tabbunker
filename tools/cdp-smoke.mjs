// 헤드리스 크롬에 dist/chrome 확장을 로드하고 CDP로 서비스워커·페이지에 접근하는 스모크 도우미
// 사용: node tools/cdp-smoke.mjs <dist/chrome 절대경로> [--keep]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.TK_CHROME || `${process.env.HOME}/.cache/chrome-for-testing/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const ext = process.argv[2];
if (!ext) { console.error('dist/chrome 경로 필요'); process.exit(2); }
const port = 9555 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'tk-smoke-'));
const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-mock-keychain', '--password-store=basic',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, 'about:blank'];
const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', d => { stderr += d.toString(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`); return r.json();
}
async function waitFor(pred, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const ts = await targets(); const t = ts.find(pred); if (t) return t; } catch {} await sleep(300); }
  return null;
}
let seq = 0;
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const pending = new Map(); const events = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, send, events };
}
async function evalIn(t, expr) {
  const c = await connect(t);
  await c.send('Runtime.enable');
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  c.ws.close();
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || 'exception' };
  return { value: r.result?.result?.value };
}
export { targets, waitFor, connect, evalIn, sleep };

// 직접 실행 시: 확장 서비스워커 존재와 오류 여부만 보고
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const sw = await waitFor(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!sw) { console.log('FAIL: 확장 서비스워커를 찾지 못함'); console.log(stderr.slice(-2000)); cleanup(1); return; }
    const extId = new URL(sw.url).host;
    console.log('service worker:', sw.url);
    const id = await evalIn(sw, 'chrome.runtime.id');
    console.log('runtime.id:', id.value, id.error || '');
    const manifest = await evalIn(sw, 'JSON.stringify(chrome.runtime.getManifest())');
    console.log('manifest name/version:', JSON.parse(manifest.value || '{}').name, JSON.parse(manifest.value || '{}').version);
    process.env.TK_EXT_ID = extId;
    console.log('EXT_ID=' + extId);
    cleanup(0);
  })();
}
function cleanup(code) { try { chrome.kill('SIGTERM'); } catch {} setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 500); }
