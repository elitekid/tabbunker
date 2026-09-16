#!/usr/bin/env node
// docs/recover/shared/ 에 확장의 순수 모듈(model·importers·exporters)을 복사한다. GitHub Pages(/docs)에서 복구 페이지가 이 모듈을 import 한다.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'recover', 'shared');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
for (const f of ['model.js', 'importers.js', 'exporters.js']) cpSync(join(root, 'src', 'shared', f), join(out, f));
console.log('site shared modules copied ->', out);
