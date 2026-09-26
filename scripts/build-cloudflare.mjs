import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 25 * 1024 * 1024;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

async function walk(dir) {
  const output = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not a deployable asset: ${dir}/${entry.name}`);
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else if (entry.isFile()) output.push(full);
  }
  return output.sort();
}

export async function build(root = ROOT) {
  root = await fs.realpath(root);
  const dist = path.resolve(root, 'dist');
  if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('Invalid build destination');
  const old = await fs.lstat(dist).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (old) {
    if (!old.isDirectory() || old.isSymbolicLink()) throw new Error('dist must be a regular directory');
    // Only clear a directory previously produced by this script, inside this project.
    if (!(await fs.readFile(path.join(dist, '.museum-build'), 'utf8').catch(() => '')).startsWith('picturebook-museum')) {
      throw new Error('dist exists without the museum build marker; move it aside before building');
    }
    // Keep the root directory: Windows dev servers can hold it open as their cwd.
    for (const entry of await fs.readdir(dist)) {
      if (entry === '.museum-build') continue;
      const target = path.resolve(dist, entry);
      if (path.dirname(target) !== dist) throw new Error('Invalid generated asset path');
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, '.museum-build'), 'picturebook-museum generated assets\n');
  await fs.writeFile(path.join(dist, '.assetsignore'), '.museum-build\n.git\n.git/**\n**/*.zip\n**/*.pack\n');
  const copied = [];
  const copy = async file => {
    const relative = path.relative(root, file);
    const target = path.join(dist, relative);
    const stat = await fs.stat(file);
    if (stat.size > LIMIT) throw new Error(`Static asset exceeds 25 MiB: ${relative}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
    copied.push({ path: relative.split(path.sep).join('/'), bytes: stat.size });
  };
  await copy(path.join(root, 'index.html'));
  for (const folder of ['assets/css', 'assets/js']) {
    for (const file of await walk(path.join(root, folder))) {
      if (['.css', '.js', '.mjs'].includes(path.extname(file))) await copy(file);
    }
  }
  const imageRoot = path.join(root, 'assets/images');
  const exhibitRoot = path.join(imageRoot, 'exhibits');
  const images = await walk(imageRoot);
  const upload = [];
  let routes = {};
  for (const file of images) {
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) continue;
    if (!file.startsWith(exhibitRoot + path.sep)) { await copy(file); continue; }
    const data = await fs.readFile(file);
    const hash = createHash('sha256').update(data).digest('hex');
    const source = path.relative(root, file).split(path.sep).join('/');
    // Content-addressed keys preserve old deployments and never overwrite an older image.
    const key = `exhibits/${hash}${path.extname(file).toLowerCase()}`;
    routes['/' + source] = { key, type, bytes: data.length, hash };
    upload.push({ source, ...routes['/' + source] });
  }
  if (!upload.length) {
    // GitHub builds use the checked-in index; image binaries live only in R2.
    routes = JSON.parse(await fs.readFile(path.join(root, 'worker/exhibit-manifest.json'), 'utf8'));
    for (const [url, entry] of Object.entries(routes)) {
      if (!url.startsWith('/assets/images/exhibits/') || !/^[a-f0-9]{64}$/.test(entry.hash) || !entry.key.startsWith(`exhibits/${entry.hash}.`)) {
        throw new Error(`Invalid exhibit manifest entry: ${url}`);
      }
      upload.push({ source: url.slice(1), ...entry });
    }
    if (!upload.length) throw new Error('No exhibit images or R2 manifest entries found');
  }
  const packText = await fs.readFile(path.join(root, 'assets/js/museum-data.js'), 'utf8');
  const pack = JSON.parse(packText.slice(packText.indexOf('=') + 1).trim().replace(/;$/, ''));
  for (const museum of pack.museums) {
    for (const node of museum.nodes) {
      if (!routes['/' + node.image.replace(/^\.\//, '')]) throw new Error(`Missing exhibit image: ${node.image}`);
    }
  }
  await fs.mkdir(path.join(root, 'worker'), { recursive: true });
  await fs.mkdir(path.join(root, '.cloudflare'), { recursive: true });
  await fs.writeFile(path.join(root, 'worker/exhibit-manifest.json'), JSON.stringify(routes));
  const result = { static_files: copied, r2_images: upload, static_bytes: copied.reduce((s, f) => s + f.bytes, 0), r2_bytes: upload.reduce((s, f) => s + f.bytes, 0) };
  await fs.writeFile(path.join(root, '.cloudflare/build-manifest.json'), JSON.stringify(result, null, 2));
  console.log(`Workers: ${copied.length} files / ${result.static_bytes} bytes; R2: ${upload.length} images / ${result.r2_bytes} bytes`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
