import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './build-cloudflare.mjs';

// The secret is read from the ignored local file and passed over stdin, never in process arguments.
const text = await readFile(path.join(ROOT, '.dev.vars'), 'utf8');
const match = text.match(/^ZHIHU_OAUTH_APP_KEY\s*=\s*["']?([a-zA-Z0-9_-]+)["']?\s*$/m);
if (!match || match[1].startsWith('replace-')) throw new Error('Configure ZHIHU_OAUTH_APP_KEY in the local .dev.vars file first');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', 'ZHIHU_OAUTH_APP_KEY'], { cwd: ROOT, shell: false, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', reject);
  child.stdin.on('error', () => {});
  child.on('close', code => code === 0 ? resolve() : reject(new Error('Cloudflare secret configuration failed; check login and Worker access')));
  child.stdin.end(match[1] + '\n');
});
