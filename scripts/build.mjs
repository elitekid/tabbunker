#!/usr/bin/env node
// dist/chrome, dist/firefox 생성 및 zip 패키징

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

const targets = [
  { name: 'chrome', manifest: 'manifest.chrome.json', zip: 'tabbunker-chrome.zip' },
  { name: 'firefox', manifest: 'manifest.firefox.json', zip: 'tabbunker-firefox.zip' },
];

// dist 정리
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const target of targets) {
  const outDir = join(dist, target.name);
  mkdirSync(outDir, { recursive: true });

  // src 복사
  cpSync(src, outDir, { recursive: true });

  // manifest 복사
  const manifestSrc = join(root, target.manifest);
  const manifestJson = readFileSync(manifestSrc, 'utf8');
  writeFileSync(join(outDir, 'manifest.json'), manifestJson);

  // JSON 유효성 검사
  JSON.parse(manifestJson);

  // zip 생성
  const zipPath = join(dist, target.zip);
  execSync(`cd "${outDir}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });

  console.log(`Built ${target.name} -> ${outDir}`);
  console.log(`Zipped -> ${zipPath}`);
}

console.log('Build complete.');
