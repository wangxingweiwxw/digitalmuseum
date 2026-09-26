import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ROOT, build } from './build-cloudflare.mjs';

export function wrangler(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: ROOT, shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    let output = '';
    if (capture) for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Wrangler failed (${code}): ${output}`)));
  });
}

export async function upload(mode = '--dry-run') {
  if (!['--dry-run', '--local', '--remote'].includes(mode)) throw new Error('Use --dry-run, --local or --remote');
  const manifest = await build(ROOT, { refreshImages: true });
  const config = JSON.parse(await readFile(path.join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const bucket = config.r2_buckets.find(item => item.binding === 'EXHIBITS')?.bucket_name;
  if (!bucket) throw new Error('Missing EXHIBITS bucket_name in wrangler.jsonc');
  const images = [...new Map(manifest.r2_images.map(item => [item.key, item])).values()];
  console.log(`${mode}: ${images.length} images -> R2 bucket ${bucket}`);
  if (mode === '--dry-run') {
    console.log('No upload performed. Use --remote to upload to Cloudflare or --local for local development.');
    return;
  }
  // Validate all sources before writing any objects; CI intentionally has no image binaries.
  for (const item of images) {
    await access(path.join(ROOT, item.source)).catch(() => { throw new Error(`Run R2 uploads from the local project containing all images. Missing: ${item.source}`); });
  }
  // Sequential uploads stop at the first failure; never publish references to missing objects.
  for (const [index, item] of images.entries()) {
    await wrangler(['r2', 'object', 'put', `${bucket}/${item.key}`, '--file', path.join(ROOT, item.source),
      '--content-type', item.type, '--cache-control', 'public, max-age=31536000, immutable', mode], true);
    console.log(`[${index + 1}/${images.length}] ${item.source}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('Specify exactly one upload mode');
  await upload(args[0] || '--dry-run');
}
